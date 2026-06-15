import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import { MMORPG_RULEBOOK, getMaxResources } from "../rulebook.js";
import type { PlayerState } from "../schema.js";
import type { PluginContext } from "../../../types.js";
import {
  simulateBattle,
  formatBattleSummary,
  type BattleResult,
} from "../battle-simulator.js";
import { renderBattleLogToImage } from "../menu-renderer.js";
import { describeArea } from "./descriptions.js";
import { rt } from "./runtime.js";
import {
  requireArea,
  requirePlayer,
  getExistingPlayer,
  savePlayer,
} from "./player-access.js";
import {
  requireNotInCombat,
  setCombatLock,
  releaseCombatLock,
  checkMonsterPool,
  recordMonsterKill,
  handlePlayerDeath,
} from "./combat.js";
import {
  addPlayerItem,
  grantBridgedCoins,
  resolvePartyForPlayer,
} from "./economy.js";
import { getPlayerEffectiveStats } from "./stats.js";
import {
  applyRewardBonuses,
  getLevelDecayMultiplier,
  grantExperience,
} from "./progression.js";
import {
  resolveLocalMonster,
  incrementKillProgress,
  updateQuestProgressFromState,
} from "./quest.js";
import { checkAchievementsOnKill, formatNewlyUnlocked } from "./achievements.js";
import { resolveMessageTarget, type MessageLike } from "./messenger.js";

/**
 * 战斗发起与异步结算（依赖层级 5）。
 * startBattle 立即模拟战斗并锁定玩家，延迟发放奖励。
 */

export async function startBattle(
  player: PlayerState,
  monsterId: string | undefined,
  message: MessageLike,
  ctx: PluginContext,
  ambushed = false,
): Promise<string> {
  // Prevent starting a new battle while already in combat
  requireNotInCombat(player);

  const area = requireArea(player.areaId);
  if (area.monsterIds.length === 0) {
    throw new Error("当前区域没有可狩猎的怪物。");
  }
  if (player.resources.hp <= 0) {
    throw new Error("你已经无法战斗，请先回复 HP。");
  }
  const poolBlocked = checkMonsterPool(area.id);
  if (poolBlocked) return poolBlocked;

  const monster = resolveLocalMonster(area, monsterId);

  // Persist pre-battle state so the delayed reward callback always loads the correct HP
  savePlayer(player);

  // Run the simulation immediately
  const allSkills = DEFAULT_MMORPG_CONTENT.skills;
  const effectivePlayer = {
    ...player,
    stats: getPlayerEffectiveStats(player),
  };
  // Read party formation if the player is in a party (affects aggro/defense).
  const party = resolvePartyForPlayer(player);
  const formation = party?.formation ?? "balanced";
  const result = simulateBattle(effectivePlayer, monster, allSkills, formation, ambushed);

  // Store battle log for later retrieval
  rt.battleLogStore.set(player.userId, result);

  // If player died in simulation, apply immediately (no lock needed)
  if (!result.victory) {
    player.resources.hp = 0;
    savePlayer(player);
    const deathMsg = handlePlayerDeath(player, ctx);
    return `${deathMsg}\n💡 私聊发送 $mmo-battle-log 查看详细战斗记录`;
  }

  // Record kill IMMEDIATELY (synchronous) so the pool is depleted right away.
  recordMonsterKill(area.id);

  // Lock the player in combat for the duration of the battle
  setCombatLock(player.userId, result.estimatedSeconds * 1000);

  // Schedule reward delivery after the estimated battle duration
  const target = resolveMessageTarget(message);
  setTimeout(async () => {
    // Always release combat lock first
    releaseCombatLock(player.userId);
    try {
      // Re-load player to ensure fresh state
      const freshPlayer = getExistingPlayer(player.userId);
      if (!freshPlayer) return;

      // Apply HP loss from battle — use simulation ending HP directly
      freshPlayer.resources.hp = Math.max(1, Math.min(getMaxResources(freshPlayer.stats).maxHp, result.playerHpRemaining));

      // Check if player died from HP loss
      if (freshPlayer.resources.hp <= 0) {
        freshPlayer.resources.hp = 0;
        savePlayer(freshPlayer);
        const deathMsg = handlePlayerDeath(freshPlayer, ctx);
        await ctx.sendMessage(target, `⚔️ 战斗结束…\n${deathMsg}`);
        return;
      }

      // Grant rewards (with level-difference decay)
      const decay = getLevelDecayMultiplier(freshPlayer.level, monster.level);
      const baseExp = Math.floor(monster.level * 12 * decay);
      const baseCoins = Math.floor(monster.level * 4 * decay);
      const rewards = applyRewardBonuses(freshPlayer, baseExp, baseCoins);
      result.rewards = rewards;
      const levelResult = grantExperience(freshPlayer, rewards.exp);
      result.levelsGained = levelResult.levelsGained;
      if (rewards.coins > 0) {
        grantBridgedCoins(freshPlayer.userId, rewards.coins, ctx);
      }
      for (const itemId of monster.lootItemIds) {
        addPlayerItem(freshPlayer, itemId, 1);
      }
      // Equipment drop roll
      if (monster.dropChance && monster.dropPool && monster.dropPool.length > 0 && Math.random() < monster.dropChance) {
        const droppedItemId = monster.dropPool[Math.floor(Math.random() * monster.dropPool.length)];
        if (DEFAULT_MMORPG_CONTENT.items[droppedItemId]) {
          addPlayerItem(freshPlayer, droppedItemId, 1, undefined, monster.level);
          result.equipmentDrop = droppedItemId;
        }
      }
      incrementKillProgress(freshPlayer, monster.id);
      const newlyUnlocked = checkAchievementsOnKill(freshPlayer, monster.id);
      const completions = updateQuestProgressFromState(freshPlayer);
      savePlayer(freshPlayer);

      // Party affinity gains: battle together to increase mutual affinity
      const partyForAffinity = resolvePartyForPlayer(freshPlayer);
      if (partyForAffinity && partyForAffinity.memberUserIds.length > 1) {
        const isLeader = partyForAffinity.leaderUserId === freshPlayer.userId;
        const selfGain = isLeader
          ? MMORPG_RULEBOOK.affinity.partyBattleLeader
          : MMORPG_RULEBOOK.affinity.partyBattleMember;
        for (const memberId of partyForAffinity.memberUserIds) {
          if (memberId === freshPlayer.userId) continue;
          rt.social.addUserAffinity(freshPlayer.userId, memberId, selfGain);
          rt.social.addUserAffinity(memberId, freshPlayer.userId, isLeader
            ? MMORPG_RULEBOOK.affinity.partyBattleMember
            : MMORPG_RULEBOOK.affinity.partyBattleLeader);
        }
      }

      // Apply affinity decay on battle interaction
      rt.social.applyAffinityDecay(freshPlayer.userId);

      // Update stored result with actual rewards
      rt.battleLogStore.set(freshPlayer.userId, result);

      // Send battle log as image
      try {
        const battleImgPath = await renderBattleLogToImage(result, process.cwd());
        await ctx.sendImage(target, battleImgPath);
        // Append quest completions and decay notice as text if any
        const extraMessages: string[] = [];
        if (completions.length > 0) extraMessages.push(...completions);
        const achievementText = formatNewlyUnlocked(newlyUnlocked);
        if (achievementText) extraMessages.push(achievementText);
        if (result.equipmentDrop) {
          const dropItem = DEFAULT_MMORPG_CONTENT.items[result.equipmentDrop];
          if (dropItem) extraMessages.push(`🎁 掉落了装备：${dropItem.name}！`);
        }
        if (decay < 1 && decay > 0) extraMessages.push(`⚠ 等级差距衰减：你比怪物高 ${freshPlayer.level - monster.level} 级，经验与金币仅获得 ${Math.round(decay * 100)}%。`);
        if (decay === 0) extraMessages.push(`⚠ 等级差距过大：你比怪物高 ${freshPlayer.level - monster.level} 级，无法从该怪物获得任何经验与金币。`);
        if (extraMessages.length > 0) await ctx.sendMessage(target, extraMessages.join("\n"));
      } catch {
        // Fallback to text summary
        const summary = formatBattleSummary(result);
        const completionText = completions.length > 0 ? "\n" + completions.join("\n") : "";
        const achievementText = formatNewlyUnlocked(newlyUnlocked);
        await ctx.sendMessage(target, summary + completionText + achievementText);
      }
    } catch (err) {
      await ctx.sendMessage(target, `战斗结算出错：${err instanceof Error ? err.message : String(err)}`);
    }
  }, result.estimatedSeconds * 1000);

  // Return immediate feedback
  const durationText = result.estimatedSeconds < 60
    ? `${result.estimatedSeconds}秒`
    : `${Math.floor(result.estimatedSeconds / 60)}分${result.estimatedSeconds % 60}秒`;
  return `⚔️ 你向 ${monster.name}（Lv.${monster.level}）发起了挑战！\n战斗模拟中…预计 ${durationText} 后结束。\n战斗结束后将自动通知你结果。\n💡 结束后可私聊发送 $mmo-battle-log 查看战斗详情。`;
}

export function getBattleLog(userId: string): BattleResult | undefined {
  return rt.battleLogStore.get(userId);
}
