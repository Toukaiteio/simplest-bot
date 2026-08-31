import fs from "node:fs";
import path from "node:path";
import type { MemoryConfig, BotMessage } from "./types.js";
import type { ConversationScope, ExtractedMemory, MessageStore } from "./message-store.js";

export type MemoryMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type CompressCallback = (history: MemoryMessage[]) => Promise<string>;

export class MemoryManager {
  private conversationHistory = new Map<string, MemoryMessage[]>();
  private config: MemoryConfig;
  private compressCallback?: CompressCallback;
  private saveTimer: NodeJS.Timeout | null = null;
  private hydratedKeys = new Set<string>();

  constructor(config: MemoryConfig, private readonly messageStore?: MessageStore) {
    this.config = config;
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
    if (!this.messageStore) return;

    // Auto-migrate from legacy JSON file if it exists and SQLite is empty
    const jsonPath = path.resolve(process.cwd(), "data", "conversation-history.json");
    if (fs.existsSync(jsonPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as { conversations?: Record<string, MemoryMessage[]> };
        const conversations = raw.conversations ?? {};
        const keys = Object.keys(conversations);
        if (keys.length > 0) {
          console.log(`[Memory] 检测到旧版 conversation-history.json（${keys.length} 个会话），开始迁移至 SQLite…`);
          for (const [scope, history] of Object.entries(conversations)) {
            const normalized = normalizeHistory(history);
            if (normalized.length > 0) {
              this.messageStore.saveConversationSnapshot(scope, normalized);
            }
          }
          console.log("[Memory] conversation-history.json 迁移完成");
        }
        fs.renameSync(jsonPath, jsonPath + ".archived");
        console.log("[Memory] conversation-history.json 已归档为 .archived");
      } catch (error) {
        console.error("[Memory] 迁移 conversation-history.json 失败:", error);
      }
    }

    // Load from SQLite
    try {
      const snapshots = this.messageStore.getAllConversationSnapshots();
      for (const [scope, messages] of snapshots) {
        const normalized = normalizeHistory(messages as MemoryMessage[]);
        if (normalized.length > 0) {
          this.conversationHistory.set(scope, normalized);
        }
      }
    } catch (error) {
      console.error("[Memory] 从 SQLite 加载会话快照失败:", error);
    }
  }

  private persistConversationHistorySoon() {
    if (!this.messageStore) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        for (const [scope, messages] of this.conversationHistory) {
          this.messageStore!.saveConversationSnapshot(scope, messages);
        }
      } catch (error) {
        console.error("[Memory] 保存会话快照至 SQLite 失败:", error);
      }
    }, 200);
  }

  async init() {
    if (!this.config.enabled) return;
    console.log("[Memory] 使用 SQLite + 本地快照作为记忆源");
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

    // 从 SQLite 重建完整对话轮次（权威数据源）
    const restored = this.rebuildConversationFromStore(message);

    // 保留 JSON 快照中的 system 摘要（SQLite 不存储这些）
    const existing = this.conversationHistory.get(key);
    const summaries = existing?.filter((m) => m.role === "system") ?? [];

    if (summaries.length > 0 && restored.length > 0) {
      // 摘要 + SQLite 完整轮次合并
      this.conversationHistory.set(key, [...summaries, ...restored]);
    } else if (restored.length > 0) {
      this.conversationHistory.set(key, restored);
    }
    // 如果 SQLite 也没有数据，保留 JSON 原样（可能是新 scope 或空 scope）

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
    if (!this.messageStore || !message.userId) return [];

    try {
      const allFacts = this.messageStore.getAllUserFacts(message.userId);
      if (allFacts.length === 0) return [];

      const messageTokens = tokenize(message.text);
      if (messageTokens.length === 0) return [];

      const now = Date.now();
      const scored = allFacts
        .filter((mem) => !isFactDormant(mem)) // 过滤掉不活跃的事实
        .map((mem) => ({
        id: mem.id,
        content: mem.content,
        score: computeFactScore(mem, messageTokens, now),
      }));

      scored.sort((a, b) => b.score - a.score);
      const topN = scored.filter((s) => s.score > 0).slice(0, 5);

      if (topN.length > 0) {
        const accessedIds = topN.map((s) => s.id);
        this.messageStore.bumpFactAccess(accessedIds);
      }

      return topN.map((s) => s.content);
    } catch {
      return [];
    }
  }

  /** Save inline-extracted facts with substring deduplication. */
  async saveExtractedFacts(userId: string, facts: string[]): Promise<void> {
    if (!this.messageStore || facts.length === 0) return;

    const existing = this.messageStore.getAllUserFacts(userId);
    const existingTexts = existing.map((m) => m.content);

    for (const fact of facts) {
      if (!isDuplicateFact(fact, existingTexts)) {
        this.messageStore.insertExtractedMemory({
          userId,
          content: fact,
          type: "extracted_fact",
          attributedTo: "inline_extractor",
        });
      }
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
  }

  getConversationHistory(message: BotMessage): MemoryMessage[] {
    this.ensureConversationHydrated(message);
    const key = this.getHistoryKey(message);
    const history = this.conversationHistory.get(key) || [];

    // 只返回最近若干条，不全量恢复
    const limit = this.config.maxHistoryLength * 2;
    if (history.length <= limit) return history;

    // 保留摘要（如果在头部）+ 最近的条目
    const hasSummary = history[0]?.role === "system";
    if (hasSummary) {
      return [history[0], ...history.slice(-limit)];
    }
    return history.slice(-limit);
  }

  clearHistory(message: BotMessage) {
    const key = this.getHistoryKey(message);
    this.conversationHistory.delete(key);
    this.hydratedKeys.delete(key);
    if (this.messageStore) {
      this.messageStore.deleteConversationSnapshot(key);
    }
  }

  /** 扫描 AI 回复中的 [FACT:xxx] 标记，激活对应事实的访问计数 */
  processFactMentions(response: string, userId: string): void {
    if (this.messageStore) {
      processFactMentions(response, userId, this.messageStore);
    }
  }

  async getUserFacts(userId: string, limit = 20): Promise<string[]> {
    if (!this.messageStore) return [];
    const facts = this.messageStore.getAllUserFacts(userId);
    return facts.slice(0, limit).map((f) => f.content);
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

// ── Fact retrieval helpers ──────────────────────────────────────────────

/** Chinese-aware tokenizer: split on punctuation/spaces, filter stop words and short tokens. */
const STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "你", "他", "她", "它", "们",
  "这", "那", "有", "和", "与", "或", "不", "也", "都", "就",
  "会", "要", "能", "可以", "可", "把", "被", "让", "给", "从",
  "对", "向", "用", "着", "过", "吗", "呢", "吧", "啊", "嗯",
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "in", "on", "at", "to", "for", "of", "and", "or", "but",
  "it", "he", "she", "we", "they", "this", "that", "do", "does",
]);

function tokenize(text: string): string[] {
  const raw = text
    .split(/[\s,.;:!?，。；：！？、\n\r\t()[\]{}""''「」『』【】《》<>@#$%^&*+=~`|\\/]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return [...new Set(raw)]; // deduplicate tokens
}

/**
 * Score a fact against the current message using keyword overlap, recency, and access frequency.
 * Pure local computation — no LLM calls.
 */
function computeFactScore(fact: ExtractedMemory, messageTokens: string[], now: number): number {
  const factTokens = tokenize(fact.content);
  if (factTokens.length === 0) return 0;

  // Keyword overlap: how many fact tokens appear in the message
  const messageTokenSet = new Set(messageTokens);
  let overlap = 0;
  for (const token of factTokens) {
    if (messageTokenSet.has(token)) overlap++;
  }
  if (overlap === 0) return 0; // No keyword match at all → irrelevant

  const keywordScore = overlap * 3;

  // Recency: newer facts score higher (decay over 30 days)
  const updatedAt = fact.imported_at; // fallback to imported_at if updated_at is null
  const ageMs = now - updatedAt;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const recencyScore = Math.max(0, 1 - ageMs / thirtyDaysMs);

  // Access frequency: frequently accessed facts are more important
  const accessScore = Math.min(fact.access_count, 10) * 0.5;

  return keywordScore + recencyScore + accessScore;
}

// ==================== 记忆淡忘系统 ====================

/** 事实超过此天数未访问即进入不活跃状态 */
const DORMANT_DAYS = 30;
/** 访问次数低于此阈值 + 超过 DORMANT_DAYS 未访问 = 不活跃 */
const DORMANT_ACCESS_THRESHOLD = 5;

/** 判断一条事实是否处于不活跃状态（不活跃 = 不会主动注入但可被查询） */
function isFactDormant(fact: ExtractedMemory): boolean {
  if (fact.access_count >= DORMANT_ACCESS_THRESHOLD) return false;
  const lastAccess = fact.last_accessed_at ?? fact.imported_at;
  const ageMs = Date.now() - lastAccess;
  return ageMs > DORMANT_DAYS * 24 * 60 * 60 * 1000;
}

/** 扫描 AI 回复中的 [FACT:xxx] 标记，激活对应的事实（通过 MemoryManager 调用） */
export function processFactMentions(response: string, userId: string, messageStore: MessageStore): void {
  const regex = /\[FACT:([^\]]+?)\]/g;
  let match: RegExpExecArray | null;
  const mentionedTexts: string[] = [];
  while ((match = regex.exec(response)) !== null) {
    const text = match[1].trim();
    if (text) mentionedTexts.push(text);
  }
  if (mentionedTexts.length === 0 || !messageStore) return;

  // 查找匹配的事实并 bump
  const allFacts = messageStore.getAllUserFacts(userId);
  const toBump: number[] = [];
  for (const fact of allFacts) {
    for (const mentioned of mentionedTexts) {
      if (fact.content.includes(mentioned) || mentioned.includes(fact.content)) {
        toBump.push(fact.id);
        break;
      }
    }
  }
  if (toBump.length > 0) {
    messageStore.bumpFactAccess(toBump);
  }
}

/** 查询用户事实（包括不活跃的），用于 AI 的直接查询工具 */
export function queryUserFacts(
  userId: string,
  query: string,
  messageStore: MessageStore,
): Array<{ content: string; active: boolean; accessCount: number; lastAccess: number | null }> {
  const allFacts = messageStore.getAllUserFacts(userId);
  const queryLower = query.toLowerCase();
  const results = allFacts
    .filter(f => f.content.toLowerCase().includes(queryLower))
    .map(f => ({
      content: f.content,
      active: !isFactDormant(f),
      accessCount: f.access_count,
      lastAccess: f.last_accessed_at ?? f.imported_at,
    }));
  return results;
}
function isDuplicateFact(fact: string, existingTexts: string[]): boolean {
  const factLower = fact.toLowerCase();
  for (const existing of existingTexts) {
    const existLower = existing.toLowerCase();
    if (factLower.length >= 6 && existLower.includes(factLower)) return true;
    if (existLower.length >= 6 && factLower.includes(existLower)) return true;
  }
  return false;
}
