/**
 * 独立迁移脚本：重置所有玩家进度，计算经验瓶和钱袋补偿。
 * 用法：node migrate-reset.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const DATA_FILE = path.resolve(__dirname, "data", "mmorpg-state.json");
const BACKUP_FILE = path.resolve(
  __dirname,
  "data",
  `mmorpg-state-backup-${Date.now()}.json`
);

// ── 经验公式 ──
const EXP_COEFFICIENT = 3.5;
function getExpRequiredForLevel(level) {
  const base = Math.max(50, level * 15 + Math.pow(level, 1.6));
  return Math.round(base * EXP_COEFFICIENT);
}

// ── 职业基础属性 ──
const CLASS_BASE_STATS = {
  warrior:  { strength: 8,  defense: 7, charm: 3, agility: 4, eloquence: 2,  endurance: 7, life: 8 },
  mage:     { strength: 2,  defense: 3, charm: 5, agility: 3, eloquence: 8,  endurance: 4, life: 5 },
  ranger:   { strength: 4,  defense: 4, charm: 4, agility: 8, eloquence: 4,  endurance: 5, life: 6 },
  cleric:   { strength: 3,  defense: 4, charm: 7, agility: 3, eloquence: 8,  endurance: 5, life: 6 },
  rogue:    { strength: 5,  defense: 3, charm: 5, agility: 9, eloquence: 5,  endurance: 4, life: 5 },
  paladin:  { strength: 6,  defense: 9, charm: 5, agility: 3, eloquence: 4,  endurance: 6, life: 7 },
  warlock:  { strength: 3,  defense: 3, charm: 7, agility: 4, eloquence: 9,  endurance: 5, life: 5 },
  druid:    { strength: 4,  defense: 4, charm: 6, agility: 7, eloquence: 5,  endurance: 6, life: 6 },
  martial_god:      { strength: 10, defense: 9, charm: 3, agility: 5, eloquence: 3, endurance: 8, life: 9 },
  holy_spirit_mage: { strength: 3,  defense: 4, charm: 9, agility: 4, eloquence: 10, endurance: 5, life: 7 },
  dragon_knight:    { strength: 8,  defense: 7, charm: 6, agility: 5, eloquence: 4, endurance: 7, life: 8 },
  magic_swordsman:  { strength: 6,  defense: 5, charm: 5, agility: 6, eloquence: 8, endurance: 5, life: 6 },
};
const DEFAULT_STATS = { strength: 5, defense: 5, charm: 5, agility: 5, eloquence: 5, endurance: 5, life: 5 };

function createBaseStats(classId) {
  return CLASS_BASE_STATS[classId] || DEFAULT_STATS;
}

function createBaseResources(stats) {
  return {
    hp:    100 + stats.life * 16,
    focus: 40  + stats.eloquence * 8,
    stamina: 60 + stats.endurance * 5,
  };
}

// ── 主逻辑 ──
console.log("=== MMORPG 数据迁移脚本 ===\n");

// 1. 读取
const raw = fs.readFileSync(DATA_FILE, "utf-8");
const state = JSON.parse(raw);
const players = state.players || {};
const playerCount = Object.keys(players).length;
console.log(`读取到 ${playerCount} 位玩家数据。\n`);

// 2. 备份
fs.writeFileSync(BACKUP_FILE, raw, "utf-8");
console.log(`已备份到: ${path.basename(BACKUP_FILE)}\n`);

// 3. 迁移
let resetCount = 0;
let skippedCount = 0;
const zeroRebirthBonus = { strength: 0, defense: 0, charm: 0, agility: 0, eloquence: 0, endurance: 0, life: 0 };

for (const [userId, player] of Object.entries(players)) {
  // 幂等检查：已迁移的玩家跳过
  if (player.pendingCompensationExp !== undefined) {
    console.log(`[跳过] ${userId} (${player.raceId}/${player.classId} Lv.${player.level}) — 已迁移`);
    skippedCount++;
    continue;
  }

  // 计算总经验
  let totalExp = player.exp || 0;
  for (let lvl = 1; lvl < player.level; lvl++) {
    totalExp += getExpRequiredForLevel(lvl);
  }
  const compensationExp = Math.floor(totalExp / 10);

  // 计算金币补偿 (1%)
  const currentGold = player.currencies?.gold ?? 0;
  const compensationGold = Math.floor(currentGold / 100);

  console.log(`[重置] ${userId} (${player.raceId}/${player.classId} Lv.${player.level})`);
  console.log(`       总经验: ${totalExp} → 补偿经验瓶: ${compensationExp}`);
  console.log(`       当前金币: ${currentGold} → 补偿钱袋: ${compensationGold}`);

  // 重置
  const stats = createBaseStats(player.classId);
  player.areaId = "starter_village";
  player.level = 1;
  player.exp = 0;
  player.coinsEarnedFromMMO = 0;
  player.stats = stats;
  player.resources = createBaseResources(stats);
  player.currencies = { gold: 0, honor: 0, guild_token: 0 };
  player.inventory = [];
  player.equipment = {};
  player.unlockedSkillIds = [];
  player.equippedSkillIds = [];
  player.professionLevels = {};
  player.factionReputation = {};
  player.questLog = [];
  player.dialogueFlags = [];
  player.fishBasket = [];
  player.fishingSession = undefined;
  player.pendingMenu = undefined;
  player.deathMarker = undefined;
  player.guildId = undefined;
  player.partyId = undefined;
  player.marriage = undefined;
  player.portraitPath = undefined;
  player.portraitGeneratedAt = undefined;
  player.rebirthCount = 0;
  player.rebirthBonus = { ...zeroRebirthBonus };
  player.guideCompleted = false;
  player.itemInstances = {};
  player.unlockedAchievementIds = [];
  player.claimedAchievementIds = [];
  player.factionRewardClaimedIds = [];
  player.dailyGifts = undefined;
  player.lastAffinityDecayAt = undefined;
  player.pendingCompensationExp = compensationExp;
  player.pendingCompensationGold = compensationGold;
  player.updatedAt = new Date().toISOString();

  resetCount++;
}

// 清除共享状态
state.parties = {};
state.marriageProposals = {};
state.marketListings = {};
state.mails = {};

// 4. 保存
fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf-8");

console.log(`\n=== 迁移完成 ===`);
console.log(`已重置: ${resetCount} 位玩家`);
console.log(`已跳过: ${skippedCount} 位玩家`);
console.log(`备份位置: ${BACKUP_FILE}`);
