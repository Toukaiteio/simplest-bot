/**
 * 生成猜动漫人物游戏面板预览图
 * 运行: npx tsx scripts/preview-guessr.ts
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { renderGameHtml } from "../src/plugins/anime-guessr/render.js";
import { generateFeedback } from "../src/plugins/anime-guessr/logic.js";
import type { AnimeCharacter, Game, GuessRecord } from "../src/plugins/anime-guessr/types.js";

// 用真实数据中的角色做演示
const answer: AnimeCharacter = {
  id: 2, name: "L", nameCn: "L", aliases: ["L Lawliet"], gender: "male",
  hairColor: "黑发", eyeColor: "黑瞳", popularity: 4800,
  worksCount: 2, highestRating: 8.4, latestYear: 2008, earliestYear: 2006,
  voiceActors: ["山口勝平", "曹冀魯"], 
  appearances: [
    { id: 100, name: "DEATH NOTE", nameCn: "死亡笔记", year: 2006, rating: 8.4, studio: "MADHouse", staff: "主角" },
    { id: 101, name: "DEATH NOTE Rewrite", nameCn: "死亡笔记 重写", year: 2008, rating: 7.5, studio: "MADHouse", staff: "主角" },
  ],
  tags: ["黑瞳", "黑发", "短发", "腹黑"], image: "https://lain.bgm.tv/r/400/pic/crt/l/c6/41/2_crt_X3t2R.jpg", tier: "S",
};

const guesses: AnimeCharacter[] = [
  {
    id: 1, name: "夜神月", nameCn: "夜神月", aliases: ["Light Yagami"], gender: "male",
    hairColor: "棕发", eyeColor: "棕瞳", popularity: 5000,
    worksCount: 2, highestRating: 8.4, latestYear: 2008, earliestYear: 2006,
    voiceActors: ["宮野真守", "李景唐"],
    appearances: [
      { id: 100, name: "DEATH NOTE", nameCn: "死亡笔记", year: 2006, rating: 8.4, studio: "MADHouse", staff: "主角" },
    ],
    tags: ["棕瞳", "棕发", "高中生", "腹黑"], image: "https://lain.bgm.tv/r/400/pic/crt/l/d5/0a/1_crt_6RRpR.jpg", tier: "S",
  },
  {
    id: 3, name: "牧瀬紅莉栖", nameCn: "牧濑红莉栖", aliases: ["Chris Makise"], gender: "female",
    hairColor: "棕发", eyeColor: "紫瞳", popularity: 3800,
    worksCount: 4, highestRating: 8.1, latestYear: 2018, earliestYear: 2011,
    voiceActors: ["今井麻美"],
    appearances: [
      { id: 200, name: "STEINS;GATE", nameCn: "命运石之门", year: 2011, rating: 8.1, studio: "WHITE FOX", staff: "主角" },
    ],
    tags: ["紫瞳", "棕发", "长直", "傲娇", "天才"], image: "https://lain.bgm.tv/r/400/pic/crt/l/f7/2a/12393_crt_SS7II.jpg", tier: "S",
  },
  {
    id: 4, name: "アルトリア・ペンドラゴン", nameCn: "阿尔托莉雅·潘德拉贡", aliases: ["Saber"], gender: "female",
    hairColor: "金发", eyeColor: "绿瞳", popularity: 2180,
    worksCount: 8, highestRating: 8.1, latestYear: 2014, earliestYear: 2006,
    voiceActors: ["川澄綾子"],
    appearances: [
      { id: 300, name: "Fate/stay night", nameCn: "Fate/stay night", year: 2006, rating: 7.1, studio: "Studio DEEN", staff: "主角" },
      { id: 301, name: "Fate/Zero", nameCn: "Fate/Zero", year: 2011, rating: 8.1, studio: "ufotable", staff: "主角" },
    ],
    tags: ["绿瞳", "金发", "呆毛", "认真"], image: "https://lain.bgm.tv/r/400/pic/crt/l/7d/58/273_crt_N99A0.jpg", tier: "S",
  },
];

// 构建游戏状态
const records: GuessRecord[] = guesses.map((g) => ({
  character: g,
  feedback: generateFeedback(g, answer),
  isCorrect: g.id === answer.id,
  timestamp: Date.now(),
}));

const game: Game = {
  groupId: "preview",
  state: "playing",
  answer,
  players: new Map([
    ["user1", { userId: "user1", name: "小明", guesses: records, maxAttempts: 7, finished: false, won: false }],
    ["user2", { userId: "user2", name: "小红", guesses: [], maxAttempts: 7, finished: false, won: false }],
    ["user3", { userId: "user3", name: "阿强", guesses: [records[0]], maxAttempts: 7, finished: false, won: false }],
  ]),
  creatorId: "user1",
  round: 3,
  startedAt: Date.now() - 120000,
  endedAt: null,
};

async function main() {
  const html = renderGameHtml(game, "user1");
  const outDir = path.resolve("data/guessr-images");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "preview.webp");

  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 600, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load" });

  const clip = await page.evaluate(() => {
    const el = document.querySelector(".gc") as HTMLElement;
    const r = el.getBoundingClientRect();
    return { x: Math.ceil(r.left), y: Math.ceil(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  });

  await page.screenshot({ path: outPath, type: "webp", quality: 90, clip });
  await browser.close();
  console.log(`Preview saved to: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
