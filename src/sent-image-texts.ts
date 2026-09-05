import fs from "node:fs";
import path from "node:path";

/**
 * 已发送“图片型消息”的原文注册表（持久化）。
 *
 * 背景：markdown-image 等插件会把 bot 的长文本 / Markdown 回复渲染成图片发送。
 * 用户随后引用该图片消息时，从 QQ 拿回的是纯图片段（extractText → `[图片 file=...]`），
 * 原文已经丢失，导致 AI 只能看到一个占位符。本模块在发送图片成功时记录
 * “该图片消息 message_id ↔ 生成它的原文文本”，引用解析时即可还原成文本传给 AI。
 *
 * 采用内存 Map + 磁盘 JSON 持久化（对齐 voice-message-registry 的方案），
 * 保证重启后仍可回溯“很久之前发送的图片消息”。
 */
export type SentImageTextRecord = {
  /** 生成该图片的原始文本（如 markdown 原文）。 */
  text: string;
  userId?: string;
  groupId?: string;
  type: "group" | "private";
  relTarget: { type: "group" | "private"; id: string };
};

type Entry = {
  record: SentImageTextRecord;
  expiresAt: number;
};

type PersistedState = Record<string, Entry>;

const registry = new Map<string, Entry>();

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天：覆盖“很久之前发送的图片消息被引用”的场景
const MAX_ENTRIES = 5000;
const SAVE_DEBOUNCE_MS = 300;

let ttlMs = DEFAULT_TTL_MS;
let dataFile: string | null = null;
let saveTimer: NodeJS.Timeout | null = null;

/**
 * 初始化注册表：加载持久化数据并清理过期条目。启动时调用一次。
 * 未初始化时 register/get 仍可用（仅作用于内存），但不会落盘。
 */
export function initSentImageTexts(filePath: string): void {
  const resolved = path.resolve(process.cwd(), filePath);
  dataFile = resolved;
  try {
    if (fs.existsSync(resolved)) {
      const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [msgId, entry] of Object.entries(parsed as PersistedState)) {
          if (entry && typeof entry === "object" && entry.record && typeof entry.record.text === "string") {
            registry.set(msgId, { record: entry.record, expiresAt: Number(entry.expiresAt) || 0 });
          }
        }
      }
    }
  } catch (error) {
    console.error(`[SentImageTexts] 读取图片原文注册表失败：${resolved}`, error);
    registry.clear();
  }
  if (evictExpired()) scheduleSave();
}

export function configureSentImageTexts(options: { ttlMs?: number }): void {
  if (typeof options.ttlMs === "number" && options.ttlMs > 0) {
    ttlMs = options.ttlMs;
  }
}

/** 记录一个已发送图片消息的原文。msgId 由 onebot 发送图片消息后返回的真实 message_id。 */
export function registerSentImageText(rawMsgId: string | number, record: SentImageTextRecord): SentImageTextRecord {
  const msgId = String(rawMsgId ?? "");
  if (!msgId) return record;
  evictExpired();
  if (registry.size >= MAX_ENTRIES && !registry.has(msgId)) {
    // 容量封顶：淘汰最早一条（Map 保持插入序）。
    const oldestKey = registry.keys().next().value as string | undefined;
    if (oldestKey) registry.delete(oldestKey);
  }
  registry.set(msgId, { record, expiresAt: Date.now() + ttlMs });
  scheduleSave();
  return record;
}

/** 查询某图片消息的原文；命中且未过期时返回记录，否则 null。 */
export function lookupSentImageText(rawMsgId: string): SentImageTextRecord | null {
  const msgId = String(rawMsgId ?? "");
  const entry = registry.get(msgId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    registry.delete(msgId);
    scheduleSave();
    return null;
  }
  return entry.record;
}

function evictExpired(): boolean {
  const now = Date.now();
  let removed = false;
  for (const [key, entry] of registry) {
    if (now > entry.expiresAt) {
      registry.delete(key);
      removed = true;
    }
  }
  return removed;
}

function scheduleSave(): void {
  if (!dataFile) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, SAVE_DEBOUNCE_MS);
}

function persist(): void {
  if (!dataFile) return;
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const state: PersistedState = Object.create(null);
    for (const [msgId, entry] of registry) {
      state[msgId] = entry;
    }
    fs.writeFileSync(dataFile, JSON.stringify(state, null, 2), "utf-8");
  } catch (error) {
    console.error(`[SentImageTexts] 写入图片原文注册表失败：${dataFile}`, error);
  }
}

/** 仅供测试/诊断：清空注册表。 */
export function clearSentImageTexts(): void {
  registry.clear();
  scheduleSave();
}
