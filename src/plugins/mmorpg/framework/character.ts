import type { PlayerState, ItemDef } from "../schema.js";
import type { PluginContext } from "../../../types.js";
import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import { describeArea } from "./descriptions.js";
import { formatAreaSummary } from "./format.js";
import { decodeTextToken } from "./utils.js";
import { rt } from "./runtime.js";
import { requireArea, requireRace, requireClass, requireGender, savePlayer } from "./player-access.js";
import { syncPlayerEconomy, resolvePartyForPlayer } from "./economy.js";
import { isSafeArea, healPlayer } from "./combat.js";
import { buildCharacterStats } from "./stats.js";
import { updateQuestProgressFromState } from "./quest.js";
import { checkAchievementsOnAreaVisit, formatNewlyUnlocked } from "./achievements.js";

/**
 * 角色创建、区域移动与区域状态格式化（依赖层级 5）。
 */

export function createCharacter(input: {
  userId: string;
  raceId: string;
  classId: string;
  genderId: string;
  appearance: string;
  personalDeclaration?: string;
}, ctx: PluginContext): PlayerState {
  if (!rt.stateStore) {
    throw new Error("MMORPG 状态存储尚未初始化。");
  }
  if (rt.stateStore.getPlayer(input.userId)) {
    throw new Error("该用户已经创建过角色。");
  }

  const race = requireRace(input.raceId);
  const classDef = requireClass(input.classId);
  if (classDef.requiredRebirths || classDef.unlockQuestId) {
    throw new Error(
      `职业「${classDef.name}」为隐藏/限定职业，不能在创建角色时选择。` +
      (classDef.requiredRebirths ? `（需要 ${classDef.requiredRebirths} 次轮回）` : "") +
      (classDef.unlockQuestId ? `（需要完成解锁任务）` : "")
    );
  }
  const gender = requireGender(input.genderId);
  const appearance = decodeTextToken(input.appearance).trim();
  if (!appearance) {
    throw new Error("appearance 不能为空。");
  }

  const stats = buildCharacterStats(race.id, classDef, 1);
  const player = rt.stateStore.createPlayer({
    userId: input.userId,
    raceId: race.id,
    classDef,
    genderId: gender.id,
    appearance,
    personalDeclaration: input.personalDeclaration?.trim() || undefined,
    startingAreaId: ctx.config.pluginSettings.mmorpgFramework.defaultStartingAreaId,
    stats,
  });
  // Auto-equip starter items that have an equipSlot
  const items = DEFAULT_MMORPG_CONTENT.items;
  for (const entry of player.inventory) {
    const item = items[entry.itemId];
    if (item?.equipSlot) {
      player.equipment[item.equipSlot] = entry.itemId;
    }
  }
  return syncPlayerEconomy(input.userId, player);
}

export function movePlayerToArea(player: PlayerState, targetAreaId: string): string {
  const currentArea = requireArea(player.areaId);
  const targetArea = requireArea(targetAreaId);
  if (targetArea.id === currentArea.id) {
    return `你已经在 ${targetArea.name}。`;
  }

  player.areaId = targetArea.id;
  if (isSafeArea(targetArea)) {
    healPlayer(player);
  }
  const completions = updateQuestProgressFromState(player);

  const party = resolvePartyForPlayer(player);
  if (party && party.leaderUserId === player.userId) {
    party.currentAreaId = targetArea.id;
    rt.stateStore!.saveParty(party);
  }
  const newlyUnlocked = checkAchievementsOnAreaVisit(player, targetArea.id);
  savePlayer(player);

  const partyHint = party
    ? (party.leaderUserId === player.userId
      ? "你是队长，队伍当前位置镜像也已同步更新。"
      : `当前你在队伍 ${party.id} 中，队伍镜像位置仍为 ${describeArea(party.currentAreaId)}。`)
    : undefined;

  const safeNote = isSafeArea(targetArea) ? "\n你已进入安全区域，HP 已完全恢复。" : "";

  return [
    `你已从 ${currentArea.name} 移动到 ${targetArea.name}。${safeNote}`,
    formatAreaSummary(targetArea),
    ...completions,
    formatNewlyUnlocked(newlyUnlocked) || undefined,
    partyHint,
  ].filter(Boolean).join("\n");
}

export function formatAreaStatus(player: PlayerState): string {
  const area = requireArea(player.areaId);
  const party = resolvePartyForPlayer(player);
  return [
    formatAreaSummary(area),
    `HP：${player.resources.hp}`,
    isSafeArea(area) ? "⚜️ 安全区域" : undefined,
    party ? `队伍镜像位置：${describeArea(party.currentAreaId)}（队伍 ${party.id}）` : undefined,
  ].filter(Boolean).join("\n");
}
