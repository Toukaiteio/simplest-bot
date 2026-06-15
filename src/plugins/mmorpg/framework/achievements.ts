import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import type { FishCatch, FishRarity, PlayerState } from "../schema.js";

const STARTER_AREA_IDS = new Set([
  "starter_village",
  "whisper_forest",
  "iron_mine",
  "misty_marsh",
  "frontier_checkpoint",
  "ruined_crypt",
  "southern_hills",
  "stoneheart_valley",
  "frostleaf_ridge",
]);

const KINGDOM_AREA_IDS = new Set([
  "broken_bridge",
  "oak_ridge_town",
  "red_bandit_ridge",
  "garrison_fort",
]);

const FRONTIER_AREA_IDS = new Set([
  "windwall_fortress",
  "iron_wall_road",
  "black_swamp",
  "goblin_caves",
]);

const HIGHLAND_AREA_IDS = new Set([
  "mist_port_city",
  "highland_plateau",
  "flame_mountains",
  "iron_oath_garrison",
  "ruined_kingdom_throne",
]);

const SHADOW_AREA_IDS = new Set([
  "dragon_spine_mountains",
  "shadow_council_reach",
  "frozen_lake",
  "blacktide_coast",
  "snowveil_pass",
]);

const DEMON_AREA_IDS = new Set([
  "fire_demon_caverns",
  "corrupted_spirit_woods",
  "demon_king_throne",
  "spirit_king_sanctuary",
]);

const ABYSS_AREA_IDS = new Set([
  "abyss_descent",
  "nine_turn_labyrinth",
  "void_boundary",
]);

const ALL_AREA_IDS = new Set([
  ...STARTER_AREA_IDS,
  ...KINGDOM_AREA_IDS,
  ...FRONTIER_AREA_IDS,
  ...HIGHLAND_AREA_IDS,
  ...SHADOW_AREA_IDS,
  ...DEMON_AREA_IDS,
  ...ABYSS_AREA_IDS,
]);

const REPUTATION_ACHIEVEMENTS: Record<string, { id: string; threshold: number }> = {
  dawn_alliance: { id: "dawn_ally", threshold: 100 },
  iron_oath: { id: "iron_oath_friend", threshold: 100 },
  silver_covenant: { id: "silver_covenant_scholar", threshold: 100 },
  ash_covenant: { id: "ash_covenant_agent", threshold: 100 },
};

const PROFESSION_ACHIEVEMENTS: Record<string, { id: string; threshold: number }> = {
  herbalism: { id: "herb_gatherer", threshold: 20 },
  mining: { id: "miner_veteran", threshold: 20 },
};

function markUnlocked(player: PlayerState, achievementId: string): boolean {
  const existing = player.unlockedAchievementIds.includes(achievementId);
  if (existing) return false;
  player.unlockedAchievementIds.push(achievementId);
  return true;
}

export function unlockAchievement(
  player: PlayerState,
  achievementId: string
): boolean {
  if (!DEFAULT_MMORPG_CONTENT.achievements[achievementId]) return false;
  return markUnlocked(player, achievementId);
}

export function unlockAchievements(
  player: PlayerState,
  achievementIds: string[]
): string[] {
  const newlyUnlocked: string[] = [];
  for (const id of achievementIds) {
    if (unlockAchievement(player, id)) newlyUnlocked.push(id);
  }
  return newlyUnlocked;
}

export function claimAchievement(
  player: PlayerState,
  achievementId: string,
  grantCoins: (amount: number) => void
): { success: boolean; message: string } {
  const ach = DEFAULT_MMORPG_CONTENT.achievements[achievementId];
  if (!ach) return { success: false, message: "未知成就。" };
  if (!player.unlockedAchievementIds.includes(achievementId)) {
    return { success: false, message: `成就「${ach.name}」尚未解锁。` };
  }
  if (player.claimedAchievementIds.includes(achievementId)) {
    return { success: false, message: `成就「${ach.name}」奖励已经领取。` };
  }
  player.claimedAchievementIds.push(achievementId);
  if (ach.rewardCoins > 0) grantCoins(ach.rewardCoins);
  return {
    success: true,
    message: `领取成就「${ach.name}」奖励：${ach.rewardCoins} 金币。`,
  };
}

export function checkAchievementsOnLevelUp(
  player: PlayerState,
  newLevel: number
): string[] {
  const ids: string[] = [];
  if (newLevel >= 50) ids.push("level_50");
  if (newLevel >= 100) ids.push("level_100");
  if (newLevel >= 500) ids.push("level_500");
  if (newLevel >= 1000) ids.push("level_1000");
  if (newLevel >= 1500) ids.push("level_1500");
  return unlockAchievements(player, ids);
}

export function checkAchievementsOnKill(
  player: PlayerState,
  monsterId: string
): string[] {
  const ids: string[] = ["first_blood"];
  if (monsterId === "demon_king") ids.push("demon_slayer");
  if (monsterId === "eternal_dragon") ids.push("dragon_conqueror");
  return unlockAchievements(player, ids);
}

export function checkAchievementsOnFishCatch(
  player: PlayerState,
  fish: FishCatch
): string[] {
  const ids: string[] = ["first_cast"];
  if (fish.rarity === "legendary") ids.push("angler_master");
  const catchCount = player.fishBasket.length;
  if (catchCount >= 20) ids.push("fisherman");
  return unlockAchievements(player, ids);
}

export function checkAchievementsOnDungeonClear(
  player: PlayerState,
  dungeonId: string
): string[] {
  const ids: string[] = [];
  if (dungeonId === "ruined_crypt_run") ids.push("crypt_clearer");
  const allDungeons = Object.keys(DEFAULT_MMORPG_CONTENT.dungeons);
  const cleared = new Set([dungeonId]);
  // Note: tracking persistent clear count would need extra state; here we infer single clear.
  if (allDungeons.every((id) => cleared.has(id) || false)) {
    // dungeon_master requires clearing all dungeons; this helper alone cannot verify.
    // It is kept here as a hook for future persistent tracking.
  }
  return unlockAchievements(player, ids);
}

export function checkAllDungeonsCleared(player: PlayerState): boolean {
  const dungeonIds = Object.keys(DEFAULT_MMORPG_CONTENT.dungeons);
  // No persistent clear tracking yet; placeholder for future expansion.
  return dungeonIds.length === 0;
}

export function checkAchievementsOnMarriage(player: PlayerState): string[] {
  return unlockAchievements(player, ["married"]);
}

export function checkAchievementsOnPartyJoin(player: PlayerState): string[] {
  return unlockAchievements(player, ["party_ready"]);
}

export function checkAchievementsOnReputations(player: PlayerState): string[] {
  const ids: string[] = [];
  for (const [factionId, cfg] of Object.entries(REPUTATION_ACHIEVEMENTS)) {
    const rep = player.factionReputation[factionId] ?? 0;
    if (rep >= cfg.threshold) ids.push(cfg.id);
  }
  return unlockAchievements(player, ids);
}

export function checkAchievementsOnProfessions(player: PlayerState): string[] {
  const ids: string[] = [];
  for (const [profId, cfg] of Object.entries(PROFESSION_ACHIEVEMENTS)) {
    const level = player.professionLevels[profId] ?? 0;
    if (level >= cfg.threshold) ids.push(cfg.id);
  }
  return unlockAchievements(player, ids);
}

export function checkAchievementsOnAreaVisit(
  player: PlayerState,
  areaId: string
): string[] {
  const visited = new Set<string>();
  // Best-effort visited tracking: current area + death marker area
  visited.add(player.areaId);
  if (player.deathMarker) visited.add(player.deathMarker.areaId);
  visited.add(areaId);

  const ids: string[] = [];
  if (STARTER_AREA_IDS.size > 0 && [...STARTER_AREA_IDS].every((id) => visited.has(id))) {
    ids.push("frontier_walker");
  }
  if (KINGDOM_AREA_IDS.size > 0 && [...KINGDOM_AREA_IDS].every((id) => visited.has(id))) {
    ids.push("kingdom_explorer");
  }
  if (ALL_AREA_IDS.size > 0 && [...ALL_AREA_IDS].every((id) => visited.has(id))) {
    ids.push("world_traveler");
  }
  return unlockAchievements(player, ids);
}

export function getAchievementStatus(
  player: PlayerState,
  achievementId: string
): "locked" | "unlocked" | "claimed" {
  if (player.claimedAchievementIds.includes(achievementId)) return "claimed";
  if (player.unlockedAchievementIds.includes(achievementId)) return "unlocked";
  return "locked";
}

export function formatAchievementLabel(
  player: PlayerState,
  achievementId: string,
  name: string
): string {
  const status = getAchievementStatus(player, achievementId);
  if (status === "claimed") return `✅ ${name}`;
  if (status === "unlocked") return `🆕 ${name}`;
  return `⬜ ${name}`;
}

export function formatNewlyUnlocked(ids: string[]): string {
  if (ids.length === 0) return "";
  const names = ids.map((id) => DEFAULT_MMORPG_CONTENT.achievements[id]?.name ?? id);
  return `\n🏆 解锁成就：${names.join("、")}`;
}
