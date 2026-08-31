/**
 * 别名补全 + 作品名校验脚本
 *
 * 对 data/anime-characters.json 中的每个角色：
 *   1. 从 Bangumi infobox 提取别名（英文名、罗马字、昵称等）
 *   2. 校验/补全出演作品的中文名
 *
 * 用法: node scripts/enrich-aliases.mjs
 * 并发: 12 路，支持断点续传
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ===== Config =====
const CONCURRENCY = 12;
const DELAY_MS = 200;
const UA = "simplest-bot-anime-guessr/1.0 (contact: bot-dev)";
const API = "https://api.bgm.tv";

// ===== Paths =====
const DATA_FILE = path.join(ROOT, "data", "anime-characters.json");
const PROGRESS_FILE = path.join(__dirname, ".enrich-progress.json");

// ===== Helpers =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429) {
    await sleep(8000);
    return apiGet(url);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 并发池
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

// 从 infobox 提取别名
function extractAliases(infobox) {
  if (!Array.isArray(infobox)) return [];
  const aliases = new Set();

  for (const entry of infobox) {
    if (entry.key === "别名" && Array.isArray(entry.value)) {
      for (const alias of entry.value) {
        const v = alias.v ?? alias;
        if (typeof v === "string" && v.trim().length > 0 && v.trim().length < 50) {
          aliases.add(v.trim());
        }
      }
    }
    // 简体中文名也作为别名（方便搜索）
    if (entry.key === "简体中文名" && typeof entry.value === "string" && entry.value.trim()) {
      aliases.add(entry.value.trim());
    }
  }

  return [...aliases];
}

// ===== Main =====
async function main() {
  console.log("=== 别名补全 + 作品名校验 ===\n");

  // 1. Load data
  const characters = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  console.log(`Loaded ${characters.length} characters`);

  // 2. Load progress
  let progress = {};
  if (fs.existsSync(PROGRESS_FILE)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
    console.log(`Resuming: ${Object.keys(progress).length} already done\n`);
  }

  // 3. Filter to characters that need enrichment
  const toProcess = characters.filter((c) => !progress[c.id]);
  console.log(`To process: ${toProcess.length}\n`);

  if (toProcess.length === 0) {
    console.log("All characters already enriched!");
  } else {
    // 4. Process with concurrency
    let done = 0;
    let aliasFound = 0;
    let workFixed = 0;
    let errors = 0;

    await parallelMap(toProcess, async (char) => {
      done++;
      try {
        // Fetch character detail for aliases
        const detail = await apiGet(`${API}/v0/characters/${char.id}`);
        await sleep(DELAY_MS);

        const aliases = extractAliases(detail.infobox);
        const nameCn = detail.infobox?.find((e) => e.key === "简体中文名")?.value || char.nameCn;

        // Check if any appearance is missing nameCn
        let needsWorkCheck = (char.appearances || []).some((a) => !a.nameCn || a.nameCn === a.name);

        let updatedAppearances = char.appearances;
        if (needsWorkCheck) {
          // Fetch subject details for missing Chinese names (max 3 to limit calls)
          const missingWorks = (char.appearances || [])
            .filter((a) => !a.nameCn || a.nameCn === a.name)
            .slice(0, 3);

          updatedAppearances = [...(char.appearances || [])];
          for (const work of missingWorks) {
            try {
              const subDetail = await apiGet(`${API}/v0/subjects/${work.id}`);
              await sleep(DELAY_MS);
              if (subDetail.name_cn) {
                const idx = updatedAppearances.findIndex((a) => a.id === work.id);
                if (idx >= 0) {
                  updatedAppearances[idx] = { ...updatedAppearances[idx], nameCn: subDetail.name_cn };
                  workFixed++;
                }
              }
            } catch { /* skip */ }
          }
        }

        // Save result
        progress[char.id] = {
          aliases,
          nameCn: nameCn || char.nameCn,
          appearances: updatedAppearances,
        };

        if (aliases.length > 0) aliasFound++;

      } catch (e) {
        errors++;
        progress[char.id] = { aliases: [], nameCn: char.nameCn, appearances: char.appearances, error: e.message };
      }

      if (done % 100 === 0) {
        process.stdout.write(`\r  ${done}/${toProcess.length} | aliases: ${aliasFound} | works fixed: ${workFixed} | errors: ${errors}`);
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
      }
    }, CONCURRENCY);

    console.log(`\n\nProcessing complete.`);
    console.log(`  Processed: ${done}`);
    console.log(`  Aliases found: ${aliasFound}`);
    console.log(`  Work names fixed: ${workFixed}`);
    console.log(`  Errors: ${errors}`);
  }

  // 5. Save progress
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));

  // 6. Merge back into main data
  console.log("\nMerging enriched data...");
  let mergedAliases = 0;
  let mergedWorks = 0;

  for (const char of characters) {
    const p = progress[char.id];
    if (!p) continue;

    if (p.aliases && p.aliases.length > 0) {
      char.aliases = p.aliases;
      mergedAliases++;
    }
    if (p.nameCn && p.nameCn !== char.nameCn) {
      char.nameCn = p.nameCn;
    }
    if (p.appearances) {
      char.appearances = p.appearances;
      mergedWorks++;
    }
  }

  // 7. Write final output
  fs.writeFileSync(DATA_FILE, JSON.stringify(characters, null, 2));

  // 8. Verification report
  const withAliases = characters.filter((c) => c.aliases && c.aliases.length > 0).length;
  const withNameCn = characters.filter((c) => c.nameCn).length;
  const withWorks = characters.filter((c) => c.appearances && c.appearances.length > 0).length;
  const withWorkCn = characters.filter((c) =>
    c.appearances && c.appearances.some((a) => a.nameCn && a.nameCn !== a.name)
  ).length;
  const processedCount = Object.keys(progress).length;

  console.log(`\n=== Verification ===`);
  console.log(`Total characters: ${characters.length}`);
  console.log(`Enriched: ${processedCount} (${(processedCount / characters.length * 100).toFixed(1)}%)`);
  console.log(`With aliases: ${withAliases} (${(withAliases / characters.length * 100).toFixed(1)}%)`);
  console.log(`With Chinese name: ${withNameCn} (${(withNameCn / characters.length * 100).toFixed(1)}%)`);
  console.log(`With appearances: ${withWorks}`);
  console.log(`With CN work names: ${withWorkCn}`);
  console.log(`\nOutput: ${DATA_FILE}`);
  console.log(`Size: ${(fs.statSync(DATA_FILE).size / 1024 / 1024).toFixed(2)} MB`);

  if (processedCount < characters.length) {
    console.log(`\n⚠ WARNING: ${characters.length - processedCount} characters were NOT processed!`);
  } else {
    console.log(`\n✓ All ${characters.length} characters processed successfully.`);
  }
}

main().catch(console.error);
