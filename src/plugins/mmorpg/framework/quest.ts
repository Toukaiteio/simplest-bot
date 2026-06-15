import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import type {
  AreaDef,
  MonsterDef,
  NpcDef,
  PlayerState,
  QuestDef,
  QuestObjective,
  QuestProgress,
  ResourceNodeDef,
} from "../schema.js";
import type { PluginContext } from "../../../types.js";
import {
  describeArea,
  describeFaction,
  describeItem,
  describeMonster,
  describeProfession,
  describeResourceNode,
} from "./descriptions.js";
import {
  formatQuestStatus,
} from "./format.js";
import { getObjectiveKey, getObjectiveTarget } from "./utils.js";
import { formatNewlyUnlocked } from "./achievements.js";
import {
  requireArea,
  requireNpc,
  requireQuest,
  requireResourceNode,
  requireMonster,
  savePlayer,
  getQuestProgress,
} from "./player-access.js";
import {
  addPlayerItem,
  removePlayerItem,
  getPlayerItemQuantity,
  grantBridgedCoins,
} from "./economy.js";
import { applyRewardBonuses, grantExperience } from "./progression.js";
import { checkAchievementsOnProfessions } from "./achievements.js";
import { checkResourcePool, recordResourceGather } from "./combat.js";

/**
 * 任务进度跟踪、接取、交付与资源采集（依赖层级 4）。
 */

export function getObjectiveCounter(progress: QuestProgress, objective: QuestObjective): number {
  return progress.counters[getObjectiveKey(objective)] ?? 0;
}

export function updateQuestProgressFromState(player: PlayerState): string[] {
  const previous = new Map(player.questLog.map((entry) => [entry.questId, entry.status]));
  for (const entry of player.questLog) {
    if (entry.status === "turned_in") {
      continue;
    }
    const quest = requireQuest(entry.questId);
    refreshQuestProgress(player, quest, entry);
  }
  return player.questLog
    .filter((entry) => previous.get(entry.questId) === "active" && entry.status === "completed")
    .map((entry) => `任务完成：${requireQuest(entry.questId).name}`);
}

export function refreshQuestProgress(player: PlayerState, quest: QuestDef, progress: QuestProgress): void {
  for (const objective of quest.objectives) {
    const key = getObjectiveKey(objective);
    if (objective.type === "collect") {
      progress.counters[key] = getPlayerItemQuantity(player, objective.itemId);
    } else if (objective.type === "reach") {
      progress.counters[key] = Math.max(progress.counters[key] ?? 0, player.areaId === objective.areaId ? 1 : 0);
    } else {
      progress.counters[key] ??= 0;
    }
  }

  const completed = quest.objectives.every((objective) => (
    getObjectiveCounter(progress, objective) >= getObjectiveTarget(objective)
  ));
  if (progress.status === "active" && completed) {
    progress.status = "completed";
  }
}

export function markTalkProgress(player: PlayerState, npcId: string): string | undefined {
  let updated = false;
  for (const progress of player.questLog) {
    if (progress.status === "turned_in") {
      continue;
    }
    const quest = requireQuest(progress.questId);
    for (const objective of quest.objectives) {
      if (objective.type === "talk" && objective.npcId === npcId) {
        progress.counters[getObjectiveKey(objective)] = 1;
        updated = true;
      }
    }
  }
  const completions = updateQuestProgressFromState(player);
  if (!updated && completions.length === 0) {
    return undefined;
  }
  return [...completions].join("\n");
}

export function incrementKillProgress(player: PlayerState, monsterId: string): void {
  for (const progress of player.questLog) {
    if (progress.status === "turned_in") {
      continue;
    }
    const quest = requireQuest(progress.questId);
    for (const objective of quest.objectives) {
      if (objective.type === "kill" && objective.monsterId === monsterId) {
        const key = getObjectiveKey(objective);
        const target = getObjectiveTarget(objective);
        progress.counters[key] = Math.min(target, (progress.counters[key] ?? 0) + 1);
      }
    }
  }
}

export function canAcceptQuest(player: PlayerState, quest: QuestDef): { ok: boolean; reason?: string } {
  if (getQuestProgress(player, quest.id)) {
    return { ok: false, reason: "该任务已接取或已完成过。" };
  }
  if (player.level < quest.requiredLevel) {
    return { ok: false, reason: `需要达到 ${quest.requiredLevel} 级。` };
  }
  // Prerequisite quest chain (AND logic)
  for (const prerequisiteId of quest.prerequisiteQuestIds) {
    const prerequisite = getQuestProgress(player, prerequisiteId);
    if (prerequisite?.status !== "turned_in") {
      return { ok: false, reason: `前置任务 ${prerequisiteId} 尚未交付。` };
    }
  }
  // Exclusion check (OR logic: if any excluded quest is active/turned_in, hide this quest)
  if (quest.excludedQuestIds && quest.excludedQuestIds.length > 0) {
    for (const excludedId of quest.excludedQuestIds) {
      const excluded = getQuestProgress(player, excludedId);
      if (excluded && (excluded.status === "active" || excluded.status === "completed" || excluded.status === "turned_in")) {
        return { ok: false, reason: `该任务与任务 ${excludedId} 互斥。` };
      }
    }
  }
  // Class restriction
  if (quest.allowedClasses && quest.allowedClasses.length > 0) {
    if (!quest.allowedClasses.includes(player.classId)) {
      const classNames = quest.allowedClasses.map((c) => DEFAULT_MMORPG_CONTENT.classes[c]?.name ?? c).join("、");
      return { ok: false, reason: `仅限 ${classNames} 职业接取。` };
    }
  }
  // Rebirth count
  if (quest.requiredRebirths !== undefined && (player.rebirthCount ?? 0) < quest.requiredRebirths) {
    return { ok: false, reason: `需要轮回 ${quest.requiredRebirths} 次以上。` };
  }
  // Faction reputation
  if (quest.requiredFactionRep && quest.requiredFactionRep.length > 0) {
    for (const req of quest.requiredFactionRep) {
      const current = player.factionReputation[req.factionId] ?? 0;
      if (current < req.minRep) {
        const factionName = DEFAULT_MMORPG_CONTENT.factions[req.factionId]?.name ?? req.factionId;
        return { ok: false, reason: `需要 ${factionName} 声望达到 ${req.minRep}（当前 ${current}）。` };
      }
    }
  }
  // Required items
  if (quest.requiredItems && quest.requiredItems.length > 0) {
    for (const req of quest.requiredItems) {
      const qty = getPlayerItemQuantity(player, req.itemId);
      if (qty < req.quantity) {
        const itemName = DEFAULT_MMORPG_CONTENT.items[req.itemId]?.name ?? req.itemId;
        return { ok: false, reason: `需要持有 ${itemName} x${req.quantity}（当前 ${qty}）。` };
      }
    }
  }
  // Dialogue flags
  if (quest.requiredDialogueFlags && quest.requiredDialogueFlags.length > 0) {
    const flags = new Set(player.dialogueFlags ?? []);
    for (const flag of quest.requiredDialogueFlags) {
      if (!flags.has(flag)) {
        return { ok: false, reason: `需要先完成相关对话（${flag}）。` };
      }
    }
  }
  // Guild membership
  if (quest.requiresGuild && !player.guildId) {
    return { ok: false, reason: "需要加入公会后才能接取。" };
  }
  // Required skills
  if (quest.requiredSkillIds && quest.requiredSkillIds.length > 0) {
    const unlocked = new Set(player.unlockedSkillIds ?? []);
    for (const skillId of quest.requiredSkillIds) {
      if (!unlocked.has(skillId)) {
        const skillName = DEFAULT_MMORPG_CONTENT.skills[skillId]?.name ?? skillId;
        return { ok: false, reason: `需要先解锁技能「${skillName}」。` };
      }
    }
  }
  // Cooldown check
  if (quest.cooldownSeconds && quest.cooldownSeconds > 0) {
    const progress = getQuestProgress(player, quest.id);
    if (progress?.status === "turned_in" && progress.turnedInAt) {
      const elapsed = (Date.now() - new Date(progress.turnedInAt).getTime()) / 1000;
      if (elapsed < quest.cooldownSeconds) {
        const remaining = Math.ceil(quest.cooldownSeconds - elapsed);
        const min = Math.floor(remaining / 60);
        const sec = remaining % 60;
        return { ok: false, reason: `冷却中，还需 ${min > 0 ? `${min}分` : ""}${sec}秒。` };
      }
    }
  }
  return { ok: true };
}

export function getLocalAvailableQuests(player: PlayerState): QuestDef[] {
  const area = requireArea(player.areaId);
  const questIds = new Set<string>(area.questIds);
  for (const npcId of area.npcIds) {
    const npc = requireNpc(npcId);
    for (const questId of npc.offeredQuestIds) {
      questIds.add(questId);
    }
  }
  return [...questIds]
    .map((questId) => requireQuest(questId))
    // Only offer quests whose giver NPC is actually present in this area —
    // otherwise the player would see it in the list but be unable to accept it.
    .filter((quest) => quest.giverNpcId !== undefined && requireNpc(quest.giverNpcId).areaId === player.areaId)
    .filter((quest) => canAcceptQuest(player, quest).ok);
}

export function formatLocalNpcList(player: PlayerState): string {
  const area = requireArea(player.areaId);
  if (area.npcIds.length === 0) {
    return "当前区域没有可互动的 NPC。";
  }
  return [
    `当前区域 NPC：${area.name}`,
    ...area.npcIds.map((npcId) => {
      const npc = requireNpc(npcId);
      return `- ${npc.name}(${npc.id}) / ${npc.role} / 提供任务 ${npc.offeredQuestIds.length}`;
    }),
  ].join("\n");
}

export function formatNpcDetail(player: PlayerState, npc: NpcDef): string {
  const offered = npc.offeredQuestIds.length > 0
    ? npc.offeredQuestIds.map((questId) => {
      const quest = requireQuest(questId);
      const existing = getQuestProgress(player, questId);
      const status = existing ? existing.status : (canAcceptQuest(player, quest).ok ? "可接" : "未满足条件");
      return `${quest.name}(${quest.id})[${status}]`;
    }).join("、")
    : "无";
  const shopItems = npc.shopItemIds.length > 0
    ? npc.shopItemIds.map((itemId) => describeItem(itemId)).join("、")
    : "无";
  return [
    `${npc.name}（${npc.id}）`,
    `身份：${npc.role}`,
    `描述：${npc.description}`,
    `提供任务：${offered}`,
    `可售物品：${shopItems}`,
  ].join("\n");
}

export function formatQuestJournal(player: PlayerState): string {
  const active = player.questLog.filter((entry) => entry.status === "active" || entry.status === "completed");
  const available = getLocalAvailableQuests(player);
  const turnedIn = player.questLog.filter((entry) => entry.status === "turned_in");

  return [
    active.length > 0
      ? ["当前任务：", ...active.map((entry) => formatQuestStatus(requireQuest(entry.questId), entry))].join("\n")
      : "当前没有进行中的任务。",
    available.length > 0
      ? ["本区域可接任务：", ...available.map((quest) => `- ${quest.name}(${quest.id}) / 需求等级 ${quest.requiredLevel}`)].join("\n")
      : "本区域暂无可接新任务。",
    turnedIn.length > 0 ? `已交付任务数：${turnedIn.length}` : undefined,
  ].filter(Boolean).join("\n");
}

export function acceptQuest(player: PlayerState, questId: string): string {
  const quest = requireQuest(questId);
  const giver = requireNpc(quest.giverNpcId);
  if (giver.areaId !== player.areaId) {
    throw new Error(`该任务需要在 ${describeArea(giver.areaId)} 与 ${giver.name} 对话接取。`);
  }
  const eligibility = canAcceptQuest(player, quest);
  if (!eligibility.ok) {
    throw new Error(eligibility.reason ?? "当前不能接取该任务。");
  }
  const progress: QuestProgress = {
    questId: quest.id,
    status: "active",
    counters: {},
  };
  player.questLog.push(progress);

  // Auto-mark talk objectives where the target NPC is the giver — the player
  // is already talking to this NPC to accept the quest, so it counts.
  for (const objective of quest.objectives) {
    if (objective.type === "talk" && objective.npcId === quest.giverNpcId) {
      progress.counters[getObjectiveKey(objective)] = 1;
    }
  }

  const completions = updateQuestProgressFromState(player);
  savePlayer(player);
  return [
    `已接受任务：${quest.name}。`,
    `任务说明：${quest.description}`,
    formatQuestStatus(quest, progress),
    ...completions,
  ].join("\n");
}

export function turnInQuest(player: PlayerState, questId: string, ctx: PluginContext): string {
  const quest = requireQuest(questId);
  const progress = getQuestProgress(player, questId);
  if (!progress) {
    throw new Error("你还没有接取该任务。");
  }

  updateQuestProgressFromState(player);
  if (progress.status !== "completed") {
    throw new Error(`该任务尚未完成。\n${formatQuestStatus(quest, progress)}`);
  }

  const turnInNpc = requireNpc(quest.turnInNpcId);
  if (turnInNpc.areaId !== player.areaId) {
    throw new Error(`请前往 ${describeArea(turnInNpc.areaId)} 找 ${turnInNpc.name} 交付任务。`);
  }

  for (const objective of quest.objectives) {
    if (objective.type === "collect" && getPlayerItemQuantity(player, objective.itemId) < objective.count) {
      throw new Error(`交付材料不足：${describeItem(objective.itemId)} x${objective.count}`);
    }
  }
  for (const objective of quest.objectives) {
    if (objective.type === "collect") {
      removePlayerItem(player, objective.itemId, objective.count);
    }
  }

  for (const itemId of quest.reward.itemIds) {
    addPlayerItem(player, itemId, 1);
  }
  if (quest.reward.reputation) {
    player.factionReputation[quest.reward.reputation.factionId] = (
      player.factionReputation[quest.reward.reputation.factionId] ?? 0
    ) + quest.reward.reputation.amount;
  }

  // Skill unlock reward (typically a passive skill from a side quest).
  let unlockedSkillName: string | undefined;
  if (quest.reward.rewardSkillId && !player.unlockedSkillIds.includes(quest.reward.rewardSkillId)) {
    player.unlockedSkillIds.push(quest.reward.rewardSkillId);
    const skill = DEFAULT_MMORPG_CONTENT.skills[quest.reward.rewardSkillId];
    unlockedSkillName = skill?.name ?? quest.reward.rewardSkillId;
  }

  const rewards = applyRewardBonuses(player, quest.reward.exp, quest.reward.coins);
  const levelResult = grantExperience(player, rewards.exp);
  if (rewards.coins > 0) {
    grantBridgedCoins(player.userId, rewards.coins, ctx);
  }
  progress.status = "turned_in";
  progress.turnedInAt = new Date().toISOString();
  savePlayer(player);

  const rewardItemsText = quest.reward.itemIds.length > 0
    ? quest.reward.itemIds.map((itemId) => describeItem(itemId)).join("、")
    : "无";
  const levelText = levelResult.levelsGained > 0
    ? `升级：+${levelResult.levelsGained}，当前等级 ${player.level}`
    : `当前等级：${player.level}`;
  return [
    `已交付任务：${quest.name}`,
    `奖励经验：${rewards.exp}`,
    `奖励金币：${rewards.coins}`,
    `奖励物品：${rewardItemsText}`,
    quest.reward.reputation
      ? `阵营声望：${describeFaction(quest.reward.reputation.factionId)} +${quest.reward.reputation.amount}`
      : undefined,
    unlockedSkillName ? `🎉 解锁技能：${unlockedSkillName}${DEFAULT_MMORPG_CONTENT.skills[quest.reward.rewardSkillId!]?.category === "passive" ? "（被动·永久生效）" : ""}` : undefined,
    levelText,
  ].filter(Boolean).join("\n");
}

export function abandonQuest(player: PlayerState, questId: string): string {
  const progress = getQuestProgress(player, questId);
  if (!progress) {
    throw new Error("你还没有接取该任务。");
  }
  if (progress.status === "turned_in") {
    throw new Error("已交付的任务无法放弃。");
  }
  const quest = requireQuest(questId);

  // Recycle quest-category items held for this task's collect objectives.
  // Regular materials/consumables are kept — they may be farmed for other
  // quests or sold, so we only reclaim dedicated quest-key items.
  const reclaimed: string[] = [];
  for (const objective of quest.objectives) {
    if (objective.type !== "collect") continue;
    const item = DEFAULT_MMORPG_CONTENT.items[objective.itemId];
    if (!item || item.category !== "quest") continue;
    const have = getPlayerItemQuantity(player, objective.itemId);
    const toRemove = Math.min(have, objective.count);
    if (toRemove > 0) {
      removePlayerItem(player, objective.itemId, toRemove);
      reclaimed.push(`${describeItem(objective.itemId)} x${toRemove}`);
    }
  }

  // Removing the questLog entry clears all kill/talk/reach/collect counters.
  player.questLog = player.questLog.filter((entry) => entry.questId !== questId);
  savePlayer(player);
  return [
    `已放弃任务：${quest.name}。`,
    reclaimed.length > 0 ? `已回收任务物品：${reclaimed.join("、")}` : undefined,
    `如需重新挑战，可前往原任务发布 NPC 处重新接取。`,
  ].filter(Boolean).join("\n");
}

export function resolveLocalMonster(area: AreaDef, monsterId?: string): MonsterDef {
  if (monsterId) {
    const monster = requireMonster(monsterId);
    if (!area.monsterIds.includes(monster.id)) {
      throw new Error(`当前区域无法狩猎 ${monster.name}。可选目标：${area.monsterIds.map((id) => describeMonster(id)).join("、")}`);
    }
    return monster;
  }
  if (area.monsterIds.length === 1) {
    return requireMonster(area.monsterIds[0]);
  }
  const randomIndex = Math.floor(Math.random() * area.monsterIds.length);
  return requireMonster(area.monsterIds[randomIndex]);
}

export function resolveLocalResourceNode(area: AreaDef, nodeId?: string): ResourceNodeDef {
  if (nodeId) {
    const node = requireResourceNode(nodeId);
    if (!area.resourceNodeIds.includes(node.id)) {
      throw new Error(`当前区域无法采集 ${node.name}。可选资源点：${area.resourceNodeIds.map((id) => requireResourceNode(id).name).join("、")}`);
    }
    return node;
  }
  if (area.resourceNodeIds.length === 1) {
    return requireResourceNode(area.resourceNodeIds[0]);
  }
  throw new Error(`当前区域有多个资源点，请指定 resourceNodeId：${area.resourceNodeIds.map((id) => describeResourceNode(id)).join("、")}`);
}

export function gatherResource(player: PlayerState, nodeId: string | undefined, recordPool = true): string {
  const area = requireArea(player.areaId);
  if (area.resourceNodeIds.length === 0) {
    throw new Error("当前区域没有可采集的资源点。");
  }
  const node = resolveLocalResourceNode(area, nodeId);

  // Check resource pool
  if (recordPool) {
    const poolBlocked = checkResourcePool(area.id);
    if (poolBlocked) return poolBlocked;
  }

  for (const itemId of node.itemIds) {
    addPlayerItem(player, itemId, 1);
  }
  player.professionLevels[node.professionId] = (player.professionLevels[node.professionId] ?? 0) + 1;
  const levelResult = grantExperience(player, 8 + node.itemIds.length * 4);
  const newlyUnlocked = checkAchievementsOnProfessions(player);
  const completions = updateQuestProgressFromState(player);

  // Record gather in pool
  if (recordPool) {
    recordResourceGather(area.id);
  }

  savePlayer(player);

  return [
    `你采集了 ${node.name}。`,
    `获得物品：${node.itemIds.map((itemId) => describeItem(itemId)).join("、")}`,
    `副职业进度：${describeProfession(node.professionId)} ${player.professionLevels[node.professionId]}`,
    levelResult.levelsGained > 0 ? `升级：+${levelResult.levelsGained}，当前等级 ${player.level}` : `获得经验：${8 + node.itemIds.length * 4}`,
    ...completions,
    formatNewlyUnlocked([...newlyUnlocked, ...levelResult.newlyUnlockedAchievementIds]) || undefined,
  ].filter(Boolean).join("\n");
}
