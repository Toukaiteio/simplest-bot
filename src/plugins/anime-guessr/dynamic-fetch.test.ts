/** 真实 Bangumi API 冒烟测试：pnpm exec tsx src/plugins/anime-guessr/dynamic-fetch.test.ts */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchCharacterById, fetchWorkContribution, initDynamicFetch, searchBangumiCharacterCandidates } from "./dynamic-fetch.js";
import type { AnimeCharacter } from "./types.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anime-guessr-"));
const dataFile = path.join(tempDir, "characters.json");
const database: AnimeCharacter[] = [];
let rebuildCount = 0;

try {
  fs.writeFileSync(dataFile, "[]", "utf8");
  initDynamicFetch(database, dataFile, () => { rebuildCount += 1; }, { backgroundCharactersPerWork: 0 });
  const candidates = await searchBangumiCharacterCandidates("夜神月", 5);
  assert.equal(database.length, 0, "轻量搜索不得写入角色库或展开详情");
  const lightCandidate = candidates.find((character) => character.id === 2215);
  assert(lightCandidate, "轻量搜索应返回夜神月候选");
  const light = await fetchCharacterById(lightCandidate.id);
  assert(light, "应从 Bangumi 找到夜神月（ID 2215）");
  assert(light.appearances.some((appearance) => appearance.nameCn.includes("死亡笔记")), "应包含动画作品资料");
  assert(light.aliases.some((alias) => alias.toLowerCase().includes("yagami light")), "应解析别名");
  assert(light.tags.includes("棕发") && light.tags.includes("腹黑"), "应加载角色自身标签");
  assert(light.tags.includes("TV") && light.tags.includes("漫画改"), "应合并出演作品标签");
  assert.equal(light.hairColor, "棕发", "应从角色标签同步发色");
  assert.equal(light.eyeColor, "棕瞳", "应从角色标签同步瞳色");
  assert.equal(database.some((character) => character.id === 2215), true, "应加入内存数据库");
  assert.equal(rebuildCount, 1, "入库后应重建一次搜索索引");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const persisted = JSON.parse(fs.readFileSync(dataFile, "utf8")) as AnimeCharacter[];
  assert.equal(persisted.some((character) => character.id === 2215), true, "应持久化到数据文件");
  const workPreview = await fetchWorkContribution("死亡笔记", 2);
  assert(workPreview, "应按中文作品名找到死亡笔记动画");
  assert.equal(workPreview.work.id, 1773, "应优先选择名称精确匹配的动画条目");
  assert(workPreview.characters.length > 0 && workPreview.characters.length <= 2, "应按限制获取作品角色");
  assert(workPreview.characters.every((character) => character.appearances.some((appearance) => appearance.id === workPreview.work.id)), "角色资料应包含目标作品");
  console.log("✅ Bangumi 动态查询、资料转换、索引回调和持久化均正常");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
