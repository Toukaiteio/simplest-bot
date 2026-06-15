import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import { MMORPG_RULEBOOK } from "../rulebook.js";
import type {
  AreaDef,
  PendingMenu,
  PlayerState,
  QuestDef,
  QuestObjective,
  QuestProgress,
} from "../schema.js";
import {
  describeArea,
  describeFaction,
  describeFishSpecies,
  describeItem,
  describeMonster,
  describeNpc,
  describeObjective,
  describeQuest,
  describeResourceNode,
  formatFishCatch,
  formatFishingStatusText,
} from "./descriptions.js";
import { getObjectiveKey, getObjectiveTarget } from "./utils.js";

/**
 * Pure formatting helpers. No closure/state dependencies — only content + rulebook.
 */

export function formatCreationOptions(): string {
  const openClasses = Object.values(DEFAULT_MMORPG_CONTENT.classes)
    .filter((job) => !job.requiredRebirths && !job.unlockQuestId);
  return [
    `种族：${Object.values(DEFAULT_MMORPG_CONTENT.races).map((race) => `${race.id}(${race.name})`).join("、")}`,
    `职业：${openClasses.map((job) => `${job.id}(${job.name})`).join("、")}`,
    `性别：${Object.values(DEFAULT_MMORPG_CONTENT.genders).map((gender) => `${gender.id}(${gender.name})`).join("、")}`,
    "外貌：自由文本描述，命令行中可用下划线代替空格。",
    "个人宣言：可选，后续可随时修改。",
    `变更种族需要 ${MMORPG_RULEBOOK.economy.raceChangeItemId}，变更性别需要 ${MMORPG_RULEBOOK.economy.genderChangeItemId}，变更外貌需要 ${MMORPG_RULEBOOK.economy.appearanceChangeItemId}。`,
    `15 级前可自由更换职业（隐藏/限定职业需满足特殊条件）；结婚需要 ${MMORPG_RULEBOOK.economy.marriageRingItemId}。`,
  ].join("\n");
}

export function buildCreateOptionsMenu(): PendingMenu {
  const races = Object.values(DEFAULT_MMORPG_CONTENT.races);
  const openClasses = Object.values(DEFAULT_MMORPG_CONTENT.classes)
    .filter((j) => !j.requiredRebirths && !j.unlockQuestId);
  const genders = Object.values(DEFAULT_MMORPG_CONTENT.genders);
  return {
    title: "角色创建指南",
    context: `种族 ${races.length} 种 · 职业 ${openClasses.length} 种 · 性别 ${genders.length} 种`,
    groups: [
      {
        label: `种族 (${races.length})`,
        category: "interact",
        items: races.map((r) => ({
          label: `${r.name} (${r.id})`,
          description: r.traitSummary,
          action: { type: "noop" },
        })),
      },
      {
        label: `职业 (${openClasses.length}) — 隐藏/限定职业不在此列出`,
        category: "combat",
        items: openClasses.map((c) => ({
          label: `${c.name} (${c.id})`,
          description: c.description,
          action: { type: "noop" },
        })),
      },
      {
        label: "性别",
        category: "system",
        items: genders.map((g) => ({
          label: `${g.name} (${g.id})`,
          description: g.description,
          action: { type: "noop" },
        })),
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

export function buildFieldErrorMenu(fieldLabel: string, rawValue: string, suggestions: string[]): PendingMenu {
  return {
    title: `「${fieldLabel}」无效`,
    context: `你输入的值：${rawValue}`,
    groups: [
      {
        label: `可用的 ${fieldLabel} 选项`,
        category: "interact",
        items: suggestions.map((s) => ({
          label: s,
          action: { type: "noop" },
        })),
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

export function formatMMOInventory(player: PlayerState): string {
  if (player.inventory.length === 0 && player.fishBasket.length === 0) {
    return "MMORPG 背包为空。";
  }
  return [
    "MMORPG 背包：",
    ...(player.inventory.length > 0
      ? player.inventory.map((entry) => `- ${describeItem(entry.itemId)} x${entry.quantity}`)
      : ["- 常规物品：无"]),
    `- 鱼篓数量：${player.fishBasket.length}（使用 mmo-fish-basket 查看详情）`,
  ].join("\n");
}

export function formatFishBasket(player: PlayerState, options: { compact?: boolean } = {}): string {
  const lines: string[] = [formatFishingStatusText(player)];
  if (player.fishBasket.length === 0) {
    lines.push("鱼篓为空。");
    return lines.join("\n");
  }

  const totalValue = player.fishBasket.reduce((sum, fish) => sum + fish.price, 0);
  lines.push(`鱼篓里共有 ${player.fishBasket.length} 条鱼，估值 ${totalValue} 金币。`);
  if (options.compact) {
    lines.push(...player.fishBasket.slice(0, 5).map((fish) => `- ${formatFishCatch(fish, { withId: false })}`));
    if (player.fishBasket.length > 5) {
      lines.push(`- 其余 ${player.fishBasket.length - 5} 条请使用 mmo-fish-basket 查看。`);
    }
    return lines.join("\n");
  }

  lines.push(...player.fishBasket.map((fish) => `- ${formatFishCatch(fish)}`));
  lines.push("使用 mmo-fish-sell <fishId|all> 可以出售鱼获。");
  return lines.join("\n");
}

export function formatQuestStatus(quest: QuestDef, progress: QuestProgress): string {
  return [
    `- ${quest.name}(${quest.id}) [${progress.status}]`,
    `  ${quest.description}`,
    `  目标：${formatQuestObjectives(quest, progress)}`,
  ].join("\n");
}

export function formatQuestObjectives(quest: QuestDef, progress: QuestProgress): string {
  return quest.objectives.map((objective) => {
    const count = progress.counters[getObjectiveKey(objective)] ?? 0;
    const target = getObjectiveTarget(objective);
    return `${describeObjective(objective)} ${count}/${target}`;
  }).join("；");
}

export function formatConnectedAreaNames(area: AreaDef): string {
  if (area.connectedAreaIds.length === 0) {
    return "无";
  }
  return area.connectedAreaIds.map((areaId) => describeArea(areaId)).join("、");
}

/**
 * Format connected area names annotated with their 1-based menu index.
 * Falls back to plain describeArea when the index is not available.
 */
export function formatConnectedAreaNamesWithIndices(area: AreaDef, indexMap: Map<string, number>): string {
  if (area.connectedAreaIds.length === 0) return "无";
  return area.connectedAreaIds.map((areaId) => {
    const a = DEFAULT_MMORPG_CONTENT.areas[areaId];
    const name = a ? a.name : areaId;
    const idx = indexMap.get(areaId);
    return idx !== undefined ? `${name}(序号${idx})` : describeArea(areaId);
  }).join("、");
}

export function formatAreaSummary(area: AreaDef): string {
  const npcText = area.npcIds.length > 0
    ? area.npcIds.map((npcId) => describeNpc(npcId)).join("、")
    : "无";
  const monsterText = area.monsterIds.length > 0
    ? area.monsterIds.map((monsterId) => describeMonster(monsterId)).join("、")
    : "无";
  const resourceText = area.resourceNodeIds.length > 0
    ? area.resourceNodeIds.map((nodeId) => describeResourceNode(nodeId)).join("、")
    : "无";
  const questText = area.questIds.length > 0
    ? area.questIds.map((questId) => describeQuest(questId)).join("、")
    : "无";
  const factionText = area.factionId ? describeFaction(area.factionId) : "无";
  const fishText = Object.values(DEFAULT_MMORPG_CONTENT.fishSpecies)
    .filter((species) => species.habitatAreaIds.includes(area.id))
    .map((species) => describeFishSpecies(species.id))
    .join("、") || "无";

  return [
    `当前位置：${area.name}（${area.id}）`,
    `描述：${area.description}`,
    `推荐等级：${area.recommendedLevel[0]}-${area.recommendedLevel[1]}`,
    `所属阵营：${factionText}`,
    `可前往：${formatConnectedAreaNames(area)}`,
    `NPC：${npcText}`,
    `怪物：${monsterText}`,
    `资源点：${resourceText}`,
    `可钓鱼种：${fishText}`,
    `区域任务：${questText}`,
  ].join("\n");
}

export function formatWorldMapOverview(): string {
  return [
    "世界地图：",
    ...Object.values(DEFAULT_MMORPG_CONTENT.areas).map((area) => `- ${area.id} (${area.name}) -> ${formatConnectedAreaNames(area)}`),
  ].join("\n");
}
