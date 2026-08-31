/**
 * 猜动漫人物 - 数据加载
 */

import fs from "node:fs";
import path from "node:path";
import type { AnimeCharacter } from "./types.js";

let cache: AnimeCharacter[] | null = null;
let cachePath: string | null = null;

/**
 * 加载角色数据库。带内存缓存，文件变更时自动重载。
 */
export function loadCharacterDatabase(filePath: string): AnimeCharacter[] {
  const resolved = path.resolve(process.cwd(), filePath);

  if (cache && cachePath === resolved) {
    return cache;
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`角色数据文件不存在: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, "utf-8");
  const data = JSON.parse(raw) as AnimeCharacter[];

  // 基本校验
  const valid = data.filter(
    (c) => c.id && c.name && Array.isArray(c.appearances)
  );

  cache = valid;
  cachePath = resolved;
  return valid;
}

/**
 * 清除缓存（用于测试或热更新）
 */
export function clearCache(): void {
  cache = null;
  cachePath = null;
}
