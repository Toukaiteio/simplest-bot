/**
 * 猜动漫人物 - 核心逻辑测试
 * 运行: npx tsx src/plugins/anime-guessr/logic.test.ts
 */

import { generateFeedback, isCorrectGuess, searchCharacter, pickRandomAnswer } from "./logic.js";
import type { AnimeCharacter } from "./types.js";

// ===== 模拟数据 =====

const mockCharacters: AnimeCharacter[] = [
  {
    id: 1, name: "夜神月", nameCn: "夜神月",
    aliases: ["Light Yagami", "月"],
    gender: "male", hairColor: "棕发", eyeColor: "棕瞳",
    popularity: 5000, worksCount: 2, highestRating: 8.4,
    latestYear: 2008, earliestYear: 2006,
    voiceActors: ["宮野真守", "李景唐"],
    appearances: [
      { id: 100, name: "DEATH NOTE", nameCn: "死亡笔记", year: 2006, rating: 8.4, studio: "MADHouse", staff: "主角" },
      { id: 101, name: "DEATH NOTE Rewrite", nameCn: "死亡笔记 重写", year: 2008, rating: 7.5, studio: "MADHouse", staff: "主角" },
    ],
    tags: ["棕瞳", "棕发", "高中生", "腹黑"],
    image: "https://example.com/1.jpg", tier: "S",
  },
  {
    id: 2, name: "L", nameCn: "L",
    aliases: ["L Lawliet", "龙崎"],
    gender: "male", hairColor: "黑发", eyeColor: "黑瞳",
    popularity: 4800, worksCount: 2, highestRating: 8.4,
    latestYear: 2008, earliestYear: 2006,
    voiceActors: ["山口勝平", "曹冀魯"],
    appearances: [
      { id: 100, name: "DEATH NOTE", nameCn: "死亡笔记", year: 2006, rating: 8.4, studio: "MADHouse", staff: "主角" },
      { id: 101, name: "DEATH NOTE Rewrite", nameCn: "死亡笔记 重写", year: 2008, rating: 7.5, studio: "MADHouse", staff: "主角" },
    ],
    tags: ["黑瞳", "黑发", "短发", "腹黑"],
    image: "https://example.com/2.jpg", tier: "S",
  },
  {
    id: 3, name: "牧瀬紅莉栖", nameCn: "牧濑红莉栖",
    aliases: ["Chris Makise", "助手", "Christina"],
    gender: "female", hairColor: "棕发", eyeColor: "紫瞳",
    popularity: 3800, worksCount: 4, highestRating: 8.1,
    latestYear: 2018, earliestYear: 2011,
    voiceActors: ["今井麻美"],
    appearances: [
      { id: 200, name: "STEINS;GATE", nameCn: "命运石之门", year: 2011, rating: 8.1, studio: "WHITE FOX", staff: "主角" },
      { id: 201, name: "STEINS;GATE 0", nameCn: "命运石之门 0", year: 2018, rating: 7.8, studio: "WHITE FOX", staff: "主角" },
    ],
    tags: ["紫瞳", "棕发", "长直", "傲娇", "天才"],
    image: "https://example.com/3.jpg", tier: "S",
  },
  {
    id: 4, name: "アルトリア・ペンドラゴン", nameCn: "阿尔托莉雅·潘德拉贡",
    aliases: ["Saber", "Artoria Pendragon"],
    gender: "female", hairColor: "金发", eyeColor: "绿瞳",
    popularity: 2180, worksCount: 8, highestRating: 8.1,
    latestYear: 2014, earliestYear: 2006,
    voiceActors: ["川澄綾子"],
    appearances: [
      { id: 300, name: "Fate/stay night", nameCn: "Fate/stay night", year: 2006, rating: 7.1, studio: "Studio DEEN", staff: "主角" },
      { id: 301, name: "Fate/Zero", nameCn: "Fate/Zero", year: 2011, rating: 8.1, studio: "ufotable", staff: "主角" },
    ],
    tags: ["绿瞳", "金发", "呆毛", "认真"],
    image: "https://example.com/4.jpg", tier: "S",
  },
];

// ===== 测试框架 =====

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function assertEq(actual: unknown, expected: unknown, msg: string) {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ FAIL: ${msg} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

// ===== Tests =====

console.log("\n=== isCorrectGuess ===");
assert(isCorrectGuess(mockCharacters[0], mockCharacters[0]), "same character = correct");
assert(!isCorrectGuess(mockCharacters[0], mockCharacters[1]), "different character = not correct");

console.log("\n=== generateFeedback (exact match) ===");
const fb1 = generateFeedback(mockCharacters[0], mockCharacters[0]);
assertEq(fb1.gender, "yes", "gender match");
assertEq(fb1.popularity, "=", "popularity exact");
assertEq(fb1.worksCount, "=", "worksCount exact");
assertEq(fb1.highestRating, "=", "rating exact");
assertEq(fb1.latestYear, "=", "latestYear exact");
assertEq(fb1.earliestYear, "=", "earliestYear exact");
assert(fb1.sharedWorks.length > 0, "shared works exist");
assert(fb1.sharedTags.length === 4, "all tags shared");

console.log("\n=== generateFeedback (夜神月 vs L) ===");
const fb2 = generateFeedback(mockCharacters[0], mockCharacters[1]);
assertEq(fb2.gender, "yes", "both male");
assertEq(fb2.popularity, "=", "5000 vs 4800 within 5%");
assertEq(fb2.worksCount, "=", "both 2 works");
assertEq(fb2.highestRating, "=", "both 8.4");
assert(fb2.sharedVoiceActors.length === 0, "no shared VA");
assert(fb2.sharedStudios.includes("MADHouse"), "shared studio MADHouse");
assert(fb2.sharedWorks.includes("死亡笔记"), "shared work 死亡笔记");
assert(fb2.sharedTags.includes("腹黑"), "shared tag 腹黑");
assert(!fb2.sharedTags.includes("棕发"), "棕发 not shared (L is 黑发)");

console.log("\n=== generateFeedback (夜神月 vs 牧濑红莉栖) ===");
const fb3 = generateFeedback(mockCharacters[0], mockCharacters[2]);
assertEq(fb3.gender, "no", "male vs female");
assertEq(fb3.popularity, "++", "popularity much higher");
assertEq(fb3.worksCount, "-", "fewer works");
assertEq(fb3.highestRating, "=", "rating within 0.3");
assertEq(fb3.latestYear, "--", "latestYear much earlier");
assertEq(fb3.earliestYear, "--", "earliestYear much earlier");
assert(fb3.sharedWorks.length === 0, "no shared works");

console.log("\n=== generateFeedback (gender unknown) ===");
const noGenderChar = { ...mockCharacters[0], gender: null };
const fb4 = generateFeedback(noGenderChar, mockCharacters[1]);
assertEq(fb4.gender, "unknown", "null gender = unknown");

console.log("\n=== searchCharacter ===");
const r1 = searchCharacter("夜神月", mockCharacters);
assert(r1.length > 0 && r1[0].char.id === 1, "exact CN name match");

const r2 = searchCharacter("牧瀬紅莉栖", mockCharacters);
assert(r2.length > 0 && r2[0].char.id === 3, "exact JP name match");

const r3 = searchCharacter("牧濑红莉栖", mockCharacters);
assert(r3.length > 0 && r3[0].char.id === 3, "CN name match");

const r4 = searchCharacter("Saber", mockCharacters);
assert(r4.length > 0 && r4[0].char.id === 4, "alias match: Saber");
assert(r4[0].matchedField.includes("别名"), "matched via alias field");

const r5 = searchCharacter("助手", mockCharacters);
assert(r5.length > 0 && r5[0].char.id === 3, "alias match: 助手");

const r6 = searchCharacter("アルトリア", mockCharacters);
assert(r6.length > 0 && r6[0].char.id === 4, "partial JP name match");

const r7 = searchCharacter("", mockCharacters);
assert(r7.length === 0, "empty query returns nothing");

const r8 = searchCharacter("不存在的角色xyz", mockCharacters);
assert(r8.length === 0, "no match for nonsense");

console.log("\n=== pickRandomAnswer ===");
const answer = pickRandomAnswer(mockCharacters, 0);
assert(mockCharacters.some((c) => c.id === answer.id), "picked from database");

const highPop = pickRandomAnswer(mockCharacters, 4000);
assert(highPop.popularity >= 4000, "respects minPopularity filter");

let threw = false;
try { pickRandomAnswer(mockCharacters, 99999); } catch { threw = true; }
assert(threw, "throws when no eligible characters");

// ===== Summary =====
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
