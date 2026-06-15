import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import type { PlayerState, SkillDef } from "../schema.js";
import { rt } from "./runtime.js";
import { savePlayer } from "./player-access.js";
import { getMaxSkillSlots } from "./stats.js";

/**
 * 技能槽位管理（依赖层级 2）。
 * 主动/辅助技能需装备到槽位才参与战斗；被动技能解锁即生效（不占槽位）。
 */

export type EquipSkillResult = {
  success: boolean;
  message: string;
};

/** Whether a skill is equipable into a slot (active/utility only — passives are always-on). */
export function isEquipableSkill(skill: SkillDef | undefined): boolean {
  return !!skill && skill.category !== "passive";
}

/** Skills the player has unlocked but NOT currently equipped. */
export function getUnequippedSkills(player: PlayerState): SkillDef[] {
  const equipped = new Set(player.equippedSkillIds);
  return player.unlockedSkillIds
    .filter((id) => !equipped.has(id))
    .map((id) => DEFAULT_MMORPG_CONTENT.skills[id])
    .filter((s): s is SkillDef => !!s && s.category !== "passive");
}

/** Equip a skill into the next free slot. Returns false if slots full or skill invalid. */
export function equipSkill(player: PlayerState, skillId: string): EquipSkillResult {
  const skill = DEFAULT_MMORPG_CONTENT.skills[skillId];
  if (!skill) return { success: false, message: `未知技能：${skillId}` };
  if (!isEquipableSkill(skill)) {
    return { success: false, message: `被动技能「${skill.name}」解锁即生效，无需装备。` };
  }
  if (!player.unlockedSkillIds.includes(skillId)) {
    return { success: false, message: `你尚未解锁技能「${skill.name}」。` };
  }
  if (player.equippedSkillIds.includes(skillId)) {
    return { success: false, message: `「${skill.name}」已经装备在槽位中。` };
  }

  const maxSlots = getMaxSkillSlots(player);
  if (player.equippedSkillIds.length >= maxSlots) {
    return {
      success: false,
      message: `技能槽位已满（${player.equippedSkillIds.length}/${maxSlots}）。请先卸下某个技能。`,
    };
  }

  player.equippedSkillIds.push(skillId);
  savePlayer(player);
  return {
    success: true,
    message: `已装备「${skill.name}」到技能槽位（${player.equippedSkillIds.length}/${maxSlots}）。`,
  };
}

/** Unequip a skill by its 1-based slot index. */
export function unequipSkill(player: PlayerState, slotIndex: number): EquipSkillResult {
  const idx = slotIndex - 1; // 1-based to 0-based
  if (idx < 0 || idx >= player.equippedSkillIds.length) {
    return { success: false, message: `无效的槽位编号：${slotIndex}（当前共 ${player.equippedSkillIds.length} 个已装备技能）。` };
  }
  const skillId = player.equippedSkillIds[idx];
  const skill = DEFAULT_MMORPG_CONTENT.skills[skillId];
  const name = skill?.name ?? skillId;
  player.equippedSkillIds.splice(idx, 1);
  savePlayer(player);
  const maxSlots = getMaxSkillSlots(player);
  return {
    success: true,
    message: `已卸下「${name}」（剩余 ${player.equippedSkillIds.length}/${maxSlots}）。`,
  };
}

/** Unequip by skill id (convenience for menu actions). */
export function unequipSkillById(player: PlayerState, skillId: string): EquipSkillResult {
  const idx = player.equippedSkillIds.indexOf(skillId);
  if (idx === -1) {
    const skill = DEFAULT_MMORPG_CONTENT.skills[skillId];
    return { success: false, message: `「${skill?.name ?? skillId}」未装备。` };
  }
  return unequipSkill(player, idx + 1);
}

/**
 * One-time auto-fill for legacy saves: if equippedSkillIds is empty but the player
 * has unlocked active/utility skills, populate slots up to the current max. This runs
 * lazily so old characters aren't left with an empty skill bar after the slot system
 * is introduced.
 */
export function autoFillEmptySlots(player: PlayerState): boolean {
  if (player.equippedSkillIds.length > 0) return false;
  const maxSlots = getMaxSkillSlots(player);
  let added = 0;
  for (const skillId of player.unlockedSkillIds) {
    if (added >= maxSlots) break;
    const skill = DEFAULT_MMORPG_CONTENT.skills[skillId];
    if (skill && isEquipableSkill(skill)) {
      player.equippedSkillIds.push(skillId);
      added++;
    }
  }
  if (added > 0) {
    savePlayer(player);
    return true;
  }
  return false;
}

/** Human-readable summary of the player's skill slot status. */
export function formatSkillSlotStatus(player: PlayerState): string {
  const maxSlots = getMaxSkillSlots(player);
  const used = player.equippedSkillIds.length;
  const lines: string[] = [
    `技能槽位：${used}/${maxSlots}`,
    `──────────────`,
    `已装备技能：`,
  ];
  if (used === 0) {
    lines.push("（空）");
  } else {
    player.equippedSkillIds.forEach((id, i) => {
      const skill = DEFAULT_MMORPG_CONTENT.skills[id];
      const name = skill?.name ?? id;
      lines.push(`  槽位 ${i + 1}：${name}`);
    });
  }

  const available = getUnequippedSkills(player);
  lines.push("", `可装备技能（${available.length}）：`);
  if (available.length === 0) {
    lines.push("（所有已解锁的主动/辅助技能均已装备）");
  } else {
    available.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.name}（${s.id}）`);
    });
  }

  // Passives overview
  const passives = player.unlockedSkillIds
    .map((id) => DEFAULT_MMORPG_CONTENT.skills[id])
    .filter((s): s is SkillDef => !!s && s.category === "passive");
  if (passives.length > 0) {
    lines.push("", `被动技能（${passives.length}，永久生效）：`);
    passives.forEach((s) => lines.push(`  • ${s.name}`));
  }

  const prefix = rt.menuPlugin.getPrefix();
  lines.push("", `命令：${prefix}mmo-equip-skill <skillId> 装备`, `      ${prefix}mmo-unequip-skill <槽位编号> 卸下`);
  return lines.join("\n");
}
