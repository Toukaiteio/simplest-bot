import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import {
  MMORPG_RULEBOOK,
  createBaseResources,
} from "../rulebook.js";
import type {
  AreaDef,
  PlayerState,
} from "../schema.js";
import type { PluginContext } from "../../../types.js";
import { rt } from "./runtime.js";
import { savePlayer, requireArea } from "./player-access.js";

/**
 * 战斗锁、旅行锁、怪物池与死亡处理（依赖层级 1-2）。
 */

export function isPlayerInCombat(userId: string): boolean {
  const until = rt.combatLock.get(userId);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    rt.combatLock.delete(userId);
    return false;
  }
  return true;
}

export function setCombatLock(userId: string, durationMs: number): void {
  rt.combatLock.set(userId, Date.now() + durationMs);
}

export function releaseCombatLock(userId: string): void {
  rt.combatLock.delete(userId);
}

export function isSafeArea(area: AreaDef): boolean {
  return area.isSafe === true || area.monsterIds.length === 0;
}

export function isPlayerTravelling(userId: string): boolean {
  const until = rt.travelLock.get(userId);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    rt.travelLock.delete(userId);
    return false;
  }
  return true;
}

export function setTravelLock(userId: string, durationMs: number): void {
  rt.travelLock.set(userId, Date.now() + durationMs);
}

export function requireNotTravelling(player: PlayerState): void {
  if (isPlayerTravelling(player.userId)) {
    const remaining = (rt.travelLock.get(player.userId)! - Date.now()) / 1000;
    const secs = Math.ceil(remaining);
    throw new Error(`你正在旅途中，请等待 ${secs} 秒后再操作。`);
  }
}

export function requireNotInCombat(player: PlayerState): void {
  if (isPlayerInCombat(player.userId)) {
    const remaining = (rt.combatLock.get(player.userId)! - Date.now()) / 1000;
    const secs = Math.ceil(remaining);
    throw new Error(`你正在战斗中，请等待 ${secs} 秒后再操作。`);
  }
  requireNotTravelling(player);
}

/**
 * Count distinct players currently located in the given area.
 * Used to scale monster pool refresh rate.
 */
export function countActivePlayersInArea(areaId: string): number {
  if (!rt.stateStore) return 0;
  const players = rt.stateStore.getState().players;
  let count = 0;
  for (const p of Object.values(players)) {
    if (p.areaId === areaId) count++;
  }
  return count;
}

/**
 * Check whether the monster pool for an area still has available monsters.
 *
 * The pool model:
 * - Each area has a `poolSize` (number of monsters that can be alive at once).
 * - Each kill records a timestamp. Dead monsters regenerate after a refresh interval.
 * - The refresh interval shrinks when more players are active in the area,
 *   but never below `poolMinRefreshMinutes`.
 * - If all pool slots are occupied by un-refreshed kills, the pool is exhausted.
 */
export function checkMonsterPool(areaId: string): string | null {
  if (!rt.stateStore) return null;
  const world = rt.stateStore.getWorld();
  const pool = world.monsterPools[areaId];
  if (!pool) return null;

  const poolSize = pool.poolSize || MMORPG_RULEBOOK.monster.poolDefaultSize;
  const activePlayers = countActivePlayersInArea(areaId);
  const refreshMs = Math.max(
    MMORPG_RULEBOOK.monster.poolMinRefreshMinutes,
    MMORPG_RULEBOOK.monster.poolBaseRefreshMinutes - activePlayers * MMORPG_RULEBOOK.monster.poolRefreshPerActivePlayer,
  ) * 60_000;

  const now = Date.now();

  // Only count kills whose refresh window has NOT yet elapsed (still "dead")
  const aliveKills = pool.killedTimestamps.filter((t) => now - t < refreshMs);

  // Prune fully-refreshed timestamps from persisted state
  pool.killedTimestamps = aliveKills;
  rt.stateStore.saveWorld(world);

  if (aliveKills.length >= poolSize) {
    // Pool exhausted — compute wait time from the oldest un-refreshed kill
    const oldestKill = aliveKills[0];
    const waitSec = Math.ceil((refreshMs - (now - oldestKill)) / 1000);
    return `当前区域怪物已被清空（${aliveKills.length}/${poolSize}），约 ${waitSec} 秒后刷新。`;
  }
  return null;
}

/**
 * Record a monster kill in the area's pool.
 * Must be called synchronously after battle simulation confirms a player victory
 * (not in the delayed reward callback) to prevent race conditions.
 */
export function recordMonsterKill(areaId: string): void {
  if (!rt.stateStore) return;
  const world = rt.stateStore.getWorld();
  if (!world.monsterPools[areaId]) {
    // Lazily compute pool size from area monster definitions
    const area = DEFAULT_MMORPG_CONTENT.areas[areaId];
    const poolSize = area?.monsterIds?.length
      ? Math.max(MMORPG_RULEBOOK.monster.poolDefaultSize, area.monsterIds.length * 2)
      : MMORPG_RULEBOOK.monster.poolDefaultSize;
    world.monsterPools[areaId] = { killedTimestamps: [], poolSize };
  }
  world.monsterPools[areaId].killedTimestamps.push(Date.now());
  rt.stateStore.saveWorld(world);
}

/**
 * Check whether the resource pool for an area still has available gather slots.
 * Returns a human-readable message if exhausted, or null if gathering is allowed.
 */
export function checkResourcePool(areaId: string): string | null {
  if (!rt.stateStore) return null;
  const world = rt.stateStore.getWorld();
  const pool = world.resourcePools[areaId];
  if (!pool) return null;

  const poolSize = pool.poolSize || MMORPG_RULEBOOK.gathering.poolDefaultSize;
  const activePlayers = countActivePlayersInArea(areaId);
  const refreshMs = Math.max(
    MMORPG_RULEBOOK.gathering.poolMinRefreshMinutes,
    MMORPG_RULEBOOK.gathering.poolBaseRefreshMinutes - activePlayers * MMORPG_RULEBOOK.gathering.poolRefreshPerActivePlayer,
  ) * 60_000;

  const now = Date.now();
  const aliveGathers = pool.gatheredTimestamps.filter((t) => now - t < refreshMs);
  pool.gatheredTimestamps = aliveGathers;
  rt.stateStore.saveWorld(world);

  if (aliveGathers.length >= poolSize) {
    const oldestGather = aliveGathers[0];
    const waitSec = Math.ceil((refreshMs - (now - oldestGather)) / 1000);
    return `当前区域资源已采集殆尽（${aliveGathers.length}/${poolSize}），约 ${waitSec} 秒后恢复。`;
  }
  return null;
}

/**
 * Record a resource gather in the area's pool.
 */
export function recordResourceGather(areaId: string): void {
  if (!rt.stateStore) return;
  const world = rt.stateStore.getWorld();
  if (!world.resourcePools[areaId]) {
    const area = DEFAULT_MMORPG_CONTENT.areas[areaId];
    const poolSize = area?.resourceNodeIds?.length
      ? Math.max(MMORPG_RULEBOOK.gathering.poolDefaultSize, area.resourceNodeIds.length * 2)
      : MMORPG_RULEBOOK.gathering.poolDefaultSize;
    world.resourcePools[areaId] = { gatheredTimestamps: [], poolSize };
  }
  world.resourcePools[areaId].gatheredTimestamps.push(Date.now());
  rt.stateStore.saveWorld(world);
}

/**
 * Calculate the chance of a random encounter when moving into an area.
 * Base 2%, increasing when player is below the area's recommended level (cap 20%).
 */
export function getEncounterChance(player: PlayerState, area: AreaDef): number {
  const base = 0.02;
  const [minLevel] = area.recommendedLevel;
  const levelDiff = Math.max(0, minLevel - player.level);
  const extra = Math.min(0.18, levelDiff * 0.005);
  return Math.min(0.20, base + extra);
}

export function healPlayer(player: PlayerState): void {
  player.resources = createBaseResources(player.stats);
}

export function getDeathPosition(player: PlayerState): string {
  if (!player.deathMarker) return "";
  return player.deathMarker.areaId;
}

export function handlePlayerDeath(player: PlayerState, ctx: PluginContext): string {
  const protectedLevel = 25;
  if (player.level < protectedLevel) {
    player.areaId = rt.STARTER_AREA_ID;
    healPlayer(player);
    savePlayer(player);
    return `你被击败了！已回到 ${requireArea(rt.STARTER_AREA_ID).name}，生命值已恢复。（25 级前保护期，无金币掉落）`;
  }

  const goldDropped = Math.floor((player.currencies.gold ?? 0) * MMORPG_RULEBOOK.monster.deathGoldLossRate);
  const profile = rt.store.getUserData(player.userId);
  profile.coins -= goldDropped;
  rt.store.saveUserData(player.userId, profile);
  player.currencies.gold = profile.coins;
  player.deathMarker = {
    areaId: player.areaId,
    goldDropped,
    timestamp: new Date().toISOString(),
  };
  player.areaId = rt.STARTER_AREA_ID;
  healPlayer(player);
  savePlayer(player);
  return `你被击败了！掉落 ${goldDropped} 金币。已回到 ${requireArea(rt.STARTER_AREA_ID).name}，生命值已恢复。使用 ${rt.menuPlugin.getPrefix()}mmo-recover 可前往死亡地点拾回部分金币。`;
}
