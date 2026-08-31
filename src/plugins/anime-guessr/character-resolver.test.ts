import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CharacterResolver } from "./character-resolver.js";
import type { AnimeCharacter } from "./types.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "guessr-resolver-"));
const cacheFile = path.join(tempDir, "cache.json");
let now = Date.UTC(2026, 6, 28);
let remoteCalls = 0;
let detailCalls = 0;

const localCharacter: AnimeCharacter = {
  id: 1, name: "Local", nameCn: "本地角色", aliases: [], gender: null,
  hairColor: null, eyeColor: null, popularity: 100, worksCount: 1,
  highestRating: null, latestYear: null, earliestYear: null, voiceActors: [],
  appearances: [], tags: [], image: "", tier: "S",
};

const makeResolver = () => new CharacterResolver({
  cacheFile, positiveTtlDays: 1, negativeTtlDays: 1,
  minRemoteIntervalMs: 0, dailyRemoteLimit: 20, now: () => now,
  searchLocal: (query) => query === "本地角色" ? [{ char: localCharacter, score: 100, matchedField: "精确" }] : [],
  findLocalById: (id) => id === 1 ? localCharacter : undefined,
  searchRemote: async (query) => {
    remoteCalls += 1;
    if (query === "不存在") return [];
    return [{ id: 99, name: "Remote", nameCn: "远端角色", aliases: ["远端别名"], popularity: 9, image: "" }];
  },
  fetchDetail: async (id) => {
    detailCalls += 1;
    return { ...localCharacter, id, name: "Remote", nameCn: "远端角色", tier: "dynamic" };
  },
});

try {
  const resolver = makeResolver();
  const local = await resolver.resolve("本地角色");
  assert.equal(local.source, "local");
  assert.equal(remoteCalls, 0, "本地高置信度不得调用 Bangumi");

  const [first, concurrent] = await Promise.all([resolver.resolve("陌生写法"), resolver.resolve("陌生写法")]);
  assert.equal(first.source, "bangumi-live");
  assert.equal(concurrent.candidates[0]?.id, 99);
  assert.equal(remoteCalls, 1, "相同关键词并发请求必须合并");
  assert.equal(detailCalls, 0, "搜索候选阶段不得获取完整详情");

  const selected = await resolver.materialize(first.candidates[0]);
  assert.equal(selected?.id, 99);
  assert.equal(detailCalls, 1, "用户选定后才获取完整详情");

  const cached = await makeResolver().resolve("陌生写法");
  assert.equal(cached.source, "bangumi-cache");
  assert.equal(remoteCalls, 1, "重启后应读取持久查询缓存");

  const learnedAlias = await makeResolver().resolve("远端别名");
  assert.equal(learnedAlias.candidates[0]?.id, 99);
  assert.equal(learnedAlias.candidates[0]?.matchedField, "Bangumi 已学习别名");
  assert.equal(remoteCalls, 1, "Bangumi 官方别名应从已有缓存复用，不再次请求");

  const negativeFirst = await resolver.resolve("不存在");
  const negativeSecond = await makeResolver().resolve("不存在");
  assert.equal(negativeFirst.candidates.length, 0);
  assert.equal(negativeSecond.source, "negative-cache");
  assert.equal(remoteCalls, 2, "负缓存命中不得重复请求");

  now += 2 * 24 * 60 * 60 * 1000;
  const stale = await resolver.resolve("陌生写法");
  assert.equal(stale.source, "bangumi-stale", "过期正缓存应立即返回旧候选");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(remoteCalls, 3, "过期正缓存应在后台刷新一次");
  console.log("✅ CharacterResolver 本地优先、持久缓存、singleflight、负缓存和按需详情正常");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
