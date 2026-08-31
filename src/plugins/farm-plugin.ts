import type { BotMessage, MenuPlugin, Plugin, PluginContext } from "../types.js";
import type { OneBotClient } from "../onebot.js";
import type { DataStorePlugin } from "../types.js";
import { MessageStore } from "../message-store.js";
import fs from "node:fs";
import path from "node:path";
import { screenshotHtml } from "./mmorpg/screenshot.js";

const ICON_HOME = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
const ICON_COIN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#e3b341" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>';
const ICON_SPROUT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22V12"/><path d="M12 12c-3 0-6-2-6-6 0 0 2-3 6-3s6 3 6 3c0 4-3 6-6 6z"/></svg>';
const ICON_LEAF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 17 3.5 19 2c1 2 2 4.5 2 8 0 5.5-4.78 10-10 10z"/></svg>';
const ICON_DROP = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#d29922" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const ICON_SHOP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#d29922" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>';
const ICON_SHIELD = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#f85149" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
const ICON_HARVEST = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#e3b341" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>';
const ICON_SUN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#d29922" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
const ICON_SNOW = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12h-8M12 4v16"/><path d="M16 8l-4-4-4 4M16 16l-4 4-4-4"/><path d="M4 12h16"/></svg>';
const ICON_FLOWER = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#bc8cff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>';
const ICON_AUTUMN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#f0883e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 17 3.5 19 2c1 2 2 4.5 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>';
const ICON_GREENHOUSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 12v6"/><path d="M9 15h6"/></svg>';
const ICON_TOOL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#8b949e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
type Season = "spring" | "summer" | "autumn" | "winter";

const SEASON_NAMES: Record<Season, string> = { spring: "春", summer: "夏", autumn: "秋", winter: "冬" };
const SEASON_ICONS: Record<Season, string> = { spring: ICON_FLOWER, summer: ICON_SUN, autumn: ICON_AUTUMN, winter: ICON_SNOW };

function getCurrentSeason(): Season {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return "spring";
  if (m >= 6 && m <= 8) return "summer";
  if (m >= 9 && m <= 11) return "autumn";
  return "winter";
}

function todayKey(): string {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

type CropDef = {
  id: string; name: string; growthHours: number; buyPrice: number;
  minHarvest: number; maxHarvest: number; sellPricePerUnit: number;
  levelRequired: number; season: Season;
};

const CROPS: CropDef[] = [
  { id: "strawberry", name: "草莓", growthHours: 8, buyPrice: 29, minHarvest: 3, maxHarvest: 5, sellPricePerUnit: 11, levelRequired: 1, season: "spring" },
  { id: "corn", name: "玉米", growthHours: 8, buyPrice: 29, minHarvest: 3, maxHarvest: 6, sellPricePerUnit: 10, levelRequired: 1, season: "autumn" },
  { id: "tomato", name: "番茄", growthHours: 10, buyPrice: 35, minHarvest: 3, maxHarvest: 5, sellPricePerUnit: 15, levelRequired: 1, season: "summer" },
  { id: "moonlight_berry", name: "月光莓", growthHours: 10, buyPrice: 35, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 19, levelRequired: 1, season: "winter" },
  { id: "potato", name: "土豆", growthHours: 10, buyPrice: 40, minHarvest: 4, maxHarvest: 7, sellPricePerUnit: 11, levelRequired: 2, season: "winter" },
  { id: "carrot", name: "胡萝卜", growthHours: 12, buyPrice: 46, minHarvest: 3, maxHarvest: 6, sellPricePerUnit: 17, levelRequired: 2, season: "spring" },
  { id: "sweet_potato", name: "地瓜", growthHours: 12, buyPrice: 46, minHarvest: 4, maxHarvest: 7, sellPricePerUnit: 14, levelRequired: 2, season: "autumn" },
  { id: "blueberry", name: "蓝莓", growthHours: 12, buyPrice: 51, minHarvest: 3, maxHarvest: 6, sellPricePerUnit: 18, levelRequired: 3, season: "spring" },
  { id: "watermelon", name: "西瓜", growthHours: 14, buyPrice: 57, minHarvest: 1, maxHarvest: 3, sellPricePerUnit: 48, levelRequired: 3, season: "summer" },
  { id: "mint", name: "薄荷", growthHours: 14, buyPrice: 57, minHarvest: 4, maxHarvest: 7, sellPricePerUnit: 17, levelRequired: 3, season: "spring" },
  { id: "snow_pea", name: "雪豌豆", growthHours: 14, buyPrice: 57, minHarvest: 3, maxHarvest: 5, sellPricePerUnit: 24, levelRequired: 3, season: "winter" },
  { id: "chili", name: "辣椒", growthHours: 16, buyPrice: 68, minHarvest: 3, maxHarvest: 6, sellPricePerUnit: 26, levelRequired: 4, season: "summer" },
  { id: "pumpkin", name: "南瓜", growthHours: 16, buyPrice: 68, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 39, levelRequired: 4, season: "autumn" },
  { id: "eggplant", name: "茄子", growthHours: 16, buyPrice: 68, minHarvest: 3, maxHarvest: 5, sellPricePerUnit: 29, levelRequired: 4, season: "summer" },
  { id: "mushroom", name: "松茸", growthHours: 16, buyPrice: 73, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 41, levelRequired: 5, season: "autumn" },
  { id: "cocoa", name: "可可豆", growthHours: 18, buyPrice: 79, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 46, levelRequired: 5, season: "summer" },
  { id: "grape", name: "葡萄", growthHours: 18, buyPrice: 79, minHarvest: 3, maxHarvest: 6, sellPricePerUnit: 31, levelRequired: 5, season: "autumn" },
  { id: "rice", name: "水稻", growthHours: 18, buyPrice: 84, minHarvest: 4, maxHarvest: 8, sellPricePerUnit: 24, levelRequired: 6, season: "autumn" },
  { id: "coffee_bean", name: "咖啡豆", growthHours: 18, buyPrice: 84, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 48, levelRequired: 6, season: "spring" },
  { id: "tea_leaf", name: "茶叶", growthHours: 18, buyPrice: 84, minHarvest: 3, maxHarvest: 5, sellPricePerUnit: 36, levelRequired: 6, season: "spring" },
  { id: "sunflower", name: "向日葵", growthHours: 20, buyPrice: 95, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 55, levelRequired: 7, season: "summer" },
  { id: "aloe", name: "芦荟", growthHours: 20, buyPrice: 95, minHarvest: 3, maxHarvest: 5, sellPricePerUnit: 42, levelRequired: 7, season: "summer" },
  { id: "star_fruit", name: "星花果", growthHours: 20, buyPrice: 95, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 55, levelRequired: 7, season: "summer" },
  { id: "peach", name: "蜜桃", growthHours: 20, buyPrice: 95, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 55, levelRequired: 7, season: "winter" },
  { id: "ginseng", name: "人参", growthHours: 22, buyPrice: 106, minHarvest: 1, maxHarvest: 3, sellPricePerUnit: 95, levelRequired: 8, season: "winter" },
  { id: "lavender", name: "薰衣草", growthHours: 22, buyPrice: 106, minHarvest: 3, maxHarvest: 5, sellPricePerUnit: 48, levelRequired: 8, season: "spring" },
  { id: "cherry_blossom", name: "樱花", growthHours: 22, buyPrice: 106, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 63, levelRequired: 8, season: "spring" },
  { id: "pomegranate", name: "石榴", growthHours: 22, buyPrice: 106, minHarvest: 1, maxHarvest: 3, sellPricePerUnit: 95, levelRequired: 8, season: "autumn" },
  { id: "saffron", name: "藏红花", growthHours: 24, buyPrice: 117, minHarvest: 1, maxHarvest: 3, sellPricePerUnit: 108, levelRequired: 9, season: "autumn" },
  { id: "dragon_pepper", name: "龙息椒", growthHours: 24, buyPrice: 117, minHarvest: 1, maxHarvest: 3, sellPricePerUnit: 108, levelRequired: 9, season: "summer" },
  { id: "star_anise", name: "八角星", growthHours: 24, buyPrice: 117, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 72, levelRequired: 9, season: "autumn" },
  { id: "durian", name: "榴莲", growthHours: 26, buyPrice: 128, minHarvest: 1, maxHarvest: 3, sellPricePerUnit: 121, levelRequired: 10, season: "summer" },
  { id: "melon", name: "蜜瓜", growthHours: 26, buyPrice: 128, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 80, levelRequired: 10, season: "winter" },
  { id: "peony", name: "牡丹", growthHours: 26, buyPrice: 128, minHarvest: 1, maxHarvest: 3, sellPricePerUnit: 121, levelRequired: 10, season: "autumn" },
  { id: "truffle", name: "黑松露", growthHours: 28, buyPrice: 134, minHarvest: 1, maxHarvest: 2, sellPricePerUnit: 175, levelRequired: 10, season: "winter" },
  { id: "lotus_root", name: "莲藕", growthHours: 28, buyPrice: 139, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 89, levelRequired: 11, season: "winter" },
  { id: "moon_flower", name: "月华花", growthHours: 28, buyPrice: 139, minHarvest: 1, maxHarvest: 3, sellPricePerUnit: 134, levelRequired: 11, season: "winter" },
  { id: "rainbow_flower", name: "彩虹花", growthHours: 30, buyPrice: 145, minHarvest: 1, maxHarvest: 2, sellPricePerUnit: 193, levelRequired: 11, season: "spring" },
  { id: "immortal_peach", name: "仙桃", growthHours: 30, buyPrice: 150, minHarvest: 1, maxHarvest: 2, sellPricePerUnit: 197, levelRequired: 12, season: "winter" },
  { id: "golden_lotus", name: "金莲", growthHours: 30, buyPrice: 150, minHarvest: 1, maxHarvest: 2, sellPricePerUnit: 197, levelRequired: 12, season: "summer" },
  { id: "time_fruit", name: "时光果", growthHours: 48, buyPrice: 209, minHarvest: 1, maxHarvest: 2, sellPricePerUnit: 321, levelRequired: 13, season: "autumn" },
  { id: "nebula_fruit", name: "星云果", growthHours: 48, buyPrice: 209, minHarvest: 1, maxHarvest: 2, sellPricePerUnit: 321, levelRequired: 13, season: "spring" },
  { id: "abyss_flower", name: "深渊花", growthHours: 60, buyPrice: 250, minHarvest: 1, maxHarvest: 1, sellPricePerUnit: 616, levelRequired: 14, season: "winter" },
  { id: "eternal_vine", name: "永恒藤", growthHours: 72, buyPrice: 286, minHarvest: 1, maxHarvest: 1, sellPricePerUnit: 751, levelRequired: 14, season: "winter" },
  { id: "starlight_vine", name: "星光藤", growthHours: 72, buyPrice: 291, minHarvest: 1, maxHarvest: 2, sellPricePerUnit: 507, levelRequired: 15, season: "summer" },
  { id: "world_tree_sapling", name: "世界树苗", growthHours: 96, buyPrice: 363, minHarvest: 1, maxHarvest: 1, sellPricePerUnit: 1057, levelRequired: 15, season: "spring" },
  { id: "cosmic_wheat", name: "宇宙麦", growthHours: 96, buyPrice: 363, minHarvest: 2, maxHarvest: 4, sellPricePerUnit: 352, levelRequired: 15, season: "autumn" },
  { id: "primordial_herb", name: "原初草", growthHours: 144, buyPrice: 507, minHarvest: 1, maxHarvest: 1, sellPricePerUnit: 1755, levelRequired: 15, season: "winter" },
];

const OFF_SEASON_LIMIT = 5;

const FACILITIES: Record<string, { name: string; cost: number; icon: string; desc: string }> = {
  greenhouse: { name: "温室", cost: 500, icon: ICON_GREENHOUSE, desc: "错季种植不受惩罚，售价 x1.5" },
  autoWater: { name: "自动灌溉", cost: 200, icon: ICON_DROP, desc: "每次查看农场自动浇水" },
  scarecrow: { name: "稻草人", cost: 150, icon: ICON_SHIELD, desc: "偷菜收益减半（偷取率 40%）" },
  expand1: { name: "扩建 Lv.1", cost: 300, icon: ICON_TOOL, desc: "地块 +3（共 12 块）" },
  expand2: { name: "扩建 Lv.2", cost: 600, icon: ICON_TOOL, desc: "地块 +3（共 15 块）" },
  expand3: { name: "扩建 Lv.3", cost: 1000, icon: ICON_TOOL, desc: "地块 +3（共 18 块）" },
  chicken_coop: { name: "鸡舍", cost: 100, icon: ICON_HOME, desc: "饲养鸡、鸭、鹌鹑" },
  rabbit_hutch: { name: "兔笼", cost: 120, icon: ICON_HOME, desc: "饲养兔" },
  hatchery: { name: "孵化室", cost: 200, icon: ICON_GREENHOUSE, desc: "饲养蚕、凤羽鸡" },
  sheep_pen: { name: "羊圈", cost: 250, icon: ICON_HOME, desc: "饲养山羊、绵羊" },
  cow_barn: { name: "牛棚", cost: 400, icon: ICON_HOME, desc: "饲养奶牛、牦牛" },
  stable: { name: "畜栏", cost: 600, icon: ICON_HOME, desc: "饲养羊驼、鸵鸟" },
  spirit_nest: { name: "灵兽巢", cost: 1000, icon: ICON_GREENHOUSE, desc: "饲养龙龟、月狐" },
};

const PESTICIDE_PRICE = 30;
const FERTILIZER_PRICE = 25;
const FERTILIZER_DURATION_MS = 12 * 60 * 60 * 1000;
const FERTILIZER_MAX_BOOST = 0.2;
const PEST_TOLERANCE_MS = 3 * 60 * 60 * 1000;
const THIRST_TOLERANCE_MS = 60 * 60 * 1000;

type LivestockDef = { id: string; name: string; buyPrice: number; produceName: string; producePrice: number; produceIntervalHours: number; feedCost: number; growHours: number };
const LIVESTOCK: LivestockDef[] = [
  { id: "quail", name: "鹌鹑", buyPrice: 50, produceName: "鹌鹑蛋", producePrice: 6, produceIntervalHours: 1, feedCost: 3, growHours: 2 },
  { id: "chicken", name: "鸡", buyPrice: 60, produceName: "鸡蛋", producePrice: 8, produceIntervalHours: 2, feedCost: 5, growHours: 4 },
  { id: "duck", name: "鸭", buyPrice: 80, produceName: "鸭蛋", producePrice: 12, produceIntervalHours: 3, feedCost: 6, growHours: 6 },
  { id: "rabbit", name: "兔", buyPrice: 100, produceName: "兔毛", producePrice: 18, produceIntervalHours: 4, feedCost: 8, growHours: 8 },
  { id: "silkworm", name: "蚕", buyPrice: 120, produceName: "蚕丝", producePrice: 25, produceIntervalHours: 5, feedCost: 10, growHours: 10 },
  { id: "goat", name: "山羊", buyPrice: 200, produceName: "羊奶", producePrice: 35, produceIntervalHours: 6, feedCost: 15, growHours: 12 },
  { id: "sheep", name: "绵羊", buyPrice: 300, produceName: "羊毛", producePrice: 50, produceIntervalHours: 8, feedCost: 20, growHours: 16 },
  { id: "cow", name: "奶牛", buyPrice: 500, produceName: "牛奶", producePrice: 80, produceIntervalHours: 12, feedCost: 35, growHours: 24 },
  { id: "llama", name: "羊驼", buyPrice: 800, produceName: "羊驼毛", producePrice: 120, produceIntervalHours: 16, feedCost: 50, growHours: 32 },
  { id: "yak", name: "牦牛", buyPrice: 1000, produceName: "牦牛奶", producePrice: 150, produceIntervalHours: 18, feedCost: 60, growHours: 36 },
  { id: "ostrich", name: "鸵鸟", buyPrice: 1200, produceName: "鸵鸟蛋", producePrice: 200, produceIntervalHours: 20, feedCost: 80, growHours: 40 },
  { id: "phoenix_chicken", name: "凤羽鸡", buyPrice: 1500, produceName: "凤羽", producePrice: 250, produceIntervalHours: 24, feedCost: 100, growHours: 48 },
  { id: "dragon_turtle", name: "龙龟", buyPrice: 2500, produceName: "龙鳞", producePrice: 400, produceIntervalHours: 36, feedCost: 150, growHours: 72 },
  { id: "moon_fox", name: "月狐", buyPrice: 4000, produceName: "月光绒", producePrice: 600, produceIntervalHours: 48, feedCost: 200, growHours: 96 },
];

// ── Weather system ──

type Weather = "sunny" | "rainy" | "cloudy" | "windy";
const WEATHER_NAMES: Record<Weather, string> = { sunny: "晴", rainy: "雨", cloudy: "阴", windy: "风" };
const WEATHER_ICONS: Record<Weather, string> = { sunny: ICON_SUN, rainy: ICON_DROP, cloudy: ICON_SNOW, windy: ICON_AUTUMN };
const WEATHER_GROWTH: Record<Weather, number> = { sunny: 1.0, rainy: 1.15, cloudy: 0.95, windy: 0.9 };

function rollWeather(): Weather {
  const r = Math.random();
  if (r < 0.4) return "sunny";
  if (r < 0.65) return "cloudy";
  if (r < 0.85) return "rainy";
  return "windy";
}

// ── Quality tiers ──

type Quality = "normal" | "silver" | "gold";
const QUALITY_MULT: Record<Quality, number> = { normal: 1.0, silver: 1.25, gold: 1.6 };

function calcQuality(plot: PlotState): Quality {
  let score = 0;
  if (plot.watered) score++;
  if (plot.fertilizedAt && Date.now() - plot.fertilizedAt < FERTILIZER_DURATION_MS) score++;
  if (!plot.pestedAt || Date.now() - plot.pestedAt >= PEST_TOLERANCE_MS) score++;
  if (score >= 3) return "gold";
  if (score >= 2) return "silver";
  return "normal";
}

// ── Processing recipes ──

type Recipe = { input: string; inputQty: number; output: string; outputQty: number; cost: number };
const RECIPES: Recipe[] = [
  { input: "grape", inputQty: 3, output: "葡萄酒", outputQty: 1, cost: 20 },
  { input: "rice", inputQty: 2, output: "米饭", outputQty: 1, cost: 5 },
  { input: "coffee_bean", inputQty: 3, output: "咖啡", outputQty: 1, cost: 15 },
  { input: "tea_leaf", inputQty: 2, output: "茶叶包", outputQty: 1, cost: 10 },
  { input: "cocoa", inputQty: 3, output: "巧克力", outputQty: 1, cost: 20 },
  { input: "milk", inputQty: 2, output: "奶酪", outputQty: 1, cost: 15 },
  { input: "strawberry", inputQty: 3, output: "草莓酱", outputQty: 1, cost: 10 },
  { input: "pumpkin", inputQty: 1, output: "南瓜灯", outputQty: 1, cost: 25 },
  { input: "sunflower", inputQty: 2, output: "葵花籽油", outputQty: 1, cost: 20 },
  { input: "moonlight_berry", inputQty: 3, output: "月光酒", outputQty: 1, cost: 30 },
  { input: "dragon_pepper", inputQty: 2, output: "龙息酱", outputQty: 1, cost: 40 },
  { input: "rainbow_flower", inputQty: 1, output: "彩虹染料", outputQty: 1, cost: 50 },
  { input: "time_fruit", inputQty: 1, output: "时光精华", outputQty: 1, cost: 100 },
];

const PROCESSED_PRICES: Record<string, number> = {
  "葡萄酒": 120, "米饭": 35, "咖啡": 150, "茶叶包": 80, "巧克力": 110,
  "奶酪": 180, "草莓酱": 25, "南瓜灯": 60, "葵花籽油": 130,
  "月光酒": 40, "龙息酱": 250, "彩虹染料": 300, "时光精华": 600,
};

// ── Animal feed mapping ──

const ANIMAL_FEED: Record<string, string> = {
  quail: "moonlight_berry", chicken: "corn", duck: "rice",
  rabbit: "carrot", silkworm: "tea_leaf",
  goat: "potato", sheep: "sweet_potato", cow: "rice",
  llama: "blueberry", yak: "potato", ostrich: "watermelon",
  phoenix_chicken: "moonlight_berry", dragon_turtle: "ginseng", moon_fox: "star_fruit",
};

const ANIMAL_FACILITIES: Record<string, string> = {
  quail: "quail_cage", chicken: "chicken_coop", duck: "chicken_coop",
  rabbit: "rabbit_hutch", silkworm: "hatchery",
  goat: "sheep_pen", sheep: "sheep_pen", cow: "cow_barn",
  llama: "stable", yak: "cow_barn", ostrich: "stable",
  phoenix_chicken: "hatchery", dragon_turtle: "spirit_nest", moon_fox: "spirit_nest",
};

type PlotState = { cropId: string; plantedAt: number; watered: boolean; greenhouse?: boolean; pestedAt?: number; thirstyAt?: number; fertilizedAt?: number };
type LivestockEntry = { boughtAt: number; lastCollectAt: number; lastFedAt?: number };
type FarmState = {
  plots: (PlotState | null)[]; inventory: Record<string, number>;
  stolenBy: Record<string, number>; stolenFrom: Record<string, number>;
  xp: number; level: number; facilities: string[];
  dailyLimit: Record<string, string>; livestock: Record<string, LivestockEntry>;
  weather: Weather; processedGoods: Record<string, number>;
};

function defaultFarm(): FarmState {
  return {
    plots: [null, null, null, null, null, null, null, null, null],
    inventory: {}, stolenBy: {}, stolenFrom: {},
    xp: 0, level: 1, facilities: [], dailyLimit: {}, livestock: {},
    weather: rollWeather(), processedGoods: {},
  };
}

function xpForLevel(level: number): number { return level * 50; }
function addXp(farm: FarmState, amount: number) {
  farm.xp += amount;
  while (farm.xp >= xpForLevel(farm.level)) { farm.xp -= xpForLevel(farm.level); farm.level++; }
}

function getCrop(id: string): CropDef | undefined { return CROPS.find((c) => c.id === id); }

function hasFacility(farm: FarmState, id: string): boolean { return farm.facilities.includes(id); }
function plotCount(farm: FarmState): number {
  if (hasFacility(farm, "expand3")) return 18;
  if (hasFacility(farm, "expand2")) return 15;
  if (hasFacility(farm, "expand1")) return 12;
  return 9;
}

function getStage(plot: PlotState): { stage: "sprout" | "growing" | "mature" | "ready"; remainingMs: number } {
  const crop = getCrop(plot.cropId);
  if (!crop) return { stage: "ready", remainingMs: 0 };
  const totalMs = crop.growthHours * 60 * 60 * 1000;
  const elapsed = Date.now() - plot.plantedAt;
  let bonus = plot.watered ? 0.3 * totalMs : 0;
  if (plot.fertilizedAt && Date.now() - plot.fertilizedAt < FERTILIZER_DURATION_MS) {
    bonus += FERTILIZER_MAX_BOOST * totalMs;
  }
  const effective = Math.min((elapsed + bonus) / totalMs, 1);
  if (effective >= 1) return { stage: "ready", remainingMs: 0 };
  if (effective >= 0.66) return { stage: "mature", remainingMs: totalMs - (elapsed + bonus) };
  if (effective >= 0.33) return { stage: "growing", remainingMs: totalMs - (elapsed + bonus) };
  return { stage: "sprout", remainingMs: totalMs - (elapsed + bonus) };
}

function isReady(plot: PlotState): boolean { return getStage(plot).stage === "ready"; }

function isInSeason(crop: CropDef): boolean { return crop.season === getCurrentSeason(); }

function isSleepHours(): boolean {
  const h = new Date().getHours();
  return h >= 23 || h < 8;
}

function effectiveSellPrice(crop: CropDef, farm: FarmState, plot?: PlotState): number {
  let base = crop.sellPricePerUnit;
  if (!isInSeason(crop)) {
    if (hasFacility(farm, "greenhouse")) base = Math.round(base * 1.5);
  }
  if (plot && plot.pestedAt && Date.now() - plot.pestedAt < PEST_TOLERANCE_MS) {
    base = Math.round(base * 0.5);
  }
  return base;
}

function growthMultiplier(crop: CropDef, farm: FarmState): number {
  if (isInSeason(crop)) return 1;
  if (hasFacility(farm, "greenhouse")) return 1;
  return 2;
}

function applyFarmTick(farm: FarmState): boolean {
  if (isSleepHours()) return false;
  let changed = false;
  const now = Date.now();
  for (const plot of farm.plots) {
    if (!plot || isReady(plot)) continue;
    if (!plot.pestedAt && Math.random() < 1 / 720) {
      plot.pestedAt = now;
      changed = true;
    }
    if (!plot.thirstyAt && Math.random() < 1 / 60) {
      plot.thirstyAt = now;
      changed = true;
    }
  }
  return changed;
}

const STORE_PREFIX = "farm:";

function loadFarm(messageStore: MessageStore, userId: string): FarmState {
  const data = messageStore.getContextState(STORE_PREFIX + userId) as FarmState | null;
  if (data) {
    const n = data.facilities ? (hasFacility(data, "expand3") ? 18 : hasFacility(data, "expand2") ? 15 : hasFacility(data, "expand1") ? 12 : 9) : 9;
    while (data.plots.length < n) data.plots.push(null);
    data.plots = data.plots.slice(0, n);
    data.inventory ??= {}; data.stolenBy ??= {}; data.stolenFrom ??= {};
    data.xp ??= 0; data.level ??= 1; data.facilities ??= []; data.dailyLimit ??= {}; data.livestock ??= {}; data.weather ??= rollWeather(); data.processedGoods ??= {};
    return data;
  }
  return defaultFarm();
}

function saveFarm(messageStore: MessageStore, userId: string, farm: FarmState): void {
  messageStore.saveContextState(STORE_PREFIX + userId, farm);
}

const CARD_CSS = '* { box-sizing: border-box; margin: 0; padding: 0; } body { background: #0f1117; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", sans-serif; } .ct { background: #0f1117; color: #e6edf3; width: fit-content; min-width: 300px; max-width: 380px; } .ct svg { vertical-align: middle; } .ct-hd { display: flex; align-items: center; gap: 8px; padding: 10px 14px 8px; border-bottom: 1px solid #21262d; } .ct-hd svg { flex-shrink: 0; } .ct-hd-t { font-size: 14px; font-weight: 600; color: #e6edf3; } .ct-hd-s { font-size: 10px; color: #8b949e; margin-left: auto; } .ct-row { display: flex; align-items: center; gap: 6px; padding: 4px 14px; font-size: 12px; line-height: 1.4; min-height: 24px; border-bottom: 1px solid #1a1f27; } .ct-row:last-child { border-bottom: none; } .ct-idx { color: #484f58; font-family: monospace; font-size: 11px; min-width: 20px; } .ct-name { color: #e6edf3; min-width: 44px; } .ct-status { color: #8b949e; font-size: 11px; flex: 1; text-align: right; } .ct-sec { padding: 6px 14px; border-top: 1px solid #21262d; font-size: 11px; color: #8b949e; line-height: 1.6; } .ct-ft { padding: 6px 14px; border-top: 1px solid #21262d; font-size: 10px; color: #6e7681; text-align: center; }';

function cardHtml(body: string): string {
  return '<!DOCTYPE html><html><head><style>' + CARD_CSS + '</style></head><body><div class="ct">' + body + '</div></body></html>';
}

type SI = { stage: string; label: string; icon: string };
function plotStatus(plot: PlotState): SI {
  const s = getStage(plot);
  if (s.stage === "ready") return { stage: "ready", label: "可收获", icon: ICON_CHECK };
  const totalMin = Math.ceil(s.remainingMs / 60000);
  const label = totalMin >= 60 ? Math.round(totalMin / 60) + "h" : totalMin + "m";
  const w = s.stage === "sprout" ? "发芽" : s.stage === "growing" ? "生长" : "成熟";
  const wi = s.stage === "sprout" ? ICON_SPROUT : s.stage === "growing" ? ICON_LEAF : ICON_STAR;
  return { stage: s.stage, label: w + " " + label, icon: wi };
}
function renderFarm(farm: FarmState, coins: number): string {
  const rows: string[] = [];
  const n = plotCount(farm);
  for (let i = 0; i < n; i++) {
    const plot = farm.plots[i];
    if (!plot) {
      rows.push('<div class="ct-row"><span class="ct-idx">#' + (i + 1) + '</span><span class="ct-status" style="text-align:left;color:#484f58">空闲</span></div>');
    } else {
      const crop = getCrop(plot.cropId);
      const st = plotStatus(plot);
      const wm = plot.watered && st.stage !== "ready" ? '<span style="margin-left:3px">' + ICON_DROP + '</span>' : "";
      const gh = plot.greenhouse ? '<span style="margin-left:2px;color:#3fb950">' + ICON_GREENHOUSE + '</span>' : "";
      const now = Date.now();
      const hasPest = plot.pestedAt && now - plot.pestedAt < PEST_TOLERANCE_MS;
      const isThirsty = plot.thirstyAt && now - plot.thirstyAt < THIRST_TOLERANCE_MS;
      const pestTag = hasPest ? '<span style="margin-left:2px;color:#f85149">' + ICON_SHIELD + '</span>' : "";
      const thirstTag = isThirsty ? '<span style="margin-left:2px;color:#d29922">' + ICON_DROP + '</span>' : "";
      rows.push('<div class="ct-row"><span class="ct-idx">#' + (i + 1) + '</span><span class="ct-name">' + (crop?.name ?? "?") + '</span><span class="ct-status">' + st.icon + ' ' + st.label + wm + gh + pestTag + thirstTag + '</span></div>');
    }
  }
  const inv = Object.entries(farm.inventory).filter(([, q]) => q > 0);
  const invHtml = inv.length > 0 ? inv.map(([id, qty]) => (getCrop(id)?.name ?? id) + " x" + qty).join("  ") : "空";
  const fac = farm.facilities.length > 0 ? farm.facilities.map((f) => FACILITIES[f]?.name ?? f).join(" ") : "无";
  const lv = Object.entries(farm.livestock);
  const lvHtml = lv.length > 0 ? lv.map(([id]) => { const d = LIVESTOCK.find((l) => l.id === id); return d?.name ?? id; }).join(" ") : "无";
  const s = getCurrentSeason();
  return cardHtml('<div class="ct-hd">' + ICON_HOME + '<span class="ct-hd-t">农场 Lv.' + farm.level + '</span><span class="ct-hd-s">' + SEASON_ICONS[s] + ' ' + SEASON_NAMES[s] + ' | ' + ICON_STAR + ' ' + farm.xp + '/' + xpForLevel(farm.level) + '</span></div><div class="ct-row">' + ICON_COIN + '<span style="color:#e3b341;font-weight:600">' + coins + '</span><span style="margin-left:auto;color:#8b949e;font-size:11px">' + farm.plots.filter((p) => p !== null && isReady(p)).length + ' 块可收获</span></div>' + rows.join("") + '<div class="ct-sec">' + ICON_HARVEST + ' 种子: ' + invHtml + '<br>' + ICON_TOOL + ' 设施: ' + fac + '<br>' + ICON_STAR + ' 牲畜: ' + lvHtml + '</div><div class="ct-ft">farm-buy &lt;种子&gt; | farm-plant &lt;#N&gt; &lt;种子&gt; | farm-harvest | farm-ranch</div>');
}

function renderShop(farm: FarmState, coins: number): string {
  const lines: string[] = [];
  const season = getCurrentSeason();
  const byLevel = new Map<number, CropDef[]>();
  for (const c of CROPS) { const arr = byLevel.get(c.levelRequired) ?? []; arr.push(c); byLevel.set(c.levelRequired, arr); }
  const today = todayKey();
  for (const [lv, crops] of byLevel) {
    const unlocked = lv <= farm.level;
    for (const c of crops) {
      const owned = farm.inventory[c.id] ?? 0;
      const inSeason = isInSeason(c);
      const price = c.buyPrice;
      const sell = effectiveSellPrice(c, farm);
      const mult = growthMultiplier(c, farm);
      const gt = mult > 1 ? " x" + mult : "";
      const limit = !inSeason && !hasFacility(farm, "greenhouse") ? " 限" + OFF_SEASON_LIMIT + "/天" : "";
      const dailyUsed = !inSeason && !hasFacility(farm, "greenhouse") ? parseInt((farm.dailyLimit[today + ":" + c.id] ?? "0"), 10) : 0;
      const remaining = Math.max(0, OFF_SEASON_LIMIT - dailyUsed);
      const rem = !inSeason && !hasFacility(farm, "greenhouse") ? " 余" + remaining : "";
      const lock = unlocked ? "" : ' <span style="color:#f85149">已锁定</span>';
      const op = unlocked ? "" : "0.4";
      const seasonTag = c.season === season ? "" : ' <span style="color:#f0883e">错季' + gt + '</span>';
      lines.push('<div class="ct-row" style="opacity:' + op + '"><span class="ct-name">' + c.name + seasonTag + '</span><span class="ct-status">' + price + ' | 卖' + sell + ' | ' + c.growthHours + 'h' + gt + ' | 背包x' + owned + limit + rem + lock + '</span></div>');
    }
  }
  return cardHtml('<div class="ct-hd">' + ICON_SHOP + '<span class="ct-hd-t">种子商店</span><span class="ct-hd-s">' + SEASON_ICONS[season] + ' ' + SEASON_NAMES[season] + ' | ' + ICON_COIN + ' ' + coins + ' Lv.' + farm.level + '</span></div><div style="padding:4px 14px;font-size:10px;color:#484f58;border-bottom:1px solid #1a1f27">价格 | 售价 | 时长 | 库存</div>' + lines.join("") + '<div class="ct-ft">farm-buy &lt;种子&gt; | farm-pesticide ' + PESTICIDE_PRICE + ' | farm-fertilizer ' + FERTILIZER_PRICE + ' | farm-ranch</div>');
}

function renderFacilities(farm: FarmState, coins: number): string {
  const lines: string[] = [];
  for (const [id, f] of Object.entries(FACILITIES)) {
    const owned = hasFacility(farm, id);
    const canBuy = !owned && coins >= f.cost;
    const status = owned ? ' <span style="color:#3fb950">已拥有</span>' : canBuy ? "" : ' <span style="color:#f85149">金币不足</span>';
    const op = owned ? "0.5" : "";
    lines.push('<div class="ct-row" style="opacity:' + op + '"><span class="ct-name">' + f.icon + ' ' + f.name + '</span><span class="ct-status">' + f.cost + status + '</span></div><div class="ct-row" style="padding-left:20px;font-size:10px;color:#6e7681">' + f.desc + '</div>');
  }
  return cardHtml('<div class="ct-hd">' + ICON_TOOL + '<span class="ct-hd-t">农场设施</span><span class="ct-hd-s">' + ICON_COIN + ' ' + coins + '</span></div>' + lines.join("") + '<div class="ct-ft">farm-build &lt;设施名&gt; 购买</div>');
}

function renderGuide(prefix: string): string {
  const lines: string[] = [];
  const byLevel = new Map<number, CropDef[]>();
  for (const c of CROPS) { const arr = byLevel.get(c.levelRequired) ?? []; arr.push(c); byLevel.set(c.levelRequired, arr); }
  for (const [lv, crops] of byLevel) {
    lines.push('<div class="ct-row" style="font-weight:600;color:#8b949e;font-size:11px">' + ICON_STAR + ' Lv.' + lv + '</div>');
    for (const c of crops) {
      lines.push('<div class="ct-row" style="padding-left:24px"><span class="ct-name">' + c.name + '</span><span class="ct-status">' + c.growthHours + 'h | 收' + c.minHarvest + '-' + c.maxHarvest + ' | 卖' + c.sellPricePerUnit + ' | 买' + c.buyPrice + ' | ' + SEASON_NAMES[c.season] + '</span></div>');
    }
  }
  return cardHtml('<div class="ct-hd">' + ICON_HOME + '<span class="ct-hd-t">农场指南</span><span class="ct-hd-s">作物图鉴</span></div>' + lines.join("") + '<div class="ct-ft">' + prefix + 'farm 查看农场</div>');
}

async function renderToImage(html: string): Promise<string> {
  const dir = path.resolve("data/farm-images");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, "farm-" + Date.now() + ".webp");
  await screenshotHtml(html, fp, { width: 340, format: "webp", quality: 85 });
  return fp;
}

export function createFarmPlugin(
  menuPlugin: MenuPlugin,
  messageStore: MessageStore,
  store: DataStorePlugin,
  onebot: OneBotClient,
): Plugin {
  return {
    name: "farm",
    description: "农场：种植、收获、偷菜、季节系统",

    onLoad(ctx: PluginContext) {
      menuPlugin.registerCommandGroup("farm", "农场经营", "种植、养殖、制作、交易");
      menuPlugin.registerCommand("farm", "查看我的农场状态", async (message: BotMessage) => {
        const userId = message.userId!;
        const farm = loadFarm(messageStore, userId);
        if (applyFarmTick(farm)) saveFarm(messageStore, userId, farm);
        const profile = store.getUserData(userId);
        if (hasFacility(farm, "autoWater")) {
          for (const p of farm.plots) { if (p && !isReady(p) && !p.watered) p.watered = true; }
          saveFarm(messageStore, userId, farm);
        }
        const html = renderFarm(farm, profile.coins);
        const fp = await renderToImage(html);
        const target = message.type === "group" ? { type: "group" as const, id: message.groupId! } : { type: "private" as const, id: message.userId! };
        await ctx.sendImage(target, fp);
        fs.unlink(fp, () => {});
      });

      menuPlugin.registerCommand("farm-shop", "查看种子商店", async (message: BotMessage) => {
        const userId = message.userId!;
        const farm = loadFarm(messageStore, userId);
        const profile = store.getUserData(userId);
        const html = renderShop(farm, profile.coins);
        const fp = await renderToImage(html);
        const target = message.type === "group" ? { type: "group" as const, id: message.groupId! } : { type: "private" as const, id: message.userId! };
        await ctx.sendImage(target, fp);
        fs.unlink(fp, () => {});
      });

      menuPlugin.registerCommand("farm-guide", "查看农场指南", async (message: BotMessage) => {
        const html = renderGuide(menuPlugin.getPrefix());
        const fp = await renderToImage(html);
        const target = message.type === "group" ? { type: "group" as const, id: message.groupId! } : { type: "private" as const, id: message.userId! };
        await ctx.sendImage(target, fp);
        fs.unlink(fp, () => {});
      });

      menuPlugin.registerCommand("farm-facility", "查看/购买农场设施", async (message: BotMessage) => {
        const userId = message.userId!;
        const farm = loadFarm(messageStore, userId);
        const profile = store.getUserData(userId);
        const html = renderFacilities(farm, profile.coins);
        const fp = await renderToImage(html);
        const target = message.type === "group" ? { type: "group" as const, id: message.groupId! } : { type: "private" as const, id: message.userId! };
        await ctx.sendImage(target, fp);
        fs.unlink(fp, () => {});
      });

      menuPlugin.registerCommand("farm-build", "购买农场设施", async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        if (args.length < 1) { await ctx.replyText(message, "用法: farm-build <设施名>"); return; }
        const name = args.join(" ");
        const entry = Object.entries(FACILITIES).find(([, f]) => f.name === name);
        if (!entry) { await ctx.replyText(message, "未知设施。可用: " + Object.values(FACILITIES).map((f) => f.name).join("、")); return; }
        const [id, fac] = entry;
        const farm = loadFarm(messageStore, userId);
        if (hasFacility(farm, id)) { await ctx.replyText(message, "已拥有该设施。"); return; }
        const profile = store.getUserData(userId);
        if (profile.coins < fac.cost) { await ctx.replyText(message, "金币不足。需要 " + fac.cost + "，当前 " + profile.coins + "。"); return; }
        profile.coins -= fac.cost;
        store.saveUserData(userId, profile);
        farm.facilities.push(id);
        const n = plotCount(farm);
        while (farm.plots.length < n) farm.plots.push(null);
        saveFarm(messageStore, userId, farm);
        await ctx.replyText(message, "购买了 " + fac.name + "！" + fac.desc);
      });

      menuPlugin.registerCommand("farm-buy", "购买种子", async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        if (args.length < 1) { await ctx.replyText(message, "用法: farm-buy <种子名> [数量]"); return; }
        const seedName = args[0];
        const qty = Math.max(1, parseInt(args[1] ?? "1", 10) || 1);
        const crop = CROPS.find((c) => c.name === seedName || c.id === seedName);
        if (!crop) { await ctx.replyText(message, "未知种子。"); return; }
        const farm = loadFarm(messageStore, userId);
        if (crop.levelRequired > farm.level) { await ctx.replyText(message, "需要农场等级 " + crop.levelRequired + "。"); return; }
        const inSeason = isInSeason(crop);
        const hasGh = hasFacility(farm, "greenhouse");
        if (!inSeason && !hasGh) {
          const today = todayKey();
          const key = today + ":" + crop.id;
          const used = parseInt((farm.dailyLimit[key] ?? "0"), 10);
          const canBuy = Math.min(qty, OFF_SEASON_LIMIT - used);
          if (canBuy <= 0) { await ctx.replyText(message, crop.name + " 今日限购已达上限（" + OFF_SEASON_LIMIT + "）。"); return; }
          const totalCost = crop.buyPrice * canBuy;
          const profile = store.getUserData(userId);
          if (profile.coins < totalCost) { await ctx.replyText(message, "金币不足。"); return; }
          profile.coins -= totalCost; store.saveUserData(userId, profile);
          farm.inventory[crop.id] = (farm.inventory[crop.id] ?? 0) + canBuy;
          farm.dailyLimit[key] = String(used + canBuy);
          saveFarm(messageStore, userId, farm);
          await ctx.replyText(message, "错季限购，购买了 " + crop.name + " x" + canBuy + "（今日剩余 " + (OFF_SEASON_LIMIT - used - canBuy) + "）。");
          return;
        }
        const totalCost = crop.buyPrice * qty;
        const profile = store.getUserData(userId);
        if (profile.coins < totalCost) { await ctx.replyText(message, "金币不足。"); return; }
        profile.coins -= totalCost; store.saveUserData(userId, profile);
        farm.inventory[crop.id] = (farm.inventory[crop.id] ?? 0) + qty;
        saveFarm(messageStore, userId, farm);
        await ctx.replyText(message, "购买了 " + crop.name + " x" + qty + "，花费 " + totalCost + "。");
      });

      menuPlugin.registerCommand("farm-plant", "种植", async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        if (args.length < 2) { await ctx.replyText(message, "用法: farm-plant <#1-N> <种子名>"); return; }
        const plotIdx = parseInt(args[0], 10) - 1;
        const farm = loadFarm(messageStore, userId);
        const n = plotCount(farm);
        if (isNaN(plotIdx) || plotIdx < 0 || plotIdx >= n) { await ctx.replyText(message, "地块编号为 1-" + n + "。"); return; }
        const seedName = args.slice(1).join(" ");
        const crop = CROPS.find((c) => c.name === seedName || c.id === seedName);
        if (!crop) { await ctx.replyText(message, "未知种子。"); return; }
        if (crop.levelRequired > farm.level) { await ctx.replyText(message, "需要农场等级 " + crop.levelRequired + "。"); return; }
        if (farm.plots[plotIdx] !== null) { await ctx.replyText(message, "该地块已有作物。"); return; }
        const owned = farm.inventory[crop.id] ?? 0;
        if (owned < 1) { await ctx.replyText(message, "没有 " + crop.name + " 种子。"); return; }
        farm.inventory[crop.id] = owned - 1;
        const gh = hasFacility(farm, "greenhouse");
        const mult = growthMultiplier(crop, farm);
        const actualHours = Math.round(crop.growthHours * mult);
        farm.plots[plotIdx] = { cropId: crop.id, plantedAt: Date.now(), watered: false, greenhouse: gh && !isInSeason(crop) };
        saveFarm(messageStore, userId, farm);
        const seasonNote = !isInSeason(crop) && !gh ? "（错季生长时间 x2）" : !isInSeason(crop) && gh ? "（温室种植）" : "";
        await ctx.replyText(message, "在 #" + (plotIdx + 1) + " 种植了 " + crop.name + "！预计 " + actualHours + " 小时后成熟。" + seasonNote);
      });

      menuPlugin.registerCommand("farm-water", "浇水", async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        if (args.length < 1) { await ctx.replyText(message, "用法: farm-water <#1-N>"); return; }
        const plotIdx = parseInt(args[0], 10) - 1;
        if (isNaN(plotIdx) || plotIdx < 0) { await ctx.replyText(message, "无效编号。"); return; }
        const farm = loadFarm(messageStore, userId);
        if (plotIdx >= plotCount(farm)) { await ctx.replyText(message, "地块不存在。"); return; }
        const plot = farm.plots[plotIdx];
        if (!plot) { await ctx.replyText(message, "该地块没有作物。"); return; }
        if (isReady(plot)) { await ctx.replyText(message, "作物已成熟，请收获。"); return; }
        if (plot.watered) { await ctx.replyText(message, "已浇过水。"); return; }
        plot.watered = true; addXp(farm, 2); saveFarm(messageStore, userId, farm);
        await ctx.replyText(message, "浇水成功！生长时间缩短 30%。");
      });

      menuPlugin.registerCommand("farm-pesticide", "购买并使用杀虫剂", async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        if (args.length < 1) { await ctx.replyText(message, "用法: farm-pesticide <#1-N>"); return; }
        const plotIdx = parseInt(args[0], 10) - 1;
        if (isNaN(plotIdx) || plotIdx < 0) { await ctx.replyText(message, "无效编号。"); return; }
        const farm = loadFarm(messageStore, userId);
        if (plotIdx >= plotCount(farm)) { await ctx.replyText(message, "地块不存在。"); return; }
        const plot = farm.plots[plotIdx];
        if (!plot) { await ctx.replyText(message, "该地块没有作物。"); return; }
        if (!plot.pestedAt || Date.now() - plot.pestedAt >= PEST_TOLERANCE_MS) {
          await ctx.replyText(message, "该作物没有虫害，无需使用杀虫剂。");
          return;
        }
        const profile = store.getUserData(userId);
        if (profile.coins < PESTICIDE_PRICE) { await ctx.replyText(message, "金币不足。杀虫剂需要 " + PESTICIDE_PRICE + "。"); return; }
        profile.coins -= PESTICIDE_PRICE; store.saveUserData(userId, profile);
        plot.pestedAt = undefined;
        saveFarm(messageStore, userId, farm);
        await ctx.replyText(message, "已使用杀虫剂！虫害已清除，产量恢复正常。");
      });

      menuPlugin.registerCommand("farm-fertilizer", "购买并使用化肥", async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        if (args.length < 1) { await ctx.replyText(message, "用法: farm-fertilizer <#1-N>"); return; }
        const plotIdx = parseInt(args[0], 10) - 1;
        if (isNaN(plotIdx) || plotIdx < 0) { await ctx.replyText(message, "无效编号。"); return; }
        const farm = loadFarm(messageStore, userId);
        if (plotIdx >= plotCount(farm)) { await ctx.replyText(message, "地块不存在。"); return; }
        const plot = farm.plots[plotIdx];
        if (!plot) { await ctx.replyText(message, "该地块没有作物。"); return; }
        if (plot.fertilizedAt && Date.now() - plot.fertilizedAt < FERTILIZER_DURATION_MS) {
          await ctx.replyText(message, "该地块已施肥，效果持续中。"); return;
        }
        const profile = store.getUserData(userId);
        if (profile.coins < FERTILIZER_PRICE) { await ctx.replyText(message, "金币不足。化肥需要 " + FERTILIZER_PRICE + "。"); return; }
        profile.coins -= FERTILIZER_PRICE; store.saveUserData(userId, profile);
        plot.fertilizedAt = Date.now();
        saveFarm(messageStore, userId, farm);
        await ctx.replyText(message, "已施肥！12 小时内生长速度提升 20%。");
      });

      menuPlugin.registerCommand("farm-ranch", "查看农场牧场", async (message: BotMessage) => {
        const userId = message.userId!;
        const farm = loadFarm(messageStore, userId);
        const profile = store.getUserData(userId);
        const lines: string[] = [];
        const entries = Object.entries(farm.livestock);
        if (entries.length === 0) {
          lines.push("当前没有牲畜。可用:");
          for (const l of LIVESTOCK) {
            const canBuy = profile.coins >= l.buyPrice;
            lines.push("  " + l.name + " 买" + l.buyPrice + " 产" + l.produceName + "(" + l.producePrice + ") 每" + l.produceIntervalHours + "h 饲料" + l.feedCost + (canBuy ? "" : " 金币不足"));
          }
          lines.push("farm-ranch-buy <牲畜名> 购买");
        } else {
          lines.push("牧场牲畜:");
          for (const [id, entry] of entries) {
            const def = LIVESTOCK.find((l) => l.id === id);
            if (!def) continue;
            const growMs = def.growHours * 60 * 60 * 1000;
            const age = Date.now() - entry.boughtAt;
            if (age < growMs) {
              const remainGrow = Math.ceil((growMs - age) / 3600000);
              lines.push("  " + def.name + " [幼崽] " + remainGrow + "h 后成年");
              continue;
            }
            const elapsed = Date.now() - entry.lastCollectAt;
            const intervalMs = def.produceIntervalHours * 60 * 60 * 1000;
            const ready = elapsed >= intervalMs;
            const remaining = ready ? "可收获" : Math.ceil((intervalMs - elapsed) / 3600000) + "h 后";
            lines.push("  " + def.name + " [成年] " + def.produceName + " " + remaining);
          }
          lines.push("farm-ranch-collect <牲畜名> 收获产物");
        }
        await ctx.replyText(message, lines.join("\n"));
      });

      menuPlugin.registerCommand("farm-ranch-buy", "购买牲畜", async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        if (args.length < 1) { await ctx.replyText(message, "用法: farm-ranch-buy <牲畜名>"); return; }
        const name = args.join(" ");
        const def = LIVESTOCK.find((l) => l.name === name);
        if (!def) { await ctx.replyText(message, "未知牲畜。"); return; }
        const farm = loadFarm(messageStore, userId);
        if (farm.livestock[def.id]) { await ctx.replyText(message, "已拥有该牲畜。"); return; }
        const profile = store.getUserData(userId);
        if (profile.coins < def.buyPrice) { await ctx.replyText(message, "金币不足。需要 " + def.buyPrice + "。"); return; }
        profile.coins -= def.buyPrice; store.saveUserData(userId, profile);
        farm.livestock[def.id] = { boughtAt: Date.now(), lastCollectAt: Date.now() };
        saveFarm(messageStore, userId, farm);
        await ctx.replyText(message, "购买了 " + def.name + "！" + def.growHours + "h 后成年，之后每 " + def.produceIntervalHours + "h 产出 " + def.produceName + "。");
      });

      menuPlugin.registerCommand("farm-ranch-collect", "收获牲畜产物", async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        if (args.length < 1) { await ctx.replyText(message, "用法: farm-ranch-collect <牲畜名>"); return; }
        const name = args.join(" ");
        const def = LIVESTOCK.find((l) => l.name === name);
        if (!def) { await ctx.replyText(message, "未知牲畜。"); return; }
        const farm = loadFarm(messageStore, userId);
        const entry = farm.livestock[def.id];
        if (!entry) { await ctx.replyText(message, "没有 " + def.name + "。"); return; }
        const growMs = def.growHours * 60 * 60 * 1000;
        const age = Date.now() - entry.boughtAt;
        if (age < growMs) {
          const remainGrow = Math.ceil((growMs - age) / 3600000);
          await ctx.replyText(message, def.name + " 还在幼崽期，需要 " + remainGrow + "h 后才能开始生产。"); return;
        }
        const intervalMs = def.produceIntervalHours * 60 * 60 * 1000;
        const elapsed = Date.now() - entry.lastCollectAt;
        if (elapsed < intervalMs) {
          const remaining = Math.ceil((intervalMs - elapsed) / 3600000);
          await ctx.replyText(message, def.produceName + "还需 " + remaining + "h 才能收获。"); return;
        }
        const count = Math.floor(elapsed / intervalMs);
        entry.lastCollectAt += count * intervalMs;
        const produceKey = "produce_" + def.id;
        farm.inventory[produceKey] = (farm.inventory[produceKey] ?? 0) + count;
        saveFarm(messageStore, userId, farm);
        addXp(farm, count * 5);
        saveFarm(messageStore, userId, farm);
        await ctx.replyText(message, "收获了 " + def.produceName + " x" + count + "，经验 +" + (count * 5));
      });

      menuPlugin.registerCommand("farm-craft", "加工农产品", async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        if (args.length < 1) {
          const list = Object.entries(RECIPES).map(([i, r]) => { const c = getCrop(r.input); return "  " + (c?.name ?? r.input) + " x" + r.inputQty + " -> " + r.output + " x" + r.outputQty + " 加工费" + r.cost + " 售价" + (PROCESSED_PRICES[r.output] ?? "?"); }).join("\n");
          await ctx.replyText(message, "加工配方:\n" + list + "\n用法: farm-craft <成品名>"); return;
        }
        const name = args.join(" ");
        const recipe = RECIPES.find((r) => r.output === name);
        if (!recipe) { await ctx.replyText(message, "未知成品。"); return; }
        const farm = loadFarm(messageStore, userId);
        const owned = farm.inventory[recipe.input] ?? 0;
        if (owned < recipe.inputQty) { await ctx.replyText(message, "材料不足。需要 " + (getCrop(recipe.input)?.name ?? recipe.input) + " x" + recipe.inputQty + "。"); return; }
        const profile = store.getUserData(userId);
        if (profile.coins < recipe.cost) { await ctx.replyText(message, "金币不足。加工费 " + recipe.cost + "。"); return; }
        profile.coins -= recipe.cost; store.saveUserData(userId, profile);
        farm.inventory[recipe.input] = owned - recipe.inputQty;
        farm.processedGoods[recipe.output] = (farm.processedGoods[recipe.output] ?? 0) + recipe.outputQty;
        saveFarm(messageStore, userId, farm);
        addXp(farm, 10); saveFarm(messageStore, userId, farm);
        await ctx.replyText(message, "加工完成！获得 " + recipe.output + " x" + recipe.outputQty + "。");
      });

      menuPlugin.registerCommand("farm-sell", "出售加工品", async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        if (args.length < 1) {
          const farm = loadFarm(messageStore, userId);
          const entries = Object.entries(farm.processedGoods).filter(([, q]) => q > 0);
          if (entries.length === 0) { await ctx.replyText(message, "没有可出售的加工品。"); return; }
          const list = entries.map(([name, qty]) => "  " + name + " x" + qty + " 单价" + (PROCESSED_PRICES[name] ?? "?")).join("\n");
          await ctx.replyText(message, "加工品库存:\n" + list + "\n用法: farm-sell <成品名> [数量]"); return;
        }
        const name = args[0];
        const qty = Math.max(1, parseInt(args[1] ?? "1", 10) || 1);
        const price = PROCESSED_PRICES[name];
        if (!price) { await ctx.replyText(message, "未知加工品。"); return; }
        const farm = loadFarm(messageStore, userId);
        const owned = farm.processedGoods[name] ?? 0;
        if (owned < qty) { await ctx.replyText(message, "库存不足。只有 " + owned + " 个。"); return; }
        const earnings = price * qty;
        farm.processedGoods[name] = owned - qty;
        const profile = store.getUserData(userId);
        profile.coins += earnings; store.saveUserData(userId, profile);
        saveFarm(messageStore, userId, farm);
        await ctx.replyText(message, "出售了 " + name + " x" + qty + "，获得 " + earnings + " 金币。");
      });

      menuPlugin.registerCommand("farm-harvest", "收获作物", async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        const farm = loadFarm(messageStore, userId);
        if (args.length > 0) {
          const plotIdx = parseInt(args[0], 10) - 1;
          if (isNaN(plotIdx) || plotIdx < 0 || plotIdx >= plotCount(farm)) { await ctx.replyText(message, "无效编号。"); return; }
          const plot = farm.plots[plotIdx];
          if (!plot) { await ctx.replyText(message, "该地块没有作物。"); return; }
          if (!isReady(plot)) { await ctx.replyText(message, "还未成熟。"); return; }
          const crop = getCrop(plot.cropId); if (!crop) return;
          const y = crop.minHarvest + Math.floor(Math.random() * (crop.maxHarvest - crop.minHarvest + 1));
          farm.plots[plotIdx] = null;
          farm.inventory[crop.id] = (farm.inventory[crop.id] ?? 0) + y;
          addXp(farm, Math.round(crop.growthHours * 4));
          saveFarm(messageStore, userId, farm);
          await ctx.replyText(message, "收获 " + crop.name + " x" + y + "，经验 +" + Math.round(crop.growthHours * 4));
        } else {
          let tx = 0; const h: string[] = [];
          for (let i = 0; i < plotCount(farm); i++) {
            const plot = farm.plots[i]; if (!plot || !isReady(plot)) continue;
            const crop = getCrop(plot.cropId); if (!crop) continue;
            const y = crop.minHarvest + Math.floor(Math.random() * (crop.maxHarvest - crop.minHarvest + 1));
            farm.plots[i] = null;
            farm.inventory[crop.id] = (farm.inventory[crop.id] ?? 0) + y;
            tx += Math.round(crop.growthHours * 4);
            h.push(crop.name + " x" + y);
          }
          if (h.length === 0) { await ctx.replyText(message, "没有可收获的作物。"); return; }
          addXp(farm, tx);
          saveFarm(messageStore, userId, farm);
          await ctx.replyText(message, "收获完成！共收获 " + h.join("、") + "，经验 +" + tx);
        }
      });

      menuPlugin.registerCommand("farm-steal", "偷菜", async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        if (!message.groupId) { await ctx.replyText(message, "偷菜仅限群聊。"); return; }
        if (args.length < 1) { await ctx.replyText(message, "用法: farm-steal @好友"); return; }
        const m = args[0].match(/^@?(\d+)$/) || args[0].match(/\[CQ:at,qq=(\d+)/) || args[0].match(/\[AT:(\d+)\]/);
        const tid = m?.[1];
        if (!tid) { await ctx.replyText(message, "请 @ 用户。"); return; }
        if (tid === userId) { await ctx.replyText(message, "不能偷自己的菜！"); return; }
        const tf = loadFarm(messageStore, tid);
        const mf = loadFarm(messageStore, userId);
        const ls = mf.stolenFrom[tid];
        if (ls && Date.now() - ls < 3600000) { await ctx.replyText(message, "冷却还剩 " + Math.ceil((3600000 - (Date.now() - ls)) / 60000) + " 分钟。"); return; }
        const rp: number[] = [];
        for (let i = 0; i < plotCount(tf); i++) { const p = tf.plots[i]; if (p && isReady(p)) rp.push(i); }
        if (rp.length === 0) { await ctx.replyText(message, "该用户没有可偷的作物。"); return; }
        const hasScarecrow = hasFacility(tf, "scarecrow");
        const maxSteal = hasScarecrow ? 1 : 1 + Math.floor(Math.random() * 2);
        const n = Math.min(rp.length, maxSteal);
        const st: string[] = [];
        const sh = [...rp].sort(() => Math.random() - 0.5);
        for (let s = 0; s < n; s++) {
          const idx = sh[s]; const p = tf.plots[idx]!; const c = getCrop(p.cropId); if (!c) continue;
          const tk = 1 + Math.floor(Math.random() * Math.min(c.maxHarvest, 2));
          const rate = hasScarecrow ? 0.4 : 0.8;
          const stolen = Math.max(1, Math.round(tk * rate));
          mf.inventory[c.id] = (mf.inventory[c.id] ?? 0) + stolen;
          st.push(c.name + " x" + stolen); tf.plots[idx] = null;
        }
        if (st.length === 0) { await ctx.replyText(message, "偷菜失败。"); return; }
        mf.stolenFrom[tid] = Date.now(); tf.stolenBy[userId] = Date.now();
        saveFarm(messageStore, tid, tf); saveFarm(messageStore, userId, mf);
        try {
          await onebot.sendSegments({ type: "group", id: message.groupId }, [
            { type: "at", data: { qq: tid } },
            { type: "text", data: { text: " 你的农场被偷了！" + st.join("、") } },
          ]);
        } catch { /* ignore */ }
        await ctx.replyText(message, "偷菜成功！获得 " + st.join("、") + "。");
      });
    },
  };
}
