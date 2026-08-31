import assert from "node:assert/strict";
import { buildSearchIndex, searchIndex } from "./search-index.js";
import type { AnimeCharacter } from "./types.js";

const base = (value: Partial<AnimeCharacter>): AnimeCharacter => ({
  id: 1, name: "", nameCn: null, aliases: [], gender: null,
  hairColor: null, eyeColor: null, popularity: 0, worksCount: 1,
  highestRating: null, latestYear: null, earliestYear: null,
  voiceActors: [], appearances: [], tags: [], image: "", tier: "dynamic",
  ...value,
});

buildSearchIndex([
  base({ id: 16490, name: "アスナ / 結城明日奈", nameCn: "亚丝娜／结城明日奈", popularity: 1241,
    appearances: [{ id: 1, name: "Sword Art Online", nameCn: "刀剑神域", year: 2012, rating: 7.3, studio: null, staff: "主角" }] }),
  base({ id: 160182, name: "アスナ", nameCn: "亚丝娜", popularity: 9,
    appearances: [{ id: 2, name: "Other", nameCn: "另一部作品", year: 2025, rating: 0, studio: null, staff: "配角" }] }),
]);

const matches = searchIndex("亚丝娜", 5);
assert.deepEqual(matches.map((match) => match.char.id), [16490, 160182], "同分时仍按热度稳定排序");
assert.equal(matches[0].score, 100, "复合中文名的单独组成部分应为精确匹配");
assert.equal(matches[1].score, 100, "完整同名也应为精确匹配，以便上层触发歧义");
assert.equal(searchIndex("结城明日奈", 1)[0]?.char.id, 16490, "复合名称的另一部分也应可精确匹配");
assert.equal(searchIndex("アスナ", 2).every((match) => match.score === 100), true, "日文复合名称同样应拆分");
console.log("✅ 复合角色名拆分、精确匹配与同名候选排序正常");
