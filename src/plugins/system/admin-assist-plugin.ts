import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { BotMessage, Plugin, PluginContext, PromptBuildInput } from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";
import type { OneBotClient } from "../../onebot.js";

type TruncationProvider = {
  getTruncatedFullText: (id: string) => string | undefined;
};

type AdminAssistHandler = {
  buildDynamicPromptAppends: (message: BotMessage) => Promise<string[]>;
  generateReply: (message: BotMessage, dynamicPromptAppends: string[]) => Promise<string>;
  sendReply: (message: BotMessage, reply: string) => Promise<void>;
};

type AdminAssistPlugin = Plugin & {
  getToolRegistrations: () => BotToolRegistration[];
  setHandler: (handler: AdminAssistHandler) => void;
  setTruncationProvider: (provider: TruncationProvider) => void;
};

type ActivitySample = {
  timestamp: number;
  category: string;
  detail?: string;
  idleSeconds: number | null;
};

type PendingMention = {
  key: string;
  message: BotMessage;
  groupId: string;
  mentionedAdminIds: string[];
  createdAt: number;
  timer: NodeJS.Timeout;
};

type QueuedPrivateMessage = {
  userId: string;
  text: string;
};

type AwayStatus = {
  adminId: string;
  reason: string;
  since: number;
};

type CachedValue<T> = {
  expiresAt: number;
  value: T;
};

type RawActivitySnapshot = {
  processName?: string;
  windowTitle?: string;
  idleSeconds?: number;
  capturedAt?: string;
};

const ACTIVITY_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinApi {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
"@

$hwnd = [WinApi]::GetForegroundWindow()
$title = New-Object System.Text.StringBuilder 512
[void][WinApi]::GetWindowText($hwnd, $title, $title.Capacity)
$processId = [uint32]0
[void][WinApi]::GetWindowThreadProcessId($hwnd, [ref]$processId)
$processName = $null
if ($processId -ne 0) {
  try {
    $processName = (Get-Process -Id $processId).ProcessName
  } catch {}
}

$lastInput = New-Object WinApi+LASTINPUTINFO
$lastInput.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][WinApi+LASTINPUTINFO])
$idleSeconds = $null
if ([WinApi]::GetLastInputInfo([ref]$lastInput)) {
  $idleSeconds = [math]::Round(([Environment]::TickCount - $lastInput.dwTime) / 1000.0, 1)
}

[ordered]@{
  processName = $processName
  windowTitle = if ($title.Length -gt 0) { $title.ToString() } else { $null }
  idleSeconds = $idleSeconds
  capturedAt = (Get-Date).ToString("o")
} | ConvertTo-Json -Compress
`;

const execFileAsync = promisify(execFile);

/** Lazily write the PowerShell script to a .ps1 file and return its path. */
let _cachedScriptPath: string | null = null;
function getScriptFilePath(): string {
  if (_cachedScriptPath) return _cachedScriptPath;
  const dir = path.resolve("data");
  fs.mkdirSync(dir, { recursive: true });
  _cachedScriptPath = path.join(dir, "admin-activity.ps1");
  fs.writeFileSync(_cachedScriptPath, ACTIVITY_SCRIPT, "utf8");
  return _cachedScriptPath;
}

const USER_LABEL_CACHE_TTL_MS = 5 * 60 * 1000;

const AWAY_KEYWORDS = [
  "管理员在吗", "管理员在不在", "管理在吗", "管理在不在",
  "管理员去哪了", "管理员去哪", "管理去哪了",
  "管理员不在吗", "管理不在吗",
  "管理员怎么不在", "管理怎么不在",
  "管理员呢", "管理呢",
  "什么时候回来",
  "怎么没人管", "怎么没人回",
];

export function createAdminAssistPlugin(onebot: OneBotClient, adminUserIds: string[]): AdminAssistPlugin {
  const adminIdSet = new Set(adminUserIds.filter(Boolean));
  const activitySamples: ActivitySample[] = [];
  const pendingMentions = new Map<string, PendingMention>();
  const activeIncidentByMessageKey = new Map<string, string>();
  const queuedPrivateMessages = new Map<string, QueuedPrivateMessage[]>();
  const groupMemberCache = new Map<string, CachedValue<{ card?: string; nickname?: string }>>();
  const awayStatuses = new Map<string, AwayStatus>();
  let ctxRef: PluginContext | null = null;
  let handler: AdminAssistHandler | null = null;
  let sampleTimer: NodeJS.Timeout | null = null;
  let mentionCounter = 0;
  let truncationProvider: TruncationProvider | null = null;
  const activitySampleLock: { current: Promise<void> | null } = { current: null };
  const lastAdminReplyAt = new Map<string, number>();

  return {
    name: "admin-assist",
    description: "标记管理员消息，并在管理员被 @ 后超时未回复时由 AI 协助回复",
    systemPromptAppend: [
      "消息会标明发送者是不是机器人管理员。",
      "如果有人 @ 管理员但管理员暂时没回应，你可能会被叫去先帮忙看看。",
      "如果给了脱敏的活动摘要，只能大概猜猜管理员在不在或可能在忙什么，别说得好像你真能看到屏幕一样。",
      "想通知谁可以用 send_private_message 发私聊。",
      "管理员可以在私聊里让你给某个群发消息，用 send_group_message 就行（不记得群号可以先用 get_group_list 查）。",
      "用 check_is_friend 看看某人是不是好友——主动加好友目前做不到，得对方来加机器人。",
      "get_friend_list 看好友列表，get_group_list 看群列表。",
      "如果用户发的消息太长被截了，会标注完整长度和查看用的 ID，用 read_full_message 工具可以看全文。",
      "管理员说要去忙/离开一下就用 set_away_status，回来了用 clear_away_status。send_private_message 和 send_group_message 只有管理员能用。reply_in_group 可以让机器人在群里用自己的语气和知识自主回复，适合需要 bot 参与讨论的场景。",
    ].join("\n"),

    setHandler(nextHandler) {
      handler = nextHandler;
    },

    setTruncationProvider(provider) {
      truncationProvider = provider;
    },

    async onLoad(ctx) {
      ctxRef = ctx;
      captureActivitySample(activitySamples, ctx, activitySampleLock, adminUserIds);

      const intervalMs = ctx.config.pluginSettings.adminAssist.activitySampleIntervalSeconds * 1000;
      sampleTimer = setInterval(() => {
        captureActivitySample(activitySamples, ctx, activitySampleLock, adminUserIds);
      }, intervalMs);
    },

    async onBuildSystemPrompt(input: PromptBuildInput) {
      if (input.mode === "single") {
        return buildSingleMessagePrompt(onebot, input.message, adminIdSet, {
          groupMemberCache,
        });
      }

      const lines = ["当前为合并消息场景，请注意每条消息发送者身份："];
      const lastIndex = input.messages.length - 1;
      const senderLines = await Promise.all(input.messages.map(async (message, index) => {
        const isTrigger = index === lastIndex;
        const tag = isTrigger ? "（触发本次回复）" : "";
        const idHint = isTrigger && message.id ? `，消息 ID：${message.id}，如需引用回复可使用 [REPLY:${message.id}]` : "";
        return `- 消息 ${index + 1}${tag} 发送者：${await formatSenderIdentity(onebot, message, adminIdSet, {
          groupMemberCache,
        })}${idHint}`;
      }));
      lines.push(...senderLines);
      return lines.join("\n");
    },

    async onMessage(message) {
      const ctx = ctxRef;
      if (!ctx || !ctx.config.plugins.adminAssist) {
        return false;
      }

      if (message.type !== "group" || !message.groupId) {
        return false;
      }

      if (isAdminMessage(message, adminIdSet)) {
        lastAdminReplyAt.set(message.groupId, Date.now());
        cancelPendingMentions(
          pendingMentions,
          message.groupId,
          "管理员已在群内发言",
          message.userId
        );
        // 管理员如果使用 QQ 回复功能回复了某条消息，按消息 ID 精确匹配并取消待协助
        if (message.replyToMessageId) {
          for (const [key, pending] of pendingMentions) {
            if (pending.groupId === message.groupId && pending.message.id === message.replyToMessageId) {
              clearTimeout(pending.timer);
              pendingMentions.delete(key);
              console.log(`[AdminAssist] 管理员回复了消息 ${message.replyToMessageId}，取消待协助`);
              break;
            }
          }
        }
        return false;
      }

      const rawMentionedAdminIds = findMentionedAdminIds(message, adminIdSet);
      const mentionedAdminIds = await filterAdminsInGroup(
        onebot,
        message.groupId,
        rawMentionedAdminIds,
        { groupMemberCache }
      );

      // 无 @管理员 时，检查是否有管理员设置了离开状态且消息含询问关键词
      if (mentionedAdminIds.length === 0) {
        const awayAdmins = [...awayStatuses.values()].filter((s) => adminIdSet.has(s.adminId));
        const awayIds = awayAdmins.map((s) => s.adminId);
        const inGroupAwayIds = await filterAdminsInGroup(
          onebot,
          message.groupId,
          awayIds,
          { groupMemberCache }
        );
        if (inGroupAwayIds.length > 0 && AWAY_KEYWORDS.some((kw) => message.text.includes(kw))) {
          const key = `away-${++mentionCounter}`;
          const timer = setTimeout(() => {
            void handleMentionTimeout(key);
          }, 1500);
          pendingMentions.set(key, {
            key,
            message,
            groupId: message.groupId,
            mentionedAdminIds: inGroupAwayIds,
            createdAt: Date.now(),
            timer,
          });
        }
        return false;
      }

      if (message.selfId && message.text.includes(`@${message.selfId}`)) {
        return false;
      }

      const key = `mention-${++mentionCounter}`;
      const timeoutMs = ctx.config.pluginSettings.adminAssist.mentionTimeoutSeconds * 1000;
      const timer = setTimeout(() => {
        void handleMentionTimeout(key);
      }, timeoutMs);

      pendingMentions.set(key, {
        key,
        message,
        groupId: message.groupId,
        mentionedAdminIds,
        createdAt: Date.now(),
        timer,
      });

      return false;
    },

    getToolRegistrations() {
      return [
        makeTool(
          "get_recent_activity_summary",
          "获取最近一段时间电脑活动的脱敏文字摘要，只返回通用活动类别和空闲时长，不包含窗口标题、文件名、网页地址或聊天内容。",
          {
            type: "object",
            properties: {
              lookbackMinutes: { type: "number", description: "向前回看多少分钟，默认使用配置值。" },
            },
            required: [],
          },
          async (args) => {
            const ctx = ensureContext(ctxRef);
            return summarizeRecentActivity(
              activitySamples,
              ctx.config.pluginSettings.adminAssist,
              optionalNumber(args.lookbackMinutes)
            );
          }
        ),
        makeTool(
          "send_private_message",
          "向指定 QQ 用户发送私聊消息。仅在需要通知管理员或处理当前群聊上下文时使用。",
          {
            type: "object",
            properties: {
              userId: { type: "string", description: "接收私聊的 QQ 号，支持纯数字、@123456、[AT:123456]、[CQ:at,qq=123456] 等格式" },
              text: { type: "string", description: "私聊内容" },
            },
            required: ["userId", "text"],
          },
          async (args, input) => {
            requireAdmin(input, adminIdSet);
            const ctx = ensureContext(ctxRef);
            const userId = normalizeUserIdArg(args.userId, "userId");
            const text = requireString(args.text, "text");
            const messageKey = getInputMessageKey(input);
            const incidentKey = activeIncidentByMessageKey.get(messageKey);
            const groupId = getInputGroupId(input);
            const userLabel = await resolveUserLabel(onebot, groupId, userId, {
              groupMemberCache,
            });

            if (incidentKey) {
              const queue = queuedPrivateMessages.get(incidentKey) ?? [];
              queue.push({ userId, text });
              queuedPrivateMessages.set(incidentKey, queue);
              return `已记录对 ${userLabel} 的私聊通知，将在群内回复发送后再发送。`;
            }

            await ctx.sendMessage({ type: "private", id: userId }, text);
            return `已向 ${userLabel} 发送私聊消息。`;
          }
        ),
        makeTool(
          "send_group_message",
          "向指定群聊发送消息。可先用 get_group_list 查看机器人所在的群。仅管理员可要求使用此工具。",
          {
            type: "object",
            properties: {
              groupId: { type: "string", description: "目标群的群号，纯数字" },
              text: { type: "string", description: "要发送到群里的消息内容" },
            },
            required: ["groupId", "text"],
          },
          async (args, input) => {
            requireAdmin(input, adminIdSet);
            const ctx = ensureContext(ctxRef);
            const groupId = String(args.groupId ?? "").trim();
            const text = requireString(args.text, "text");
            if (!/^\d+$/.test(groupId)) {
              throw new Error("groupId 必须为纯数字群号。");
            }
            await ctx.sendMessage({ type: "group", id: groupId }, text);
            return `已向群 ${groupId} 发送消息。`;
          }
        ),
        makeTool(
          "reply_in_group",
          "代替管理员在群内回复消息或展开话题。bot 会理解上下文、使用自己的语气和知识库来生成自然的回复。仅管理员可使用。需提供目标群号和要回应的内容描述。",
          {
            type: "object",
            properties: {
              groupId: { type: "string", description: "目标群的群号，纯数字" },
              instruction: { type: "string", description: "对 bot 的说明：要回复什么、参考什么信息、用什么语气或角度等" },
            },
            required: ["groupId", "instruction"],
          },
          async (args, input) => {
            requireAdmin(input, adminIdSet);
            const currentHandler = handler;
            if (!currentHandler) throw new Error("插件尚未就绪。");

            const groupId = String(args.groupId ?? "").trim();
            if (!/^\d+$/.test(groupId)) throw new Error("groupId 必须为纯数字群号。");
            const instruction = requireString(args.instruction, "instruction");

            const msg: BotMessage = input.mode === "single" ? input.message : input.messages[input.messages.length - 1];
            const synthetic: BotMessage = {
              type: "group",
              groupId,
              userId: msg.userId ?? "0",
              text: instruction,
              raw: {} as any,
            };

            const appends = await currentHandler.buildDynamicPromptAppends(synthetic);
            const reply = await currentHandler.generateReply(synthetic, appends);
            await currentHandler.sendReply(synthetic, reply);
            return `已在群 ${groupId} 中回复。`;
          }
        ),
        makeTool(
          "check_is_friend",
          "检查指定 QQ 用户是否为机器人的好友。返回是否为好友及对方的显示名称。",
          {
            type: "object",
            properties: {
              userId: { type: "string", description: "要检查的 QQ 号，支持纯数字、@123456、[AT:123456]、[CQ:at,qq=123456] 等格式" },
            },
            required: ["userId"],
          },
          async (args) => {
            const userId = normalizeUserIdArg(args.userId, "userId");
            const friends = await onebot.getFriendList();
            const match = friends.find((f) => f.userId === userId);
            if (match) {
              const displayName = match.remark?.trim() || match.nickname?.trim() || userId;
              return `${displayName}(${userId}) 是机器人的好友。`;
            }
            return `${userId} 不是机器人的好友。`;
          }
        ),
        makeTool(
          "send_friend_request",
          "尝试主动向指定 QQ 用户发起好友申请。注意：当前 OneBot 实现（NapCat）不支持此功能，调用会返回限制说明。请引导对方主动添加机器人为好友。",
          {
            type: "object",
            properties: {
              userId: { type: "string", description: "目标 QQ 号，支持纯数字、@123456、[AT:123456]、[CQ:at,qq=123456] 等格式" },
            },
            required: ["userId"],
          },
          async (args) => {
            const userId = normalizeUserIdArg(args.userId, "userId");

            const isAlreadyFriend = await onebot.isFriend(userId);
            if (isAlreadyFriend) {
              return `${userId} 已经是机器人的好友，无需重复添加。`;
            }

            const botInfo = await onebot.getLoginInfo();
            return [
              `无法向 ${userId} 发送好友申请：当前 OneBot 实现（NapCat）不支持主动发起好友请求。`,
              `OneBot v11 协议和 NapCat 均未提供主动添加好友的 API，这是 QQ 平台的风控限制。`,
              `请引导对方主动搜索并添加机器人 QQ 号：${botInfo.userId}。`,
            ].join("\n");
          }
        ),
        makeTool(
          "read_full_message",
          "查看被截断的用户消息完整内容。当系统提示消息过长时，使用此工具查看原文。",
          {
            type: "object",
            properties: {
              id: { type: "string", description: "截断提示中提供的消息 ID，如 \"current\" 或 \"batch-1\"" },
            },
            required: ["id"],
          },
          async (args) => {
            const id = requireString(args.id, "id");
            if (!truncationProvider) {
              return "截断查看功能尚未就绪。";
            }
            const fullText = truncationProvider.getTruncatedFullText(id);
            if (fullText === undefined) {
              return `未找到 ID 为 "${id}" 的截断消息。可能该消息未被截断，或 ID 不正确。`;
            }
            return `完整消息内容（共 ${fullText.length} 字）：\n\n${fullText}`;
          }
        ),
        makeTool(
          "get_group_list",
          "获取机器人所在的所有群聊列表，包含群号、群名称和成员数。可用于确定要向哪个群发送消息。",
          {
            type: "object",
            properties: {},
            required: [],
          },
          async () => {
            const groups = await onebot.getGroupList();
            if (groups.length === 0) {
              return "机器人当前未加入任何群聊。";
            }
            const lines = groups.map((g) => {
              const name = g.groupName ?? "未命名";
              const members = g.memberCount !== undefined ? `（${g.memberCount} 人）` : "";
              return `- ${name}（群号：${g.groupId}）${members}`;
            });
            return `机器人共加入 ${groups.length} 个群聊：\n${lines.join("\n")}`;
          }
        ),
        makeTool(
          "get_friend_list",
          "获取机器人的所有好友列表，包含 QQ 号、昵称和备注。可用于确定要私聊谁或查看好友信息。",
          {
            type: "object",
            properties: {},
            required: [],
          },
          async () => {
            const friends = await onebot.getFriendList();
            if (friends.length === 0) {
              return "机器人当前没有任何好友。";
            }
            const lines = friends.map((f) => {
              const remark = f.remark?.trim();
              const nickname = f.nickname?.trim();
              const displayName = remark || nickname || "未知";
              return `- ${displayName}（QQ：${f.userId}）`;
            });
            return `机器人共有 ${friends.length} 位好友：\n${lines.join("\n")}`;
          }
        ),
        makeTool(
          "set_away_status",
          "设置管理员的离开状态。当管理员说要去某处、做某事、暂时离开时调用。设置后，群里有人找该管理员时，机器人会代为说明去向。",
          {
            type: "object",
            properties: {
              reason: { type: "string", description: "离开原因，如\"开会\"、\"吃饭\"、\"出门办事\"等" },
            },
            required: ["reason"],
          },
          async (args, input) => {
            requireAdmin(input, adminIdSet);
            const reason = requireString(args.reason, "reason");
            const message = input.mode === "single" ? input.message : input.messages[input.messages.length - 1];
            const adminId = message.userId!;
            awayStatuses.set(adminId, {
              adminId,
              reason,
              since: Date.now(),
            });
            return `已设置离开状态：${reason}。当群里有人找你时，机器人会代为说明你在${reason}。回来后告诉我即可取消。`;
          }
        ),
        makeTool(
          "clear_away_status",
          "清除管理员的离开状态。当管理员说\"我回来了\"、\"我回来了\"、结束离开时调用。",
          {
            type: "object",
            properties: {},
            required: [],
          },
          async (args, input) => {
            requireAdmin(input, adminIdSet);
            const message = input.mode === "single" ? input.message : input.messages[input.messages.length - 1];
            const adminId = message.userId!;
            const existing = awayStatuses.get(adminId);
            if (!existing) {
              return "当前没有设置离开状态。";
            }
            awayStatuses.delete(adminId);
            return `已清除离开状态（之前设置的是\"${existing.reason}\"）。群里有人找时机器人不再代为说明了。`;
          }
        ),
      ];
    },
  };

  function hasAdminRepliedSince(groupId: string, timestamp: number): boolean {
    const repliedAt = lastAdminReplyAt.get(groupId);
    return repliedAt !== undefined && repliedAt >= timestamp;
  }

  async function handleMentionTimeout(key: string) {
    const incident = pendingMentions.get(key);
    if (!incident) {
      return;
    }
    pendingMentions.delete(key);

    const ctx = ctxRef;
    const currentHandler = handler;
    if (!ctx || !currentHandler) {
      return;
    }

    const messageKey = getMessageKey(incident.message);
    activeIncidentByMessageKey.set(messageKey, incident.key);

    if (hasAdminRepliedSince(incident.groupId, incident.createdAt)) {
      console.log(`[AdminAssist] 群 ${incident.groupId} 的管理员已在 @ 后回复，跳过代为回复`);
      return;
    }

    try {
      const baseAppends = await currentHandler.buildDynamicPromptAppends(incident.message);
      const activitySummary = summarizeRecentActivity(activitySamples, ctx.config.pluginSettings.adminAssist);
      const adminLabels = await Promise.all(incident.mentionedAdminIds.map((userId) => (
        resolveUserLabel(onebot, incident.groupId, userId, {
          groupMemberCache,
        })
      )));

      const awayLines: string[] = [];
      for (const adminId of incident.mentionedAdminIds) {
        const status = awayStatuses.get(adminId);
        if (status) {
          const label = await resolveUserLabel(onebot, incident.groupId, adminId, { groupMemberCache });
          const elapsed = formatSeconds(Math.round((Date.now() - status.since) / 1000));
          awayLines.push(`${label} 已声明暂时离开去「${status.reason}」，已离开 ${elapsed}。请据此向群友说明其去向。`);
        }
      }

      const isAwayKeywordTrigger = key.startsWith("away-");
      const sceneLine = isAwayKeywordTrigger
        ? "当前场景：群成员在群里询问或提及管理员，但管理员设置了离开状态暂未回复。"
        : "当前场景：群成员 @ 了机器人管理员，但管理员在限定时间内没有在群里回复。";
      const thresholdLine = isAwayKeywordTrigger
        ? ""
        : `未回复阈值：${ctx.config.pluginSettings.adminAssist.mentionTimeoutSeconds} 秒。`;

      const incidentPrompt = [
        sceneLine,
        thresholdLine,
        `被提及的管理员：${adminLabels.join("、")}。`,
        ...awayLines,
        "你现在是代管理员先行协助的机器人，可以尝试回答问题、解释管理员可能暂时不在，或引导对方补充信息。",
        "不要冒充管理员本人；如果结论不确定，请明确说明你是在先代为处理。",
        "在代为协助时，请继续保持你在系统提示词中设定的角色人格、语气与风格，不要让回复变成刻板的机器人公告。",
        "最近电脑活动摘要（已脱敏，仅供判断管理员是否在电脑前或是否可能正忙于某类任务）：",
        activitySummary,
        "系统已自动向被提及的管理员发送私聊通知，你无需再重复通知他们。如需私聊其他用户，可调用 send_private_message 工具。",
      ].filter(Boolean).join("\n");

      const reply = await currentHandler.generateReply(incident.message, [...baseAppends, incidentPrompt]);
      if (hasAdminRepliedSince(incident.groupId, incident.createdAt)) {
        console.log(`[AdminAssist] 生成回复期间群 ${incident.groupId} 的管理员已回复，取消发送`);
        return;
      }
      await currentHandler.sendReply(incident.message, reply);

      // 自动向被 @ 的管理员发送私聊通知（不依赖 LLM 是否调用 send_private_message 工具）
      const senderLabel = await resolveSenderLabel(onebot, incident.message, { groupMemberCache });
      const truncatedMessage = incident.message.text.length > 200
        ? incident.message.text.slice(0, 200) + "..."
        : incident.message.text;
      const truncatedReply = reply.length > 500 ? reply.slice(0, 500) + "..." : reply;
      const notifyText = [
        `[管理员通知] 有人在群里 @了你`,
        `群号：${incident.groupId}`,
        `发送者：${senderLabel}`,
        `消息内容：${truncatedMessage}`,
        `机器人已代为回复：${truncatedReply}`,
      ].join("\n");

      for (const adminId of incident.mentionedAdminIds) {
        try {
          await ctx.sendMessage({ type: "private", id: adminId }, notifyText);
          console.log(`[AdminAssist] 已向管理员 ${adminId} 发送私聊通知`);
        } catch (err) {
          console.error(`[AdminAssist] 向管理员 ${adminId} 发送私聊通知失败:`, err);
        }
      }

      await flushQueuedPrivateMessages(incident.key, ctx, queuedPrivateMessages);
    } catch (error) {
      console.error("[AdminAssist] 超时协助回复失败:", error);
    } finally {
      activeIncidentByMessageKey.delete(messageKey);
      queuedPrivateMessages.delete(incident.key);
    }
  }
}

function makeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: BotToolRegistration["execute"]
): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description,
        parameters,
      },
    },
    execute,
  };
}

async function buildSingleMessagePrompt(
  onebot: OneBotClient,
  message: BotMessage,
  adminIdSet: Set<string>,
  cache: {
    groupMemberCache: Map<string, CachedValue<{ card?: string; nickname?: string }>>;
  }
): Promise<string> {
  const lines: string[] = [];
  if (message.id) {
    lines.push(`当前消息 ID：${message.id}（如需引用回复可使用 [REPLY:${message.id}]）。`);
  }
  lines.push(`当前消息发送者：${await formatSenderIdentity(onebot, message, adminIdSet, cache)}。`);
  const rawMentionedAdminIds = findMentionedAdminIds(message, adminIdSet);
  const mentionedAdminIds = await filterAdminsInGroup(onebot, message.groupId, rawMentionedAdminIds, cache);

  if (mentionedAdminIds.length > 0 && message.type === "group") {
    const adminLabels = await Promise.all(mentionedAdminIds.map((userId) => (
      resolveUserLabel(onebot, message.groupId, userId, cache)
    )));
    lines.push(`这条群消息提及了管理员：${adminLabels.join("、")}。`);
  }

  if (isAdminMessage(message, adminIdSet)) {
    lines.push("这是机器人管理员本人发送的消息。涉及配置、行为调整或执行请求时，请优先按管理员的明确指令处理。");
  }

  return lines.join("\n");
}

async function formatSenderIdentity(
  onebot: OneBotClient,
  message: BotMessage,
  adminIdSet: Set<string>,
  cache: {
    groupMemberCache: Map<string, CachedValue<{ card?: string; nickname?: string }>>;
  }
): Promise<string> {
  const userId = message.userId ?? "unknown";
  const senderLabel = await resolveSenderLabel(onebot, message, cache);
  return adminIdSet.has(userId) ? `${senderLabel}（机器人管理员）` : `${senderLabel}（普通用户）`;
}

function isAdminMessage(message: BotMessage, adminIdSet: Set<string>): boolean {
  return Boolean(message.userId && adminIdSet.has(message.userId));
}

function findMentionedAdminIds(message: BotMessage, adminIdSet: Set<string>): string[] {
  const rawMessage = message.raw.message;
  if (Array.isArray(rawMessage)) {
    const mentioned = new Set<string>();
    for (const segment of rawMessage) {
      if (segment.type !== "at") {
        continue;
      }
      const qq = typeof segment.data.qq === "string" || typeof segment.data.qq === "number"
        ? String(segment.data.qq)
        : "";
      if (qq && adminIdSet.has(qq)) {
        mentioned.add(qq);
      }
    }
    if (mentioned.size > 0) {
      return [...mentioned];
    }
  }

  const mentioned = new Set<string>();
  for (const adminUserId of adminIdSet) {
    const escaped = adminUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`@${escaped}(?!\\d)`);
    if (regex.test(message.text)) {
      mentioned.add(adminUserId);
    }
  }
  return [...mentioned];
}

async function filterAdminsInGroup(
  onebot: OneBotClient,
  groupId: string | undefined,
  adminIds: string[],
  cache: {
    groupMemberCache: Map<string, CachedValue<{ card?: string; nickname?: string }>>;
  }
): Promise<string[]> {
  if (!groupId || adminIds.length === 0) {
    return [];
  }

  const results = await Promise.all(
    adminIds.map(async (adminId) => {
      try {
        await getCachedMap(
          cache.groupMemberCache,
          `${groupId}:${adminId}`,
          async () => {
            const result = await onebot.getGroupMemberInfo(groupId, adminId);
            return { card: result.card, nickname: result.nickname };
          }
        );
        return adminId;
      } catch {
        return null;
      }
    })
  );

  return results.filter((id): id is string => id !== null);
}

function cancelPendingMentions(
  pendingMentions: Map<string, PendingMention>,
  groupId: string,
  reason: string,
  adminUserId?: string
) {
  let cancelledCount = 0;

  for (const [key, pending] of pendingMentions) {
    if (pending.groupId !== groupId) {
      continue;
    }
    if (adminUserId && !pending.mentionedAdminIds.includes(adminUserId)) {
      continue;
    }
    clearTimeout(pending.timer);
    pendingMentions.delete(key);
    cancelledCount += 1;
  }

  if (cancelledCount > 0) {
    console.log(`[AdminAssist] 已取消群 ${groupId} 的待协助事项 ${cancelledCount} 条: ${reason}`);
  }
}

async function captureActivitySample(
  activitySamples: ActivitySample[],
  ctx: PluginContext,
  lock: { current: Promise<void> | null },
  adminUserIds: string[]
) {
  if (lock.current) {
    console.log("[AdminAssist] 上一次活动采样尚未完成，跳过本次采样");
    return;
  }

  lock.current = (async () => {
    const start = Date.now();

    // Fetch Steam game info in parallel with local activity
    const { steamApiKey, steamUserIds } = ctx.config.pluginSettings.adminAssist;
    if (steamApiKey && Object.keys(steamUserIds).length > 0) {
      fetchSteamGames(steamApiKey, steamUserIds).catch(() => {});
    }

    const raw = await getRawActivitySnapshot();
    const elapsed = Date.now() - start;

    if (!raw) {
      console.log(`[AdminAssist] 活动采样未获取到数据（耗时 ${elapsed}ms）`);
      return;
    }

    const category = categorizeProcess(raw.processName);
    const idleSeconds = normalizeIdleSeconds(raw.idleSeconds);

    // Enrich with detail: prefer Steam game name, fall back to window title for games
    let detail: string | undefined;
    if (category === "游戏娱乐") {
      // Try to find a Steam game for any admin user
      for (const adminId of adminUserIds) {
        const steamGame = getSteamGameForUser(adminId);
        if (steamGame) {
          detail = steamGame.gameName;
          break;
        }
      }
      // Fall back to window title if no Steam data
      if (!detail && raw.windowTitle) {
        detail = raw.windowTitle;
      }
    }

    activitySamples.push({
      timestamp: parseTimestamp(raw.capturedAt),
      category,
      detail,
      idleSeconds,
    });

    trimActivitySamples(activitySamples, ctx.config.pluginSettings.adminAssist.activityLookbackMinutes);
    const detailLog = detail ? `, detail=${detail}` : "";
    console.log(`[AdminAssist] 活动采样成功：category=${category}${detailLog}, idle=${idleSeconds ?? "unknown"}s, 耗时 ${elapsed}ms`);
  })();

  try {
    await lock.current;
  } finally {
    lock.current = null;
  }
}

async function getRawActivitySnapshot(): Promise<RawActivitySnapshot | null> {
  try {
    const scriptPath = getScriptFilePath();
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
      {
        encoding: "utf8",
        timeout: 20000,
        windowsHide: true,
      }
    );

    const output = stdout.trim();
    if (!output) {
      return null;
    }

    return JSON.parse(output) as RawActivitySnapshot;
  } catch (error) {
    console.error("[AdminAssist] 采集电脑活动失败:", error);
    return null;
  }
}

// ── Steam API ──────────────────────────────────────────────────────────────

type SteamGameData = {
  gameName: string;
  gameId?: string;
};

const steamGameCache = new Map<string, SteamGameData>();
let steamLastFetchAt = 0;
const STEAM_FETCH_INTERVAL_MS = 60_000; // poll Steam API every 60 seconds

async function fetchSteamGames(
  steamApiKey: string,
  steamUserIds: Record<string, string>
): Promise<void> {
  const now = Date.now();
  if (now - steamLastFetchAt < STEAM_FETCH_INTERVAL_MS) return;
  steamLastFetchAt = now;

  for (const [qqId, steamId] of Object.entries(steamUserIds)) {
    if (!steamId) continue;
    try {
      const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${steamApiKey}&steamids=${steamId}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const json = (await response.json()) as {
        response?: {
          players?: Array<{
            gameextrainfo?: string;
            gameid?: string;
          }>;
        };
      };
      const player = json.response?.players?.[0];
      if (player?.gameextrainfo) {
        steamGameCache.set(qqId, {
          gameName: player.gameextrainfo,
          gameId: player.gameid,
        });
      } else {
        steamGameCache.delete(qqId);
      }
    } catch {
      // Steam API failure is non-critical; skip silently
    }
  }
}

function getSteamGameForUser(qqId: string): SteamGameData | undefined {
  return steamGameCache.get(qqId);
}

function summarizeRecentActivity(
  activitySamples: ActivitySample[],
  settings: PluginContext["config"]["pluginSettings"]["adminAssist"],
  lookbackMinutes = settings.activityLookbackMinutes
): string {
  const cutoff = Date.now() - lookbackMinutes * 60 * 1000;
  const recentSamples = activitySamples.filter((sample) => sample.timestamp >= cutoff);

  if (recentSamples.length === 0) {
    return "最近没有可用的本机活动采样记录。";
  }

  const lastSample = recentSamples[recentSamples.length - 1];
  const currentIdleSeconds = lastSample.idleSeconds;
  const appearsAway = currentIdleSeconds !== null && currentIdleSeconds >= settings.awayIdleThresholdSeconds;
  const segments = compressActivitySegments(recentSamples, settings.awayIdleThresholdSeconds);
  const dominantCategories = getDominantCategories(recentSamples, settings.awayIdleThresholdSeconds);

  const lines = [
    appearsAway
      ? `当前判断：管理员可能暂时不在电脑前，最近连续空闲约 ${formatSeconds(currentIdleSeconds)}。`
      : `当前判断：管理员最近仍在电脑前，最近空闲约 ${formatSeconds(currentIdleSeconds)}。`,
    dominantCategories.length > 0
      ? `近 ${lookbackMinutes} 分钟主要活动：${dominantCategories.join("、")}。`
      : `近 ${lookbackMinutes} 分钟主要活动：暂无足够样本判断。`,
    "最近活动轨迹：",
    ...segments.slice(-settings.maxSummarySegments).map((segment) => `- ${formatSegmentRange(segment.start, segment.end)}：${segment.label}`),
    "隐私保护：只保留通用活动类别和空闲时长，不包含窗口标题、文件名、网页地址或聊天内容。",
  ];

  return lines.join("\n");
}

function compressActivitySegments(
  recentSamples: ActivitySample[],
  awayIdleThresholdSeconds: number
): Array<{ start: number; end: number; label: string }> {
  const segments: Array<{ start: number; end: number; label: string }> = [];

  for (const sample of recentSamples) {
    let label: string;
    if (sample.idleSeconds !== null && sample.idleSeconds >= awayIdleThresholdSeconds) {
      label = "暂时离开电脑";
    } else if (sample.detail) {
      label = `${sample.category}（${sample.detail}）`;
    } else {
      label = sample.category;
    }

    const previous = segments[segments.length - 1];
    if (previous && previous.label === label) {
      previous.end = sample.timestamp;
      continue;
    }

    segments.push({
      start: sample.timestamp,
      end: sample.timestamp,
      label,
    });
  }

  return segments;
}

function getDominantCategories(
  recentSamples: ActivitySample[],
  awayIdleThresholdSeconds: number
): string[] {
  const counts = new Map<string, number>();

  for (const sample of recentSamples) {
    if (sample.idleSeconds !== null && sample.idleSeconds >= awayIdleThresholdSeconds) {
      continue;
    }
    const label = sample.detail ? `${sample.category}（${sample.detail}）` : sample.category;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label]) => label);
}

function categorizeProcess(processName: string | undefined): string {
  const normalized = (processName ?? "").trim().toLowerCase();
  if (!normalized) return "未知桌面活动";

  if (["code", "cursor", "windsurf", "idea64", "webstorm64", "pycharm64", "devenv"].includes(normalized)) {
    return "编程开发";
  }
  if (["chrome", "msedge", "firefox", "opera", "brave"].includes(normalized)) {
    return "浏览网页";
  }
  if (["powershell", "pwsh", "cmd", "windowsterminal", "wt"].includes(normalized)) {
    return "终端操作";
  }
  if (["wechat", "qq", "tim", "dingtalk"].includes(normalized)) {
    return "即时沟通";
  }
  if (["winword", "wps", "wpscloudsvr"].includes(normalized)) {
    return "文档编辑";
  }
  if (["excel", "et"].includes(normalized)) {
    return "表格处理";
  }
  if (["powerpnt", "wpp"].includes(normalized)) {
    return "演示文稿";
  }
  if (["explorer", "totalcmd64", "everything"].includes(normalized)) {
    return "文件管理";
  }
  if (["vlc", "mpv", "potplayer64"].includes(normalized)) {
    return "观看媒体";
  }
  if (["obs64", "obs"].includes(normalized)) {
    return "录屏直播";
  }
  if (["steam", "qqgame"].includes(normalized)) {
    return "游戏娱乐";
  }

  return "其他桌面活动";
}

function trimActivitySamples(activitySamples: ActivitySample[], lookbackMinutes: number) {
  const keepMs = Math.max(lookbackMinutes * 2, 30) * 60 * 1000;
  const cutoff = Date.now() - keepMs;

  while (activitySamples.length > 0 && activitySamples[0].timestamp < cutoff) {
    activitySamples.shift();
  }
}

function parseTimestamp(value: string | undefined): number {
  if (!value) {
    return Date.now();
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function normalizeIdleSeconds(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
}

function formatSeconds(value: number | null): string {
  if (value === null) {
    return "未知";
  }
  if (value < 60) {
    return `${value} 秒`;
  }
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

function formatSegmentRange(start: number, end: number): string {
  const startText = new Date(start).toLocaleTimeString("zh-CN", { hour12: false });
  const endText = new Date(end).toLocaleTimeString("zh-CN", { hour12: false });
  return start === end ? startText : `${startText}-${endText}`;
}

function getInputMessageKey(input: PromptBuildInput): string {
  return input.mode === "single"
    ? getMessageKey(input.message)
    : getMessageKey(input.messages[input.messages.length - 1]);
}

function getInputGroupId(input: PromptBuildInput): string | undefined {
  return input.mode === "single"
    ? input.message.groupId
    : input.messages[input.messages.length - 1]?.groupId;
}

function getMessageKey(message: BotMessage): string {
  if (message.id) {
    return `id:${message.id}`;
  }
  return [
    message.type,
    message.groupId ?? "",
    message.userId ?? "",
    message.selfId ?? "",
    message.text,
  ].join("|");
}

async function flushQueuedPrivateMessages(
  incidentKey: string,
  ctx: PluginContext,
  queuedPrivateMessages: Map<string, QueuedPrivateMessage[]>
) {
  const queue = queuedPrivateMessages.get(incidentKey) ?? [];
  for (const item of queue) {
    await ctx.sendMessage({ type: "private", id: item.userId }, item.text);
  }
}

function ensureContext(ctx: PluginContext | null): PluginContext {
  if (!ctx) {
    throw new Error("插件上下文尚未初始化。");
  }
  return ctx;
}

function requireAdmin(input: PromptBuildInput, adminIdSet: Set<string>): void {
  const message = input.mode === "single" ? input.message : input.messages[input.messages.length - 1];
  const userId = message?.userId;
  if (!userId || !adminIdSet.has(userId)) {
    throw new Error("此工具仅限机器人管理员使用，当前发送者不是管理员。");
  }
}

async function resolveSenderLabel(
  onebot: OneBotClient,
  message: BotMessage,
  cache: {
    groupMemberCache: Map<string, CachedValue<{ card?: string; nickname?: string }>>;
  }
): Promise<string> {
  const sender = getRawSender(message);
  const rawDisplayName = normalizeDisplayName(sender.card);
  if (message.userId && rawDisplayName) {
    return formatUserLabel(message.userId, rawDisplayName);
  }

  if (!message.userId) {
    return "@unknown";
  }

  return resolveUserLabel(onebot, message.groupId, message.userId, cache);
}

async function resolveUserLabel(
  onebot: OneBotClient,
  groupId: string | undefined,
  userId: string,
  cache: {
    groupMemberCache: Map<string, CachedValue<{ card?: string; nickname?: string }>>;
  }
): Promise<string> {
  if (groupId) {
    const member = await getCachedMap(
      cache.groupMemberCache,
      `${groupId}:${userId}`,
      async () => {
        const result = await onebot.getGroupMemberInfo(groupId, userId);
        return {
          card: result.card,
          nickname: result.nickname,
        };
      }
    ).catch(() => undefined);

    const displayName = normalizeDisplayName(member?.card);
    if (displayName) {
      return formatUserLabel(userId, displayName);
    }
  }

  return formatMentionFallback(userId);
}

function formatUserLabel(userId: string, displayName: string): string {
  return `${displayName}(${userId})`;
}

function formatMentionFallback(userId: string): string {
  return `@${userId}`;
}

function getRawSender(message: BotMessage): { card?: unknown; nickname?: unknown } {
  if (!message.raw) return {};
  const sender = message.raw.sender;
  if (!sender || typeof sender !== "object") {
    return {};
  }
  return sender as { card?: unknown; nickname?: unknown };
}

function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function getCachedMap<T>(
  cache: Map<string, CachedValue<T>>,
  key: string,
  loader: () => Promise<T>
): Promise<T> {
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) {
    return current.value;
  }

  const value = await loader();
  cache.set(key, {
    value,
    expiresAt: Date.now() + USER_LABEL_CACHE_TTL_MS,
  });
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 必须为非空字符串。`);
  }
  return value;
}

function normalizeUserIdArg(value: unknown, field: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${field} 必须为字符串或数字。`);
  }

  const raw = String(value).trim();
  if (!raw) {
    throw new Error(`${field} 不能为空。`);
  }

  const patterns = [
    /^\[AT:(\d+)]$/i,
    /^\[CQ:at,qq=(\d+)[^\]]*]$/i,
    /^@(\d+)$/,
    /^qq\s*[:：]?\s*(\d+)$/i,
    /^(\d+)$/,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) {
      return match[1];
    }
  }

  throw new Error(`${field} 无法解析为纯 QQ 号，支持格式：123456、@123456、[AT:123456]、[CQ:at,qq=123456]。`);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
