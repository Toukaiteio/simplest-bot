import type {
  BotMessage,
  MenuPlugin,
  Plugin,
  PluginContext,
  PromptBuildInput,
} from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";
import type {
  MessageStore,
  ChatMessageRecord,
  QueryMessagesOptions,
} from "../../message-store.js";

type ChatSearchPlugin = Plugin & {
  getToolRegistrations: () => BotToolRegistration[];
};

const MAX_TOOL_LIMIT = 500;
const DEFAULT_TOOL_LIMIT = 500;
const COMMAND_DEFAULT_LIMIT = 20;

export function createChatSearchPlugin(
  messageStore: MessageStore,
  menuPlugin: MenuPlugin,
): ChatSearchPlugin {
  // ── Shared helpers ──────────────────────────────────────────────

  function formatTimestamp(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "…";
  }

  function formatRecordLine(rec: ChatMessageRecord): string {
    const time = formatTimestamp(rec.timestamp);
    const scope = rec.type === "group" && rec.groupId
      ? `群${rec.groupId}`
      : rec.type === "private"
        ? "私聊"
        : "";
    const sender = rec.isBot
      ? "Bot"
      : `${rec.displayName ?? "用户"}(${rec.userId ?? "?"})`;
    const text = truncateText(rec.text, 120);
    const msgId = rec.messageId ? ` [id:${rec.messageId}]` : "";
    return `[${time}]${msgId} ${scope} · ${sender}: ${text}`;
  }

  function formatResults(records: ChatMessageRecord[], description: string, usedLimit?: number): string {
    if (records.length === 0) return `没有找到相关记录。${description}`;
    const lines = records.map(formatRecordLine);
    let result = `${lines.join("\n")}\n---\n共 ${records.length} 条记录 (${description})`;
    if (usedLimit && records.length >= usedLimit) {
      result += `\n⚠️ 结果数已达上限(${usedLimit})，可能存在更多记录。如需查看更多，请用 offset=${usedLimit} 继续翻取。`;
    }
    return result;
  }

  function parseISOTime(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const ms = Date.parse(value);
    return isNaN(ms) ? undefined : ms;
  }

  // ── $commands ───────────────────────────────────────────────────

  menuPlugin.registerCommand(
    "search-user",
    "按QQ号搜索用户消息: $search-user <QQ号> [关键词] [offset=N]",
    async (message, args, ctx) => {
      const userId = args[0];
      if (!userId) {
        await ctx.replyText(message, "用法: $search-user <QQ号> [关键词] [offset=N]");
        return;
      }
      let offset = 0;
      const keywordArgs: string[] = [];
      for (const a of args.slice(1)) {
        const m = a.match(/^offset=(\d+)$/i);
        if (m) offset = Math.max(0, parseInt(m[1], 10));
        else keywordArgs.push(a);
      }
      const keyword = keywordArgs.join(" ").trim() || undefined;
      const opts: QueryMessagesOptions = {
        userId,
        keywords: keyword ? [keyword] : undefined,
        order: "desc",
        limit: COMMAND_DEFAULT_LIMIT,
        offset,
      };
      const records = messageStore.queryMessages(opts);
      const desc = `用户${userId}${keyword ? `, 关键词: "${keyword}"` : ""}${offset ? `, 偏移: ${offset}` : ""}`;
      await ctx.replyText(message, formatResults(records, desc));
    },
  );

  menuPlugin.registerCommand(
    "search-group",
    "搜索群聊消息: $search-group <群号> [关键词] [offset=N]",
    async (message, args, ctx) => {
      const groupId = args[0];
      if (!groupId) {
        await ctx.replyText(message, "用法: $search-group <群号> [关键词] [offset=N]");
        return;
      }
      let offset = 0;
      const keywordArgs: string[] = [];
      for (const a of args.slice(1)) {
        const m = a.match(/^offset=(\d+)$/i);
        if (m) offset = Math.max(0, parseInt(m[1], 10));
        else keywordArgs.push(a);
      }
      const keyword = keywordArgs.join(" ").trim() || undefined;
      const opts: QueryMessagesOptions = {
        groupId,
        keywords: keyword ? [keyword] : undefined,
        order: "desc",
        limit: COMMAND_DEFAULT_LIMIT,
        offset,
      };
      const records = messageStore.queryMessages(opts);
      const desc = `群${groupId}${keyword ? `, 关键词: "${keyword}"` : ""}${offset ? `, 偏移: ${offset}` : ""}`;
      await ctx.replyText(message, formatResults(records, desc));
    },
  );

  menuPlugin.registerCommand(
    "search",
    "全局关键词搜索: $search <关键词> [群号] [offset=N]",
    async (message, args, ctx) => {
      const keyword = args[0];
      if (!keyword) {
        await ctx.replyText(message, "用法: $search <关键词> [群号] [offset=N]");
        return;
      }
      let offset = 0;
      let groupId: string | undefined;
      for (const a of args.slice(1)) {
        const m = a.match(/^offset=(\d+)$/i);
        if (m) offset = Math.max(0, parseInt(m[1], 10));
        else groupId = a;
      }
      const opts: QueryMessagesOptions = {
        keywords: [keyword],
        groupId,
        order: "desc",
        limit: COMMAND_DEFAULT_LIMIT,
        offset,
      };
      const records = messageStore.queryMessages(opts);
      const desc = `关键词: "${keyword}"${groupId ? `, 群${groupId}` : ""}${offset ? `, 偏移: ${offset}` : ""}`;
      await ctx.replyText(message, formatResults(records, desc));
    },
  );

  menuPlugin.registerCommand(
    "chat-history",
    "查看近期聊天记录: $chat-history [群号] [数量] [offset=N]",
    async (message, args, ctx) => {
      let groupId = message.groupId;
      let limit = COMMAND_DEFAULT_LIMIT;
      let offset = 0;
      for (const a of args) {
        const oMatch = a.match(/^offset=(\d+)$/i);
        const lMatch = a.match(/^\d+$/);
        if (oMatch) {
          offset = Math.max(0, parseInt(oMatch[1], 10));
        } else if (lMatch) {
          limit = Math.min(parseInt(a, 10), 100);
        } else {
          groupId = a;
        }
      }

      if (!groupId) {
        await ctx.replyText(message, "用法: $chat-history <群号> [数量] [offset=N]\n(在群内可直接使用，默认当前群)");
        return;
      }
      const opts: QueryMessagesOptions = {
        groupId,
        order: "desc",
        limit,
        offset,
      };
      const records = messageStore.queryMessages(opts);
      const desc = `群${groupId}, 最近 ${limit} 条${offset ? `, 偏移: ${offset}` : ""}`;
      await ctx.replyText(message, formatResults(records, desc));
    },
  );

  // ── LLM Tools ──────────────────────────────────────────────────

  const searchTimeParams = {
    startTime: {
      type: "string",
      description: "起始时间, ISO-8601 格式 (如 2026-06-01T00:00:00+08:00)",
    },
    endTime: {
      type: "string",
      description: "结束时间, ISO-8601 格式 (如 2026-06-15T23:59:59+08:00)",
    },
    order: {
      type: "string",
      enum: ["asc", "desc"],
      description: "排序方式: asc=从旧到新, desc=从新到旧 (默认 desc)",
    },
    limit: {
      type: "number",
      description: `返回条数, 默认 ${DEFAULT_TOOL_LIMIT}, 最大 ${MAX_TOOL_LIMIT}。如需全面搜索建议设为 500。`,
    },
    offset: {
      type: "number",
      description: "偏移量, 用于分页翻取更早/更旧的结果 (默认 0)",
    },
  };

  function clampLimit(n: unknown): number {
    const val = typeof n === "number" && Number.isFinite(n) ? n : DEFAULT_TOOL_LIMIT;
    return Math.max(1, Math.min(MAX_TOOL_LIMIT, Math.round(val)));
  }

  function clampOffset(n: unknown): number {
    return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }

  function resolveOrder(v: unknown): "asc" | "desc" {
    return v === "asc" ? "asc" : "desc";
  }

  const toolSearchUserMessages = makeTool(
    "search_user_messages",
    "按QQ号搜索某用户在群聊和私聊中的历史消息。当需要回忆某用户之前说过什么、查找某用户的发言记录时使用此工具。",
    {
      type: "object",
      properties: {
        userId: { type: "string", description: "用户的QQ号 (必填)" },
        keyword: { type: "string", description: "关键词过滤 (可选)" },
        groupId: { type: "string", description: "限定搜索的群号 (可选, 不填则搜索所有群和私聊)" },
        ...searchTimeParams,
      },
      required: ["userId"],
    },
    async (args) => {
      const opts: QueryMessagesOptions = {
        userId: String(args.userId),
        groupId: args.groupId ? String(args.groupId) : undefined,
        keywords: args.keyword ? [String(args.keyword)] : undefined,
        startTime: parseISOTime(args.startTime as string | undefined),
        endTime: parseISOTime(args.endTime as string | undefined),
        order: resolveOrder(args.order),
        limit: clampLimit(args.limit),
        offset: clampOffset(args.offset),
      };
      const records = messageStore.queryMessages(opts);
      const desc = `用户${opts.userId}${opts.groupId ? ` 群${opts.groupId}` : ""}${opts.keywords?.[0] ? ` 关键词"${opts.keywords[0]}"` : ""}`;
      return formatResults(records, desc, opts.limit);
    },
  );

  const toolSearchGroupMessages = makeTool(
    "search_group_messages",
    "搜索指定QQ群的聊天记录。当需要了解某个群里最近发生了什么、讨论了什么话题时使用此工具。",
    {
      type: "object",
      properties: {
        groupId: { type: "string", description: "群号 (必填)" },
        userId: { type: "string", description: "限定某用户的消息 (可选)" },
        keyword: { type: "string", description: "关键词过滤 (可选)" },
        ...searchTimeParams,
      },
      required: ["groupId"],
    },
    async (args) => {
      const opts: QueryMessagesOptions = {
        groupId: String(args.groupId),
        userId: args.userId ? String(args.userId) : undefined,
        keywords: args.keyword ? [String(args.keyword)] : undefined,
        startTime: parseISOTime(args.startTime as string | undefined),
        endTime: parseISOTime(args.endTime as string | undefined),
        order: resolveOrder(args.order),
        limit: clampLimit(args.limit),
        offset: clampOffset(args.offset),
      };
      const records = messageStore.queryMessages(opts);
      const desc = `群${opts.groupId}${opts.userId ? ` 用户${opts.userId}` : ""}${opts.keywords?.[0] ? ` 关键词"${opts.keywords[0]}"` : ""}`;
      return formatResults(records, desc, opts.limit);
    },
  );

  const toolSearchChatKeyword = makeTool(
    "search_chat_keyword",
    "在所有群聊和私聊中按关键词搜索消息。当需要查找提到某个话题、人名、事件的所有记录时使用此工具。",
    {
      type: "object",
      properties: {
        keyword: { type: "string", description: "搜索关键词 (必填)" },
        userId: { type: "string", description: "限定某用户的消息 (可选)" },
        groupId: { type: "string", description: "限定某个群 (可选, 不填则搜索所有聊天)" },
        ...searchTimeParams,
      },
      required: ["keyword"],
    },
    async (args) => {
      const opts: QueryMessagesOptions = {
        keywords: [String(args.keyword)],
        userId: args.userId ? String(args.userId) : undefined,
        groupId: args.groupId ? String(args.groupId) : undefined,
        startTime: parseISOTime(args.startTime as string | undefined),
        endTime: parseISOTime(args.endTime as string | undefined),
        order: resolveOrder(args.order),
        limit: clampLimit(args.limit),
        offset: clampOffset(args.offset),
      };
      const records = messageStore.queryMessages(opts);
      const desc = `关键词"${opts.keywords![0]}"${opts.groupId ? ` 群${opts.groupId}` : ""}${opts.userId ? ` 用户${opts.userId}` : ""}`;
      return formatResults(records, desc, opts.limit);
    },
  );

  const toolSearchMyMessages = makeTool(
    "search_my_messages",
    "获取我自己最近在所有群聊或私聊中的发言记录。当需要回忆自己之前说过什么、检查自己的发言历史时使用。",
    {
      type: "object",
      properties: {
        groupId: { type: "string", description: "限定某个群 (可选, 不填则搜索所有聊天)" },
        ...searchTimeParams,
      },
      required: [],
    },
    async (args, input) => {
      // 从 input 获取 bot 的 selfId
      const msg = input.mode === "single" ? input.message : input.messages[input.messages.length - 1];
      const selfId = msg.selfId ?? msg.userId;
      if (!selfId) return "无法确定 bot 的 ID。";

      const opts: QueryMessagesOptions = {
        userId: selfId,
        groupId: args.groupId ? String(args.groupId) : undefined,
        includeReplies: false,
        startTime: parseISOTime(args.startTime as string | undefined),
        endTime: parseISOTime(args.endTime as string | undefined),
        order: resolveOrder(args.order),
        limit: clampLimit(args.limit),
        offset: clampOffset(args.offset),
      };
      const records = messageStore.queryMessages(opts);
      const desc = `我的发言${opts.groupId ? ` 群${opts.groupId}` : " 所有聊天"}`;
      return formatResults(records, desc, opts.limit);
    },
  );

  const toolSearchInteraction = makeTool(
    "search_interaction",
    "获取我与指定用户之间的互动消息（包括对方发的和我回复的），跨所有群聊和私聊。当需要了解与某用户的完整互动历史时使用。",
    {
      type: "object",
      properties: {
        userId: { type: "string", description: "对方的QQ号 (必填)" },
        groupId: { type: "string", description: "限定某个群 (可选, 不填则搜索所有聊天)" },
        ...searchTimeParams,
      },
      required: ["userId"],
    },
    async (args) => {
      const userId = String(args.userId);
      const usedLimit = clampLimit(args.limit);
      const records = messageStore.queryInteraction(userId, {
        groupId: args.groupId ? String(args.groupId) : undefined,
        startTime: parseISOTime(args.startTime as string | undefined),
        endTime: parseISOTime(args.endTime as string | undefined),
        order: resolveOrder(args.order),
        limit: usedLimit,
        offset: clampOffset(args.offset),
      });
      const desc = `与用户${userId}的互动${args.groupId ? ` 群${args.groupId}` : " 所有聊天"}`;
      return formatResults(records, desc, usedLimit);
    },
  );

  const toolGetMessageContext = makeTool(
    "get_message_context",
    "根据消息 ID 查找该消息所在对话的上下文（前后各若干条）。当需要查看某条消息的来龙去脉时使用。",
    {
      type: "object",
      properties: {
        messageId: { type: "string", description: "消息 ID (必填)" },
        before: { type: "number", description: "获取该消息之前的条数 (默认 5, 最大 20)" },
        after: { type: "number", description: "获取该消息之后的条数 (默认 5, 最大 20)" },
      },
      required: ["messageId"],
    },
    async (args) => {
      const messageId = String(args.messageId);
      const before = Math.max(0, Math.min(20, Math.round(typeof args.before === "number" ? args.before : 5)));
      const after = Math.max(0, Math.min(20, Math.round(typeof args.after === "number" ? args.after : 5)));

      const records = messageStore.getMessageContext(messageId, before, after);
      if (records.length === 0) return `未找到消息 ID "${messageId}" 或其上下文。`;

      // 标记目标消息
      const lines = records.map((rec) => {
        const line = formatRecordLine(rec);
        return rec.messageId === messageId ? `>>> ${line}` : `    ${line}`;
      });
      return `${lines.join("\n")}\n---\n共 ${records.length} 条 (>>> 标记目标消息)`;
    },
  );

  // ── Plugin object ──────────────────────────────────────────────

  return {
    name: "chat-search",
    description: "基于聊天记录的搜索系统，替代 mem0 向量记忆，提供按用户/群/关键词的多维搜索能力",

    systemPromptAppend: [
      "[记忆系统]",
      "你拥有搜索历史聊天记录的能力。当用户提及过去发生的事情、之前说过的话、或任何需要回忆的场景时，你应主动使用搜索工具查找相关记录。",
      "可用的搜索工具：",
      "- search_user_messages: 按QQ号搜索某用户的消息",
      "- search_group_messages: 搜索某群的聊天记录",
      "- search_chat_keyword: 全局关键词搜索",
      "- search_my_messages: 查看自己最近的发言",
      "- search_interaction: 查看与某用户的互动历史",
      "- get_message_context: 按消息ID查看对话上下文",
      "重要：默认只返回最近200条，如需全面搜索请设置 limit=500。所有搜索工具支持 offset 分页（offset=200 翻取更早结果）、startTime/endTime 时间范围过滤、order 排序。",
      "搜索结果中的 [id:xxx] 是消息ID，可用 get_message_context 查看完整上下文。",
    ].join("\n"),

    onLoad() {},

    getToolRegistrations() {
      return [
        toolSearchUserMessages,
        toolSearchGroupMessages,
        toolSearchChatKeyword,
        toolSearchMyMessages,
        toolSearchInteraction,
        toolGetMessageContext,
      ];
    },
  };
}

function makeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: BotToolRegistration["execute"],
): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: { name, description, parameters },
    },
    execute,
  };
}
