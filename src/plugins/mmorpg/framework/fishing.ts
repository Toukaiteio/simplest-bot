import { randomUUID } from "node:crypto";
import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import { MMORPG_RULEBOOK } from "../rulebook.js";
import type {
  FishCatch,
  FishRarity,
  FishSpeciesDef,
  PlayerState,
} from "../schema.js";
import type { PluginContext } from "../../../types.js";
import {
  describeArea,
  describeProfession,
  formatFishCatch,
  getRarityRank,
} from "./descriptions.js";
import { randomInt, randomFloat, roundToOneDecimal, clamp } from "./utils.js";
import { savePlayer } from "./player-access.js";
import { grantBridgedCoins } from "./economy.js";
import { grantExperience } from "./progression.js";
import { checkAchievementsOnFishCatch, formatNewlyUnlocked } from "./achievements.js";

/**
 * 钓鱼系统：抛竿、收杆、卖鱼、稀有度与定价（依赖层级 4）。
 */

export function getFishSpeciesForArea(areaId: string): FishSpeciesDef[] {
  return Object.values(DEFAULT_MMORPG_CONTENT.fishSpecies).filter((species) => species.habitatAreaIds.includes(areaId));
}

export function handleFishing(player: PlayerState): string {
  const now = new Date();
  if (!player.fishingSession) {
    const availableSpecies = getFishSpeciesForArea(player.areaId);
    if (availableSpecies.length === 0) {
      throw new Error("当前区域没有适合钓鱼的水域。");
    }
    const waitSeconds = randomInt(
      MMORPG_RULEBOOK.fishing.minWaitSeconds,
      MMORPG_RULEBOOK.fishing.maxWaitSeconds
    );
    player.fishingSession = {
      areaId: player.areaId,
      startedAt: now.toISOString(),
      resolveAt: new Date(now.getTime() + waitSeconds * 1000).toISOString(),
    };
    savePlayer(player);
    return [
      `你在 ${describeArea(player.areaId)} 抛下了鱼线。`,
      `预计大约 ${waitSeconds} 秒后会有动静。`,
      "再次使用 mmo-fish 可以查看状态或收杆。",
    ].join("\n");
  }

  const resolveAtMs = new Date(player.fishingSession.resolveAt).getTime();
  if (now.getTime() < resolveAtMs) {
    const remainingSeconds = Math.max(1, Math.ceil((resolveAtMs - now.getTime()) / 1000));
    return [
      `鱼漂还没有明显动静。`,
      `大约还需要等待 ${remainingSeconds} 秒。`,
    ].join("\n");
  }

  const fish = rollFishCatch(player.fishingSession.areaId);
  player.fishingSession = undefined;
  player.fishBasket.push(fish);
  player.professionLevels.fishing = (player.professionLevels.fishing ?? 0) + 1;
  const newlyUnlocked = checkAchievementsOnFishCatch(player, fish);
  const levelResult = grantExperience(player, 6 + getRarityRank(fish.rarity) * 2);
  savePlayer(player);

  return [
    "鱼漂猛地一沉，你成功收杆。",
    formatFishCatch(fish),
    `副职业进度：${describeProfession("fishing")} ${player.professionLevels.fishing}`,
    levelResult.levelsGained > 0 ? `升级：+${levelResult.levelsGained}，当前等级 ${player.level}` : undefined,
    formatNewlyUnlocked(newlyUnlocked) || undefined,
    formatNewlyUnlocked(levelResult.newlyUnlockedAchievementIds) || undefined,
  ].filter(Boolean).join("\n");
}

export function sellFish(player: PlayerState, target: string, ctx: PluginContext): string {
  if (player.fishBasket.length === 0) {
    throw new Error("鱼篓里没有可出售的鱼。");
  }

  const soldFish = target === "all"
    ? [...player.fishBasket]
    : player.fishBasket.filter((fish) => fish.id === target);
  if (soldFish.length === 0) {
    throw new Error("未找到对应的鱼获，请使用 mmo-fish-basket 查看 fishId。");
  }

  const soldIds = new Set(soldFish.map((fish) => fish.id));
  player.fishBasket = player.fishBasket.filter((fish) => !soldIds.has(fish.id));
  const totalPrice = soldFish.reduce((sum, fish) => sum + fish.price, 0);
  if (totalPrice > 0) {
    grantBridgedCoins(player.userId, totalPrice, ctx);
  }
  savePlayer(player);

  return [
    `已出售 ${soldFish.length} 条鱼。`,
    ...soldFish.slice(0, 5).map((fish) => `- ${formatFishCatch(fish, { includePrice: true, withId: false })}`),
    soldFish.length > 5 ? `- 其余 ${soldFish.length - 5} 条已一并卖出。` : undefined,
    `共获得 ${totalPrice} 金币。`,
  ].filter(Boolean).join("\n");
}

export function rollFishCatch(areaId: string): FishCatch {
  const speciesPool = getFishSpeciesForArea(areaId);
  if (speciesPool.length === 0) {
    throw new Error("当前区域没有可钓上的鱼。");
  }
  const species = speciesPool[randomInt(0, speciesPool.length - 1)];
  const rarity = weightedPickRarity(species);
  const lengthCm = roundToOneDecimal(randomFloat(species.lengthRangeCm[0], species.lengthRangeCm[1]));
  const price = calculateFishPrice(species, rarity, lengthCm);
  return {
    id: randomUUID().slice(0, 8),
    speciesId: species.id,
    speciesName: species.name,
    rarity,
    lengthCm,
    price,
    areaId,
    caughtAt: new Date().toISOString(),
  };
}

export function weightedPickRarity(species: FishSpeciesDef): FishRarity {
  const rarities: FishRarity[] = ["common", "uncommon", "rare", "epic", "legendary"];
  const totalWeight = rarities.reduce((sum, rarity) => sum + (species.rarityWeights[rarity] ?? 0), 0);
  if (totalWeight <= 0) {
    return "common";
  }
  let roll = Math.random() * totalWeight;
  for (const rarity of rarities) {
    roll -= species.rarityWeights[rarity] ?? 0;
    if (roll <= 0) {
      return rarity;
    }
  }
  return "common";
}

export function calculateFishPrice(species: FishSpeciesDef, rarity: FishRarity, lengthCm: number): number {
  const lengthRatio = (
    (lengthCm - species.lengthRangeCm[0])
    / Math.max(1, species.lengthRangeCm[1] - species.lengthRangeCm[0])
  );
  const lengthBonus = Math.round(lengthRatio * 4);
  const rarityBonus = MMORPG_RULEBOOK.fishing.rarityBonus[rarity];
  return clamp(
    Math.round(species.baseValue + lengthBonus + rarityBonus - 1),
    MMORPG_RULEBOOK.fishing.minFishPrice,
    MMORPG_RULEBOOK.fishing.maxFishPrice
  );
}

export function formatFishingStatus(player: PlayerState): string {
  if (!player.fishingSession) {
    return "当前未在钓鱼。";
  }
  const remainingMs = new Date(player.fishingSession.resolveAt).getTime() - Date.now();
  if (remainingMs <= 0) {
    return `鱼漂已经有动静了，在 ${describeArea(player.fishingSession.areaId)} 使用 mmo-fish 收杆。`;
  }
  return `正在 ${describeArea(player.fishingSession.areaId)} 钓鱼，预计还需 ${Math.ceil(remainingMs / 1000)} 秒。`;
}
