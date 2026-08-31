/**
 * 从 Bangumi API 抓取动漫角色数据，生成猜动漫人物游戏的数据库。
 * 
 * 用法: node scripts/fetch-anime-characters.mjs
 * 
 * 特性:
 * - 自动限速 (1 req/s) 避免触发 Bangumi 限流
 * - 断点续传：进度保存到 scripts/.fetch-progress.json
 * - 只保留动画 (type=2) 出演信息
 * - 从 id_tags.js 提取发色/瞳色标签
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ===== Config =====
const TARGET_COUNT = 400; // 目标角色数量
const DELAY_MS = 1100; // 每次 API 请求间隔 (Bangumi 限流约 1req/s)
const UA = "simplest-bot-anime-guessr/1.0 (contact: bot-dev)";
const API = "https://api.bgm.tv";

// ===== Paths =====
const PROGRESS_FILE = path.join(__dirname, ".fetch-progress.json");
const OUTPUT_FILE = path.join(ROOT, "data", "anime-characters.json");
const CHAR_IMAGES_FILE = path.join(__dirname, "character_images_raw.json");
const ID_TAGS_FILE = path.join(__dirname, "id_tags_raw.js");

// ===== Helpers =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429) {
    console.warn("  [429] Rate limited, waiting 10s...");
    await sleep(10000);
    return apiGet(url); // retry
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ===== Parse id_tags.js =====
function loadIdTags() {
  const raw = fs.readFileSync(ID_TAGS_FILE, "utf-8");
  // 文件是 ESM export，简单提取对象
  const match = raw.match(/export const idToTags = ({[\s\S]*});?\s*$/);
  if (!match) throw new Error("Cannot parse id_tags.js");
  // 用 Function 安全解析（无外部依赖）
  const fn = new Function(`return (${match[1]})`);
  return fn();
}

// ===== Extract hair/eye color from tags =====
const HAIR_COLORS = ["黑发", "金发", "银发", "白发", "棕发", "红发", "蓝发", "紫发", "绿发", "粉发", "灰发", "橙发", "黄发", "浅蓝发", "深蓝发", "酒红发", "亚麻色发", "茶发", "栗发"];
const EYE_COLORS = ["黑瞳", "金瞳", "银瞳", "棕瞳", "红瞳", "蓝瞳", "紫瞳", "绿瞳", "灰瞳", "粉瞳", "橙瞳", "黄瞳", "异色瞳", "赤瞳", "碧瞳", "翠瞳"];

function extractHairColor(tags) {
  for (const t of tags) {
    const found = HAIR_COLORS.find((c) => t.includes(c.replace("发", "")) && t.includes("发"));
    if (found) return found;
  }
  // fallback: 直接匹配
  for (const t of tags) {
    if (HAIR_COLORS.includes(t)) return t;
  }
  return null;
}

function extractEyeColor(tags) {
  for (const t of tags) {
    if (EYE_COLORS.includes(t)) return t;
  }
  return null;
}

// ===== Main =====
async function main() {
  console.log("=== 动漫角色数据抓取工具 ===\n");

  // 1. Load character_images.json (popularity ranking)
  const charImages = JSON.parse(fs.readFileSync(CHAR_IMAGES_FILE, "utf-8"));
  console.log(`Loaded ${charImages.length} characters from character_images.json`);

  // 2. Load id_tags
  const idToTags = loadIdTags();
  console.log(`Loaded tags for ${Object.keys(idToTags).length} characters\n`);

  // 3. Sort by popularity (collects) and pick top N
  const sorted = charImages
    .filter((c) => c.tier === "S" || c.tier === "A" || c.collects > 500)
    .sort((a, b) => b.collects - a.collects)
    .slice(0, TARGET_COUNT);

  console.log(`Selected top ${sorted.length} characters (tier S/A or collects>500)\n`);

  // 4. Load progress
  let progress = {};
  if (fs.existsSync(PROGRESS_FILE)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
    console.log(`Resuming: ${Object.keys(progress).length} characters already fetched\n`);
  }

  const results = [];
  let fetched = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < sorted.length; i++) {
    const char = sorted[i];
    const id = char.id;

    // Skip if already fetched
    if (progress[id]) {
      results.push(progress[id]);
      skipped++;
      continue;
    }

    fetched++;
    const pct = ((i + 1) / sorted.length * 100).toFixed(1);
    process.stdout.write(`[${pct}%] Fetching #${id} ${char.name} ...`);

    try {
      // Fetch character details
      const detail = await apiGet(`${API}/v0/characters/${id}`);
      await sleep(DELAY_MS);

      // Fetch subjects (anime appearances)
      const subjects = await apiGet(`${API}/v0/characters/${id}/subjects`);
      await sleep(DELAY_MS);

      // Fetch persons (voice actors)
      const persons = await apiGet(`${API}/v0/characters/${id}/persons`);
      await sleep(DELAY_MS);

      // Filter to anime only (type=2), main/supporting roles
      const animeAppearances = subjects.filter(
        (s) => s.type === 2 && (s.staff === "主角" || s.staff === "配角")
      );

      if (animeAppearances.length === 0) {
        console.log(" SKIP (no anime appearances)");
        continue;
      }

      // Fetch details for each anime (year, rating, studio)
      const appearances = [];
      for (const anime of animeAppearances.slice(0, 8)) { // max 8 works
        try {
          const subDetail = await apiGet(`${API}/v0/subjects/${anime.id}`);
          await sleep(DELAY_MS);

          if (subDetail.locked) continue;
          const airDate = subDetail.date;
          if (airDate && new Date(airDate) > new Date()) continue; // skip unreleased

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
        } catch (e) {
          // skip failed subject fetches
        }
      }

      if (appearances.length === 0) {
        console.log(" SKIP (no valid anime data)");
        continue;
      }

      // Extract voice actors (anime only)
      const voiceActors = [...new Set(
        persons
          .filter((p) => p.subject_type === 2)
          .map((p) => p.name)
      )];

      // Extract tags
      const tags = idToTags[id] || [];
      const hairColor = extractHairColor(tags);
      const eyeColor = extractEyeColor(tags);

      // Compute aggregate stats
      const years = appearances.map((a) => a.year).filter(Boolean);
      const ratings = appearances.map((a) => a.rating).filter((r) => r > 0);
      const latestYear = years.length ? Math.max(...years) : null;
      const earliestYear = years.length ? Math.min(...years) : null;
      const highestRating = ratings.length ? Math.max(...ratings) : null;

      // Chinese name
      const nameCn = detail.infobox?.find((item) => item.key === "简体中文名")?.value || null;

      const entry = {
        id,
        name: detail.name,
        nameCn,
        gender: detail.gender === "male" || detail.gender === "female" ? detail.gender : null,
        hairColor,
        eyeColor,
        popularity: detail.stat?.collects || char.collects || 0,
        worksCount: appearances.length,
        highestRating,
        latestYear,
        earliestYear,
        voiceActors,
        appearances,
        tags: tags.slice(0, 10),
        image: char.image_medium?.[0] || char.image_grid?.[0] || detail.images?.medium || "",
        tier: char.tier || "B",
      };

      results.push(entry);
      progress[id] = entry;

      // Save progress every 10 characters
      if (fetched % 10 === 0) {
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
      }

      console.log(` OK (${appearances.length} works, ${voiceActors.length} VAs)`);
    } catch (e) {
      errors++;
      console.log(` ERROR: ${e.message}`);
      if (errors > 20) {
        console.error("\nToo many errors, stopping. Progress saved.");
        break;
      }
    }
  }

  // Final save
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));

  // Write output
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));

  console.log(`\n=== Done ===`);
  console.log(`Total: ${results.length} characters`);
  console.log(`Fetched: ${fetched}, Skipped (cached): ${skipped}, Errors: ${errors}`);
  console.log(`Output: ${OUTPUT_FILE}`);
}

main().catch(console.error);
