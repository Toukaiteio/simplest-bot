import type { MMORPGContent, QuestObjective, ValidationReport } from "./schema.js";

export function validateMMORPGContent(content: MMORPGContent): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const stats = {
    races: Object.keys(content.races).length,
    genders: Object.keys(content.genders).length,
    classes: Object.keys(content.classes).length,
    skills: Object.keys(content.skills).length,
    items: Object.keys(content.items).length,
    professions: Object.keys(content.professions).length,
    factions: Object.keys(content.factions).length,
    areas: Object.keys(content.areas).length,
    resourceNodes: Object.keys(content.resourceNodes).length,
    fishSpecies: Object.keys(content.fishSpecies).length,
    npcs: Object.keys(content.npcs).length,
    monsters: Object.keys(content.monsters).length,
    quests: Object.keys(content.quests).length,
    dungeons: Object.keys(content.dungeons).length,
    achievements: Object.keys(content.achievements).length,
  };

  for (const classDef of Object.values(content.classes)) {
    for (const skillId of classDef.starterSkillIds) {
      assertRef(content.skills, skillId, `职业 ${classDef.id} 的 starterSkillIds`, errors);
    }
    for (const itemId of classDef.starterItemIds) {
      assertRef(content.items, itemId, `职业 ${classDef.id} 的 starterItemIds`, errors);
    }
  }

  for (const area of Object.values(content.areas)) {
    for (const areaId of area.connectedAreaIds) {
      assertRef(content.areas, areaId, `区域 ${area.id} 的 connectedAreaIds`, errors);
    }
    for (const monsterId of area.monsterIds) {
      assertRef(content.monsters, monsterId, `区域 ${area.id} 的 monsterIds`, errors);
    }
    for (const npcId of area.npcIds) {
      assertRef(content.npcs, npcId, `区域 ${area.id} 的 npcIds`, errors);
    }
    for (const questId of area.questIds) {
      assertRef(content.quests, questId, `区域 ${area.id} 的 questIds`, errors);
    }
    for (const nodeId of area.resourceNodeIds) {
      assertRef(content.resourceNodes, nodeId, `区域 ${area.id} 的 resourceNodeIds`, errors);
    }
    if (area.factionId) {
      assertRef(content.factions, area.factionId, `区域 ${area.id} 的 factionId`, errors);
    }
  }

  for (const node of Object.values(content.resourceNodes)) {
    assertRef(content.professions, node.professionId, `资源点 ${node.id} 的 professionId`, errors);
    for (const itemId of node.itemIds) {
      assertRef(content.items, itemId, `资源点 ${node.id} 的 itemIds`, errors);
    }
    for (const areaId of node.areaIds) {
      assertRef(content.areas, areaId, `资源点 ${node.id} 的 areaIds`, errors);
    }
  }

  for (const fish of Object.values(content.fishSpecies)) {
    for (const areaId of fish.habitatAreaIds) {
      assertRef(content.areas, areaId, `鱼种 ${fish.id} 的 habitatAreaIds`, errors);
    }
    if (fish.baseValue <= 0) {
      errors.push(`鱼种 ${fish.id} 的 baseValue 必须大于 0。`);
    }
    if (fish.lengthRangeCm[0] <= 0 || fish.lengthRangeCm[1] < fish.lengthRangeCm[0]) {
      errors.push(`鱼种 ${fish.id} 的 lengthRangeCm 不合法。`);
    }
  }

  for (const npc of Object.values(content.npcs)) {
    assertRef(content.areas, npc.areaId, `NPC ${npc.id} 的 areaId`, errors);
    for (const questId of npc.offeredQuestIds) {
      assertRef(content.quests, questId, `NPC ${npc.id} 的 offeredQuestIds`, errors);
    }
    for (const itemId of npc.shopItemIds) {
      assertRef(content.items, itemId, `NPC ${npc.id} 的 shopItemIds`, errors);
    }
  }

  for (const monster of Object.values(content.monsters)) {
    for (const skillId of monster.skillIds) {
      assertRef(content.skills, skillId, `怪物 ${monster.id} 的 skillIds`, errors);
    }
    for (const itemId of monster.lootItemIds) {
      assertRef(content.items, itemId, `怪物 ${monster.id} 的 lootItemIds`, errors);
    }
    for (const areaId of monster.areaIds) {
      assertRef(content.areas, areaId, `怪物 ${monster.id} 的 areaIds`, errors);
    }
  }

  for (const quest of Object.values(content.quests)) {
    assertRef(content.npcs, quest.giverNpcId, `任务 ${quest.id} 的 giverNpcId`, errors);
    assertRef(content.npcs, quest.turnInNpcId, `任务 ${quest.id} 的 turnInNpcId`, errors);
    for (const prerequisiteQuestId of quest.prerequisiteQuestIds) {
      assertRef(content.quests, prerequisiteQuestId, `任务 ${quest.id} 的 prerequisiteQuestIds`, errors);
    }
    for (const objective of quest.objectives) {
      validateObjective(objective, content, quest.id, errors);
    }
    for (const itemId of quest.reward.itemIds) {
      assertRef(content.items, itemId, `任务 ${quest.id} 的奖励 itemIds`, errors);
    }
    if (quest.reward.reputation) {
      assertRef(content.factions, quest.reward.reputation.factionId, `任务 ${quest.id} 的奖励 reputation`, errors);
    }
  }

  for (const dungeon of Object.values(content.dungeons)) {
    assertRef(content.areas, dungeon.areaId, `副本 ${dungeon.id} 的 areaId`, errors);
    for (const bossId of dungeon.bossMonsterIds) {
      assertRef(content.monsters, bossId, `副本 ${dungeon.id} 的 bossMonsterIds`, errors);
    }
    for (const itemId of dungeon.rewardItemIds) {
      assertRef(content.items, itemId, `副本 ${dungeon.id} 的 rewardItemIds`, errors);
    }
    if (dungeon.partySize <= 0) {
      errors.push(`副本 ${dungeon.id} 的 partySize 必须大于 0。`);
    }
  }

  if (stats.classes < 4) {
    warnings.push("职业数量较少，后续扩展时建议补足坦克、治疗、近战、远程、潜行等定位。");
  }
  if (stats.races < 3) {
    warnings.push("种族数量较少，角色创建时的差异化路线还不够丰富。");
  }
  if (stats.dungeons === 0) {
    warnings.push("当前没有配置副本，MMORPG 框架虽然完整，但组队玩法示例不足。");
  }

  return { errors, warnings, stats };
}

function validateObjective(
  objective: QuestObjective,
  content: MMORPGContent,
  questId: string,
  errors: string[]
) {
  if (objective.type === "kill") {
    assertRef(content.monsters, objective.monsterId, `任务 ${questId} 的 kill objective`, errors);
    return;
  }
  if (objective.type === "collect") {
    assertRef(content.items, objective.itemId, `任务 ${questId} 的 collect objective`, errors);
    return;
  }
  if (objective.type === "talk") {
    assertRef(content.npcs, objective.npcId, `任务 ${questId} 的 talk objective`, errors);
    return;
  }
  assertRef(content.areas, objective.areaId, `任务 ${questId} 的 reach objective`, errors);
}

function assertRef<T extends { id: string }>(
  registry: Record<string, T>,
  id: string,
  label: string,
  errors: string[]
) {
  if (!registry[id]) {
    errors.push(`${label} 引用了不存在的 ID: ${id}`);
  }
}
