import {
  MMORPG_RULEBOOK,
  createBaseResources,
  getExpRequiredForLevel,
  getMaxResources,
} from "../rulebook.js";
import type { PlayerState } from "../schema.js";
import { rt } from "./runtime.js";
import { getExistingPlayer, requireClass } from "./player-access.js";
import { resolvePartyForPlayer } from "./economy.js";
import { buildCharacterStats } from "./stats.js";
import { checkAchievementsOnLevelUp } from "./achievements.js";

/**
 * 经验、等级、奖励加成、等级衰减（依赖层级 3）。
 * grantExperience 在升级时联动成就解锁与福利里程碑。
 */

export function applyRewardBonuses(player: PlayerState, baseExp: number, baseCoins: number) {
  const bonus = getActiveBonuses(player);
  return {
    exp: Math.max(0, Math.floor(baseExp * (1 + bonus.expRate))),
    coins: Math.max(0, Math.floor(baseCoins * (1 + bonus.goldRate))),
  };
}

/**
 * Level-difference decay multiplier for combat rewards.
 * - Player level <= monster level + 3: full rewards (1.0)
 * - Player level > monster level + 3: linear decay to 0 at diff = 20
 * This prevents high-level players from efficiently farming low-level content.
 */
export function getLevelDecayMultiplier(playerLevel: number, contentLevel: number): number {
  const diff = playerLevel - contentLevel;
  if (diff <= 3) return 1;
  if (diff >= 20) return 0;
  // Linear from 1.0 at diff=3 to 0.0 at diff=20
  return Math.max(0, Math.round(((20 - diff) / 17) * 100) / 100);
}

export function grantExperience(player: PlayerState, amount: number): { levelsGained: number; newlyUnlockedAchievementIds: string[] } {
  if (amount <= 0 || player.level >= MMORPG_RULEBOOK.progression.maxLevel) {
    return { levelsGained: 0, newlyUnlockedAchievementIds: [] };
  }

  player.exp += amount;
  let levelsGained = 0;
  while (player.level < MMORPG_RULEBOOK.progression.maxLevel && player.exp >= getExpRequiredForLevel(player.level)) {
    player.exp -= getExpRequiredForLevel(player.level);
    player.level += 1;
    levelsGained += 1;
  }
  let newlyUnlockedAchievementIds: string[] = [];
  if (player.level >= MMORPG_RULEBOOK.progression.maxLevel) {
    player.exp = 0;
  }
  if (levelsGained > 0) {
    const oldStats = { ...player.stats };
    player.stats = buildCharacterStats(player.raceId, requireClass(player.classId), player.level, player.rebirthBonus);
    const newResources = createBaseResources(player.stats);
    const oldMaxHp = getMaxResources(oldStats).maxHp;
    const newMaxHp = getMaxResources(player.stats).maxHp;
    const ratio = Math.min(1, player.resources.hp / Math.max(1, oldMaxHp));
    player.resources = {
      hp: Math.max(1, Math.round(newMaxHp * ratio)),
      focus: newResources.focus,
      stamina: newResources.stamina,
    };
    newlyUnlockedAchievementIds = checkAchievementsOnLevelUp(player, player.level);
    // Welfare: auto-grant level milestone rewards when a new threshold is reached.
    if (rt.welfare) {
      rt.welfare.checkLevelMilestones(player.userId, player.level);
    }
  }
  return { levelsGained, newlyUnlockedAchievementIds };
}

export function getActiveBonuses(player: PlayerState): { expRate: number; goldRate: number } {
  const party = resolvePartyForPlayer(player);
  let expRate = 0;
  let goldRate = 0;

  if (party) {
    const memberCount = party.memberUserIds.length;
    const extraMembers = Math.max(0, memberCount - 1);
    const members = party.memberUserIds.map((userId) => getExistingPlayer(userId)).filter(Boolean) as PlayerState[];
    const distinctClasses = new Set(members.map((member) => member.classId)).size;
    expRate += Math.min(
      MMORPG_RULEBOOK.party.maxExpFromParty,
      extraMembers * MMORPG_RULEBOOK.party.baseExpPerExtraMember
      + Math.max(0, distinctClasses - 1) * MMORPG_RULEBOOK.party.classDiversityExpBonus
    );
    goldRate += Math.min(
      MMORPG_RULEBOOK.party.maxGoldFromParty,
      extraMembers * MMORPG_RULEBOOK.party.baseGoldPerExtraMember
    );
  }

  if (player.marriage) {
    const spouseInSameParty = party?.memberUserIds.includes(player.marriage.spouseUserId) ?? false;
    const marriageRate = spouseInSameParty
      ? MMORPG_RULEBOOK.marriage.partyBonusRate
      : MMORPG_RULEBOOK.marriage.baseBonusRate;
    expRate += marriageRate;
    goldRate += marriageRate;
  }

  return { expRate, goldRate };
}
