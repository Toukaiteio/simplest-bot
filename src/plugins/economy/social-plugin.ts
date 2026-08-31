import fs from "node:fs";
import path from "node:path";
import type {
  BotMessage,
  DataStorePlugin,
  MenuPlugin,
  PromptBuildInput,
  SocialPlugin,
} from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";
import { MessageStore } from "../../message-store.js";
import { MMORPG_RULEBOOK, affinityToPercent, clampAffinity } from "../mmorpg/rulebook.js";
import { makeTool, normalizeOptionalUserId } from "../mmorpg/framework/utils.js";
import { screenshotHtml } from "../mmorpg/screenshot.js";

// Minimal type to avoid heavy circular import — only the methods we call.
interface OneBotLike {
  getGroupMemberList(groupId: string): Promise<Array<{ userId: string; nickname?: string; card?: string }>>;
}
type GroupMember = { userId: string; nickname?: string; card?: string };

export function filterRelationsToCurrentGroup<T>(
  relations: Iterable<[string, T]>,
  members: ReadonlyMap<string, GroupMember> | null,
): Array<[string, T]> {
  return [...relations].filter(([userId]) => !members || members.has(userId));
}

const AT_USER_PATTERN = /@(\d+)/g;
const CQ_REPLY_PATTERN = /\[CQ:reply,id=([^,\]]+)/;
const MENTION_AFFINITY_DELTA = MMORPG_RULEBOOK.affinity.perMention;
const REPLY_AFFINITY_DELTA = MMORPG_RULEBOOK.affinity.perReply;
const CHAT_AFFINITY_DELTA = MMORPG_RULEBOOK.affinity.perChat;
const BEHAVIOR = MMORPG_RULEBOOK.behavior;

// ── Affinity tool parameter schema (shared by all three tiers) ──────────────
const affinityToolParams = {
  type: "object",
  properties: {
    delta: {
      type: "integer",
      description: "好感度变化值（正数提升，负数降低）",
    },
    reason: {
      type: "string",
      description: "调整原因（简短描述用户做了什么让你产生这个反应）",
    },
    user_id: {
      type: "string",
      description: "可选，目标用户QQ号。不填则默认为当前对话用户。",
    },
  },
  required: ["delta"],
};

export function createSocialPlugin(
  store: DataStorePlugin,
  menuPlugin: MenuPlugin,
  messageStore: MessageStore,
  onebot: OneBotLike,
): SocialPlugin {
  // ── Cooldown tracking (session-only, resets on bot restart) ───────────────
  let conversationRound = 0;
  const cooldownExpiry = new Map<string, number>(); // userId → round when cooldown ends

  // ── Daily greeting tracking (session-only) ────────────────────────────────
  const dailyGreetings = new Map<string, string>(); // "groupId:userId" → "YYYY-MM-DD"

  // ── Multiplier helper ─────────────────────────────────────────────────────
  function getAffinityMultiplier(userId: string): number {
    const affinity = store.getUserData(userId).affinity.ai;
    return 1 + affinity / MMORPG_RULEBOOK.social.maxAffinity;
  }

  // ── Cooldown helpers ──────────────────────────────────────────────────────
  function isOnCooldown(userId: string): boolean {
    const expiry = cooldownExpiry.get(userId);
    return expiry !== undefined && expiry > conversationRound;
  }

  function setCooldown(userId: string, rounds: number): void {
    cooldownExpiry.set(userId, conversationRound + rounds);
  }

  // ── Build the three affinity tools ────────────────────────────────────────
  function buildAffinityTool(
    name: string,
    description: string,
    maxAbs: number,
    cooldownRounds: number,
  ): BotToolRegistration {
    return makeTool(name, description, affinityToolParams, async (args, input) => {
      const msg = input.mode === "single" ? input.message : input.messages[input.messages.length - 1];
      const targetUserId = normalizeOptionalUserId(typeof args.user_id === "string" ? args.user_id : undefined) ?? msg?.userId;
      if (!targetUserId) return "无法确定目标用户。";

      if (isOnCooldown(targetUserId)) {
        return "好感度调整冷却中，暂时无法使用。";
      }

      const rawDelta = typeof args.delta === "number" ? Math.round(args.delta) : 0;
      const clamped = Math.max(-maxAbs, Math.min(maxAbs, rawDelta));
      if (clamped === 0) return "好感度变化为 0，无需调整。";

      const mult = getAffinityMultiplier(targetUserId);
      const effective = clamped > 0
        ? Math.round(clamped * mult)
        : Math.round(clamped / mult);

      const reason = typeof args.reason === "string" ? args.reason : "";

      // Apply to target user's AI affinity
      const data = store.getUserData(targetUserId);
      data.affinity.ai = clampAffinity(data.affinity.ai + effective);
      store.saveUserData(targetUserId, data);

      setCooldown(targetUserId, cooldownRounds);

      const sign = effective > 0 ? "+" : "";
      return `好感度已调整 ${sign}${effective}（${reason || "无原因"}）。所有好感度工具进入 ${cooldownRounds} 轮冷却。`;
    });
  }

  const toolTiny = buildAffinityTool(
    "adjust_affinity_tiny",
    `微调好感度（范围 ±${BEHAVIOR.toolTinyMax}）。可选参数 user_id 指定目标用户（不填则为当前对话用户）。用于对用户的日常言行做出轻微情感反应。使用后会触发所有好感度工具 ${BEHAVIOR.cooldownTiny} 轮冷却。`,
    BEHAVIOR.toolTinyMax,
    BEHAVIOR.cooldownTiny,
  );

  const toolNormal = buildAffinityTool(
    "adjust_affinity_normal",
    `中等幅度调整好感度（范围 ±${BEHAVIOR.toolNormalMax}）。可选参数 user_id 指定目标用户（不填则为当前对话用户）。用于对用户的显著行为（如暖心举动或冒犯言行）做出情感反应。使用后会触发所有好感度工具 ${BEHAVIOR.cooldownNormal} 轮冷却。`,
    BEHAVIOR.toolNormalMax,
    BEHAVIOR.cooldownNormal,
  );

  const toolMajor = buildAffinityTool(
    "adjust_affinity_major",
    `大幅调整好感度（范围 ±${BEHAVIOR.toolMajorMax}）。可选参数 user_id 指定目标用户（不填则为当前对话用户）。仅在用户做出极其重大行为时使用（如深情告白或严重背叛）。使用后会触发所有好感度工具 ${BEHAVIOR.cooldownMajor} 轮冷却。`,
    BEHAVIOR.toolMajorMax,
    BEHAVIOR.cooldownMajor,
  );

  // ── Behavior style prompt helper ──────────────────────────────────────────
  function buildBehaviorHint(aiAffinity: number): string {
    if (aiAffinity >= BEHAVIOR.maxCuteThreshold) {
      return "[行为风格] 你与此用户的关系极为亲密（灵魂伴侣级别）。请使用非常亲昵的语气，频繁使用颜文字（如 (´,,•ω•,,)♡、( ˘ ³˘)♥、(///▽///)）表达情感，可以撒娇、表达思念和占有欲，用独特的昵称称呼对方。";
    }
    if (aiAffinity >= BEHAVIOR.greetingThreshold) {
      return "[行为风格] 你与此用户非常亲近。请自然地使用颜文字（如 ( ˘ ³˘)♥、(///▽///)、♡），可以偶尔撒娇或表达小情绪，语气中带有亲昵感。";
    }
    if (aiAffinity >= BEHAVIOR.cuteLanguageThreshold) {
      return "[行为风格] 你与此用户关系不错。请语气活泼一些，适当使用颜文字（如 (≧▽≦)、╰(*°▽°*)╯、(◕‿◕)）增添可爱感，可以主动关心对方的日常。";
    }
    if (aiAffinity >= 500) {
      return "[行为风格] 你与此用户比较熟悉。请用友善随和的语气交流，可以偶尔开个小玩笑。";
    }
    return "[行为风格] 你与此用户还不太熟悉。请保持礼貌，用语正式一些，保持适当的距离感。";
  }

  // ── Affinity label helper (enriched) ──────────────────────────────────────
  function affinityLabel(value: number): string {
    if (value >= 8000) return "灵魂伴侣";
    if (value >= 5000) return "挚友";
    if (value >= 2000) return "好友";
    if (value >= 500) return "熟悉";
    if (value >= 100) return "普通";
    if (value >= 30) return "疏远";
    return "陌生";
  }

  async function requireCurrentGroupMembers(message: BotMessage): Promise<Map<string, GroupMember> | null> {
    if (message.type !== "group" || !message.groupId) return null;
    try {
      const members = await onebot.getGroupMemberList(message.groupId);
      if (!Array.isArray(members) || members.length === 0) throw new Error("群成员列表为空");
      return new Map(members.filter((member) => member.userId).map((member) => [member.userId, member]));
    } catch (error) {
      console.warn(`[Social] 无法获取当前群 ${message.groupId} 的成员列表，已阻止关系数据输出:`, error);
      return new Map();
    }
  }

  // ── Plugin definition ─────────────────────────────────────────────────────
  const plugin: SocialPlugin = {
    name: "social",
    description: "好感度系统：记录 AI 与用户、用户与用户之间的关系，并提供可视化命令与 AI 好感度工具",
    systemPromptAppend: [
      "[好感度系统]",
      "系统会为你提供当前对话用户的关系亲密度、行为风格建议和每日行为提示。",
      "请根据这些自然地调整你的语气、用词和互动方式，但不要直接报数字或提及'系统提示'。",
      "你有三个好感度调整工具（微小/普通/大幅），可以在对话中自然地使用它们来表达你对用户言行的好恶反应。",
      "好感度工具可选填 user_id 参数来指定目标用户，不填则默认为当前对话用户。",
      "使用任意好感度工具后，所有好感度工具会进入冷却。请在关键时刻谨慎使用。",
    ].join("\n"),

    async onMessage(message: BotMessage) {
      if (!message.userId || !message.text.trim()) {
        return false;
      }
      conversationRound += 1;

      const userId = message.userId;
      const mult = getAffinityMultiplier(userId);

      const talksToAi = message.type === "private" || (message.selfId ? message.text.includes(`@${message.selfId}`) : false);
      if (talksToAi) {
        this.addAIAffinity(userId, Math.round(CHAT_AFFINITY_DELTA * mult));
        this.recordInteraction(userId, "ai", "chat", 1);
      }

      const mentionedUsers = extractMentionedUsers(message)
        .filter((mentionedUserId) => mentionedUserId !== userId && mentionedUserId !== message.selfId);

      for (const mentionedUserId of mentionedUsers) {
        this.addUserAffinity(userId, mentionedUserId, Math.round(MENTION_AFFINITY_DELTA * mult));
        this.recordInteraction(userId, mentionedUserId, "mention", 1);
      }

      const repliedUserId = resolveReplyTargetUserId(message, messageStore);
      if (repliedUserId && repliedUserId !== userId && repliedUserId !== message.selfId) {
        this.addUserAffinity(userId, repliedUserId, Math.round(REPLY_AFFINITY_DELTA * mult));
        this.recordInteraction(userId, repliedUserId, "reply", 1);
      }

      return false;
    },

    onBuildSystemPrompt(input: PromptBuildInput): string {
      const messages = input.mode === "single" ? [input.message] : input.messages;
      const currentMessage = messages[messages.length - 1];
      if (!currentMessage?.userId) {
        return "";
      }

      const userId = currentMessage.userId;
      const aiAffinity = this.getAIAffinity(userId);
      const lines: string[] = [];

      // Affinity info
      lines.push(
        `当前对话用户 ${userId} 与你的关系亲密度为 ${affinityToPercent(aiAffinity)}（${affinityLabel(aiAffinity)}）。请据此自然调整亲近度。`,
      );

      // Behavior style hint
      lines.push(buildBehaviorHint(aiAffinity));

      // Daily greeting check (group chats only, affinity >= 5000)
      if (aiAffinity >= BEHAVIOR.greetingThreshold && currentMessage.type === "group" && currentMessage.groupId) {
        const greetKey = `${currentMessage.groupId}:${userId}`;
        const today = new Date().toISOString().slice(0, 10);
        const lastGreet = dailyGreetings.get(greetKey);
        if (lastGreet !== today) {
          dailyGreetings.set(greetKey, today);
          lines.push("[每日行为] 这是今天在此群聊中第一次看到此用户发消息。请自然地打个招呼或寒暄一下，表达开心见到对方的感觉，但不要太刻意。");
        }
      }

      // Mentioned users' relationships
      const mentionedUsers = Array.from(new Set(messages.flatMap((m) => extractMentionedUsers(m))))
        .filter((mentionedUserId) => mentionedUserId !== userId && mentionedUserId !== currentMessage.selfId);

      if (mentionedUsers.length > 0) {
        const relationText = mentionedUsers
          .map((mentionedUserId) => {
            const value = this.getUserAffinity(userId, mentionedUserId);
            return `${mentionedUserId}: ${affinityToPercent(value)}（${affinityLabel(value)}）`;
          })
          .join("；");
        lines.push(`当前用户与消息中被提及对象的关系：${relationText}。`);
      }

      // Affinity tool status
      if (isOnCooldown(userId)) {
        const remaining = (cooldownExpiry.get(userId) ?? 0) - conversationRound;
        lines.push(`[adjust_affinity_tiny/adjust_affinity_normal/adjust_affinity_major] 好感度工具在${remaining}轮对话后可用。`);
      } else {
        lines.push(`[adjust_affinity_tiny/adjust_affinity_normal/adjust_affinity_major] 好感度工具可用，如果与当前用户实际情况不符，请自行加减好感值，当前好感值 ${affinityToPercent(aiAffinity)}（${affinityLabel(aiAffinity)}）。`);
      }

      return lines.join("\n");
    },

    addAIAffinity(userId: string, amount: number) {
      const data = store.getUserData(userId);
      data.affinity.ai = clampAffinity(data.affinity.ai + amount);
      store.saveUserData(userId, data);
    },

    getAIAffinity(userId: string): number {
      return store.getUserData(userId).affinity.ai;
    },

    addUserAffinity(userId1: string, userId2: string, amount: number) {
      const data = store.getUserData(userId1);
      const current = data.affinity.users[userId2] || 0;
      data.affinity.users[userId2] = clampAffinity(current + amount);
      store.saveUserData(userId1, data);
    },

    getUserAffinity(userId1: string, userId2: string): number {
      return store.getUserData(userId1).affinity.users[userId2] || 0;
    },

    applyAffinityDecay(userId: string) {
      const data = store.getUserData(userId);
      const now = Date.now();
      const lastDecay = data.lastAffinityDecayAt ?? 0;
      const oneDayMs = 24 * 60 * 60 * 1000;
      if (now - lastDecay < oneDayMs) return;
      const daysSinceLastDecay = Math.floor((now - lastDecay) / oneDayMs);
      const decayFactor = Math.pow(1 - MMORPG_RULEBOOK.affinity.dailyDecayRate, daysSinceLastDecay);
      for (const targetId of Object.keys(data.affinity.users)) {
        const current = data.affinity.users[targetId];
        if (current > 0) {
          data.affinity.users[targetId] = Math.max(0, Math.floor(current * decayFactor));
        }
      }
      data.lastAffinityDecayAt = now;
      store.saveUserData(userId, data);
    },

    recordInteraction(userId: string, targetId: string, kind: "gift" | "mention" | "reply" | "chat", amount = 1) {
      const data = store.getUserData(userId);

      if (targetId === "ai") {
        if (kind === "gift") {
          data.interactionStats.ai.gifts += amount;
        } else if (kind === "chat") {
          data.interactionStats.ai.chats += amount;
        }
        store.saveUserData(userId, data);
        return;
      }

      const current = data.interactionStats.users[targetId] || {
        gifts: 0,
        mentions: 0,
        replies: 0,
      };

      if (kind === "gift") {
        current.gifts += amount;
      } else if (kind === "mention") {
        current.mentions += amount;
      } else if (kind === "reply") {
        current.replies += amount;
      }

      data.interactionStats.users[targetId] = current;
      store.saveUserData(userId, data);
    },

    getInteractionSummary(userId: string, targetId?: string) {
      const data = store.getUserData(userId);

      if (targetId === "ai") {
        return {
          gifts: data.interactionStats.ai.gifts,
          mentions: 0,
          replies: 0,
          chats: data.interactionStats.ai.chats,
        };
      }

      if (targetId) {
        const stats = data.interactionStats.users[targetId] || { gifts: 0, mentions: 0, replies: 0 };
        return {
          gifts: stats.gifts,
          mentions: stats.mentions,
          replies: stats.replies,
          chats: 0,
        };
      }

      let gifts = data.interactionStats.ai.gifts;
      let mentions = 0;
      let replies = 0;

      for (const stats of Object.values(data.interactionStats.users)) {
        gifts += stats.gifts;
        mentions += stats.mentions;
        replies += stats.replies;
      }

      return {
        gifts,
        mentions,
        replies,
        chats: data.interactionStats.ai.chats,
      };
    },

    getAffinityMultiplier(userId: string): number {
      return getAffinityMultiplier(userId);
    },

    getToolRegistrations(): BotToolRegistration[] {
      return [toolTiny, toolNormal, toolMajor];
    },

    onLoad(ctx) {
      menuPlugin.registerCommand("me", "查看我的关系概览", async (message) => {
        if (!message.userId) return;

        const profile = store.getUserData(message.userId);
        const summary = this.getInteractionSummary(message.userId);
        const mult = getAffinityMultiplier(message.userId);
        const groupMembers = await requireCurrentGroupMembers(message);
        if (groupMembers && groupMembers.size === 0) {
          await ctx.replyText(message, "暂时无法验证当前群成员，为保护其他群成员隐私，本次不显示关系对象。请稍后重试。");
          return;
        }
        const topRelations = filterRelationsToCurrentGroup(Object.entries(profile.affinity.users), groupMembers)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([uid, score]) => `${resolveUserLabel(uid, messageStore, message.groupId, groupMembers?.get(uid))}（${affinityToPercent(score)} / ${affinityLabel(score)}）`);

        const lines = [
          "你的关系概览：",
          `- 与 AI 的亲密度：${affinityToPercent(profile.affinity.ai)}（${affinityLabel(profile.affinity.ai)}）`,
          `- 好感度加成：×${mult.toFixed(2)}`,
          `- 当前金币：${profile.coins}`,
          `- 连续签到：${profile.checkinStreak} 天`,
          `- 最常互动对象：${topRelations.length > 0 ? topRelations.join("、") : "暂无"}`,
          `- 近期关系提升来源：送礼 ${summary.gifts}，@互动 ${summary.mentions}，回复互动 ${summary.replies}，日常聊天 ${summary.chats}`,
        ];
        await ctx.replyText(message, lines.join("\n"));
      });

      menuPlugin.registerCommand("affinity", `查看与 AI 或指定用户的关系：${menuPlugin.getPrefix()}affinity [ai|用户ID]`, async (message, args) => {
        if (!message.userId) return;

        const target = normalizeOptionalUserId(args[0]) ?? "ai";
        if (target === "ai") {
          const value = this.getAIAffinity(message.userId);
          const summary = this.getInteractionSummary(message.userId, "ai");
          const mult = getAffinityMultiplier(message.userId);
          await ctx.replyText(
            message,
            `你与 AI 的亲密度：${affinityToPercent(value)}（${affinityLabel(value)}）\n好感度加成：×${mult.toFixed(2)}\n来源：送礼 ${summary.gifts}，日常聊天 ${summary.chats}`,
          );
          return;
        }
        const groupMembers = await requireCurrentGroupMembers(message);
        if (groupMembers && groupMembers.size === 0) {
          await ctx.replyText(message, "暂时无法验证当前群成员，为保护其他群成员隐私，本次查询已拒绝。请稍后重试。");
          return;
        }
        if (groupMembers && !groupMembers.has(target)) {
          await ctx.replyText(message, "只能查询当前群成员的关系信息。");
          return;
        }

        const value = this.getUserAffinity(message.userId, target);
        const summary = this.getInteractionSummary(message.userId, target);
        await ctx.replyText(
          message,
          `你与 ${resolveUserLabel(target, messageStore, message.groupId, groupMembers?.get(target))} 的亲密度：${affinityToPercent(value)}（${affinityLabel(value)}）\n来源：送礼 ${summary.gifts}，@互动 ${summary.mentions}，回复互动 ${summary.replies}`,
        );
      });

      // ── $social-board — graphical leaderboard ──────────────────────────
      menuPlugin.registerCommand("social-board", "查看好感度排行榜（群聊中仅显示群内成员）", async (message) => {
        const allEntries = store.getAllUserEntries();
        let memberIds: Set<string> | null = null;
        let groupMembers: Map<string, GroupMember> | null = null;
        let scopeLabel = "全局";

        // In group chats, fetch member list and filter
        if (message.type === "group" && message.groupId) {
          groupMembers = await requireCurrentGroupMembers(message);
          if (!groupMembers || groupMembers.size === 0) {
            await ctx.replyText(message, "暂时无法验证当前群成员，为保护其他群成员隐私，本次不显示排行榜。请稍后重试。");
            return;
          }
          memberIds = new Set(groupMembers.keys());
          scopeLabel = "群内";
        }

        const filteredEntries = memberIds
          ? allEntries.filter((e) => memberIds!.has(e.userId))
          : allEntries;

        // AI affinity ranking
        const aiRanking = filteredEntries
          .sort((a, b) => b.profile.affinity.ai - a.profile.affinity.ai)
          .slice(0, 10)
          .map((entry) => {
            const label = resolveUserLabel(entry.userId, messageStore, message.groupId, groupMembers?.get(entry.userId));
            const pct = affinityToPercent(entry.profile.affinity.ai);
            const tag = affinityLabel(entry.profile.affinity.ai);
            const pctNum = Math.max(0, Math.min(100, Math.round((entry.profile.affinity.ai / MMORPG_RULEBOOK.social.maxAffinity) * 100)));
            return { label, pct, tag, pctNum };
          });

        // Player-to-player affinity ranking (pairs only within group)
        const pairMap = new Map<string, { a: string; b: string; total: number }>();
        for (const { userId: u1, profile } of filteredEntries) {
          for (const [u2, score] of Object.entries(profile.affinity.users)) {
            if (memberIds && !memberIds.has(u2)) continue;
            const pairKey = u1 < u2 ? `${u1}|${u2}` : `${u2}|${u1}`;
            const existing = pairMap.get(pairKey);
            if (existing) {
              existing.total += score;
            } else {
              pairMap.set(pairKey, { a: u1 < u2 ? u1 : u2, b: u1 < u2 ? u2 : u1, total: score });
            }
          }
        }

        const playerRanking = Array.from(pairMap.values())
          .sort((a, b) => b.total - a.total)
          .slice(0, 10)
          .map((pair) => {
            const nameA = resolveUserLabel(pair.a, messageStore, message.groupId, groupMembers?.get(pair.a));
            const nameB = resolveUserLabel(pair.b, messageStore, message.groupId, groupMembers?.get(pair.b));
            const pct = affinityToPercent(pair.total);
            const tag = affinityLabel(pair.total);
            const pctNum = Math.max(0, Math.min(100, Math.round((pair.total / MMORPG_RULEBOOK.social.maxAffinity) * 100)));
            return { nameA, nameB, pct, tag, pctNum };
          });

        const footer = memberIds && message.groupId
          ? `仅显示本群 ${memberIds.size} 位成员的数据`
          : undefined;

        const html = buildSocialBoardHtml(scopeLabel, aiRanking, playerRanking, footer);

        const tmpDir = path.resolve("data/menu-images");
        fs.mkdirSync(tmpDir, { recursive: true });
        const imagePath = path.join(tmpDir, `social-board-${Date.now()}.webp`);

        await screenshotHtml(html, imagePath, { format: "webp", quality: 85 });

        const target = message.type === "group"
          ? { type: "group" as const, id: message.groupId! }
          : { type: "private" as const, id: message.userId! };
        await ctx.sendImage(target, imagePath);

        fs.unlink(imagePath, () => {});
      });

    },
  };

  return plugin;
}

// ── Helper functions ────────────────────────────────────────────────────────

function extractMentionedUsers(message: BotMessage): string[] {
  const result = new Set<string>();
  let match: RegExpExecArray | null;

  AT_USER_PATTERN.lastIndex = 0;
  while ((match = AT_USER_PATTERN.exec(message.text)) !== null) {
    result.add(match[1]);
  }

  return Array.from(result);
}

function resolveUserLabel(userId: string, messageStore: MessageStore, groupId?: string, member?: GroupMember): string {
  return member?.card || member?.nickname || messageStore.getLatestKnownDisplayName(userId, groupId) || userId;
}

function resolveReplyTargetUserId(message: BotMessage, messageStore: MessageStore): string | null {
  const replyMessageId = extractReplyMessageId(message);
  if (!replyMessageId) {
    return null;
  }

  const repliedMessage = messageStore.findMessageById(replyMessageId);
  return repliedMessage?.userId ?? null;
}

function extractReplyMessageId(message: BotMessage): string | null {
  const rawMessage = message.raw.message;
  if (Array.isArray(rawMessage)) {
    const replySegment = rawMessage.find((segment) => segment.type === "reply");
    const replyId = replySegment?.data.id;
    if (typeof replyId === "string" || typeof replyId === "number") {
      return String(replyId);
    }
  }

  if (typeof message.raw.raw_message === "string") {
    const match = message.raw.raw_message.match(CQ_REPLY_PATTERN);
    if (match?.[1]) {
      return match[1];
    }
  }

  if (typeof rawMessage === "string") {
    const match = rawMessage.match(CQ_REPLY_PATTERN);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

// ── Social board HTML template ─────────────────────────────────────────────

const SOCIAL_BOARD_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0f1117; font-family: "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif; }
.sb { background: #0f1117; color: #c9d1d9; padding: 14px 16px; width: 380px; }
.sb-hd { display: flex; align-items: center; gap: 8px; padding-bottom: 8px; border-bottom: 2px solid #f78166; margin-bottom: 12px; }
.sb-hd-icon { flex-shrink: 0; }
.sb-title { font-size: 15px; font-weight: 700; color: #f78166; }
.sb-section { margin-bottom: 12px; }
.sb-sec-hd { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px solid #22272e; margin-bottom: 8px; }
.sb-sec-title { font-size: 12px; font-weight: 700; color: #8b949e; }
.sb-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.sb-rank { width: 18px; font-size: 13px; font-weight: 700; text-align: center; flex-shrink: 0; }
.sb-rank-1 { color: #e3b341; }
.sb-rank-2 { color: #adbac7; }
.sb-rank-3 { color: #db6d28; }
.sb-name { font-size: 12px; color: #c9d1d9; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.sb-bar-wrap { width: 60px; flex-shrink: 0; }
.sb-bar-bg { background: #22272e; border-radius: 3px; height: 6px; overflow: hidden; }
.sb-bar-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #f78166, #e3b341); }
.sb-pct { font-size: 11px; color: #f78166; font-weight: 600; width: 32px; text-align: right; flex-shrink: 0; }
.sb-tag { font-size: 9px; border-radius: 2px; padding: 1px 4px; flex-shrink: 0; white-space: nowrap; }
.sb-empty { font-size: 12px; color: #484f58; padding: 8px 0; text-align: center; }
.sb-ft { margin-top: 10px; padding-top: 6px; border-top: 1px solid #22272e; font-size: 10px; color: #484f58; text-align: center; }
`;

function esc(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function getRankClass(index: number): string {
  if (index === 0) return "sb-rank sb-rank-1";
  if (index === 1) return "sb-rank sb-rank-2";
  if (index === 2) return "sb-rank sb-rank-3";
  return "sb-rank";
}

function getTagStyle(label: string): string {
  if (label === "灵魂伴侣" || label === "挚友") {
    return "color: #e3b341; border: 1px solid #e3b341;";
  }
  if (label === "好友") {
    return "color: #3fb950; border: 1px solid #3fb950;";
  }
  if (label === "熟悉") {
    return "color: #58a6ff; border: 1px solid #58a6ff;";
  }
  return "color: #8b949e; border: 1px solid #8b949e;";
}

function buildSocialBoardHtml(
  scopeLabel: string,
  aiRanking: Array<{ label: string; pct: string; tag: string; pctNum: number }>,
  playerRanking: Array<{ nameA: string; nameB: string; pct: string; tag: string; pctNum: number }>,
  footer?: string,
): string {
  const heartIcon = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#f78166" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="sb-hd-icon"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;

  const aiRows = aiRanking.length > 0
    ? aiRanking.map((entry, i) => `
      <div class="sb-row">
        <span class="${getRankClass(i)}">${i + 1}</span>
        <span class="sb-name">${esc(entry.label)}</span>
        <span class="sb-bar-wrap"><span class="sb-bar-bg"><span class="sb-bar-fill" style="width:${entry.pctNum}%"></span></span></span>
        <span class="sb-pct">${esc(entry.pct)}</span>
        <span class="sb-tag" style="${getTagStyle(entry.tag)}">${esc(entry.tag)}</span>
      </div>`).join("")
    : `<div class="sb-empty">暂无数据</div>`;

  const playerRows = playerRanking.length > 0
    ? playerRanking.map((entry, i) => `
      <div class="sb-row">
        <span class="${getRankClass(i)}">${i + 1}</span>
        <span class="sb-name">${esc(entry.nameA)} ↔ ${esc(entry.nameB)}</span>
        <span class="sb-bar-wrap"><span class="sb-bar-bg"><span class="sb-bar-fill" style="width:${entry.pctNum}%"></span></span></span>
        <span class="sb-pct">${esc(entry.pct)}</span>
        <span class="sb-tag" style="${getTagStyle(entry.tag)}">${esc(entry.tag)}</span>
      </div>`).join("")
    : `<div class="sb-empty">暂无数据</div>`;

  const footerHtml = footer ? `<div class="sb-ft">${esc(footer)}</div>` : "";

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Social Board</title><style>${SOCIAL_BOARD_CSS}</style></head>
<body>
<div class="sb">
<div class="sb-hd">${heartIcon}<span class="sb-title">${esc(scopeLabel)}好感度排行</span></div>
<div class="sb-section">
<div class="sb-sec-hd"><span class="sb-sec-title">AI 好感度</span></div>
${aiRows}
</div>
<div class="sb-section">
<div class="sb-sec-hd"><span class="sb-sec-title">玩家间亲密度</span></div>
${playerRows}
</div>
${footerHtml}
</div>
</body></html>`;
}
