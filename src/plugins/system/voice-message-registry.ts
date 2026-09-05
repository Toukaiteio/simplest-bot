import fs from "node:fs";
import path from "node:path";

/**
 * 语音消息内容注册表（持久化）。
 *
 * 当 bot 通过 TTS 发送语音时，它知道这条语音实际朗读的文本；而用户引用（回复）
 * 这条语音时，底层消息只有 `[CQ:record,...]`/`[语音 文件]` 占位信息，bot 无法得知
 * 自己当时到底说了什么。为了让 bot 能正确理解被引用的语音内容，这里维护一个
 * 共享注册表：`messageId -> 该语音实际朗读的文本`，并持久化到磁盘，保证重启后仍可回溯。
 *
 * 使用方式：启动时调用 initVoiceMessageRegistry(dataFile) 加载；TTS 发送后调用
 * registerVoiceMessageText() 写入（自动落盘）；解析引用时调用 getVoiceMessageText() 查询。
 * 对于未知语音（不在表中），保持原有 `[语音 文件]` 占位处理，不尝试额外猜测。
 */

type VoiceRegistryState = Record<string, string>;

/** 单个语音结束写入后自动落盘前的延迟（毫秒）。 */
const SAVE_DEBOUNCE_MS = 300;

let store: VoiceRegistryState = Object.create(null);
let dataFile: string | null = null;
let saveTimer: NodeJS.Timeout | null = null;

/**
 * 初始化注册表：加载持久化数据并清理过期条目。可在启动时调用一次。
 * 未初始化时 register/get 仍可用（仅作用于内存），但不会落盘。
 */
export function initVoiceMessageRegistry(filePath: string): void {
  const resolved = path.resolve(process.cwd(), filePath);
  dataFile = resolved;
  try {
    if (fs.existsSync(resolved)) {
      const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        store = parsed as VoiceRegistryState;
      }
    }
  } catch (error) {
    console.error(`[VoiceRegistry] 读取语音注册表失败：${resolved}`, error);
    store = Object.create(null);
  }
  pruneExpired();
}

/** 记录一条已发送语音消息与其实际朗读文本的对应关系，并安排落盘。 */
export function registerVoiceMessageText(messageId: string, spokenText: string): void {
  if (!messageId) return;
  const text = spokenText.trim();
  if (!text) return;
  store[messageId] = text;
  pruneExpired();
  scheduleSave();
}

/**
 * 查询指定 messageId 对应的语音内容。若该消息不是已知的 bot 语音，返回 null。
 */
export function getVoiceMessageText(messageId: string): string | null {
  const text = store[messageId];
  return typeof text === "string" && text ? text : null;
}

function pruneExpired(): void {
  // 条目使用 messageId -> text 的扁平结构，不带时间戳；为避免无限增长，
  // 通过条数上限做物理淘汰：超过上限时丢弃最旧写入的条目。
  const keys = Object.keys(store);
  if (keys.length <= 5000) return;
  const overflow = keys.length - 4000;
  for (let i = 0; i < overflow; i++) {
    delete store[keys[i]];
  }
  scheduleSave();
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
    fs.writeFileSync(dataFile, JSON.stringify(store, null, 2), "utf-8");
  } catch (error) {
    console.error(`[VoiceRegistry] 写入语音注册表失败：${dataFile}`, error);
  }
}