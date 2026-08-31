/**
 * 第二阶段：扩展抓取。
 * 读取第一阶段已采集的角色，收集其所有出演动画的 subject ID，
 * 然后抓取这些动画中的全部角色（主角+配角），补充到数据库中。
 *
 * 用法: node scripts/fetch-anime-characters-expand.mjs
 * 前置: 先运行 fetch-anime-characters.mjs 完成第一阶段
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ===== Config =====
const DELAY_MS = 500;
const CONCURRENCY = 3; // 并发数
const UA = "simplest-bot-anime-guessr/1.0 (contact: bot-dev)";
const API = "https://api.bgm.tv";

// ===== Paths =====
const PROGRESS_FILE = path.join(__dirname, ".fetch-progress.json");
const EXPAND_PROGRESS_FILE = path.join(__dirname, ".fetch-expand-progress.json");
const OUTPUT_FILE = path.join(ROOT, "data", "anime-characters.json");
const ID_TAGS_FILE = path.join(__dirname, "id_tags_raw.js");

// ===== Helpers =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 简易并发池：同时跑 N 个任务
async function parallelMap(items, fn, concurrency = CONCURRENCY) {
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

async function apiGet(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429) {
    console.warn("  [429] Rate limited, waiting 10s...");
    await sleep(10000);
    return apiGet(url);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ===== Parse id_tags.js =====
function loadIdTags() {
  const raw = fs.readFileSync(ID_TAGS_FILE, "utf-8");
  const match = raw.match(/export const idToTags = ({[\s\S]*});?\s*$/);
  if (!match) throw new Error("Cannot parse id_tags.js");
  const fn = new Function(`return (${match[1]})`);
  return fn();
}

// ===== Extract hair/eye color =====
const HAIR_COLORS = ["黑发", "金发", "银发", "白发", "棕发", "红发", "蓝发", "紫发", "绿发", "粉发", "灰发", "橙发", "黄发"];
const EYE_COLORS = ["黑瞳", "金瞳", "银瞳", "棕瞳", "红瞳", "蓝瞳", "紫瞳", "绿瞳", "灰瞳", "粉瞳", "橙瞳", "黄瞳", "异色瞳", "赤瞳", "碧瞳", "翠瞳"];

function extractHairColor(tags) {
  for (const t of tags) { if (HAIR_COLORS.includes(t)) return t; }
  return null;
}
function extractEyeColor(tags) {
  for (const t of tags) { if (EYE_COLORS.includes(t)) return t; }
  return null;
}

// ===== Fetch full character data (same logic as phase 1) =====
async function fetchCharacterFull(id, idToTags) {
  const detail = await apiGet(`${API}/v0/characters/${id}`);
  await sleep(DELAY_MS);

  const subjects = await apiGet(`${API}/v0/characters/${id}/subjects`);
  await sleep(DELAY_MS);

  const persons = await apiGet(`${API}/v0/characters/${id}/persons`);
  await sleep(DELAY_MS);

  const animeAppearances = subjects.filter(
    (s) => s.type === 2 && (s.staff === "主角" || s.staff === "配角")
  );

  if (animeAppearances.length === 0) return null;

  const appearances = [];
  for (const anime of animeAppearances.slice(0, 8)) {
    try {
      const subDetail = await apiGet(`${API}/v0/subjects/${anime.id}`);
      await sleep(DELAY_MS);
      if (subDetail.locked) continue;
      const airDate = subDetail.date;
      if (airDate && new Date(airDate) > new Date()) continue;
      const year = airDate ? parseInt(airDate.split("-")[0]) : null;
      const studio = subDetail.infobox?.find((item) => item.key === "动画制作")?.value || null;
      appearances.push({
        id: anime.id,
        name: anime.name,
        nameCn: anime.name_cn || anime.name,
        year,
        rating: subDetail.rating?.score || 0,
        studio: typeof studio === "string" ? studio : null,
        staff: anime.staff,
      });
    } catch { /* skip */ }
  }

  if (appearances.length === 0) return null;

  const voiceActors = [...new Set(
    persons.filter((p) => p.subject_type === 2).map((p) => p.name)
  )];

  const tags = idToTags[id] || [];
  const years = appearances.map((a) => a.year).filter(Boolean);
  const ratings = appearances.map((a) => a.rating).filter((r) => r > 0);
  const nameCn = detail.infobox?.find((item) => item.key === "简体中文名")?.value || null;

  return {
    id,
    name: detail.name,
    nameCn,
    gender: detail.gender === "male" || detail.gender === "female" ? detail.gender : null,
    hairColor: extractHairColor(tags),
    eyeColor: extractEyeColor(tags),
    popularity: detail.stat?.collects || 0,
    worksCount: appearances.length,
    highestRating: ratings.length ? Math.max(...ratings) : null,
    latestYear: years.length ? Math.max(...years) : null,
    earliestYear: years.length ? Math.min(...years) : null,
    voiceActors,
    appearances,
    tags: tags.slice(0, 10),
    image: detail.images?.medium || "",
    tier: "B",
  };
}

// ===== Main =====
async function main() {
  console.log("=== 第二阶段：扩展抓取（作品内全部角色） ===\n");

  // 1. Load phase 1 progress
  if (!fs.existsSync(PROGRESS_FILE)) {
    console.error("Error: Phase 1 progress not found. Run fetch-anime-characters.mjs first.");
    process.exit(1);
  }
  const phase1 = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
  const phase1Chars = Object.values(phase1);
  console.log(`Phase 1: ${phase1Chars.length} characters loaded`);

  // 2. Collect all unique anime subject IDs
  const subjectIds = new Set();
  for (const char of phase1Chars) {
    for (const app of char.appearances || []) {
      subjectIds.add(app.id);
    }
  }
  console.log(`Unique anime works: ${subjectIds.size}\n`);

  // 3. Load expand progress
  let expandProgress = {};
  if (fs.existsSync(EXPAND_PROGRESS_FILE)) {
    expandProgress = JSON.parse(fs.readFileSync(EXPAND_PROGRESS_FILE, "utf-8"));
    console.log(`Resuming expand: ${Object.keys(expandProgress).length} characters already done\n`);
  }

  // 4. Load id_tags
  const idToTags = loadIdTags();

  // 5. For each anime, get its characters (concurrent)
  const allCharIds = new Set(Object.keys(phase1).map(Number));
  const newCharIds = new Set();

  console.log("--- Step 1: Collecting character IDs from all works (concurrent) ---");
  const subjectArr = [...subjectIds];
  let done1 = 0;
  await parallelMap(subjectArr, async (subjectId) => {
    try {
      const chars = await apiGet(`${API}/v0/subjects/${subjectId}/characters`);
      await sleep(DELAY_MS);
      for (const c of chars) {
        if ((c.relation === "主角" || c.relation === "配角") && !allCharIds.has(c.id)) {
          newCharIds.add(c.id);
        }
      }
    } catch { /* skip */ }
    done1++;
    if (done1 % 20 === 0) process.stdout.write(`\r  Scanned ${done1}/${subjectArr.length} subjects, found ${newCharIds.size} new chars`);
  });

  console.log(`\n\nNew characters to fetch: ${newCharIds.size}\n`);

  // 6. Fetch each new character (concurrent)
  console.log("--- Step 2: Fetching new character details (concurrent) ---");
  const results = [...phase1Chars];
  let fetched = 0;
  let errors = 0;
  const newIds = [...newCharIds];

  // 先加载已缓存的
  const toFetch = [];
  for (const id of newIds) {
    if (expandProgress[id]) {
      if (expandProgress[id] !== "SKIP") results.push(expandProgress[id]);
    } else {
      toFetch.push(id);
    }
  }
  console.log(`  Cached: ${newIds.length - toFetch.length}, To fetch: ${toFetch.length}`);

  let done2 = 0;
  await parallelMap(toFetch, async (id) => {
    done2++;
    try {
      const entry = await fetchCharacterFull(id, idToTags);
      if (entry) {
        results.push(entry);
        expandProgress[id] = entry;
      } else {
        expandProgress[id] = "SKIP";
      }
    } catch (e) {
      errors++;
      expandProgress[id] = "SKIP";
      if (errors > 80) console.error(`  [WARN] errors=${errors}`);
    }
    if (done2 % 30 === 0) {
      process.stdout.write(`\r  Fetched ${done2}/${toFetch.length} (errors: ${errors})`);
      fs.writeFileSync(EXPAND_PROGRESS_FILE, JSON.stringify(expandProgress));
    }
  });

  // 7. Final save
  fs.writeFileSync(EXPAND_PROGRESS_FILE, JSON.stringify(expandProgress));
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));

  console.log(`\n\n=== Done ===`);
  console.log(`Total characters in database: ${results.length}`);
  console.log(`  Phase 1: ${phase1Chars.length}`);
  console.log(`  Phase 2 new: ${results.length - phase1Chars.length}`);
  console.log(`  Errors: ${errors}`);
  console.log(`Output: ${OUTPUT_FILE}`);
}

main().catch(console.error);
