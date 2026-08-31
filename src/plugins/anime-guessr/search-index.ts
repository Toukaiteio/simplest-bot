/**
 * 猜动漫人物 - 搜索索引
 * 支持：中文名、日文名、别名、纯拼音、拼音首字母、复合匹配、特殊字符归一化
 */

import { pinyin } from "pinyin-pro";
import type { AnimeCharacter } from "./types.js";

// ===== 归一化 =====

/** 去除特殊分隔符（· . = - _ 空格等），统一为无分隔小写 */
function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[·・.．=＝\-_\-–—\s\u3000]/g, "")
    .replace(/[（(]\s*/g, "")
    .replace(/\s*[)）]/g, "");
}

/**
 * Bangumi 名称经常使用「A / B」「A／B」并列角色名与本名。
 * 整体名称和每个有效组成部分都应成为独立精确检索键。
 */
function expandNameVariants(raw: string): string[] {
  const parts = raw.split(/\s*[\/／|｜]\s*/).map((part) => part.trim()).filter(Boolean);
  return [...new Set([raw, ...parts])];
}

/** 获取中文文本的完整拼音（无声调，无空格） */
function toPinyinFull(text: string): string {
  return pinyin(text, { toneType: "none", type: "array" })
    .join("")
    .toLowerCase();
}

/** 获取中文文本的拼音首字母 */
function toPinyinInitials(text: string): string {
  return pinyin(text, { toneType: "none", pattern: "first", type: "array" })
    .join("")
    .toLowerCase();
}

// ===== 索引条目 =====

type IndexEntry = {
  char: AnimeCharacter;
  /** 所有可匹配的归一化形式 */
  keys: string[];
  /** 拼音全拼形式 */
  pinyinFull: string[];
  /** 拼音首字母形式 */
  pinyinInitials: string[];
};

let index: IndexEntry[] = [];
let workIndex: Map<string, AnimeCharacter[]> = new Map(); // 作品名归一化 -> 角色列表

// ===== 构建索引 =====

export function buildSearchIndex(database: AnimeCharacter[]): void {
  index = [];
  workIndex = new Map();

  for (const char of database) {
    const keys: string[] = [];
    const pyFull: string[] = [];
    const pyInitials: string[] = [];

    // 收集所有名称变体
    const rawNames = [char.name, char.nameCn, ...(char.aliases ?? [])].filter(Boolean) as string[];
    const names = [...new Set(rawNames.flatMap(expandNameVariants))];

    for (const name of names) {
      const norm = normalize(name);
      if (norm) keys.push(norm);

      // 对含中文的名称生成拼音
      if (/[\u4e00-\u9fff]/.test(name)) {
        const full = toPinyinFull(name);
        const initials = toPinyinInitials(name);
        if (full) pyFull.push(full);
        if (initials) pyInitials.push(initials);
        // 归一化拼音也加入 keys
        if (full) keys.push(full);
        if (initials) keys.push(initials);
      }
    }

    index.push({ char, keys, pinyinFull: pyFull, pinyinInitials: pyInitials });

    // 作品名索引
    for (const app of char.appearances ?? []) {
      const workNames = [app.name, app.nameCn].filter(Boolean) as string[];
      for (const wn of workNames) {
        const wNorm = normalize(wn);
        if (!wNorm) continue;
        if (!workIndex.has(wNorm)) workIndex.set(wNorm, []);
        const list = workIndex.get(wNorm)!;
        if (!list.some((c) => c.id === char.id)) list.push(char);
      }
    }
  }
}

// ===== 搜索 =====

export type SearchMatch = {
  char: AnimeCharacter;
  score: number;
  matchedField: string;
};

/**
 * 综合搜索：支持原文、拼音全拼、首字母、复合、部分匹配
 */
export function searchIndex(query: string, limit = 8): SearchMatch[] {
  const q = normalize(query);
  if (!q) return [];

  const results: SearchMatch[] = [];

  for (const entry of index) {
    let bestScore = 0;
    let bestField = "";

    // 1. 精确匹配（归一化后）
    for (const key of entry.keys) {
      if (key === q) {
        bestScore = 100;
        bestField = "精确";
        break;
      }
    }

    // 2. 拼音全拼精确
    if (bestScore < 100) {
      for (const py of entry.pinyinFull) {
        if (py === q) { bestScore = 95; bestField = "拼音"; break; }
      }
    }

    // 3. 首字母精确
    if (bestScore < 95) {
      for (const ini of entry.pinyinInitials) {
        if (ini === q) { bestScore = 90; bestField = "首字母"; break; }
      }
    }

    // 4. 前缀/包含匹配
    if (bestScore < 90) {
      for (const key of entry.keys) {
        if (key.startsWith(q) && q.length >= 2) {
          const s = 75 + Math.min(10, q.length);
          if (s > bestScore) { bestScore = s; bestField = "前缀"; }
        } else if (key.includes(q) && q.length >= 2) {
          const s = 60 + Math.min(10, q.length);
          if (s > bestScore) { bestScore = s; bestField = "包含"; }
        }
      }
    }

    // 5. 拼音前缀
    if (bestScore < 60) {
      for (const py of entry.pinyinFull) {
        if (py.startsWith(q) && q.length >= 3) {
          bestScore = 55; bestField = "拼音前缀"; break;
        }
      }
    }

    if (bestScore > 0) {
      results.push({ char: entry.char, score: bestScore, matchedField: bestField });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || b.char.popularity - a.char.popularity)
    .slice(0, limit);
}

/**
 * 搜索作品名
 */
export function searchWorks(query: string, limit = 8): { name: string; nameCn: string; characters: AnimeCharacter[]; score: number }[] {
  const q = normalize(query);
  if (!q) return [];

  const results: { name: string; nameCn: string; characters: AnimeCharacter[]; score: number }[] = [];

  for (const [key, chars] of workIndex) {
    let score = 0;
    if (key === q) score = 100;
    else if (key.startsWith(q) && q.length >= 2) score = 80;
    else if (key.includes(q) && q.length >= 2) score = 60;

    if (score > 0 && chars.length > 0) {
      const sample = chars[0].appearances.find((a) => normalize(a.nameCn || a.name) === key);
      results.push({
        name: sample?.name ?? key,
        nameCn: sample?.nameCn ?? key,
        characters: chars,
        score,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || b.characters.length - a.characters.length)
    .slice(0, limit);
}

/**
 * 获取某作品的所有角色
 */
export function getCharactersByWork(workName: string): AnimeCharacter[] {
  const q = normalize(workName);
  return workIndex.get(q) ?? [];
}
