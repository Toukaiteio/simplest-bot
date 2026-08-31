import fs from "node:fs";
import path from "node:path";
import {
  DailyReportRenderer,
  type DailyAffinityDeltaEntry,
  type DailyAffinityEntry,
  type DailyGroupReport,
  type DailyWealthEntry,
} from "../../reporting/daily-report-renderer.js";
import { extractDisplayName, type MessageStore, type MessageStoreRecord } from "../../message-store.js";
import type { DataStorePlugin, MenuPlugin, Plugin, PluginContext } from "../../types.js";
import { MMORPG_RULEBOOK } from "../mmorpg/rulebook.js";
import type { LLMClient } from "../../llm.js";

type ReportState = {
  lastSentDate: string | null;
};

export type DailyReportPlugin = Plugin & {
  runStartupCatchup: (ctx: PluginContext) => Promise<void>;
};

const STATE_FILE = path.resolve(process.cwd(), "data", "daily-reports", "state.json");
const RENTALS_FILE = path.resolve(process.cwd(), "data", "daily-reports", "ad-rentals.json");

type AdRental = {
  userId: string;
  userName: string;
  tag: string;
  text: string;
  date: string;
  groupId: string;
};

function loadAdRentals(): AdRental[] {
  try {
    if (!fs.existsSync(RENTALS_FILE)) return [];
    const raw = fs.readFileSync(RENTALS_FILE, "utf-8");
    return JSON.parse(raw) as AdRental[];
  } catch {
    return [];
  }
}

function saveAdRentals(rentals: AdRental[]): void {
  try {
    fs.mkdirSync(path.dirname(RENTALS_FILE), { recursive: true });
    fs.writeFileSync(RENTALS_FILE, JSON.stringify(rentals, null, 2), "utf-8");
  } catch (error) {
    console.error("[DailyReport] 保存广告租赁数据失败:", error);
  }
}

function addAdRental(groupId: string, rental: AdRental): void {
  const rentals = loadAdRentals();
  rentals.push(rental);
  saveAdRentals(rentals);
}

function getAdRentalsForDate(groupId: string, dateKey: string): AdRental[] {
  const rentals = loadAdRentals();
  return rentals.filter(r => r.groupId === groupId && r.date === dateKey);
}

const MEMBER_LOOKBACK_DAYS = 30;
const RANKING_TOP_N = 8;

type AffinitySnapshot = {
  date: string;
  totals: Record<string, number>;
};

export function createDailyReportPlugin(
  messageStore: MessageStore,
  menuPlugin: MenuPlugin,
  store: DataStorePlugin,
  getLlm?: () => LLMClient | null,
): DailyReportPlugin {
  const renderer = new DailyReportRenderer();
  let timer: NodeJS.Timeout | null = null;

  async function enrichWithLLMEditorial(reports: Map<string, DailyGroupReport>, ctx: PluginContext) {
    if (!getLlm) return;
    const llm = getLlm();
    if (!llm) return;

    const threshold = ctx.config.pluginSettings.dailyReport.minLlmMessageThreshold ?? 10;

    for (const [groupId, report] of reports) {
      if (report.totalMessages < threshold) {
        console.log(`[DailyReport] Group ${groupId} messages count (${report.totalMessages}) is below LLM threshold (${threshold}). Skipping AI Editorial.`);
        continue;
      }
      try {
        const systemPrompt = "你是一位幽默的网络报纸主编。请根据以下群聊统计数据写一段约100字左右的群聊时评/社论。要求语言风趣、精炼，直接输出内容，不要标题，不要加任何排版标记和引号。";
        const userPrompt = `群组: ${groupId}\n总发言: ${report.totalMessages}条\n活跃人数: ${report.activeUsers}人\n今日水王: ${report.topUsers[0]?.userId ?? "无"}\n猫头鹰(熬夜王): ${report.nightOwl ?? "无"}\n表情包达人: ${report.memeKing ?? "无"}\n每日金句: “${report.dailyQuote}” (${report.quoteAuthor})`;
        
        const editorial = await llm.askLlm(systemPrompt, userPrompt);
        if (editorial) {
          report.editorial = editorial.trim();
        }
      } catch (err) {
        console.error("[DailyReport] AI 社论生成失败:", err);
      }
    }
  }

  async function generateForDate(dateKey: string, ctx: PluginContext): Promise<Map<string, DailyGroupReport>> {
    const [dayStart, dayEnd] = getDayRange(dateKey);
    const reports = buildReports(
      messageStore.getRecordsBetween(dayStart, dayEnd),
      dateKey,
      menuPlugin.getPrefix(),
      ctx.config.pluginSettings.dailyReport.topUsersLimit
    );

    enrichWithEconomyRankings(reports, messageStore, store, dateKey);
    
    // Attach ad rentals
    for (const [groupId, report] of reports) {
      const dayRentals = getAdRentalsForDate(groupId, dateKey);
      const ads = dayRentals.map(r => ({ tag: r.tag, text: r.text }));
      
      if (ads.length < 3) {
        ads.push({
          tag: "广告租借",
          text: `发送 ${menuPlugin.getPrefix()}rent-ad [标签] [内容] 即可花费 100 金币租借广告位！`
        });
      }
      if (ads.length < 3) {
        ads.push({
          tag: "如何自定义",
          text: "标签最多 4 字，内容最多 30 字。可写寻人启事、表白或特惠广告。"
        });
      }
      if (ads.length < 3) {
        ads.push({
          tag: "广告说明",
          text: "广告按日计价，展示与今日数据汇总日报同步发布。"
        });
      }
      report.ads = ads.slice(0, 3);
    }

    await enrichWithLLMEditorial(reports, ctx);
    return reports;
  }

  async function sendScheduledReports(dateKey: string, ctx: PluginContext) {
    const reports = await generateForDate(dateKey, ctx);
    if (reports.size === 0) {
      saveState({ lastSentDate: dateKey });
      return;
    }

    for (const [groupId, report] of reports) {
      try {
        const { imagePath } = await renderer.render(report);
        await ctx.sendImage({ type: "group", id: groupId }, imagePath, `${dateKey} 群聊日报`);
      } catch (error) {
        console.error("[DailyReport] 发图失败，回退为文本摘要:", error);
        await ctx.sendMessage({ type: "group", id: groupId }, formatFallbackText(report));
      }
    }

    saveState({ lastSentDate: dateKey });
  }

  function scheduleNext(ctx: PluginContext) {
    if (timer) clearTimeout(timer);
    const nextRunAt = getNextRunAt(ctx.config.pluginSettings.dailyReport.time);
    const delay = Math.max(nextRunAt.getTime() - Date.now(), 1_000);

    console.log(`[DailyReport] 已计划在 ${nextRunAt.toLocaleString()} 生成日报`);
    timer = setTimeout(async () => {
      const reportDateKey = formatDateKey(addDays(nextRunAt, -1));
      await sendScheduledReports(reportDateKey, ctx);
      scheduleNext(ctx);
    }, delay);
  }

  async function catchUpIfNeeded(ctx: PluginContext) {
    const yesterday = formatDateKey(addDays(new Date(), -1));
    const state = loadState();
    if (state.lastSentDate === yesterday) {
      return;
    }

    await sendScheduledReports(yesterday, ctx);
  }

  return {
    name: "daily-report",
    description: "每日 24 点生成群聊小结并以 HTML 截图形式发送",

    async runStartupCatchup(ctx: PluginContext) {
      await catchUpIfNeeded(ctx);
    },

    async onLoad(ctx) {
      scheduleNext(ctx);

      menuPlugin.registerCommand(
        "daily-report",
        `手动生成日报：${menuPlugin.getPrefix()}daily-report [today|yesterday|YYYY-MM-DD]`,
        async (message, args) => {
          const dateKey = resolveDateKeyArg(args[0]);
          const reports = await generateForDate(dateKey, ctx);

          if (message.type === "group" && message.groupId) {
            const report = reports.get(message.groupId);
            if (!report) {
              await ctx.replyText(message, `${dateKey} 这一天当前群没有可生成的日报数据。`);
              return;
            }

            try {
              const { imagePath } = await renderer.render(report);
              await ctx.sendImage({ type: "group", id: message.groupId }, imagePath, `${dateKey} 群聊日报`);
            } catch (error) {
              console.error("[DailyReport] 手动生成截图失败:", error);
              await ctx.replyText(message, formatFallbackText(report));
            }
            return;
          }

          let sentCount = 0;
          for (const [groupId, report] of reports) {
            try {
              const { imagePath } = await renderer.render(report);
              await ctx.sendImage({ type: "group", id: groupId }, imagePath, `${dateKey} 群聊日报`);
            } catch (error) {
              console.error("[DailyReport] 批量手动生成截图失败:", error);
              await ctx.sendMessage({ type: "group", id: groupId }, formatFallbackText(report));
            }
            sentCount += 1;
          }

          await ctx.replyText(message, sentCount > 0 ? `已发送 ${sentCount} 份 ${dateKey} 日报。` : `${dateKey} 没有可发送的日报数据。`);
        },
        { adminOnly: true }
      );

      menuPlugin.registerCommand(
        "rent-ad",
        `租借日报底栏广告位 (100金币/天)：${menuPlugin.getPrefix()}rent-ad [标签] [内容]`,
        async (message, args) => {
          if (!message.groupId) {
            await ctx.replyText(message, "【租借失败】此指令仅限群聊使用。");
            return;
          }

          if (args.length < 2) {
            await ctx.replyText(
              message,
              `【日报广告租借教程】\n` +
                `您可以使用金币租借群日报的底栏广告位，展示与今日数据汇总同步发布！\n` +
                `格式：${menuPlugin.getPrefix()}rent-ad [标签] [广告内容]\n` +
                `价格：100 金币 / 天\n` +
                `限制：标签最多 4 字，内容最多 30 字，当天最多排期 3 条用户广告。\n` +
                `例如：${menuPlugin.getPrefix()}rent-ad 出售 高配电脑急出私聊`
            );
            return;
          }

          const tag = args[0].trim();
          const text = args.slice(1).join(" ").trim();

          if (tag.length > 4) {
            await ctx.replyText(message, "【租借失败】标签字数不能超过 4 个字。");
            return;
          }
          if (text.length > 30) {
            await ctx.replyText(message, "【租借失败】广告内容不能超过 30 个字。");
            return;
          }

          const profile = store.getUserData(message.userId || "");
          if (profile.coins < 100) {
            await ctx.replyText(message, `【租借失败】您的金币不足 100，当前拥有 ${profile.coins} 金币。`);
            return;
          }

          const dateKey = resolveDateKeyArg("today");
          const existing = getAdRentalsForDate(message.groupId, dateKey);
          if (existing.length >= 3) {
            await ctx.replyText(message, `【租借失败】今日 (${dateKey}) 的广告位已满（最多3条），请明天再来租借吧！`);
            return;
          }

          profile.coins -= 100;
          store.saveUserData(message.userId || "", profile);

          const userName = extractDisplayName(message) || message.userId || "群友";
          addAdRental(message.groupId, {
            userId: message.userId || "",
            userName,
            tag,
            text,
            date: dateKey,
            groupId: message.groupId,
          });

          await ctx.replyText(
            message,
            `【租借成功】成功扣除 100 金币。您的广告「${tag} | ${text}」已加入今日 (${dateKey}) 日报排期！`
          );
        }
      );
    },
  };
}

function buildReports(
  records: MessageStoreRecord[],
  dateKey: string,
  commandPrefix: string,
  topUsersLimit: number
): Map<string, DailyGroupReport> {
  const inboundGroupRecords = records.filter(isInboundGroupRecord);
  const replyGroupRecords = records.filter(isReplyGroupRecord);
  const batchReplyGroupRecords = records.filter(isBatchReplyGroupRecord);

  const grouped = new Map<string, {
    messages: Extract<MessageStoreRecord, { kind: "inbound" }>[];
    replies: Extract<MessageStoreRecord, { kind: "reply" }>[];
  }>();

  for (const record of inboundGroupRecords) {
    const groupId = record.message.groupId!;
    const bucket = grouped.get(groupId) ?? { messages: [], replies: [] };
    bucket.messages.push(record);
    grouped.set(groupId, bucket);
  }

  for (const record of replyGroupRecords) {
    const groupId = record.message.groupId!;
    const bucket = grouped.get(groupId) ?? { messages: [], replies: [] };
    bucket.replies.push(record);
    grouped.set(groupId, bucket);
  }

  for (const record of batchReplyGroupRecords) {
    for (const message of record.messages) {
      if (message.type === "group" && message.groupId) {
        const groupId = message.groupId;
        const bucket = grouped.get(groupId) ?? { messages: [], replies: [] };
        bucket.messages.push({
          kind: "inbound",
          timestamp: record.timestamp,
          message,
        });
        grouped.set(groupId, bucket);
      }
    }
    const groupId = record.messages[0]?.groupId;
    if (groupId) {
      const bucket = grouped.get(groupId) ?? { messages: [], replies: [] };
      bucket.replies.push({
        kind: "reply",
        timestamp: record.timestamp,
        message: record.messages[0],
        response: record.response,
      });
      grouped.set(groupId, bucket);
    }
  }

  const reports = new Map<string, DailyGroupReport>();

  for (const [groupId, bucket] of grouped) {
    if (bucket.messages.length === 0) continue;

    const userCounter = new Map<string, number>();
    const displayNames = new Map<string, string>();
    const hourCounter = new Map<number, number>();
    let mentionCount = 0;
    let commandCount = 0;
    let totalLength = 0;

    for (const record of bucket.messages) {
      const userId = record.message.userId || "unknown";
      userCounter.set(userId, (userCounter.get(userId) || 0) + 1);
      const displayName = extractDisplayName(record.message);
      if (displayName) {
        displayNames.set(userId, displayName);
      }

      const hour = new Date(record.timestamp).getHours();
      hourCounter.set(hour, (hourCounter.get(hour) || 0) + 1);

      totalLength += record.message.text.length;
      mentionCount += countMentions(record.message.text);
      if (record.message.text.startsWith(commandPrefix)) {
        commandCount += 1;
      }
    }

    const [busiestHour, busiestHourCount] = Array.from(hourCounter.entries()).sort((a, b) => b[1] - a[1])[0];
    const topUsers = Array.from(userCounter.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topUsersLimit)
      .map(([userId, count]) => ({ userId: displayNames.get(userId) ?? userId, count }));

    const totalMessages = bucket.messages.length;
    const activeUsers = userCounter.size;
    const botReplies = bucket.replies.length;
    const averageLength = totalMessages > 0 ? Math.round(totalLength / totalMessages) : 0;

    const hourBuckets: number[] = Array.from({ length: 24 }, (_, h) => hourCounter.get(h) ?? 0);

    // Find a fun quote: find the longest inbound group message that doesn't start with commandPrefix
    const nonCommandMessages = bucket.messages.filter(
      (record) => !record.message.text.startsWith(commandPrefix) && record.message.text.length > 5 && record.message.text.length < 60
    );
    let dailyQuote = "今天大家都很安静呢，期待明天的精彩发言！";
    let quoteAuthor = "群报编辑部";
    if (nonCommandMessages.length > 0) {
      const sortedByLength = [...nonCommandMessages].sort((a, b) => b.message.text.length - a.message.text.length);
      const candidate = sortedByLength[0];
      dailyQuote = candidate.message.text;
      quoteAuthor = displayNames.get(candidate.message.userId || "") || candidate.message.userId || "神秘群友";
    }

    // Weather forecast based on chat volume
    let weatherText = "多云转阴";
    let tempText = "15°C";
    if (totalMessages > 300) {
      weatherText = "烈日狂欢";
      tempText = "38°C";
    } else if (totalMessages > 100) {
      weatherText = "微风和煦";
      tempText = "24°C";
    }

    // 🦉 深夜猫头鹰 (0:00 - 6:00 发言最多)
    const lateNightUsers = new Map<string, number>();
    // 🖼️ 表情包达人 (包含 CQ:image 消息最多)
    const imageUsers = new Map<string, number>();
    // ⚙️ 指令大师 (发送 commandPrefix 开头消息最多)
    const commandUsers = new Map<string, number>();

    for (const record of bucket.messages) {
      const userId = record.message.userId || "unknown";
      const hour = new Date(record.timestamp).getHours();
      
      if (hour >= 0 && hour < 6) {
        lateNightUsers.set(userId, (lateNightUsers.get(userId) || 0) + 1);
      }
      if (record.message.text.includes("[CQ:image")) {
        imageUsers.set(userId, (imageUsers.get(userId) || 0) + 1);
      }
      if (record.message.text.startsWith(commandPrefix)) {
        commandUsers.set(userId, (commandUsers.get(userId) || 0) + 1);
      }
    }

    let nightOwl = "暂无";
    if (lateNightUsers.size > 0) {
      const sorted = Array.from(lateNightUsers.entries()).sort((a, b) => b[1] - a[1]);
      if (sorted[0][1] > 0) {
        nightOwl = (displayNames.get(sorted[0][0]) ?? sorted[0][0]) + ` (凌晨发言 ${sorted[0][1]} 次)`;
      }
    }

    let memeKing = "暂无";
    if (imageUsers.size > 0) {
      const sorted = Array.from(imageUsers.entries()).sort((a, b) => b[1] - a[1]);
      if (sorted[0][1] > 0) {
        memeKing = (displayNames.get(sorted[0][0]) ?? sorted[0][0]) + ` (发送表情 ${sorted[0][1]} 张)`;
      }
    }

    let commandMaster = "暂无";
    if (commandUsers.size > 0) {
      const sorted = Array.from(commandUsers.entries()).sort((a, b) => b[1] - a[1]);
      if (sorted[0][1] > 0) {
        commandMaster = (displayNames.get(sorted[0][0]) ?? sorted[0][0]) + ` (调用指令 ${sorted[0][1]} 次)`;
      }
    }

    reports.set(groupId, {
      dateKey,
      groupId,
      totalMessages,
      activeUsers,
      botReplies,
      commandCount,
      mentionCount,
      averageLength,
      busiestHour,
      busiestHourCount,
      topUsers,
      hourBuckets,
      insights: buildInsights({
        busiestHour,
        busiestHourCount,
        topUsers,
        botReplies,
        commandCount,
        mentionCount,
        totalMessages,
        activeUsers,
      }),
      dailyQuote,
      quoteAuthor,
      weatherText,
      tempText,
      nightOwl,
      memeKing,
      commandMaster,
    });
  }

  return reports;
}

function buildInsights(input: {
  busiestHour: number;
  busiestHourCount: number;
  topUsers: Array<{ userId: string; count: number }>;
  botReplies: number;
  commandCount: number;
  mentionCount: number;
  totalMessages: number;
  activeUsers: number;
}): string[] {
  const lines = [
    `今天共收到 ${input.totalMessages} 条群消息，活跃成员 ${input.activeUsers} 人。`,
    `最忙时段是 ${String(input.busiestHour).padStart(2, "0")}:00 - ${String(input.busiestHour).padStart(2, "0")}:59，共 ${input.busiestHourCount} 条消息。`,
    `机器人共回复 ${input.botReplies} 次，期间有 ${input.commandCount} 次命令调用、${input.mentionCount} 次 @ 互动。`,
  ];

  if (input.topUsers[0]) {
    lines.splice(1, 0, `${input.topUsers[0].userId} 是今日最活跃成员，发送了 ${input.topUsers[0].count} 条消息。`);
  }

  return lines;
}

function countMentions(text: string): number {
  const matches = text.match(/@\d+/g);
  return matches?.length || 0;
}

function resolveDateKeyArg(value?: string): string {
  if (!value || value === "today") {
    return formatDateKey(new Date());
  }
  if (value === "yesterday") {
    return formatDateKey(addDays(new Date(), -1));
  }
  return value;
}

function getDayRange(dateKey: string): [number, number] {
  const [year, month, day] = dateKey.split("-").map(Number);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return [start.getTime(), end.getTime()];
}

function getNextRunAt(time: string): Date {
  const [hours, minutes] = time.split(":").map(Number);
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);

  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }

  return candidate;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function loadState(): ReportState {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { lastSentDate: null };
    }
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw) as ReportState;
  } catch {
    return { lastSentDate: null };
  }
}

function saveState(state: ReportState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function formatFallbackText(report: DailyGroupReport): string {
  const topUserText = report.topUsers[0]
    ? `今日最活跃：${report.topUsers[0].userId}（${report.topUsers[0].count} 条）`
    : "今日最活跃：暂无";

  return [
    `群聊日报 ${report.dateKey}`,
    `群号：${report.groupId}`,
    `消息数：${report.totalMessages}`,
    `活跃人数：${report.activeUsers}`,
    `机器人回复：${report.botReplies}`,
    `最忙时段：${String(report.busiestHour).padStart(2, "0")}:00 - ${String(report.busiestHour).padStart(2, "0")}:59（${report.busiestHourCount} 条）`,
    topUserText,
  ].join("\n");
}

function isInboundGroupRecord(record: MessageStoreRecord): record is Extract<MessageStoreRecord, { kind: "inbound" }> {
  return record.kind === "inbound" && record.message.type === "group" && Boolean(record.message.groupId);
}

function isReplyGroupRecord(record: MessageStoreRecord): record is Extract<MessageStoreRecord, { kind: "reply" }> {
  return record.kind === "reply" && record.message.type === "group" && Boolean(record.message.groupId);
}

function isBatchReplyGroupRecord(record: MessageStoreRecord): record is Extract<MessageStoreRecord, { kind: "batch_reply" }> {
  return record.kind === "batch_reply" && record.messages.length > 0 && record.messages.some(msg => msg.type === "group" && Boolean(msg.groupId));
}

// ── Economy / affinity rankings ─────────────────────────────────────────────

function snapshotKey(groupId: string): string {
  return `daily-report:snapshot:${groupId}`;
}

function loadSnapshot(messageStore: MessageStore, groupId: string): AffinitySnapshot | null {
  try {
    const raw = messageStore.getContextState(snapshotKey(groupId));
    if (!raw || typeof raw !== "object") return null;
    const s = raw as Partial<AffinitySnapshot>;
    if (!s.date || !s.totals) return null;
    return { date: s.date, totals: s.totals };
  } catch {
    return null;
  }
}

function saveSnapshot(messageStore: MessageStore, groupId: string, snap: AffinitySnapshot): void {
  try {
    messageStore.saveContextState(snapshotKey(groupId), snap);
  } catch (error) {
    console.error(`[DailyReport] 保存好感度快照失败 (${groupId}):`, error);
  }
}

function collectGroupMembers(messageStore: MessageStore, groupId: string, dayEnd: number): Map<string, string> {
  const lookbackStart = dayEnd - MEMBER_LOOKBACK_DAYS * 86400000;
  const records = messageStore.getRecordsBetween(lookbackStart, dayEnd);
  const members = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== "inbound") continue;
    if (record.message.type !== "group" || record.message.groupId !== groupId) continue;
    const uid = record.message.userId;
    if (!uid) continue;
    if (!members.has(uid)) {
      const name = extractDisplayName(record.message) ?? messageStore.getLatestKnownDisplayName(uid, groupId) ?? uid;
      members.set(uid, name);
    }
  }
  return members;
}

function formatRelationName(key: string, members: Map<string, string>): string {
  const [fromId, toId] = key.split(":");
  const fromName = members.get(fromId) ?? fromId;
  if (toId === "ai") {
    return `${fromName} ➜ 机器人`;
  }
  const toName = members.get(toId) ?? toId;
  return `${fromName} ➜ ${toName}`;
}

function enrichWithEconomyRankings(
  reports: Map<string, DailyGroupReport>,
  messageStore: MessageStore,
  store: DataStorePlugin,
  dateKey: string,
): void {
  const [, dayEnd] = getDayRange(dateKey);
  const allEntries = store.getAllUserEntries();
  const profileMap = new Map(allEntries.map((e) => [e.userId, e.profile]));

  for (const [groupId, report] of reports) {
    const members = collectGroupMembers(messageStore, groupId, dayEnd);
    if (members.size === 0) continue;

    const todayTotals: Record<string, number> = {};
    for (const [uid] of members) {
      const profile = profileMap.get(uid);
      if (profile) {
        // AI affinity
        todayTotals[uid + ":ai"] = profile.affinity.ai;
        
        // User-to-user affinities within the group
        for (const [targetUid, val] of Object.entries(profile.affinity.users || {})) {
          if (members.has(targetUid)) {
            todayTotals[uid + ":" + targetUid] = val;
          }
        }
      }
    }

    const prev = loadSnapshot(messageStore, groupId);

    // Affinity delta ranking (sort by abs delta, then by positive value)
    if (prev) {
      const deltas: DailyAffinityDeltaEntry[] = [];
      for (const [key, current] of Object.entries(todayTotals)) {
        let previous = prev.totals[key];
        // Migration fallback for old snapshots
        if (previous === undefined) {
          const [fromId, toId] = key.split(":");
          if (toId === "ai") {
            previous = prev.totals[fromId] ?? 0;
          } else {
            previous = 0;
          }
        }

        const delta = current - previous;
        if (delta === 0) continue;
        const [fromId] = key.split(":");
        deltas.push({
          userId: fromId,
          name: formatRelationName(key, members),
          delta,
          current,
        });
      }
      deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      report.affinityDeltaTop = deltas.slice(0, RANKING_TOP_N);
    } else {
      report.affinityDeltaTop = [];
    }

    // Affinity total ranking
    const totals: DailyAffinityEntry[] = [];
    for (const [key, value] of Object.entries(todayTotals)) {
      if (value <= 0) continue;
      const percent = Math.max(
        0,
        Math.min(100, Math.round((value / MMORPG_RULEBOOK.social.maxAffinity) * 100)),
      );
      const [fromId] = key.split(":");
      totals.push({
        userId: fromId,
        name: formatRelationName(key, members),
        value,
        percent,
      });
    }
    totals.sort((a, b) => b.value - a.value);
    report.affinityTop = totals.slice(0, RANKING_TOP_N);

    // Wealth ranking
    const wealth: DailyWealthEntry[] = [];
    for (const [uid, name] of members) {
      const profile = profileMap.get(uid);
      if (!profile || profile.coins <= 0) continue;
      wealth.push({ userId: uid, name, coins: profile.coins });
    }
    wealth.sort((a, b) => b.coins - a.coins);
    report.wealthTop = wealth.slice(0, RANKING_TOP_N);

    // Save today's snapshot for tomorrow's delta
    saveSnapshot(messageStore, groupId, { date: dateKey, totals: todayTotals });
  }
}
