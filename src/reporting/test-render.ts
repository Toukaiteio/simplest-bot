/**
 * Test script: render a daily report preview with sample data.
 * Run: npx tsx src/reporting/test-render.ts
 * Generates HTML file only (no browser needed).
 */
import fs from "node:fs";
import path from "node:path";
import { buildHtml, DailyGroupReport } from "./daily-report-renderer.js";

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const sampleReport: DailyGroupReport = {
  dateKey: "2026-06-29",
  groupId: "123456789",
  dailyQuote: "群里有没有懂配电脑的？预算五千想配个能玩黑神话的，在线等急！",
  quoteAuthor: "小猝生",
  weatherText: "烈日狂欢",
  tempText: "38°C",
  nightOwl: "小猝生 (凌晨发言 12 次)",
  memeKing: "小明 (发送表情 18 张)",
  commandMaster: "小红 (调用指令 25 次)",
  editorial: "今日群聊呈现显著的『狂欢暴晒』特征，整体活跃度持续走高。以小猝生为代表的群友在晚间就『五千元电脑装机』展开了深度学术探讨，并金句频出。本报主编在此提醒各位：装机虽爽，但长期熬夜水群有害视力，深夜活跃的猫头鹰们请注意早点休息！",
  ads: [
    { tag: "出售", text: "5000金币收神仙水，有的老板带价私聊我！" },
    { tag: "寻人", text: "寻昨天和我一起打UNO的群友，我的金币还没付呢。" },
    { tag: "广告租借", text: "发送 $rent-ad [标签] [内容] 即可租借此处广告！" }
  ],
  totalMessages: 428,
  activeUsers: 23,
  botReplies: 156,
  commandCount: 89,
  mentionCount: 34,
  averageLength: 47,
  busiestHour: 21,
  busiestHourCount: 52,
  topUsers: [
    { userId: "小明", count: 87 },
    { userId: "小红", count: 64 },
    { userId: "小猝生", count: 52 },
    { userId: "大妖精", count: 48 },
    { userId: "烤骨学家", count: 41 },
    { userId: "奥古斯都", count: 35 },
    { userId: "康斯坦丁", count: 28 },
    { userId: "路人甲", count: 22 },
  ],
  insights: [
    "今天群聊活跃度较高，比昨日增长 12%",
    "最活跃时段出现在 21:00-22:00，有 52 条消息",
    "机器人被 @ 了 34 次，回复了 156 次",
    "今日新增 3 个活跃成员",
  ],
  affinityDeltaTop: [
    { userId: "user1", name: "小明 ➜ 机器人", delta: 8, current: 72 },
    { userId: "user2", name: "小红 ➜ 小明", delta: 5, current: 68 },
    { userId: "user3", name: "小猝生 ➜ 机器人", delta: 3, current: 85 },
    { userId: "user4", name: "大妖精 ➜ 烤骨学家", delta: -2, current: 45 },
    { userId: "user5", name: "烤骨学家 ➜ 机器人", delta: 1, current: 60 },
    { userId: "user6", name: "奥古斯都 ➜ 小明", delta: 4, current: 52 },
    { userId: "user7", name: "康斯坦丁 ➜ 机器人", delta: 2, current: 30 },
    { userId: "user8", name: "路人甲 ➜ 小红", delta: -1, current: 15 },
  ],
  affinityTop: [
    { userId: "user3", name: "小猝生 ➜ 机器人", value: 85, percent: 85 },
    { userId: "user1", name: "小明 ➜ 机器人", value: 72, percent: 72 },
    { userId: "user2", name: "小红 ➜ 小明", value: 68, percent: 68 },
    { userId: "user5", name: "烤骨学家 ➜ 机器人", value: 60, percent: 60 },
    { userId: "user6", name: "奥古斯都 ➜ 小明", value: 52, percent: 52 },
    { userId: "user4", name: "大妖精 ➜ 烤骨学家", value: 45, percent: 45 },
    { userId: "user7", name: "康斯坦丁 ➜ 机器人", value: 30, percent: 30 },
    { userId: "user8", name: "路人甲 ➜ 小红", value: 15, percent: 15 },
  ],
  wealthTop: [
    { userId: "user1", name: "小明", coins: 12580 },
    { userId: "user3", name: "小猝生", coins: 9340 },
    { userId: "user2", name: "小红", coins: 7210 },
    { userId: "user5", name: "烤骨学家", coins: 5680 },
    { userId: "user6", name: "奥古斯都", coins: 4920 },
    { userId: "user4", name: "大妖精", coins: 3890 },
    { userId: "user7", name: "康斯坦丁", coins: 2800 },
    { userId: "user8", name: "路人甲", coins: 1500 },
  ],
  hourBuckets: Array.from({ length: 24 }, (_, h) => {
    if (h >= 0 && h < 6) return randomBetween(0, 3);
    if (h >= 6 && h < 9) return randomBetween(5, 15);
    if (h >= 9 && h < 12) return randomBetween(15, 30);
    if (h >= 12 && h < 14) return randomBetween(20, 35);
    if (h >= 14 && h < 17) return randomBetween(15, 28);
    if (h >= 17 && h < 19) return randomBetween(20, 40);
    if (h >= 19 && h < 21) return randomBetween(30, 48);
    return randomBetween(35, 55);
  }),
};

async function main() {
  const html = buildHtml(sampleReport);
  const outDir = path.resolve(process.cwd(), "data", "daily-reports-test", sampleReport.dateKey);
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, `group-${sampleReport.groupId}.html`);
  fs.writeFileSync(htmlPath, html, "utf-8");
  console.log("HTML generated at:", htmlPath);
}

main().catch(console.error);
