import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import {
  MMORPG_RULEBOOK,
  affinityToPercent,
  getExpRequiredForLevel,
  getMaxResources,
} from "../rulebook.js";
import type {
  MenuGroup,
  NpcDef,
  PartyState,
  PendingMenu,
  PendingMenuItem,
  PlayerState,
  StatBlock,
} from "../schema.js";
import {
  describeArea,
  describeProfession,
} from "./descriptions.js";
import { formatPercent } from "./utils.js";
import { formatQuestObjectives } from "./format.js";
import { rt } from "./runtime.js";
import {
  requireArea,
  getExistingPlayer,
  getQuestProgress,
} from "./player-access.js";
import {
  resolvePartyForPlayer,
} from "./economy.js";
import {
  getLocalAvailableQuests,
  canAcceptQuest,
} from "./quest.js";
import {
  describeInstanceOrItem,
  getPlayerEffectiveStats,
  calculatePlayerCombatPower,
} from "./stats.js";
import { getActiveBonuses } from "./progression.js";

/**
 * 菜单构建与社交状态格式化（依赖层级 5）。
 */

export function buildLocationMenu(player: PlayerState): PendingMenu {
  const area = requireArea(player.areaId);
  const groups: MenuGroup[] = [];

  // Move
  const moveItems: PendingMenuItem[] = [];
  for (const areaId of area.connectedAreaIds) {
    const a = DEFAULT_MMORPG_CONTENT.areas[areaId];
    if (a) moveItems.push({ label: a.name, description: `Lv.${a.recommendedLevel[0]}-${a.recommendedLevel[1]}`, action: { type: "move", targetId: areaId } });
  }
  // 快捷移动：返回初始之地
  if (player.areaId !== rt.STARTER_AREA_ID && !area.connectedAreaIds.includes(rt.STARTER_AREA_ID)) {
    const starter = requireArea(rt.STARTER_AREA_ID);
    moveItems.push({ label: `返回${starter.name}`, description: "安全区域，HP 完全恢复", action: { type: "move", targetId: rt.STARTER_AREA_ID } });
  }
  // 快捷移动：拾回掉落金币
  if (player.deathMarker && player.deathMarker.areaId !== player.areaId) {
    moveItems.push({ label: "拾回掉落金币", description: `前往${describeArea(player.deathMarker.areaId)}`, action: { type: "recover_gold" } });
  }
  if (moveItems.length) groups.push({ label: "移动", category: "move", items: moveItems });

  // Combat
  const combatItems: PendingMenuItem[] = [];
  for (const monsterId of area.monsterIds) {
    const m = DEFAULT_MMORPG_CONTENT.monsters[monsterId];
    if (m) combatItems.push({ label: m.name, description: `Lv.${m.level}`, action: { type: "hunt", targetId: monsterId } });
  }
  if (combatItems.length) groups.push({ label: "战斗", category: "combat", items: combatItems });

  // NPC
  const npcItems: PendingMenuItem[] = [];
  for (const npcId of area.npcIds) {
    const n = DEFAULT_MMORPG_CONTENT.npcs[npcId];
    if (n) {
      const hasQuests = n.offeredQuestIds.length > 0;
      npcItems.push({ label: hasQuests ? `❗${n.name}` : n.name, description: n.role, action: { type: "talk", targetId: npcId } });
    }
  }
  if (npcItems.length) groups.push({ label: "NPC", category: "talk", items: npcItems });

  // Interact (gather, fish, dungeon)
  const interactItems: PendingMenuItem[] = [];
  for (const nodeId of area.resourceNodeIds) {
    const n = DEFAULT_MMORPG_CONTENT.resourceNodes[nodeId];
    if (n) interactItems.push({ label: `采集 ${n.name}`, description: describeProfession(n.professionId), action: { type: "gather", targetId: nodeId } });
  }
  const hasFish = Object.values(DEFAULT_MMORPG_CONTENT.fishSpecies).some((s) => s.habitatAreaIds.includes(area.id));
  if (hasFish) interactItems.push({ label: "钓鱼", action: { type: "fish" } });
  for (const dungeonId of Object.keys(DEFAULT_MMORPG_CONTENT.dungeons)) {
    const d = DEFAULT_MMORPG_CONTENT.dungeons[dungeonId];
    if (d?.areaId === area.id) interactItems.push({ label: d.name, description: `Lv.${d.requiredLevel}+`, action: { type: "enter_dungeon", targetId: dungeonId } });
  }
  if (interactItems.length) groups.push({ label: "互动", category: "interact", items: interactItems });

  // Quest
  const questItems: PendingMenuItem[] = [];
  const available = getLocalAvailableQuests(player);
  for (const q of available) {
    questItems.push({ label: q.name, description: `Lv.${q.requiredLevel}`, action: { type: "accept_quest", targetId: q.id } });
  }
  if (questItems.length) groups.push({ label: "任务", category: "quest", items: questItems });

  // System sub-menu entries
  const sysItems: PendingMenuItem[] = [];
  if (player.inventory.length > 0) sysItems.push({ label: "背包管理", action: { type: "open_bag" } });
  sysItems.push({ label: "装备管理", action: { type: "open_equip" } });
  sysItems.push({ label: "技能 / 公会 / 成就", action: { type: "open_skills" } });
  groups.push({ label: "系统", category: "system", items: sysItems });

  return {
    context: `Lv.${area.recommendedLevel[0]}-${area.recommendedLevel[1]}`,
    title: area.name,
    groups,
    createdAt: new Date().toISOString(),
  };
}

export function buildNpcMenu(player: PlayerState, npc: NpcDef): PendingMenu {
  const groups: MenuGroup[] = [];
  const talkItems: PendingMenuItem[] = [
    { label: "对话", description: "与 NPC 交谈", action: { type: "talk", targetId: npc.id } },
  ];
  if (npc.shopItemIds.length > 0) {
    talkItems.push({ label: "打开商店", description: `${npc.shopItemIds.length}种物品`, action: { type: "buy", targetId: npc.id } });
  }
  groups.push({ label: "互动", category: "talk", items: talkItems });

  const questItems: PendingMenuItem[] = [];
  for (const questId of npc.offeredQuestIds) {
    const quest = DEFAULT_MMORPG_CONTENT.quests[questId];
    if (!quest) continue;
    const existing = getQuestProgress(player, questId);
    if (!existing && canAcceptQuest(player, quest).ok) {
      questItems.push({ label: quest.name, description: `Lv.${quest.requiredLevel}`, action: { type: "accept_quest", targetId: questId } });
    }
    if (existing?.status === "active") {
      // Surface in-progress objectives so the player knows how far along they are.
      questItems.push({
        label: `进行中：${quest.name}`,
        description: formatQuestObjectives(quest, existing),
        action: { type: "noop" },
      });
    }
    if (existing?.status === "completed") {
      questItems.push({ label: `✅ 交付：${quest.name}`, description: "任务已完成，点击交付", action: { type: "turn_in_quest", targetId: questId } });
    }
  }
  if (questItems.length) groups.push({ label: "任务", category: "quest", items: questItems });

  return { context: npc.role, title: npc.name, groups, createdAt: new Date().toISOString() };
}

export function buildBagMenu(player: PlayerState): PendingMenu {
  const groups: MenuGroup[] = [];
  const equipItems: PendingMenuItem[] = [];
  const consumItems: PendingMenuItem[] = [];
  const sellItems: PendingMenuItem[] = [];
  for (const entry of player.inventory) {
    const item = DEFAULT_MMORPG_CONTENT.items[entry.itemId];
    if (!item) continue;

    const label = entry.instanceId ? describeInstanceOrItem(player, entry.instanceId) : item.name;
    const targetId = entry.instanceId || entry.itemId;

    if (item.equipSlot) {
      equipItems.push({ label, description: item.equipSlot, action: { type: "equip", targetId } });
    }
    if (item.category === "consumable") {
      consumItems.push({ label, description: `x${entry.quantity}`, action: { type: "use_item", targetId } });
    }
    if (item.sellPrice && item.sellPrice > 0 && !item.equipSlot && item.category !== "consumable" && item.category !== "quest") {
      sellItems.push({ label, description: `x${entry.quantity} · ${item.sellPrice}g/个`, action: { type: "sell", targetId } });
    }
  }
  if (equipItems.length) groups.push({ label: "可装备", category: "interact", items: equipItems });
  if (consumItems.length) groups.push({ label: "消耗品", category: "interact", items: consumItems });
  if (sellItems.length) groups.push({ label: "可出售", category: "interact", items: sellItems });

  const unequipItems: PendingMenuItem[] = [];
  for (const [slot, idOrInstanceId] of Object.entries(player.equipment)) {
    if (idOrInstanceId) {
      unequipItems.push({ label: describeInstanceOrItem(player, idOrInstanceId), description: slot, action: { type: "unequip", targetId: slot } });
    }
  }
  for (const [slot, idOrInstanceId] of Object.entries(player.fashionEquipment ?? {})) {
    if (idOrInstanceId) {
      unequipItems.push({ label: `🌟${describeInstanceOrItem(player, idOrInstanceId)}`, description: `时装-${slot}`, action: { type: "unequip", targetId: slot } });
    }
  }
  if (unequipItems.length) groups.push({ label: "已装备 - 卸下", category: "system", items: unequipItems });

  return { context: `${player.inventory.length}件 · ${player.currencies.gold}g`, title: "背包", groups, createdAt: new Date().toISOString() };
}

export function buildQuestMenu(player: PlayerState): PendingMenu {
  const groups: MenuGroup[] = [];
  const active = player.questLog.filter((e) => e.status === "active" || e.status === "completed");
  const activeItems: PendingMenuItem[] = [];
  for (const entry of active) {
    const quest = DEFAULT_MMORPG_CONTENT.quests[entry.questId];
    if (!quest) continue;
    activeItems.push({
      label: quest.name,
      description: entry.status === "completed" ? "可交付 ✓" : formatQuestObjectives(quest, entry),
      action: entry.status === "completed" ? { type: "turn_in_quest", targetId: quest.id } : { type: "noop" },
    });
  }
  if (activeItems.length) groups.push({ label: "进行中", category: "quest", items: activeItems });

  const localItems: PendingMenuItem[] = [];
  for (const quest of getLocalAvailableQuests(player)) {
    localItems.push({ label: quest.name, description: `Lv.${quest.requiredLevel}`, action: { type: "accept_quest", targetId: quest.id } });
  }
  if (localItems.length) groups.push({ label: "本区域可接", category: "quest", items: localItems });

  const turnedIn = player.questLog.filter((e) => e.status === "turned_in").length;
  return { context: `${active.length}进行中 · ${turnedIn}已交付`, title: "任务日志", groups, createdAt: new Date().toISOString() };
}

export function buildEquipMenu(player: PlayerState): PendingMenu {
  const groups: MenuGroup[] = [];
  const equipItems: PendingMenuItem[] = [];
  for (const entry of player.inventory) {
    const item = DEFAULT_MMORPG_CONTENT.items[entry.itemId];
    if (!item?.equipSlot) continue;
    const label = entry.instanceId ? describeInstanceOrItem(player, entry.instanceId) : item.name;
    const targetId = entry.instanceId || entry.itemId;
    equipItems.push({ label, description: `${item.equipSlot} · x${entry.quantity}`, action: { type: "equip", targetId } });
  }
  if (equipItems.length) groups.push({ label: "可装备", category: "interact", items: equipItems });

  const unequipItems: PendingMenuItem[] = [];
  for (const [slot, idOrInstanceId] of Object.entries(player.equipment)) {
    if (!idOrInstanceId) continue;
    unequipItems.push({ label: describeInstanceOrItem(player, idOrInstanceId), description: slot, action: { type: "unequip", targetId: slot } });
  }
  for (const [slot, idOrInstanceId] of Object.entries(player.fashionEquipment ?? {})) {
    if (!idOrInstanceId) continue;
    unequipItems.push({ label: `🌟${describeInstanceOrItem(player, idOrInstanceId)}`, description: `时装-${slot}`, action: { type: "unequip", targetId: slot } });
  }
  if (unequipItems.length) groups.push({ label: "已装备 - 卸下", category: "system", items: unequipItems });

  return { context: "装备管理", title: "装备", groups, createdAt: new Date().toISOString() };
}

export function flattenMenuGroups(groups: MenuGroup[]): PendingMenuItem[] {
  const result: PendingMenuItem[] = [];
  for (const g of groups) for (const item of g.items) result.push(item);
  return result;
}

export function buildProfileDetails(player: PlayerState): Array<{ label: string; value: string }> {
  const race = DEFAULT_MMORPG_CONTENT.races[player.raceId];
  const cls = DEFAULT_MMORPG_CONTENT.classes[player.classId];
  const gender = DEFAULT_MMORPG_CONTENT.genders[player.genderId];
  const slotLabel: Record<string, string> = { weapon: "武器", offhand: "副手", head: "头部", body: "身体", legs: "腿部", accessory: "饰品" };
  const eqEntries = Object.entries(player.equipment).filter(([, id]) => id);
  const fashionEntries = Object.entries(player.fashionEquipment ?? {}).filter(([, id]) => id);
  const expNeeded = getExpRequiredForLevel(player.level);
  const eff = getPlayerEffectiveStats(player);
  const effRes = getMaxResources(eff);
  const formatStat = (key: keyof StatBlock) => {
    const base = player.stats[key];
    const bonus = eff[key] - base;
    return bonus > 0 ? `${base} (+${bonus})` : `${base}`;
  };
  return [
    { label: "种族", value: race?.name ?? player.raceId },
    { label: "职业", value: cls?.name ?? player.classId },
    { label: "性别", value: gender?.name ?? player.genderId },
    { label: "位置", value: describeArea(player.areaId) },
    { label: "经验", value: `${player.exp}/${expNeeded}` },
    { label: "HP", value: `${player.resources.hp}/${effRes.maxHp}` },
    { label: "Focus", value: `${player.resources.focus}/${effRes.maxFocus}` },
    { label: "Stamina", value: `${player.resources.stamina}/${effRes.maxStamina}` },
    { label: "力量", value: formatStat("strength") },
    { label: "防御", value: formatStat("defense") },
    { label: "魅力", value: formatStat("charm") },
    { label: "敏捷", value: formatStat("agility") },
    { label: "口才", value: formatStat("eloquence") },
    { label: "耐力", value: formatStat("endurance") },
    { label: "生命", value: formatStat("life") },
    { label: "金币", value: String(player.currencies.gold) },
    { label: "战力", value: String(calculatePlayerCombatPower(player)) },
    ...eqEntries.map(([slot, id]) => ({
      label: slotLabel[slot] ?? slot,
      value: describeInstanceOrItem(player, id!),
    })),
    ...fashionEntries.map(([slot, id]) => ({
      label: `时装·${slotLabel[slot] ?? slot}`,
      value: describeInstanceOrItem(player, id!),
    })),
  ];
}

export function buildProfileMenu(player: PlayerState): PendingMenu {
  const slotLabel: Record<string, string> = { weapon: "武器", offhand: "副手", head: "头部", body: "身体", legs: "腿部", accessory: "饰品" };
  const equipItems = Object.entries(player.equipment).filter(([, id]) => id).map(([slot, id]) => {
    const baseId = player.itemInstances?.[id!]?.itemId ?? id!;
    return {
      label: describeInstanceOrItem(player, id!),
      description: slotLabel[slot],
      action: { type: "view_item" as const, targetId: id!, extra: { itemId: baseId } },
    };
  });
  const fashionItems = Object.entries(player.fashionEquipment ?? {}).filter(([, id]) => id).map(([slot, id]) => {
    const baseId = player.itemInstances?.[id!]?.itemId ?? id!;
    return {
      label: describeInstanceOrItem(player, id!),
      description: `时装·${slotLabel[slot]}`,
      action: { type: "view_item" as const, targetId: id!, extra: { itemId: baseId } },
    };
  });
  const groups: MenuGroup[] = [
    { label: "角色", category: "interact", items: [
      { label: "背包管理", action: { type: "open_bag" } },
      { label: "装备管理", action: { type: "open_equip" } },
      { label: "技能列表", action: { type: "open_skills" } },
    ] },
    { label: "社交", category: "quest", items: [
      { label: "公会系统", action: { type: "open_guild" } },
      { label: "成就列表", action: { type: "open_achievements" } },
      { label: "任务日志", action: { type: "open_quest_log" } },
    ] },
    { label: "世界", category: "system", items: [
      { label: "当前位置", action: { type: "back" } },
    ] },
  ];
  if (equipItems.length > 0) {
    groups.push({ label: "装备", category: "interact", items: equipItems });
  }
  if (fashionItems.length > 0) {
    groups.push({ label: "时装", category: "interact", items: fashionItems });
  }
  const race = DEFAULT_MMORPG_CONTENT.races[player.raceId];
  const cls = DEFAULT_MMORPG_CONTENT.classes[player.classId];
  return {
    context: `Lv.${player.level}${player.rebirthCount > 0 ? ` 轮回${player.rebirthCount}` : ""}`,
    title: `${race?.name ?? ""} ${cls?.name ?? ""}`.trim() || player.userId,
    groups,
    createdAt: new Date().toISOString(),
  };
}

export function formatMarriageStatus(player: PlayerState): string {
  if (!player.marriage) {
    return [
      "当前未婚。",
      `结婚条件：双方达到 ${MMORPG_RULEBOOK.social.marriageRequiredLevel} 级，互相亲密度达到 ${affinityToPercent(MMORPG_RULEBOOK.social.marriageRequiredAffinity)}，并持有誓约戒指。`,
    ].join("\n");
  }

  const bonus = getActiveBonuses(player);
  const spouseInSameParty = resolvePartyForPlayer(player)?.memberUserIds.includes(player.marriage.spouseUserId) ?? false;
  return [
    `配偶：${player.marriage.spouseUserId}`,
    `结婚时间：${new Date(player.marriage.marriedAt).toLocaleString("zh-CN", { hour12: false })}`,
    `当前婚姻加成：经验 +${formatPercent(spouseInSameParty ? MMORPG_RULEBOOK.marriage.partyBonusRate : MMORPG_RULEBOOK.marriage.baseBonusRate)}，金币 +${formatPercent(spouseInSameParty ? MMORPG_RULEBOOK.marriage.partyBonusRate : MMORPG_RULEBOOK.marriage.baseBonusRate)}`,
    `当前总加成：经验 +${formatPercent(bonus.expRate)}，金币 +${formatPercent(bonus.goldRate)}`,
  ].join("\n");
}

export function formatPartyStatus(party: PartyState): string {
  const members = party.memberUserIds.map((userId) => getExistingPlayer(userId)).filter(Boolean) as PlayerState[];
  const leader = getExistingPlayer(party.leaderUserId);
  const distinctClasses = new Set(members.map((member) => member.classId)).size;
  const spousePairs = members.filter((member) => member.marriage && party.memberUserIds.includes(member.marriage.spouseUserId)).length / 2;
  const bonus = members[0] ? getActiveBonuses(members[0]) : { expRate: 0, goldRate: 0 };

  return [
    `队伍 ${party.id}`,
    `队长：${leader?.userId ?? party.leaderUserId}`,
    `成员：${party.memberUserIds.join("、")}`,
    `阵型：${party.formation}`,
    `目标：${party.objective ?? "未设置"}`,
    `职业多样性：${distinctClasses}`,
    `夫妻同队对数：${spousePairs}`,
    `当前示例加成：经验 +${formatPercent(bonus.expRate)}，金币 +${formatPercent(bonus.goldRate)}`,
    "设计规则：每多 1 名队友提供额外经验/金币加成，不同职业组合提供额外经验加成；夫妻同队时婚姻加成提升到 30%。",
  ].join("\n");
}
