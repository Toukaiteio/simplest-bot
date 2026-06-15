import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import type {
  AreaDef,
  ClassDef,
  FishSpeciesDef,
  MonsterDef,
  NpcDef,
  PlayerState,
  QuestDef,
  QuestProgress,
  ResourceNodeDef,
} from "../schema.js";
import { rt } from "./runtime.js";
import { checkGuideEnforcement } from "./guide.js";

/**
 * 玩家与内容访问的基础 helper（依赖层级 0-1）。
 * 这些函数只读取运行时容器 rt 与静态内容，无副作用写入（除 savePlayer）。
 * 它们是几乎所有其他模块的依赖基座。
 */

export function savePlayer(player: PlayerState): void {
  rt.stateStore?.savePlayer(player);
}

export function getExistingPlayer(userId: string): PlayerState | null {
  return rt.stateStore?.getPlayer(userId) ?? null;
}

export function requirePlayer(userId: string): PlayerState {
  const player = getExistingPlayer(userId);
  if (!player) {
    throw new Error("目标用户还没有创建 MMORPG 角色。");
  }
  return player;
}

export function requirePlayerFromMessage(message: { userId?: string }, skipGuideCheck = false): PlayerState {
  if (!message.userId) {
    throw new Error("无法确定当前用户身份。");
  }
  const player = requirePlayer(message.userId);
  if (!skipGuideCheck) {
    checkGuideEnforcement(player, rt.menuPlugin.getPrefix());
  }
  return player;
}

export function requireRace(raceId: string) {
  const race = DEFAULT_MMORPG_CONTENT.races[raceId];
  if (!race) {
    throw new Error(`未知种族：${raceId}`);
  }
  return race;
}

export function requireClass(classId: string): ClassDef {
  const classDef = DEFAULT_MMORPG_CONTENT.classes[classId];
  if (!classDef) {
    throw new Error(`未知职业：${classId}`);
  }
  return classDef;
}

export function requireArea(areaId: string): AreaDef {
  const area = DEFAULT_MMORPG_CONTENT.areas[areaId];
  if (!area) {
    throw new Error(`未知区域：${areaId}`);
  }
  return area;
}

export function requireGender(genderId: string) {
  const gender = DEFAULT_MMORPG_CONTENT.genders[genderId];
  if (!gender) {
    throw new Error(`未知性别：${genderId}`);
  }
  return gender;
}

export function requireNpc(npcId: string): NpcDef {
  const npc = DEFAULT_MMORPG_CONTENT.npcs[npcId];
  if (!npc) {
    throw new Error(`未知 NPC：${npcId}`);
  }
  return npc;
}

export function requireQuest(questId: string): QuestDef {
  const quest = DEFAULT_MMORPG_CONTENT.quests[questId];
  if (!quest) {
    throw new Error(`未知任务：${questId}`);
  }
  return quest;
}

export function requireMonster(monsterId: string): MonsterDef {
  const monster = DEFAULT_MMORPG_CONTENT.monsters[monsterId];
  if (!monster) {
    throw new Error(`未知怪物：${monsterId}`);
  }
  return monster;
}

export function requireResourceNode(nodeId: string): ResourceNodeDef {
  const node = DEFAULT_MMORPG_CONTENT.resourceNodes[nodeId];
  if (!node) {
    throw new Error(`未知资源点：${nodeId}`);
  }
  return node;
}

export function requireFishSpecies(speciesId: string): FishSpeciesDef {
  const species = DEFAULT_MMORPG_CONTENT.fishSpecies[speciesId];
  if (!species) {
    throw new Error(`未知鱼种：${speciesId}`);
  }
  return species;
}

export function requireLocalNpc(player: PlayerState, npcId: string): NpcDef {
  const npc = requireNpc(npcId);
  if (npc.areaId !== player.areaId) {
    const area = requireArea(player.areaId);
    throw new Error(`${npc.name} 不在当前区域（${area.name}）。`);
  }
  return npc;
}

export function getQuestProgress(player: PlayerState, questId: string): QuestProgress | undefined {
  return player.questLog.find((entry) => entry.questId === questId);
}
