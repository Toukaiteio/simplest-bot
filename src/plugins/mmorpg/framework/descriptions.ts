import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import type {
  FishCatch,
  FishRarity,
  PlayerState,
  QuestObjective,
} from "../schema.js";

export function describeArea(areaId: string): string {
  const area = DEFAULT_MMORPG_CONTENT.areas[areaId];
  return area ? `${area.name}(${area.id})` : areaId;
}

export function describeNpc(npcId: string): string {
  const npc = DEFAULT_MMORPG_CONTENT.npcs[npcId];
  return npc ? `${npc.name}(${npc.id})` : npcId;
}

export function describeMonster(monsterId: string): string {
  const monster = DEFAULT_MMORPG_CONTENT.monsters[monsterId];
  return monster ? `${monster.name}(${monster.id})` : monsterId;
}

export function describeResourceNode(nodeId: string): string {
  const node = DEFAULT_MMORPG_CONTENT.resourceNodes[nodeId];
  return node ? `${node.name}(${node.id})` : nodeId;
}

export function describeQuest(questId: string): string {
  const quest = DEFAULT_MMORPG_CONTENT.quests[questId];
  return quest ? `${quest.name}(${quest.id})` : questId;
}

export function describeFaction(factionId: string): string {
  const faction = DEFAULT_MMORPG_CONTENT.factions[factionId];
  return faction ? `${faction.name}(${faction.id})` : factionId;
}

export function describeItem(itemId: string): string {
  const item = DEFAULT_MMORPG_CONTENT.items[itemId];
  return item ? `${item.name}(${item.id})` : itemId;
}

export function describeProfession(professionId: string): string {
  const profession = DEFAULT_MMORPG_CONTENT.professions[professionId];
  return profession ? `${profession.name}(${profession.id})` : professionId;
}

export function describeFishSpecies(speciesId: string): string {
  const species = DEFAULT_MMORPG_CONTENT.fishSpecies[speciesId];
  return species ? `${species.name}(${species.id})` : speciesId;
}

export function describeObjective(objective: QuestObjective): string {
  if (objective.type === "kill") {
    return `击败 ${describeMonster(objective.monsterId)}`;
  }
  if (objective.type === "collect") {
    return `收集 ${describeItem(objective.itemId)}`;
  }
  if (objective.type === "talk") {
    return `与 ${describeNpc(objective.npcId)} 交谈`;
  }
  return `到达 ${describeArea(objective.areaId)}`;
}

export function formatFishRarity(rarity: FishRarity): string {
  if (rarity === "common") return "普通";
  if (rarity === "uncommon") return "优秀";
  if (rarity === "rare") return "稀有";
  if (rarity === "epic") return "史诗";
  return "传说";
}

export function getRarityRank(rarity: FishRarity): number {
  if (rarity === "common") return 1;
  if (rarity === "uncommon") return 2;
  if (rarity === "rare") return 3;
  if (rarity === "epic") return 4;
  return 5;
}

export function formatFishCatch(
  fish: FishCatch,
  options: { includePrice?: boolean; withId?: boolean } = {}
): string {
  const includePrice = options.includePrice ?? true;
  const withId = options.withId ?? true;
  return [
    withId ? `${fish.speciesName}[${fish.id}]` : fish.speciesName,
    `${formatFishRarity(fish.rarity)}`,
    `${fish.lengthCm}cm`,
    `产地 ${describeArea(fish.areaId)}`,
    includePrice ? `${fish.price} 金币` : undefined,
  ]
    .filter(Boolean)
    .join(" / ");
}

export function formatFishingStatusText(player: PlayerState): string {
  if (!player.fishingSession) {
    return "当前未在钓鱼。";
  }
  const remainingMs =
    new Date(player.fishingSession.resolveAt).getTime() - Date.now();
  if (remainingMs <= 0) {
    return `鱼漂已经有动静了，在 ${describeArea(
      player.fishingSession.areaId
    )} 使用 mmo-fish 收杆。`;
  }
  return `正在 ${describeArea(
    player.fishingSession.areaId
  )} 钓鱼，预计还需 ${Math.ceil(remainingMs / 1000)} 秒。`;
}
