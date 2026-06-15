import { Memory } from "mem0ai/oss";
import fs from "node:fs";
import path from "node:path";
import type { MemoryConfig, BotMessage, LLMConfig } from "./types.js";
import type { ConversationScope, MessageStore } from "./message-store.js";

export type MemoryMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type CompressCallback = (history: MemoryMessage[]) => Promise<string>;

type PersistedConversationHistory = {
  version: 1;
  conversations: Record<string, MemoryMessage[]>;
};

export class MemoryManager {
  private mem0?: Memory;
  private conversationHistory = new Map<string, MemoryMessage[]>();
  private config: MemoryConfig;
  private compressCallback?: CompressCallback;
  private readonly snapshotPath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private hydratedKeys = new Set<string>();

  constructor(config: MemoryConfig, private readonly messageStore?: MessageStore) {
    this.config = config;
    this.snapshotPath = path.resolve(process.cwd(), "data", "conversation-history.json");
    this.loadPersistedConversationHistory();
  }

  setCompressCallback(cb: CompressCallback) {
    this.compressCallback = cb;
  }

  private async compressSummary(history: MemoryMessage[]): Promise<string> {
    if (!this.compressCallback) return "";
    return this.compressCallback(history);
  }

  private loadPersistedConversationHistory() {
    try {
      if (!fs.existsSync(this.snapshotPath)) {
        return;
      }
      const raw = JSON.parse(fs.readFileSync(this.snapshotPath, "utf-8")) as Partial<PersistedConversationHistory>;
      const conversations = raw.conversations ?? {};
      for (const [key, history] of Object.entries(conversations)) {
        const normalized = normalizeHistory(history);
        if (normalized.length > 0) {
          this.conversationHistory.set(key, normalized);
          this.hydratedKeys.add(key);
        }
      }
    } catch (error) {
      console.error("[Memory] 读取本地会话快照失败:", error);
    }
  }

  private persistConversationHistorySoon() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        const dir = path.dirname(this.snapshotPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const payload: PersistedConversationHistory = {
          version: 1,
          conversations: Object.fromEntries(this.conversationHistory.entries()),
        };
        fs.writeFileSync(this.snapshotPath, JSON.stringify(payload, null, 2), "utf-8");
      } catch (error) {
        console.error("[Memory] 保存本地会话快照失败:", error);
      }
    }, 200);
  }

  async init(llmConfig?: LLMConfig) {
    if (!this.config.enabled) return;

    if (this.config.provider === "mem0") {
      const mem0Config: Record<string, unknown> = {};

      // 配置 Embedder - Google AI Studio OpenAI 兼容接口
      const embedderConfig: Record<string, string | number> = {
        apiKey: this.config.mem0ApiKey,
        model: this.config.mem0EmbeddingModel || "models/gemini-embedding-001",
      };
      if (this.config.mem0BaseUrl) {
        embedderConfig.baseURL = this.config.mem0BaseUrl;
      }
      mem0Config.embedder = { provider: "openai", config: embedderConfig };

      // 配置 LLM 提取（使用聊天的 DeepSeek API）
      if (llmConfig) {
        const llmInnerConfig: Record<string, unknown> = {
          apiKey: llmConfig.apiKey,
          model: llmConfig.model,
        };
        if (llmConfig.baseUrl) {
          llmInnerConfig.baseURL = llmConfig.baseUrl;
        }
        mem0Config.llm = { provider: "openai", config: llmInnerConfig };
      }

      // 禁用 SQLite history store（避免 better-sqlite3 原生模块问题）
      mem0Config.disableHistory = true;

      // 配置 vectorStore 维度及持久化路径
      const dimension = this.config.mem0EmbeddingDimension;
      const vectorStoreConfig: Record<string, unknown> = {
        collectionName: "memories",
        dbPath: path.resolve(process.cwd(), "data", "vector_store.db"),
      };
      if (dimension) {
        vectorStoreConfig.dimension = dimension;
      }
      mem0Config.vectorStore = { provider: "memory", config: vectorStoreConfig };

      this.mem0 = new Memory(mem0Config);
      console.log("[Memory] mem0 已初始化");
    } else {
      console.log("[Memory] 使用简易内存模式（无持久化）");
    }
  }

  private getHistoryKey(message: BotMessage): string {
    if (message.type === "private") return `user:${message.userId}`;
    return `group:${message.groupId}`;
  }

  private ensureConversationHydrated(message: BotMessage) {
    const key = this.getHistoryKey(message);
    if (this.hydratedKeys.has(key)) {
      return;
    }

    const existing = this.conversationHistory.get(key);
    if (existing && existing.length > 0) {
      this.hydratedKeys.add(key);
      return;
    }

    const restored = this.rebuildConversationFromStore(message);
    if (restored.length > 0) {
      this.conversationHistory.set(key, restored);
    }
    this.hydratedKeys.add(key);
  }

  private rebuildConversationFromStore(message: BotMessage): MemoryMessage[] {
    if (!this.messageStore) {
      return [];
    }

    const scope: ConversationScope = message.type === "private"
      ? { type: "private", userId: message.userId ?? "" }
      : { type: "group", groupId: message.groupId ?? "" };
    const turns = this.messageStore.getRecentConversationTurns(scope, this.config.maxHistoryLength);
    const rebuilt: MemoryMessage[] = [];

    for (const turn of turns) {
      if (turn.userText.trim()) {
        rebuilt.push({ role: "user", content: turn.userText });
      }
      if (turn.assistantText.trim()) {
        rebuilt.push({ role: "assistant", content: turn.assistantText });
      }
    }

    return rebuilt;
  }

  async getRelevantMemories(message: BotMessage): Promise<string[]> {
    if (!this.config.enabled || !this.mem0) return [];

    try {
      const userId = message.userId || "unknown";
      const results = await this.mem0.search(message.text, {
        filters: { user_id: userId },
      });
      return results.results.map((m: { memory: string }) => m.memory);
    } catch (error) {
      const err = error as { status?: number; message?: string; error?: { message?: string } };
      console.error("[Memory] 搜索记忆失败:", err.status ? `HTTP ${err.status}` : "", err.message || err.error?.message || error);
      return [];
    }
  }

  async addMessage(message: BotMessage, response: string) {
    const key = this.getHistoryKey(message);
    this.ensureConversationHydrated(message);
    const history = this.conversationHistory.get(key) || [];

    appendConversationTurn(history, formatConversationChunk([message]), response);

    await this.compactHistory(history);

    this.conversationHistory.set(key, history);
    this.persistConversationHistorySoon();

    // 异步存储到 mem0
    if (this.config.enabled && this.mem0 && message.userId) {
      try {
        await this.mem0.add(
          [
            { role: "user", content: message.text },
            { role: "assistant", content: response },
          ],
          { userId: message.userId }
        );
      } catch (error) {
        console.error("[Memory] 存储记忆失败:", error);
      }
    }
  }

  getConversationHistory(message: BotMessage): MemoryMessage[] {
    this.ensureConversationHydrated(message);
    const key = this.getHistoryKey(message);
    return this.conversationHistory.get(key) || [];
  }

  clearHistory(message: BotMessage) {
    const key = this.getHistoryKey(message);
    this.conversationHistory.delete(key);
    this.hydratedKeys.delete(key);
    this.persistConversationHistorySoon();
  }

  async addBatch(messages: BotMessage[], response: string) {
    if (messages.length === 0) return;

    const primary = messages[0];
    const key = this.getHistoryKey(primary);
    this.ensureConversationHydrated(primary);
    const history = this.conversationHistory.get(key) || [];

    appendConversationTurn(history, formatConversationChunk(messages), response);

    await this.compactHistory(history);

    this.conversationHistory.set(key, history);
    this.persistConversationHistorySoon();

    if (this.config.enabled && this.mem0 && primary.userId) {
      const lastMsg = messages[messages.length - 1];
      try {
        await this.mem0.add(
          [
            { role: "user", content: lastMsg.text },
            { role: "assistant", content: response },
          ],
          { userId: primary.userId }
        );
      } catch (error) {
        console.error("[Memory] 批量存储记忆失败:", error);
      }
    }
  }

  private async compactHistory(history: MemoryMessage[]) {
    const maxEntries = this.config.maxHistoryLength * 2;
    if (history.length <= maxEntries) {
      return;
    }

    // 保留最近的条目数（偶数，保证 user/assistant 成对）
    const recentLimit = Math.max(4, Math.floor(this.config.maxHistoryLength * 0.75) * 2);

    // 如果还没有摘要，将超出部分压缩为固定摘要放在头部（之后不再修改，保证前缀稳定）
    const hasSummary = history[0]?.role === "system";
    if (!hasSummary) {
      const excess = history.length - recentLimit;
      if (excess > 0) {
        const head = history.splice(0, excess);
        const summary = await this.compressSummary(head);
        if (summary) {
          history.unshift({ role: "system", content: `[历史摘要] ${summary}` });
        }
        return;
      }
    }

    // 已有摘要时：摘要永远保持在 position 0 不动，仅从摘要之后裁剪最旧的条目
    const startIdx = hasSummary ? 1 : 0;
    const nonSummaryCount = history.length - startIdx;
    if (nonSummaryCount > recentLimit) {
      const toRemove = nonSummaryCount - recentLimit;
      history.splice(startIdx, toRemove);
    }
  }
}

function normalizeHistory(history: MemoryMessage[] | undefined): MemoryMessage[] {
  if (!Array.isArray(history)) {
    return [];
  }
  const filtered = history.filter((item): item is MemoryMessage => (
    Boolean(item)
    && (item.role === "user" || item.role === "assistant" || item.role === "system")
    && typeof item.content === "string"
    && item.content.length > 0
  ));
  return coalesceUserChunks(filtered);
}

function appendConversationTurn(history: MemoryMessage[], userContent: string, assistantContent: string) {
  if (userContent.trim()) {
    if (history[history.length - 1]?.role === "user") {
      history[history.length - 1] = {
        role: "user",
        content: `${history[history.length - 1].content}\n${userContent}`,
      };
    } else {
      history.push({ role: "user", content: userContent });
    }
  }

  if (assistantContent.trim()) {
    history.push({ role: "assistant", content: assistantContent });
  }
}

function formatConversationChunk(messages: BotMessage[]): string {
  if (messages.length === 1) {
    return messages[0].text;
  }

  return messages.map((message, index) => {
    const sender = message.userId ? message.userId : "用户";
    return `消息 ${index + 1} (${sender}): ${message.text}`;
  }).join("\n");
}

function coalesceUserChunks(history: MemoryMessage[]): MemoryMessage[] {
  const result: MemoryMessage[] = [];

  for (const item of history) {
    const previous = result[result.length - 1];
    if (item.role === "user" && previous?.role === "user") {
      previous.content = `${previous.content}\n${item.content}`;
      continue;
    }
    result.push({ ...item });
  }

  return result;
}
