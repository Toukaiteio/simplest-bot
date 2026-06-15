import { randomUUID } from "node:crypto";
import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import { MMORPG_RULEBOOK, affinityToPercent } from "../rulebook.js";
import type {
  PartyState,
  PlayerState,
  StatBlock,
} from "../schema.js";
import type { PluginContext } from "../../../types.js";
import { rt } from "./runtime.js";
import { requirePlayer, savePlayer } from "./player-access.js";

/**
 * 金币桥接、物品操作、婚姻校验、队伍解析（依赖层级 2）。
 * 纯经济与物品操作；区域移动（依赖任务进度）放在 actions 模块。
 */

export function syncPlayerEconomy(userId: string, player: PlayerState): PlayerState {
  if (!rt.stateStore) {
    throw new Error("MMORPG 状态存储尚未初始化。");
  }

  const profile = rt.store.getUserData(userId);
  if (profile.coins < 0) {
    profile.coins = 0;
    rt.store.saveUserData(userId, profile);
  }

  if ((player.currencies.gold ?? 0) !== profile.coins) {
    player.currencies.gold = profile.coins;
    rt.stateStore.syncPlayerGold(userId, profile.coins);
  }

  return player;
}

export function grantBridgedCoins(userId: string, amount: number, ctx: PluginContext): PlayerState {
  if (!rt.stateStore) {
    throw new Error("MMORPG 状态存储尚未初始化。");
  }

  const player = syncPlayerEconomy(userId, requirePlayer(userId));
  const profile = rt.store.getUserData(userId);
  profile.coins += amount;
  rt.store.saveUserData(userId, profile);
  rt.stateStore.recordMMOCoinsGranted(userId, amount, profile.coins);
  player.currencies.gold = profile.coins;
  return player;
}

export function consumeFrameworkItem(userId: string, itemId: string): void {
  if (!rt.inventory.hasItem(userId, itemId, 1)) {
    const itemName = rt.store.getItem(itemId)?.name ?? itemId;
    throw new Error(`缺少所需道具：${itemName}`);
  }
  rt.inventory.removeItem(userId, itemId, 1);
}

export function validateMarriageEligibility(left: PlayerState, right: PlayerState): void {
  if (left.userId === right.userId) {
    throw new Error("不能与自己结婚。");
  }
  if (left.marriage || right.marriage) {
    throw new Error("任一方已处于婚姻状态。");
  }
  if (left.level < MMORPG_RULEBOOK.social.marriageRequiredLevel || right.level < MMORPG_RULEBOOK.social.marriageRequiredLevel) {
    throw new Error(`双方都需要达到 ${MMORPG_RULEBOOK.social.marriageRequiredLevel} 级。`);
  }
  const leftAffinity = rt.social.getUserAffinity(left.userId, right.userId);
  const rightAffinity = rt.social.getUserAffinity(right.userId, left.userId);
  if (leftAffinity < MMORPG_RULEBOOK.social.marriageRequiredAffinity || rightAffinity < MMORPG_RULEBOOK.social.marriageRequiredAffinity) {
    throw new Error(`双方互相亲密度都需要达到 ${affinityToPercent(MMORPG_RULEBOOK.social.marriageRequiredAffinity)}（当前：${affinityToPercent(leftAffinity)} / ${affinityToPercent(rightAffinity)}）。`);
  }
  if (!rt.inventory.hasItem(left.userId, MMORPG_RULEBOOK.economy.marriageRingItemId, 1)) {
    throw new Error("发起求婚的一方缺少誓约戒指。");
  }
}

export function findProposal(proposerUserId: string, targetUserId: string) {
  return rt.stateStore?.findProposal(proposerUserId, targetUserId) ?? null;
}

export function resolvePartyForPlayer(player: PlayerState): PartyState | null {
  if (!rt.stateStore) {
    throw new Error("MMORPG 状态存储尚未初始化。");
  }
  if (!player.partyId) {
    return null;
  }
  return rt.stateStore.getParty(player.partyId) ?? rt.stateStore.findPartyByMember(player.userId);
}

export function getPlayerItemQuantity(player: PlayerState, itemId: string): number {
  return player.inventory.find((entry) => entry.itemId === itemId)?.quantity ?? 0;
}

export function addPlayerItem(player: PlayerState, itemId: string, quantity: number, instanceId?: string, sourceLevel?: number): void {
  if (!player.itemInstances) player.itemInstances = {};
  const item = DEFAULT_MMORPG_CONTENT.items[itemId];

  if (item && (item.category === "weapon" || item.category === "armor") && !instanceId) {
    for (let i = 0; i < quantity; i++) {
      const rand = Math.random() * 100;
      let rarity: "common" | "uncommon" | "rare" | "epic" | "legendary" = "common";
      let affixCount = 0;
      if (rand < 0.5) { rarity = "legendary"; affixCount = 4; }
      else if (rand < 3.0) { rarity = "epic"; affixCount = 3; }
      else if (rand < 10.0) { rarity = "rare"; affixCount = 2; }
      else if (rand < 30.0) { rarity = "uncommon"; affixCount = 1; }

      const substats: StatBlock = { strength: 0, defense: 0, charm: 0, agility: 0, eloquence: 0, endurance: 0, life: 0 };
      const baseValue = Math.max(1, Math.floor((item.sellPrice ?? 10) / 10));
      const levelMult = sourceLevel ? Math.max(0.5, 1 + (sourceLevel - (item.requiredLevel ?? 1)) * 0.005) : 1;
      const statOptions: Array<keyof StatBlock> = ["strength", "defense", "charm", "agility", "eloquence", "endurance", "life"];
      for (let a = 0; a < affixCount; a++) {
        const opt = statOptions[Math.floor(Math.random() * statOptions.length)];
        const val = Math.max(1, Math.round(baseValue * levelMult * (0.8 + Math.random() * 0.4)));
        substats[opt] += val;
      }

      let suffix = "";
      let maxVal = 0;
      let maxKey: keyof StatBlock | null = null;
      for (const k of statOptions) {
        if (substats[k] > maxVal) {
          maxVal = substats[k];
          maxKey = k;
        }
      }
      if (maxKey === "strength") suffix = "之蛮力";
      else if (maxKey === "defense") suffix = "之坚韧";
      else if (maxKey === "charm") suffix = "之优雅";
      else if (maxKey === "agility") suffix = "之疾风";
      else if (maxKey === "eloquence") suffix = "之睿智";
      else if (maxKey === "endurance") suffix = "之不屈";
      else if (maxKey === "life") suffix = "之生命";

      const newInstId = "inst_" + randomUUID().slice(0, 8);
      player.itemInstances[newInstId] = {
        id: newInstId,
        itemId,
        enhancement: 0,
        rarity,
        substats,
        suffix: suffix || undefined,
      };
      player.inventory.push({ itemId, quantity: 1, instanceId: newInstId });
    }
    return;
  }

  if (instanceId) {
    player.inventory.push({ itemId, quantity: 1, instanceId });
    return;
  }

  const entry = player.inventory.find((candidate) => candidate.itemId === itemId && !candidate.instanceId);
  if (entry) {
    entry.quantity += quantity;
    return;
  }
  player.inventory.push({ itemId, quantity });
}

export function removePlayerItem(player: PlayerState, itemId: string, quantity: number, instanceId?: string): boolean {
  const index = player.inventory.findIndex((candidate) => {
    if (instanceId) return candidate.instanceId === instanceId;
    return candidate.itemId === itemId && !candidate.instanceId;
  });
  if (index === -1) return false;
  const entry = player.inventory[index];
  if (entry.quantity < quantity) return false;
  entry.quantity -= quantity;
  if (entry.quantity <= 0) {
    player.inventory.splice(index, 1);
  }
  return true;
}

// Re-export savePlayer so callers that previously reached it via the closure
// can import a single economy entry point if desired.
export { savePlayer };
