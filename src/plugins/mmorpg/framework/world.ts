import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import { MMORPG_RULEBOOK } from "../rulebook.js";
import type { FishRarity, MonsterDef, PlayerState, WorldState } from "../schema.js";

export function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function refreshDailyBossIfNeeded(world: WorldState): void {
  const today = getTodayKey();
  if (!world.updatedAt.startsWith(today)) {
    world.dailyBossDefeatedIds = [];
    world.eventFlags = [];
    world.updatedAt = new Date().toISOString();
  }
}

export function isDailyBossDefeated(world: WorldState): boolean {
  refreshDailyBossIfNeeded(world);
  return world.dailyBossDefeatedIds.includes(getTodayKey());
}

export function markDailyBossDefeated(world: WorldState): void {
  refreshDailyBossIfNeeded(world);
  if (!world.dailyBossDefeatedIds.includes(getTodayKey())) {
    world.dailyBossDefeatedIds.push(getTodayKey());
  }
  world.updatedAt = new Date().toISOString();
}

export function createDailyBoss(player: PlayerState): MonsterDef {
  const template =
    DEFAULT_MMORPG_CONTENT.monsters["void_lord"] ??
    DEFAULT_MMORPG_CONTENT.monsters["eternal_dragon"] ??
    Object.values(DEFAULT_MMORPG_CONTENT.monsters).pop();
  if (!template) {
    throw new Error("没有可用的世界 Boss 模板。");
  }
  const level = Math.min(player.level + 5, MMORPG_RULEBOOK.progression.maxLevel);
  return { ...template, level };
}

export function calculateDailyBossRewards(
  player: PlayerState,
  rarity: FishRarity = "epic"
): { exp: number; coins: number; honor: number } {
  const baseExp = 50 + player.level * 20;
  const baseCoins = 30 + player.level * 10;
  const honor = 10 + Math.floor(player.level / 10);
  const rarityMult =
    rarity === "legendary" ? 2 : rarity === "epic" ? 1.5 : rarity === "rare" ? 1.2 : 1;
  return {
    exp: Math.floor(baseExp * rarityMult),
    coins: Math.floor(baseCoins * rarityMult),
    honor,
  };
}

export function formatWorldStatus(world: WorldState): string {
  refreshDailyBossIfNeeded(world);
  const today = getTodayKey();
  const bossDefeated = world.dailyBossDefeatedIds.includes(today);
  const lines = [
    `📅 今日日期：${today}`,
    `👹 日常世界 Boss：${bossDefeated ? "已击败（明日刷新）" : "尚未挑战"}`,
    world.eventFlags.length > 0 ? `🚩 当前事件：${world.eventFlags.join("、")}` : "🚩 当前事件：无",
  ];
  return lines.join("\n");
}
