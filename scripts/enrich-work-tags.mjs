/**
 * 为角色补充作品级标签（TV/剧场版/漫画改/小说改/原创/游戏改等）
 * 从 Bangumi subject tags 中提取，合并到角色的 tags 数组中
 *
 * 用法: node scripts/enrich-work-tags.mjs
 * 并发: 12 路
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CONCURRENCY = 12;
const DELAY_MS = 200;
const UA = "simplest-bot-anime-guessr/1.0";
const API = "https://api.bgm.tv";
const DATA_FILE = path.join(ROOT, "data", "anime-characters.json");
const PROGRESS_FILE = path.join(__dirname, ".work-tags-progress.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    if (res.status === 429) { await sleep(8000); return apiGet(url); }
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function parallelMap(items, fn, concurrency) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// 要提取的标签白名单
const WANTED_TAGS = new Set([
  // 来源
  "原创", "漫画改", "小说改", "游戏改", "动画改", "影视改",
  // 类型
  "TV", "剧场版", "OVA", "OAD", "WEB", "短篇",
  // 常见题材
  "科幻", "奇幻", "校园", "恋爱", "日常", "冒险", "战斗",
  "悬疑", "推理", "运动", "音乐", "后宫", "穿越", "机战",
  "搞笑", "治愈", "致郁", "热血", "催泪",
]);

// 标签归一化映射
const TAG_NORMALIZE = {
  "GAL改": "游戏改",
  "轻小说改": "小说改",
  "轻改": "小说改",
  "漫改": "漫画改",
  "网文改": "小说改",
  "原创动画": "原创",
};

function extractWorkTags(subject) {
  if (!subject) return [];
  const tags = new Set();

  // 从 meta_tags 提取
  if (Array.isArray(subject.meta_tags)) {
    for (const t of subject.meta_tags) {
      const normalized = TAG_NORMALIZE[t] || t;
      if (WANTED_TAGS.has(normalized)) tags.add(normalized);
    }
  }

  // 从 tags 数组提取（按热度取前几个）
  if (Array.isArray(subject.tags)) {
    for (const t of subject.tags.slice(0, 15)) {
      const name = t.name || t;
      const normalized = TAG_NORMALIZE[name] || name;
      if (WANTED_TAGS.has(normalized)) tags.add(normalized);
    }
  }

  // 判断 TV/剧场版 类型（从 subject type 或 eps 推断）
  // Bangumi subject.type === 2 是动画，但无法直接区分 TV/剧场版
  // 通过 eps 数量或 tags 判断
  if (subject.eps_count && subject.eps_count >= 10) tags.add("TV");

  return [...tags];
}

async function main() {
  console.log("=== 作品标签补充 ===\n");

  const characters = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  console.log(`Loaded ${characters.length} characters`);

  // 收集所有唯一的 subject IDs
  const subjectIds = new Set();
  for (const char of characters) {
    for (const app of char.appearances || []) {
      subjectIds.add(app.id);
    }
  }
  console.log(`Unique subjects: ${subjectIds.size}`);

  // 加载进度
  let progress = {};
  if (fs.existsSync(PROGRESS_FILE)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
    console.log(`Cached: ${Object.keys(progress).length} subjects\n`);
  }

  // 获取未缓存的 subject tags
  const toFetch = [...subjectIds].filter((id) => !progress[id]);
  console.log(`To fetch: ${toFetch.length}\n`);

  if (toFetch.length > 0) {
    let done = 0;
    await parallelMap(toFetch, async (id) => {
      done++;
      const subject = await apiGet(`${API}/v0/subjects/${id}`);
      await sleep(DELAY_MS);
      progress[id] = subject ? extractWorkTags(subject) : [];
      if (done % 100 === 0) {
        process.stdout.write(`\r  ${done}/${toFetch.length}`);
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
      }
    }, CONCURRENCY);
    console.log(`\n  Fetched ${done} subjects`);
  }

  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));

  // 合并到角色 tags
  console.log("\nMerging work tags into characters...");
  let enriched = 0;
  for (const char of characters) {
    const workTags = new Set();
    for (const app of char.appearances || []) {
      const tags = progress[app.id];
      if (Array.isArray(tags)) {
        for (const t of tags) workTags.add(t);
      }
    }
    // 合并到 char.tags（去重）
    if (!char.tags) char.tags = [];
    const existing = new Set(char.tags);
    let added = 0;
    for (const t of workTags) {
      if (!existing.has(t)) {
        char.tags.push(t);
        added++;
      }
    }
    if (added > 0) enriched++;
  }

  // 写回
  fs.writeFileSync(DATA_FILE, JSON.stringify(characters, null, 2));

  // 统计
  const withWorkTags = characters.filter((c) =>
    c.tags && c.tags.some((t) => WANTED_TAGS.has(t))
  ).length;

  console.log(`\n=== Done ===`);
  console.log(`Characters enriched: ${enriched}`);
  console.log(`Characters with work tags: ${withWorkTags} (${(withWorkTags / characters.length * 100).toFixed(0)}%)`);
  console.log(`File: ${DATA_FILE}`);
}

main().catch(console.error);
