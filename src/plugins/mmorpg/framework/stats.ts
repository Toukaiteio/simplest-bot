import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import {
  MMORPG_RULEBOOK,
  createBaseStats,
  getExpRequiredForLevel,
  getMaxResources,
} from "../rulebook.js";
import type {
  ClassDef,
  ItemDef,
  PlayerState,
  SkillDef,
  StatBlock,
} from "../schema.js";
import { describeArea } from "./descriptions.js";
import { requireRace, getQuestProgress } from "./player-access.js";

/**
 * 属性计算、战力评估、角色档案格式化（依赖层级 2）。
 * 纯计算逻辑 + 对玩家状态只读，无写入副作用。
 */

export function buildCharacterStats(raceId: string, classDef: ClassDef, level: number, rebirthBonus?: StatBlock): StatBlock {
  const race = requireRace(raceId);
  const classBase = createBaseStats(classDef.id);
  const result = {} as StatBlock;
  for (const key of Object.keys(race.baseStats) as Array<keyof StatBlock>) {
    const base = race.baseStats[key] + classBase[key];
    const multiplier = classDef.growthMultipliers[key] ?? 1;
    const growthBonus = Math.floor(Math.max(0, level - 1) * multiplier);
    result[key] = base + growthBonus + (rebirthBonus?.[key] ?? 0);
  }
  return result;
}

export function assertClassUnlocked(classDef: ClassDef, player: PlayerState): void {
  if (classDef.requiredRebirths && player.rebirthCount < classDef.requiredRebirths) {
    throw new Error(`该职业需要至少 ${classDef.requiredRebirths} 次轮回才能解锁（当前 ${player.rebirthCount} 次）。`);
  }
  if (classDef.unlockQuestId) {
    const progress = getQuestProgress(player, classDef.unlockQuestId);
    if (progress?.status !== "turned_in") {
      throw new Error(`该职业需要完成隐藏任务「${classDef.unlockQuestId}」后才能解锁，请先完成任务。`);
    }
  }
}

export function getBaseItemId(player: PlayerState, idOrInstanceId: string): string {
  if (player.itemInstances && player.itemInstances[idOrInstanceId]) {
    return player.itemInstances[idOrInstanceId].itemId;
  }
  return idOrInstanceId;
}

export function getDefaultBasePower(level: number): number {
  if (level <= 0) return 1;
  if (level <= 50) return Math.round(8 + (level - 1) * 0.3);
  if (level <= 100) return Math.round(23 + (level - 50) * 0.4);
  if (level <= 150) return Math.round(43 + (level - 100) * 0.6);
  if (level <= 300) return Math.round(73 + (level - 150) * 1.0);
  if (level <= 500) return Math.round(223 + (level - 300) * 1.5);
  if (level <= 800) return Math.round(523 + (level - 500) * 2.5);
  return Math.round(1273 + (level - 800) * 4);
}

export function getItemBaseStats(item: ItemDef): StatBlock {
  const stats: StatBlock = { strength: 0, defense: 0, charm: 0, agility: 0, eloquence: 0, endurance: 0, life: 0 };
  const baseValue = item.basePower ?? getDefaultBasePower(item.requiredLevel ?? 1);

  const itemId = item.id.toLowerCase();
  const isMagic = itemId.includes("staff") || itemId.includes("rod") || itemId.includes("wand") ||
    itemId.includes("focus") || itemId.includes("robe") || itemId.includes("crown") ||
    itemId.includes("pendant") || itemId.includes("amulet") || itemId.includes("ring");

  if (item.equipSlot === "weapon") {
    if (isMagic) {
      stats.eloquence = Math.round(baseValue * 0.7);
      stats.charm = Math.round(baseValue * 0.3);
    } else {
      stats.strength = Math.round(baseValue * 1.0);
    }
  } else if (item.equipSlot === "offhand") {
    stats.defense = Math.round(baseValue * 0.3);
    stats.endurance = Math.round(baseValue * 0.2);
  } else if (item.equipSlot === "head" || item.equipSlot === "body" || item.equipSlot === "legs") {
    stats.defense = Math.round(baseValue * 0.2);
    stats.endurance = Math.round(baseValue * 0.15);
    stats.life = Math.round(baseValue * 0.1);
  } else if (item.equipSlot === "accessory") {
    stats.charm = Math.round(baseValue * 0.4);
    stats.eloquence = Math.round(baseValue * 0.4);
    stats.agility = Math.round(baseValue * 0.2);
  }
  return stats;
}

export function getPlayerEffectiveStats(player: PlayerState): StatBlock {
  const effective = { ...player.stats };
  if (!player.itemInstances) player.itemInstances = {};

  for (const [slot, idOrInstanceId] of Object.entries(player.equipment)) {
    if (!idOrInstanceId) continue;

    let baseItemId = idOrInstanceId;
    let enhancement = 0;
    let rarity: "common" | "uncommon" | "rare" | "epic" | "legendary" = "common";
    let substats: StatBlock = { strength: 0, defense: 0, charm: 0, agility: 0, eloquence: 0, endurance: 0, life: 0 };

    const instance = player.itemInstances[idOrInstanceId];
    if (instance) {
      baseItemId = instance.itemId;
      enhancement = instance.enhancement ?? 0;
      rarity = instance.rarity ?? "common";
      substats = instance.substats ?? substats;
    }

    const item = DEFAULT_MMORPG_CONTENT.items[baseItemId];
    if (!item) continue;

    if (item.requiredLevel !== undefined && player.level < item.requiredLevel) continue;

    const baseStats = getItemBaseStats(item);

    if (item.category === "fashion") {
      const FASHION_CHARM_CAP = 95;
      const FASHION_STAT_CAP = 50;
      for (const key of Object.keys(effective) as Array<keyof StatBlock>) {
        if (key === "charm") {
          effective[key] += Math.min(baseStats[key], FASHION_CHARM_CAP);
        } else {
          effective[key] += Math.min(Math.round(baseStats[key] * 0.2), FASHION_STAT_CAP);
        }
      }
      effective.charm += 5;
      continue;
    }

    let rarityMult = 1.0;
    if (rarity === "uncommon") rarityMult = 1.1;
    else if (rarity === "rare") rarityMult = 1.25;
    else if (rarity === "epic") rarityMult = 1.45;
    else if (rarity === "legendary") rarityMult = 1.7;

    const enhancementMult = 1.0 + enhancement * 0.2;

    for (const key of Object.keys(effective) as Array<keyof StatBlock>) {
      effective[key] += Math.round(baseStats[key] * rarityMult * enhancementMult);
      effective[key] += substats[key] ?? 0;
    }
  }

  for (const [slot, idOrInstanceId] of Object.entries(player.fashionEquipment ?? {})) {
    if (!idOrInstanceId) continue;

    let baseItemId = idOrInstanceId;
    const instance = player.itemInstances?.[idOrInstanceId];
    if (instance) baseItemId = instance.itemId;

    const item = DEFAULT_MMORPG_CONTENT.items[baseItemId];
    if (!item || item.category !== "fashion") continue;

    if (item.requiredLevel !== undefined && player.level < item.requiredLevel) continue;

    const baseStats = getItemBaseStats(item);
    const FASHION_CHARM_CAP = 95;
    const FASHION_STAT_CAP = 50;
    for (const key of Object.keys(effective) as Array<keyof StatBlock>) {
      if (key === "charm") {
        effective[key] += Math.min(baseStats[key], FASHION_CHARM_CAP);
      } else {
        effective[key] += Math.min(Math.round(baseStats[key] * 0.2), FASHION_STAT_CAP);
      }
    }
    effective.charm += 5;
  }

  return effective;
}

export function statsFrom(player: PlayerState): StatBlock {
  return getPlayerEffectiveStats(player);
}

export function calculatePlayerCombatPower(player: PlayerState): number {
  const eff = getPlayerEffectiveStats(player);
  const physical = eff.strength * MMORPG_RULEBOOK.combat.attackPowerPerStrength;
  const defense = eff.defense * MMORPG_RULEBOOK.combat.defensePowerPerDefense;
  const social = eff.charm * MMORPG_RULEBOOK.combat.socialPowerPerCharm;
  const utility = eff.eloquence * MMORPG_RULEBOOK.combat.negotiationPowerPerEloquence;
  const mobility = eff.agility * 1.5;
  const sustain = eff.endurance * 2 + eff.life * 2;
  return Math.round(player.level * 10 + physical + defense + social + utility + mobility + sustain);
}

export function formatItemDetail(player: PlayerState, itemId: string): string {
  const item = DEFAULT_MMORPG_CONTENT.items[itemId];
  if (!item) return "未知物品。";

  const lines: string[] = [
    `📦 ${item.name}（${item.id}）`,
    `类别：${item.category}`,
    `描述：${item.description}`,
  ];

  if (item.equipSlot) {
    const slotLabel: Record<string, string> = { weapon: "武器", offhand: "副手", head: "头部", body: "身体", legs: "腿部", accessory: "饰品" };
    lines.push(`装备槽：${slotLabel[item.equipSlot] ?? item.equipSlot}`);
  }

  if (item.requiredLevel !== undefined) {
    lines.push(`需求等级：${item.requiredLevel}`);
  }

  if (item.allowedClasses && item.allowedClasses.length > 0) {
    const classNames = item.allowedClasses.map((cid) => {
      const cls = DEFAULT_MMORPG_CONTENT.classes[cid];
      return cls?.name ?? cid;
    }).join("、");
    lines.push(`职业限制：${classNames}`);
  } else if (item.equipSlot) {
    lines.push("职业限制：无");
  }

  if (item.sellPrice !== undefined) {
    const baseStats = getItemBaseStats(item);
    const statLabels: Record<string, string> = { strength: "力量", defense: "防御", charm: "魅力", agility: "敏捷", eloquence: "口才", endurance: "耐力", life: "生命" };
    const statParts: string[] = [];
    for (const [key, val] of Object.entries(baseStats)) {
      if (val > 0) statParts.push(`${statLabels[key] ?? key}+${val}`);
    }
    if (statParts.length > 0) lines.push(`基础属性：${statParts.join("、")}`);
    lines.push(`售价：${item.sellPrice} 金币`);
  }

  const qty = (() => {
    let count = 0;
    for (const entry of player.inventory) {
      if (entry.itemId === itemId) count += entry.quantity;
    }
    return count;
  })();
  lines.push(`持有：${qty}`);

  return lines.join("\n");
}

export function describeInstanceOrItem(player: PlayerState, idOrInstanceId: string): string {
  if (!player.itemInstances) player.itemInstances = {};
  const instance = player.itemInstances[idOrInstanceId];
  if (instance) {
    const item = DEFAULT_MMORPG_CONTENT.items[instance.itemId];
    if (!item) return idOrInstanceId;
    let rarityName = "";
    if (instance.rarity === "uncommon") rarityName = "优秀";
    else if (instance.rarity === "rare") rarityName = "精良";
    else if (instance.rarity === "epic") rarityName = "史诗";
    else if (instance.rarity === "legendary") rarityName = "传说";

    const rarityPrefix = rarityName ? `[${rarityName}] ` : "";
    const enhanceSuffix = instance.enhancement > 0 ? ` +${instance.enhancement}` : "";
    const suffixName = instance.suffix ?? "";

    // 经验瓶特殊展示：显示内含经验值
    if (instance.itemId === "exp_bottle" && instance.expAmount !== undefined) {
      return `${rarityPrefix}${item.name}${suffixName}（${instance.expAmount} 经验）`;
    }

    // 钱袋特殊展示：显示内含金币
    if (instance.itemId === "gold_bag" && instance.goldAmount !== undefined) {
      return `${rarityPrefix}${item.name}${suffixName}（${instance.goldAmount} 金币）`;
    }

    return `${rarityPrefix}${item.name}${suffixName}${enhanceSuffix}`;
  }
  const item = DEFAULT_MMORPG_CONTENT.items[idOrInstanceId];
  return item ? `${item.name}(${item.id})` : idOrInstanceId;
}

export function formatPlayerSnapshot(player: PlayerState, isNew = false): string {
  const prefix = isNew ? "新角色档案：" : "角色档案：";
  const marriageText = player.marriage ? `已婚（配偶 ${player.marriage.spouseUserId}）` : "未婚";
  const rebirthText = player.rebirthCount > 0 ? `轮回次数：${player.rebirthCount}/${MMORPG_RULEBOOK.rebirth.maxRebirths}` : undefined;
  const deathText = player.deathMarker
    ? `\n⚠️ 你上次在 ${describeArea(player.deathMarker.areaId)} 阵亡，掉落 ${player.deathMarker.goldDropped} 金币。使用 mmo-recover 前往拾回。`
    : "";

  const effectiveStats = getPlayerEffectiveStats(player);
  const formatStat = (key: keyof StatBlock) => {
    const base = player.stats[key];
    const bonus = effectiveStats[key] - base;
    return bonus > 0 ? `${base} (+${bonus})` : `${base}`;
  };

  const effMaxRes = getMaxResources(effectiveStats);

  const SLOT_LABELS: Record<string, string> = { weapon: "武器", offhand: "副手", head: "头部", body: "身体", legs: "腿部", accessory: "饰品" };
  const ALL_SLOTS = ["weapon", "offhand", "head", "body", "legs", "accessory"] as const;
  const equipLines = ALL_SLOTS.map((slot) => {
    const id = player.equipment[slot];
    return `  ${SLOT_LABELS[slot]}：${id ? describeInstanceOrItem(player, id) : "—"}`;
  });
  const fashionEntries = Object.entries(player.fashionEquipment ?? {}).filter(([, id]) => id);
  const fashionLine = `时装：${fashionEntries.length > 0 ? fashionEntries.map(([, id]) => describeInstanceOrItem(player, id!)).join("、") : "无"}`;

  return [
    prefix,
    `用户：${player.userId}`,
    `种族 / 职业 / 性别：${player.raceId} / ${player.classId} / ${player.genderId}`,
    `外貌：${player.appearance}`,
    `个人宣言：${player.personalDeclaration ?? "未设置"}`,
    `当前位置：${describeArea(player.areaId)}`,
    `等级：${player.level}（下一级所需经验 ${getExpRequiredForLevel(player.level)}）`,
    `属性：力量 ${formatStat("strength")}，防御 ${formatStat("defense")}，魅力 ${formatStat("charm")}，敏捷 ${formatStat("agility")}，口才 ${formatStat("eloquence")}，耐力 ${formatStat("endurance")}，生命 ${formatStat("life")}`,
    `资源：HP ${player.resources.hp}/${effMaxRes.maxHp}  Focus ${player.resources.focus}/${effMaxRes.maxFocus}  Stamina ${player.resources.stamina}/${effMaxRes.maxStamina}`,
    `装备：`,
    ...equipLines,
    fashionLine,
    `共享金币余额：${player.currencies.gold}（其中 MMORPG 累计产出 ${player.coinsEarnedFromMMO}）`,
    `婚姻状态：${marriageText}`,
    rebirthText,
    `战力评估：${calculatePlayerCombatPower(player)}`,
    "共享状态：该角色在所有群聊与私聊中共用同一份账号数据，金币也与 Bot 经济系统共用同一真实账户。",
    deathText,
  ].filter(Boolean).join("\n");
}

// ─────────────────────────────────────────────────────────
// 技能格式化辅助
// ─────────────────────────────────────────────────────────

const SKILL_CATEGORY_LABELS: Record<SkillDef["category"], string> = {
  active: "主动",
  passive: "被动",
  utility: "辅助",
};

const SCALING_STAT_LABELS: Record<keyof StatBlock, string> = {
  strength: "力量",
  defense: "防御",
  charm: "魅力",
  agility: "敏捷",
  eloquence: "口才",
  endurance: "耐力",
  life: "生命",
};

/** Format a skill's resource cost as a compact string (e.g. "Focus 10" / "Stamina 8, HP 5").
 *  Passive skills (empty cost) return "无消耗". */
export function formatSkillResourceCost(skill: SkillDef): string {
  const parts: string[] = [];
  const cost = skill.resourceCost ?? {};
  if (cost.hp && cost.hp > 0) parts.push(`HP ${cost.hp}`);
  if (cost.focus && cost.focus > 0) parts.push(`专注 ${cost.focus}`);
  if (cost.stamina && cost.stamina > 0) parts.push(`体力 ${cost.stamina}`);
  return parts.length > 0 ? parts.join("、") : "无消耗";
}

/** Format a skill's cooldown as a readable string. */
export function formatSkillCooldown(skill: SkillDef): string {
  if (skill.category === "passive") return "常驻";
  if (skill.cooldownTurns <= 0) return "无冷却";
  return `${skill.cooldownTurns} 回合`;
}

/** One-line summary for skill list rows (used in mmo-skills and open_skills menus). */
export function formatSkillSummary(skill: SkillDef): string {
  const category = SKILL_CATEGORY_LABELS[skill.category] ?? skill.category;
  const stat = SCALING_STAT_LABELS[skill.scalingStat] ?? String(skill.scalingStat);
  const cost = skill.category === "passive" ? "" : ` · ${formatSkillResourceCost(skill)}`;
  const cd = skill.category === "passive" ? "" : ` · CD ${formatSkillCooldown(skill)}`;
  return `${category} · ${stat}${cost}${cd}`;
}

/** Full multi-line detail for a single skill (used in view_skill action). */
export function formatSkillDetail(skill: SkillDef): string {
  const category = SKILL_CATEGORY_LABELS[skill.category] ?? skill.category;
  const stat = SCALING_STAT_LABELS[skill.scalingStat] ?? String(skill.scalingStat);
  return [
    `⚡ ${skill.name}（${skill.id}）`,
    `类型：${category}`,
    `缩放属性：${stat}`,
    `消耗：${formatSkillResourceCost(skill)}`,
    `冷却：${formatSkillCooldown(skill)}`,
    `描述：${skill.description}`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────
// 技能槽位
// ─────────────────────────────────────────────────────────

/** Compute a player's maximum number of skill slots (active/utility only; passives
 *  are always-on and don't consume slots). */
export function getMaxSkillSlots(player: PlayerState): number {
  const r = MMORPG_RULEBOOK.skillSlots;
  const fromLevel = Math.floor(player.level / r.extraSlotEveryLevel);
  const fromRebirth = player.rebirthCount * r.extraSlotPerRebirth;
  return Math.min(r.maxSlots, r.baseSlots + fromLevel + fromRebirth);
}

/** Side-by-side comparison of two skills for the compare command. */
export function formatSkillCompare(a: SkillDef, b: SkillDef): string {
  const catA = SKILL_CATEGORY_LABELS[a.category] ?? a.category;
  const catB = SKILL_CATEGORY_LABELS[b.category] ?? b.category;
  const statA = SCALING_STAT_LABELS[a.scalingStat] ?? String(a.scalingStat);
  const statB = SCALING_STAT_LABELS[b.scalingStat] ?? String(b.scalingStat);
  // Pad the left column so the two values align.
  const label = (s: string) => s.padEnd(8, "　");
  return [
    `技能对比`,
    `──────────────`,
    `${label("名称")}｜ ${a.name}  VS  ${b.name}`,
    `${label("ID")}｜ ${a.id}  VS  ${b.id}`,
    `${label("类型")}｜ ${catA}  VS  ${catB}`,
    `${label("缩放属性")}｜ ${statA}  VS  ${statB}`,
    `${label("消耗")}｜ ${formatSkillResourceCost(a)}  VS  ${formatSkillResourceCost(b)}`,
    `${label("冷却")}｜ ${formatSkillCooldown(a)}  VS  ${formatSkillCooldown(b)}`,
    `${label("描述")}｜`,
    `  A：${a.description}`,
    `  B：${b.description}`,
  ].join("\n");
}
