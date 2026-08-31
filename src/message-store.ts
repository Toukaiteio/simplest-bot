import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { BotMessage, UserProfile, ItemDef } from "./types.js";

// ── Public types (unchanged) ──────────────────────────────────────

export type MessageStoreRecord =
  | { kind: "inbound"; timestamp: number; message: BotMessage }
  | { kind: "reply"; timestamp: number; message: BotMessage; response: string }
  | { kind: "batch_reply"; timestamp: number; messages: BotMessage[]; response: string };

type LegacyStoredMessage = {
  timestamp: number;
  message: BotMessage;
  response?: string;
};

export type ConversationScope =
  | { type: "private"; userId: string }
  | { type: "group"; groupId: string };

export type StoredConversationTurn = {
  userText: string;
  assistantText: string;
};

export type QueryMessagesOptions = {
  userId?: string;
  groupId?: string;
  keywords?: string[];
  startTime?: number;
  endTime?: number;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
  includeReplies?: boolean;
};

export type ChatMessageRecord = {
  timestamp: number;
  userId?: string;
  groupId?: string;
  type: "group" | "private";
  text: string;
  displayName?: string;
  isBot: boolean;
  messageId?: string;
};

export type ActiveGroupInfo = {
  groupId: string;
  lastMessageAt: number;
};

export type ExtractedMemory = {
  id: number;
  source_id: string | null;
  type: string;
  user_id: string | null;
  attributed_to: string | null;
  content: string;
  scope: string | null;
  created_at: string | null;
  updated_at: string | null;
  metadata: string | null;
  imported_at: number;
  access_count: number;
  last_accessed_at: number | null;
};

// ── SQLite-backed MessageStore ────────────────────────────────────

export class MessageStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(dbPath = "data/messages.db") {
    const resolved = path.resolve(process.cwd(), dbPath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolved);
    // Performance tuning: WAL mode for concurrent read/write,
    // NORMAL sync for good balance of safety and speed.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.initSchema();
    this.migrateSchema();
    this.insertStmt = this.db.prepare(`
      INSERT INTO messages (timestamp, user_id, group_id, msg_type, text, display_name, is_bot, record_kind, message_id, message_json)
      VALUES (@timestamp, @user_id, @group_id, @msg_type, @text, @display_name, @is_bot, @record_kind, @message_id, @message_json)
    `);

    // Auto-migrate from JSONL if the legacy file exists
    const legacyPath = path.resolve(process.cwd(), "data/messages.jsonl");
    if (fs.existsSync(legacyPath)) {
      this.migrateFromJsonl(legacyPath);
    }
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        user_id TEXT,
        group_id TEXT,
        msg_type TEXT NOT NULL DEFAULT 'group',
        text TEXT NOT NULL DEFAULT '',
        display_name TEXT,
        is_bot INTEGER NOT NULL DEFAULT 0,
        record_kind TEXT NOT NULL,
        message_id TEXT,
        message_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_msg_user_time ON messages(user_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_msg_group_time ON messages(group_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_msg_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_msg_message_id ON messages(message_id) WHERE message_id IS NOT NULL;

      -- Extracted memories from old mem0 system (migrated facts & conversation summaries)
      CREATE TABLE IF NOT EXISTS extracted_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT,
        type TEXT NOT NULL,
        user_id TEXT,
        attributed_to TEXT,
        content TEXT NOT NULL,
        scope TEXT,
        created_at TEXT,
        updated_at TEXT,
        metadata TEXT,
        imported_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_user ON extracted_memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON extracted_memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON extracted_memories(scope);

      -- Conversation snapshots (replaces conversation-history.json)
      CREATE TABLE IF NOT EXISTS conversation_snapshots (
        scope TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- User profiles (replaces plugins.json users)
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Item definitions (replaces plugins.json items)
      CREATE TABLE IF NOT EXISTS item_defs (
        item_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      -- MMORPG entities (replaces mmorpg-state.json)
      CREATE TABLE IF NOT EXISTS mmorpg_entities (
        category TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (category, entity_id)
      );

      -- MMORPG world state
      CREATE TABLE IF NOT EXISTS mmorpg_world (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- ContextManager per-session state (working chunks, stable memory, segments)
      CREATE TABLE IF NOT EXISTS context_states (
        scope TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Incremental schema migrations (ALTER TABLE). Each migration is idempotent:
   * "duplicate column name" errors are silently ignored.
   */
  private migrateSchema() {
    const migrations = [
      "ALTER TABLE extracted_memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE extracted_memories ADD COLUMN last_accessed_at INTEGER",
    ];
    for (const sql of migrations) {
      try {
        this.db.exec(sql);
      } catch (e: unknown) {
        if (!(e instanceof Error && e.message.includes("duplicate column"))) {
          throw e;
        }
      }
    }
  }

  /**
   * One-time migration from JSONL to SQLite.
   * Reads the legacy file, inserts all records, then renames it to .migrated.
   */
  private migrateFromJsonl(jsonPath: string) {
    console.log("[MessageStore] 检测到旧版 messages.jsonl，开始迁移至 SQLite…");
    const content = fs.readFileSync(jsonPath, "utf-8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    let count = 0;

    const tx = this.db.transaction(() => {
      for (const line of lines) {
        const parsed = safeJsonParse(line);
        if (!parsed) continue;
        const record = normalizeRecord(parsed);
        if (!record) continue;
        this.insertRecord(record);
        count++;
      }
    });
    tx();

    // Rename the legacy file so it won't be migrated again
    const migratedPath = jsonPath + ".migrated";
    try {
      fs.renameSync(jsonPath, migratedPath);
    } catch {
      // If rename fails (e.g., file in use), just leave it — won't re-migrate due to data already in DB
    }
    console.log(`[MessageStore] 迁移完成：${count} 条记录已导入。旧文件已重命名为 messages.jsonl.migrated`);
  }

  // ── Write methods ───────────────────────────────────────────────

  appendIncoming(message: BotMessage) {
    this.insertRecord({
      kind: "inbound",
      timestamp: Date.now(),
      message,
    });
  }

  appendReply(message: BotMessage, response: string) {
    this.insertRecord({
      kind: "reply",
      timestamp: Date.now(),
      message,
      response,
    });
  }

  appendBatchReply(messages: BotMessage[], response: string) {
    if (messages.length === 0) return;
    this.insertRecord({
      kind: "batch_reply",
      timestamp: Date.now(),
      messages,
      response,
    });
  }

  private insertRecord(record: MessageStoreRecord) {
    const ts = record.timestamp;

    if (record.kind === "inbound") {
      const msg = record.message;
      this.insertStmt.run({
        timestamp: ts,
        user_id: msg.userId ?? null,
        group_id: msg.groupId ?? null,
        msg_type: msg.type,
        text: msg.text,
        display_name: extractDisplayName(msg),
        is_bot: 0,
        record_kind: "inbound",
        message_id: msg.id ?? null,
        message_json: safeStringify(stripRaw(msg)),
      });
    } else if (record.kind === "reply") {
      const msg = record.message;
      this.insertStmt.run({
        timestamp: ts,
        user_id: msg.userId ?? null,
        group_id: msg.groupId ?? null,
        msg_type: msg.type,
        text: msg.text,
        display_name: extractDisplayName(msg),
        is_bot: 0,
        record_kind: "reply",
        message_id: msg.id ?? null,
        message_json: safeStringify(stripRaw(msg)),
      });
      // Bot reply
      this.insertStmt.run({
        timestamp: ts + 1,
        user_id: msg.userId ?? null,
        group_id: msg.groupId ?? null,
        msg_type: msg.type,
        text: record.response,
        display_name: null,
        is_bot: 1,
        record_kind: "reply",
        message_id: null,
        message_json: null,
      });
    } else {
      // batch_reply
      for (const msg of record.messages) {
        this.insertStmt.run({
          timestamp: ts,
          user_id: msg.userId ?? null,
          group_id: msg.groupId ?? null,
          msg_type: msg.type,
          text: msg.text,
          display_name: extractDisplayName(msg),
          is_bot: 0,
          record_kind: "batch_reply",
          message_id: msg.id ?? null,
          message_json: safeStringify(stripRaw(msg)),
        });
      }
      // Bot reply for the batch
      const primary = record.messages[0];
      this.insertStmt.run({
        timestamp: ts + 1,
        user_id: primary?.userId ?? null,
        group_id: primary?.groupId ?? null,
        msg_type: primary?.type ?? "group",
        text: record.response,
        display_name: null,
        is_bot: 1,
        record_kind: "batch_reply",
        message_id: null,
        message_json: null,
      });
    }
  }

  // ── Read methods ────────────────────────────────────────────────

  getRecordsBetween(startTime: number, endTime: number): MessageStoreRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE timestamp >= ? AND timestamp < ?
      ORDER BY timestamp ASC
    `).all(startTime, endTime) as MessageRow[];

    // Group by record_kind + timestamp to reconstruct records
    return this.reconstructRecords(rows);
  }

  getLatestKnownDisplayName(userId: string, groupId?: string): string | null {
    const sql = groupId
      ? `SELECT display_name FROM messages
         WHERE user_id = ? AND group_id = ? AND is_bot = 0 AND record_kind != 'batch_reply' AND display_name IS NOT NULL AND display_name != ''
         ORDER BY timestamp DESC LIMIT 1`
      : `SELECT display_name FROM messages
         WHERE user_id = ? AND is_bot = 0 AND record_kind != 'batch_reply' AND display_name IS NOT NULL AND display_name != ''
         ORDER BY timestamp DESC LIMIT 1`;

    const row = groupId
      ? this.db.prepare(sql).get(userId, groupId) as { display_name: string } | undefined
      : this.db.prepare(sql).get(userId) as { display_name: string } | undefined;

    return row?.display_name ?? null;
  }

  findMessageById(messageId: string): BotMessage | null {
    const row = this.db.prepare(`
      SELECT message_json FROM messages
      WHERE message_id = ? AND message_json IS NOT NULL
      ORDER BY timestamp DESC LIMIT 1
    `).get(messageId) as { message_json: string } | undefined;

    if (!row?.message_json) return null;
    try {
      return JSON.parse(row.message_json) as BotMessage;
    } catch {
      return null;
    }
  }

  getRecentConversationTurns(scope: ConversationScope, limit: number): StoredConversationTurn[] {
    if (limit <= 0) return [];

    // Find reply/batch_reply records in this scope, newest first
    const scopeCondition = scope.type === "private"
      ? `msg_type = 'private' AND user_id = ?`
      : `msg_type = 'group' AND group_id = ?`;
    const scopeParam = scope.type === "private" ? scope.userId : scope.groupId;

    // Get distinct record timestamps that have bot replies in this scope
    const recordRows = this.db.prepare(`
      SELECT DISTINCT timestamp, record_kind
      FROM messages
      WHERE (${scopeCondition}) AND record_kind IN ('reply', 'batch_reply') AND is_bot = 1
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(scopeParam, limit) as { timestamp: number; record_kind: string }[];

    const turns: StoredConversationTurn[] = [];

    for (const rec of recordRows) {
      // Get all user messages in this record (same timestamp, is_bot = 0)
      const userMsgs = this.db.prepare(`
        SELECT text, user_id FROM messages
        WHERE timestamp = ? AND is_bot = 0 AND record_kind = ?
        ORDER BY id ASC
      `).all(rec.timestamp, rec.record_kind) as { text: string; user_id: string | null }[];

      // Get the bot reply (same timestamp, is_bot = 1)
      const botRow = this.db.prepare(`
        SELECT text FROM messages
        WHERE timestamp = ? AND is_bot = 1 AND record_kind = ?
        LIMIT 1
      `).get(rec.timestamp, rec.record_kind) as { text: string } | undefined;

      if (userMsgs.length > 0 && botRow) {
        turns.push({
          userText: userMsgs.length === 1
            ? userMsgs[0].text
            : userMsgs.map((m, i) => `消息 ${i + 1} (${m.user_id ?? "用户"}): ${m.text}`).join("\n"),
          assistantText: botRow.text,
        });
      }
    }

    return turns.reverse();
  }

  queryMessages(opts: QueryMessagesOptions): ChatMessageRecord[] {
    const includeReplies = opts.includeReplies !== false;
    const limit = Math.min(opts.limit ?? 50, 1000);
    const offset = Math.max(0, opts.offset ?? 0);
    const order = opts.order ?? "desc";
    const orderSql = order === "asc" ? "ASC" : "DESC";

    // Build dynamic WHERE clause
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.userId) {
      // For user queries: match either user messages from this userId,
      // or bot replies in the same context (same group/private)
      if (!includeReplies) {
        conditions.push("user_id = ? AND is_bot = 0");
        params.push(opts.userId);
      } else {
        conditions.push("user_id = ?");
        params.push(opts.userId);
      }
    }

    if (opts.groupId) {
      conditions.push("group_id = ?");
      params.push(opts.groupId);
    }

    if (!includeReplies && !opts.userId) {
      conditions.push("is_bot = 0");
    }

    if (opts.startTime) {
      conditions.push("timestamp >= ?");
      params.push(opts.startTime);
    }
    if (opts.endTime) {
      conditions.push("timestamp <= ?");
      params.push(opts.endTime);
    }

    // Keyword filtering: use LIKE for each keyword (case-insensitive by default in SQLite for ASCII)
    const lowerKeywords = (opts.keywords ?? []).map((k) => k.toLowerCase());
    for (const kw of lowerKeywords) {
      conditions.push("LOWER(text) LIKE ?");
      params.push(`%${kw}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT timestamp, user_id, group_id, msg_type, text, display_name, is_bot, message_id FROM messages ${whereClause} ORDER BY timestamp ${orderSql} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as {
      timestamp: number;
      user_id: string | null;
      group_id: string | null;
      msg_type: string;
      text: string;
      display_name: string | null;
      is_bot: number;
      message_id: string | null;
    }[];

    return rows.map((row) => ({
      timestamp: row.timestamp,
      userId: row.user_id ?? undefined,
      groupId: row.group_id ?? undefined,
      type: row.msg_type as "group" | "private",
      text: row.text,
      displayName: row.display_name ?? undefined,
      isBot: row.is_bot === 1,
      messageId: row.message_id ?? undefined,
    }));
  }

  listActiveGroups(limit = 20): ActiveGroupInfo[] {
    const rows = this.db.prepare(`
      SELECT group_id, MAX(timestamp) as last_message_at
      FROM messages
      WHERE msg_type = 'group' AND group_id IS NOT NULL
      GROUP BY group_id
      ORDER BY last_message_at DESC
      LIMIT ?
    `).all(limit) as { group_id: string; last_message_at: number }[];

    return rows.map((r) => ({
      groupId: r.group_id,
      lastMessageAt: r.last_message_at,
    }));
  }

  /**
   * 获取某条消息周围的上下文（前后各 N 条），用于按 message_id 查找对话上下文。
   */
  getMessageContext(messageId: string, before = 5, after = 5): ChatMessageRecord[] {
    // 先查目标消息
    const target = this.db.prepare(`
      SELECT timestamp, group_id, user_id, msg_type
      FROM messages WHERE message_id = ? LIMIT 1
    `).get(messageId) as { timestamp: number; group_id: string | null; user_id: string | null; msg_type: string } | undefined;

    if (!target) return [];

    // 确定 scope：群聊按 group_id，私聊按 user_id
    const scopeCondition = target.msg_type === "group" && target.group_id
      ? "group_id = ?"
      : "user_id = ?";
    const scopeValue = target.msg_type === "group" ? target.group_id : target.user_id;

    const selectCols = "timestamp, user_id, group_id, msg_type, text, display_name, is_bot, message_id";

    // 查前面的消息
    const beforeRows = this.db.prepare(`
      SELECT ${selectCols} FROM messages
      WHERE ${scopeCondition} AND timestamp <= ? AND message_id != ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(scopeValue, target.timestamp, messageId, before) as Array<{
      timestamp: number; user_id: string | null; group_id: string | null;
      msg_type: string; text: string; display_name: string | null;
      is_bot: number; message_id: string | null;
    }>;

    // 查后面的消息
    const afterRows = this.db.prepare(`
      SELECT ${selectCols} FROM messages
      WHERE ${scopeCondition} AND timestamp >= ? AND message_id != ?
      ORDER BY timestamp ASC LIMIT ?
    `).all(scopeValue, target.timestamp, messageId, after) as Array<{
      timestamp: number; user_id: string | null; group_id: string | null;
      msg_type: string; text: string; display_name: string | null;
      is_bot: number; message_id: string | null;
    }>;

    // 查目标消息本身
    const targetRow = this.db.prepare(`
      SELECT ${selectCols} FROM messages WHERE message_id = ? LIMIT 1
    `).get(messageId) as {
      timestamp: number; user_id: string | null; group_id: string | null;
      msg_type: string; text: string; display_name: string | null;
      is_bot: number; message_id: string | null;
    } | undefined;

    const toRecord = (row: typeof beforeRows[0]): ChatMessageRecord => ({
      timestamp: row.timestamp,
      userId: row.user_id ?? undefined,
      groupId: row.group_id ?? undefined,
      type: row.msg_type as "group" | "private",
      text: row.text,
      displayName: row.display_name ?? undefined,
      isBot: row.is_bot === 1,
      messageId: row.message_id ?? undefined,
    });

    const result: ChatMessageRecord[] = [];
    // before 是 DESC 顺序，需要反转为 ASC
    for (let i = beforeRows.length - 1; i >= 0; i--) {
      result.push(toRecord(beforeRows[i]));
    }
    if (targetRow) result.push(toRecord(targetRow));
    for (const row of afterRows) {
      result.push(toRecord(row));
    }

    return result;
  }

  /**
   * 查询 bot 与指定用户之间的互动消息（双向：用户发的 + bot 回复该用户的）。
   */
  queryInteraction(userId: string, opts: {
    groupId?: string;
    startTime?: number;
    endTime?: number;
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
  } = {}): ChatMessageRecord[] {
    const limit = Math.min(opts.limit ?? 50, 1000);
    const offset = Math.max(0, opts.offset ?? 0);
    const orderSql = (opts.order ?? "desc") === "asc" ? "ASC" : "DESC";

    const conditions: string[] = [
      "(user_id = ? AND is_bot = 0) OR (user_id = ? AND is_bot = 1)",
    ];
    const params: unknown[] = [userId, userId];

    if (opts.groupId) {
      conditions.push("group_id = ?");
      params.push(opts.groupId);
    }
    if (opts.startTime) {
      conditions.push("timestamp >= ?");
      params.push(opts.startTime);
    }
    if (opts.endTime) {
      conditions.push("timestamp <= ?");
      params.push(opts.endTime);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;
    const sql = `SELECT timestamp, user_id, group_id, msg_type, text, display_name, is_bot, message_id FROM messages ${whereClause} ORDER BY timestamp ${orderSql} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as {
      timestamp: number; user_id: string | null; group_id: string | null;
      msg_type: string; text: string; display_name: string | null;
      is_bot: number; message_id: string | null;
    }[];

    return rows.map((row) => ({
      timestamp: row.timestamp,
      userId: row.user_id ?? undefined,
      groupId: row.group_id ?? undefined,
      type: row.msg_type as "group" | "private",
      text: row.text,
      displayName: row.display_name ?? undefined,
      isBot: row.is_bot === 1,
      messageId: row.message_id ?? undefined,
    }));
  }

  // ── Internal helpers ────────────────────────────────────────────

  /**
   * Reconstruct MessageStoreRecord[] from flat message rows.
   * Groups by (record_kind, base timestamp) to rebuild the original records.
   */
  private reconstructRecords(rows: MessageRow[]): MessageStoreRecord[] {
    const records: MessageStoreRecord[] = [];
    // Group by the base timestamp (bot replies have timestamp + 1, so we use the user msg timestamp)
    const groups = new Map<number, MessageRow[]>();

    for (const row of rows) {
      // The base timestamp is the row's own timestamp for user msgs,
      // or timestamp - 1 for bot replies
      const baseTs = row.is_bot === 1 ? row.timestamp - 1 : row.timestamp;
      let group = groups.get(baseTs);
      if (!group) {
        group = [];
        groups.set(baseTs, group);
      }
      group.push(row);
    }

    for (const [, group] of groups) {
      const kind = group[0].record_kind;
      const baseTs = group[0].is_bot === 1 ? group[0].timestamp - 1 : group[0].timestamp;
      const userRows = group.filter((r) => r.is_bot === 0);
      const botRow = group.find((r) => r.is_bot === 1);

      if (kind === "inbound" && userRows.length > 0) {
        const msg = this.rowToBotMessage(userRows[0]);
        records.push({ kind: "inbound", timestamp: baseTs, message: msg });
      } else if (kind === "reply" && userRows.length > 0 && botRow) {
        const msg = this.rowToBotMessage(userRows[0]);
        records.push({
          kind: "reply",
          timestamp: baseTs,
          message: msg,
          response: botRow.text,
        });
      } else if (kind === "batch_reply" && userRows.length > 0 && botRow) {
        const messages = userRows.map((r) => this.rowToBotMessage(r));
        records.push({
          kind: "batch_reply",
          timestamp: baseTs,
          messages,
          response: botRow.text,
        });
      }
    }

    return records.sort((a, b) => a.timestamp - b.timestamp);
  }

  private rowToBotMessage(row: MessageRow): BotMessage {
    const sender: { card?: string; nickname?: string } = {};
    if (row.display_name) {
      sender.card = row.display_name;
    }

    // Try to reconstruct from message_json if available
    if (row.message_json) {
      try {
        const parsed = JSON.parse(row.message_json) as BotMessage;
        if (!parsed.raw) {
          parsed.raw = { sender } as BotMessage["raw"];
        } else if (!(parsed.raw as Record<string, unknown>).sender) {
          (parsed.raw as Record<string, unknown>).sender = sender;
        }
        return parsed;
      } catch { /* fall through */ }
    }
    // Minimal reconstruction from column data
    return {
      id: row.message_id ?? undefined,
      type: row.msg_type as "group" | "private",
      userId: row.user_id ?? undefined,
      groupId: row.group_id ?? undefined,
      text: row.text,
      raw: { sender } as BotMessage["raw"],
    };
  }

  // ── Extracted memories (migrated from mem0) ──────────────────

  queryExtractedMemories(opts: {
    userId?: string;
    type?: string;
    types?: string[];
    scope?: string;
    keyword?: string;
    limit?: number;
  }): ExtractedMemory[] {
    const limit = Math.min(opts.limit ?? 50, 200);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.userId) {
      conditions.push("user_id = ?");
      params.push(opts.userId);
    }
    if (opts.types && opts.types.length > 0) {
      const placeholders = opts.types.map(() => "?").join(", ");
      conditions.push(`type IN (${placeholders})`);
      params.push(...opts.types);
    } else if (opts.type) {
      conditions.push("type = ?");
      params.push(opts.type);
    }
    if (opts.scope) {
      conditions.push("scope = ?");
      params.push(opts.scope);
    }
    if (opts.keyword) {
      conditions.push("LOWER(content) LIKE ?");
      params.push(`%${opts.keyword.toLowerCase()}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT id, source_id, type, user_id, attributed_to, content, scope, created_at, updated_at, metadata, imported_at, access_count, last_accessed_at FROM extracted_memories ${whereClause} ORDER BY id DESC LIMIT ?`;
    params.push(limit);

    return this.db.prepare(sql).all(...params) as ExtractedMemory[];
  }

  insertExtractedMemory(entry: {
    userId: string;
    content: string;
    type?: string;
    attributedTo?: string;
    scope?: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT INTO extracted_memories (type, user_id, attributed_to, content, scope, metadata, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.type ?? "extracted_fact",
      entry.userId,
      entry.attributedTo ?? "llm_extractor",
      entry.content,
      entry.scope ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      Date.now(),
    );
  }

  /** Retrieve all facts for a user (for keyword-based relevance scoring). */
  getAllUserFacts(userId: string): ExtractedMemory[] {
    return this.db.prepare(`
      SELECT id, source_id, type, user_id, attributed_to, content, scope,
             created_at, updated_at, metadata, imported_at, access_count, last_accessed_at
      FROM extracted_memories
      WHERE user_id = ? AND type IN ('mem0_fact', 'extracted_fact')
      ORDER BY id DESC
    `).all(userId) as ExtractedMemory[];
  }

  /** Increment access_count and update last_accessed_at for the given fact IDs. */
  bumpFactAccess(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`
      UPDATE extracted_memories
      SET access_count = access_count + 1, last_accessed_at = ?
      WHERE id IN (${placeholders})
    `).run(Date.now(), ...ids);
  }

  // ── Conversation snapshots ──────────────────────────────────────────────

  getConversationSnapshot(scope: string): unknown[] | null {
    const row = this.db.prepare("SELECT data FROM conversation_snapshots WHERE scope = ?").get(scope) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  saveConversationSnapshot(scope: string, messages: unknown[]): void {
    this.db.prepare(`
      INSERT INTO conversation_snapshots (scope, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(scope, JSON.stringify(messages), Date.now());
  }

  deleteConversationSnapshot(scope: string): void {
    this.db.prepare("DELETE FROM conversation_snapshots WHERE scope = ?").run(scope);
  }

  getAllConversationSnapshots(): Map<string, unknown[]> {
    const rows = this.db.prepare("SELECT scope, data FROM conversation_snapshots").all() as Array<{ scope: string; data: string }>;
    const map = new Map<string, unknown[]>();
    for (const row of rows) {
      try {
        map.set(row.scope, JSON.parse(row.data));
      } catch {
        // skip corrupted entries
      }
    }
    return map;
  }

  // ── ContextManager state persistence ────────────────────────────────────

  saveContextState(scope: string, data: unknown): void {
    this.db.prepare(`
      INSERT INTO context_states (scope, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(scope, JSON.stringify(data), Date.now());
  }

  getContextState(scope: string): unknown | null {
    const row = this.db.prepare("SELECT data FROM context_states WHERE scope = ?").get(scope) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data);
    } catch {
      return null;
    }
  }

  deleteContextState(scope: string): void {
    this.db.prepare("DELETE FROM context_states WHERE scope = ?").run(scope);
  }

  getAllContextStateKeys(): string[] {
    const rows = this.db.prepare("SELECT scope FROM context_states").all() as Array<{ scope: string }>;
    return rows.map((r) => r.scope);
  }

  // ── User profiles ───────────────────────────────────────────────────────

  getUserProfile(userId: string): UserProfile | null {
    const row = this.db.prepare("SELECT data FROM user_profiles WHERE user_id = ?").get(userId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as UserProfile : null;
  }

  saveUserProfile(userId: string, data: UserProfile): void {
    this.db.prepare(`
      INSERT INTO user_profiles (user_id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(userId, JSON.stringify(data), Date.now());
  }

  getAllUserProfiles(): Array<{ userId: string; profile: UserProfile }> {
    const rows = this.db.prepare("SELECT user_id, data FROM user_profiles").all() as Array<{ user_id: string; data: string }>;
    const result: Array<{ userId: string; profile: UserProfile }> = [];
    for (const row of rows) {
      try {
        result.push({ userId: row.user_id, profile: JSON.parse(row.data) as UserProfile });
      } catch {
        // skip corrupted entries
      }
    }
    return result;
  }

  // ── Item definitions ────────────────────────────────────────────────────

  getItemDef(itemId: string): ItemDef | undefined {
    const row = this.db.prepare("SELECT data FROM item_defs WHERE item_id = ?").get(itemId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as ItemDef : undefined;
  }

  getAllItemDefs(): ItemDef[] {
    const rows = this.db.prepare("SELECT data FROM item_defs").all() as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as ItemDef);
  }

  saveItemDef(item: ItemDef): void {
    this.db.prepare(`
      INSERT INTO item_defs (item_id, data) VALUES (?, ?)
      ON CONFLICT(item_id) DO UPDATE SET data = excluded.data
    `).run(item.id, JSON.stringify(item));
  }

  // ── MMORPG entities ─────────────────────────────────────────────────────

  getMMORPGEntity(category: string, entityId: string): unknown | null {
    const row = this.db.prepare("SELECT data FROM mmorpg_entities WHERE category = ? AND entity_id = ?").get(category, entityId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  saveMMORPGEntity(category: string, entityId: string, data: unknown): void {
    this.db.prepare(`
      INSERT INTO mmorpg_entities (category, entity_id, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(category, entity_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(category, entityId, JSON.stringify(data), Date.now());
  }

  deleteMMORPGEntity(category: string, entityId: string): void {
    this.db.prepare("DELETE FROM mmorpg_entities WHERE category = ? AND entity_id = ?").run(category, entityId);
  }

  getAllMMORPGEntities(category: string): Record<string, unknown> {
    const rows = this.db.prepare("SELECT entity_id, data FROM mmorpg_entities WHERE category = ?").all(category) as Array<{ entity_id: string; data: string }>;
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.entity_id] = JSON.parse(row.data);
      } catch {
        // skip corrupted entries
      }
    }
    return result;
  }

  // ── MMORPG world state ──────────────────────────────────────────────────

  getMMORPGWorld(): unknown | null {
    const row = this.db.prepare("SELECT data FROM mmorpg_world WHERE id = 1").get() as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  saveMMORPGWorld(data: unknown): void {
    this.db.prepare(`
      INSERT INTO mmorpg_world (id, data, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(JSON.stringify(data), Date.now());
  }

  /** Close the database connection (for graceful shutdown). */
  close() {
    this.db.close();
  }
}

// ── Helper types and functions ────────────────────────────────────

type MessageRow = {
  id?: number;
  timestamp: number;
  user_id: string | null;
  group_id: string | null;
  msg_type: string;
  text: string;
  display_name: string | null;
  is_bot: number;
  record_kind: string;
  message_id: string | null;
  message_json: string | null;
};

export function extractDisplayName(message: BotMessage): string | null {
  const sender = getRawSender(message.raw);
  const groupCard = normalizeDisplayName(sender.card);
  if (groupCard) return groupCard;

  const nickname = normalizeDisplayName(sender.nickname);
  if (nickname) return nickname;

  return null;
}

function safeJsonParse(line: string): MessageStoreRecord | LegacyStoredMessage | null {
  try {
    return JSON.parse(line) as MessageStoreRecord | LegacyStoredMessage;
  } catch {
    return null;
  }
}

function normalizeRecord(parsed: MessageStoreRecord | LegacyStoredMessage): MessageStoreRecord | null {
  if ("kind" in parsed) {
    if (parsed.kind === "inbound") return parsed;
    if (parsed.kind === "reply" && typeof parsed.response === "string") return parsed;
    if (parsed.kind === "batch_reply" && Array.isArray(parsed.messages) && typeof parsed.response === "string") return parsed;
    return null;
  }

  if (typeof parsed.response === "string") {
    return {
      kind: "reply",
      timestamp: parsed.timestamp,
      message: parsed.message,
      response: parsed.response,
    };
  }

  return {
    kind: "inbound",
    timestamp: parsed.timestamp,
    message: parsed.message,
  };
}

function getRawSender(raw: BotMessage["raw"]): { card?: unknown; nickname?: unknown } {
  if (!raw) return {};
  const sender = raw.sender;
  if (!sender || typeof sender !== "object") return {};
  return sender as { card?: unknown; nickname?: unknown };
}

function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Strip the large `raw` field from BotMessage before JSON storage to save space. */
function stripRaw(msg: BotMessage): Omit<BotMessage, "raw"> & { raw?: unknown } {
  const { raw: _raw, ...rest } = msg;
  return rest;
}

function safeStringify(obj: unknown): string | null {
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}
