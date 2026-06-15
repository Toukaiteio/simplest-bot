import fs from "node:fs";
import path from "node:path";
import { DailyReportRenderer, type DailyGroupReport } from "../../reporting/daily-report-renderer.js";
import { extractDisplayName, type MessageStore, type MessageStoreRecord } from "../../message-store.js";
import type { MenuPlugin, Plugin, PluginContext } from "../../types.js";

type ReportState = {
  lastSentDate: string | null;
};

export type DailyReportPlugin = Plugin & {
  runStartupCatchup: (ctx: PluginContext) => Promise<void>;
};

const STATE_FILE = path.resolve(process.cwd(), "data", "daily-reports", "state.json");

export function createDailyReportPlugin(messageStore: MessageStore, menuPlugin: MenuPlugin): DailyReportPlugin {
  const renderer = new DailyReportRenderer();
  let timer: NodeJS.Timeout | null = null;

  async function generateForDate(dateKey: string, ctx: PluginContext): Promise<Map<string, DailyGroupReport>> {
    const reports = buildReports(
      messageStore.getRecordsBetween(...getDayRange(dateKey)),
      dateKey,
      menuPlugin.getPrefix(),
      ctx.config.pluginSettings.dailyReport.topUsersLimit
    );
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
