import fs from "node:fs";
import path from "node:path";
import type { BotMessage } from "./types.js";

export type MessageStoreRecord =
  | {
      kind: "inbound";
      timestamp: number;
      message: BotMessage;
    }
  | {
      kind: "reply";
      timestamp: number;
      message: BotMessage;
      response: string;
    }
  | {
      kind: "batch_reply";
      timestamp: number;
      messages: BotMessage[];
      response: string;
    };

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

export class MessageStore {
  private dbPath: string;

  constructor(dbPath = "data/messages.jsonl") {
    this.dbPath = path.resolve(process.cwd(), dbPath);
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  appendIncoming(message: BotMessage) {
    this.writeRecord({
      kind: "inbound",
      timestamp: Date.now(),
      message,
    });
  }

  appendReply(message: BotMessage, response: string) {
    this.writeRecord({
      kind: "reply",
      timestamp: Date.now(),
      message,
      response,
    });
  }

  appendBatchReply(messages: BotMessage[], response: string) {
    if (messages.length === 0) {
      return;
    }
    this.writeRecord({
      kind: "batch_reply",
      timestamp: Date.now(),
      messages,
      response,
    });
  }

  getRecordsBetween(startTime: number, endTime: number): MessageStoreRecord[] {
    if (!fs.existsSync(this.dbPath)) {
      return [];
    }

    const content = fs.readFileSync(this.dbPath, "utf-8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    const records: MessageStoreRecord[] = [];

    for (const line of lines) {
      const parsed = safeJsonParse(line);
      if (!parsed) continue;

      const record = normalizeRecord(parsed);
      if (!record) continue;
      if (record.timestamp < startTime || record.timestamp >= endTime) continue;

      records.push(record);
    }

    return records;
  }

  getLatestKnownDisplayName(userId: string, groupId?: string): string | null {
    if (!fs.existsSync(this.dbPath)) {
      return null;
    }

    const content = fs.readFileSync(this.dbPath, "utf-8");
    const lines = content.split(/\r?\n/).filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = safeJsonParse(lines[index]);
      if (!parsed) continue;

      const record = normalizeRecord(parsed);
      if (!record) continue;
      if (record.kind === "batch_reply") continue;
      if (record.message.userId !== userId) continue;
      if (groupId && record.message.groupId !== groupId) continue;

      const displayName = extractDisplayName(record.message);
      if (displayName) {
        return displayName;
      }
    }

    return null;
  }

  findMessageById(messageId: string): BotMessage | null {
    if (!fs.existsSync(this.dbPath)) {
      return null;
    }

    const content = fs.readFileSync(this.dbPath, "utf-8");
    const lines = content.split(/\r?\n/).filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = safeJsonParse(lines[index]);
      if (!parsed) continue;

      const record = normalizeRecord(parsed);
      if (!record) continue;
      if (record.kind === "batch_reply") continue;
      if (record.message.id !== messageId) continue;

      return record.message;
    }

    return null;
  }

  getRecentConversationTurns(scope: ConversationScope, limit: number): StoredConversationTurn[] {
    if (!fs.existsSync(this.dbPath) || limit <= 0) {
      return [];
    }

    const content = fs.readFileSync(this.dbPath, "utf-8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    const turns: StoredConversationTurn[] = [];

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = safeJsonParse(lines[index]);
      if (!parsed) continue;

      const record = normalizeRecord(parsed);
      if (!record) continue;

      if (record.kind === "reply") {
        if (!matchesConversationScope(record.message, scope)) continue;
        turns.push({
          userText: formatConversationChunk([record.message]),
          assistantText: record.response,
        });
      } else if (record.kind === "batch_reply") {
        if (!record.messages.some((message) => matchesConversationScope(message, scope))) continue;
        turns.push({
          userText: formatConversationChunk(record.messages),
          assistantText: record.response,
        });
      } else {
        continue;
      }

      if (turns.length >= limit) {
        break;
      }
    }

    return turns.reverse();
  }

  private writeRecord(record: MessageStoreRecord) {
    fs.appendFileSync(this.dbPath, JSON.stringify(record) + "\n");
  }
}

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
    if (parsed.kind === "inbound") {
      return parsed;
    }
    if (parsed.kind === "reply" && typeof parsed.response === "string") {
      return parsed;
    }
    if (parsed.kind === "batch_reply" && Array.isArray(parsed.messages) && typeof parsed.response === "string") {
      return parsed;
    }
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
  const sender = raw.sender;
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

function matchesConversationScope(message: BotMessage, scope: ConversationScope): boolean {
  if (scope.type === "private") {
    return message.type === "private" && message.userId === scope.userId;
  }
  return message.type === "group" && message.groupId === scope.groupId;
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
