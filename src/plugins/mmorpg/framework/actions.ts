import { randomUUID } from "node:crypto";
import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import { MMORPG_RULEBOOK } from "../rulebook.js";
import type {
  MenuAction,
  MenuGroup,
  PendingMenu,
  PendingMenuItem,
  PlayerState,
} from "../schema.js";
import type { PluginContext } from "../../../types.js";
import {
  describeArea,
  describeItem,
  describeMonster,
} from "./descriptions.js";
import { formatAreaSummary, formatFishBasket } from "./format.js";
import {
  findPathBFS,
  buildAreaIndexMap,
  formatPathWithIndices,
} from "./pathfinding.js";
import {
  resolveDialogueTree,
  buildDialogueMenu,
  applyDialogueEffects,
} from "../dialogue-engine.js";
import {
  buildGuideMenu,
  getGuideStepDetails,
  generateStarterRewards,
} from "./guide.js";
import { rt } from "./runtime.js";
import {
  requireArea,
  requireNpc,
  requireMonster,
  requireLocalNpc,
  savePlayer,
} from "./player-access.js";
import {
  addPlayerItem,
  removePlayerItem,
  grantBridgedCoins,
  syncPlayerEconomy,
  resolvePartyForPlayer,
  getPlayerItemQuantity,
} from "./economy.js";
import {
  requireNotInCombat,
  setCombatLock,
  setTravelLock,
  isSafeArea,
  healPlayer,
  getEncounterChance,
} from "./combat.js";
import { describeInstanceOrItem, formatSkillSummary, formatSkillDetail, getMaxSkillSlots } from "./stats.js";
import {
  equipSkill, unequipSkill, unequipSkillById, getUnequippedSkills,
  autoFillEmptySlots, formatSkillSlotStatus, isEquipableSkill,
} from "./skill-slots.js";
import {
  applyRewardBonuses,
  getLevelDecayMultiplier,
  grantExperience,
} from "./progression.js";
import {
  movePlayerToArea,
} from "./character.js";
import {
  markTalkProgress,
  acceptQuest,
  turnInQuest,
  abandonQuest,
  gatherResource,
  updateQuestProgressFromState,
  incrementKillProgress,
  formatNpcDetail,
} from "./quest.js";
import { handleFishing, sellFish } from "./fishing.js";
import { startBattle } from "./battle.js";
import { canClaimFactionReward, claimFactionReward, getNextReputationTier, getReputationTierName } from "./factions.js";
import { checkAchievementsOnDungeonClear, formatNewlyUnlocked, claimAchievement, getAchievementStatus } from "./achievements.js";
import {
  buildLocationMenu,
  buildEquipMenu,
  buildBagMenu,
  buildQuestMenu,
} from "./menus.js";
import {
  resolveMessageTarget,
  sendMenuImage,
  sendDetailMenuImage,
  setAndSavePendingMenu,
  type MessageLike,
} from "./messenger.js";

/**
 * 菜单动作调度核心（依赖层级 6，最高扇出）。
 * dispatchMenuAction 是玩家所有游戏操作的中央入口。
 */

export async function dispatchMenuAction(
  player: PlayerState,
  action: MenuAction,
  message: MessageLike,
  ctx: PluginContext,
  menuIndexMap?: Map<string, number>,
): Promise<string> {
  switch (action.type) {
    case "move": {
      const targetId = action.targetId!;
      const currentArea = requireArea(player.areaId);
      const targetArea = requireArea(targetId);

      // Already at target
      if (targetArea.id === currentArea.id) {
        return `你已经在 ${targetArea.name}。`;
      }

      // Single-step: directly connected
      if (currentArea.connectedAreaIds.includes(targetArea.id)) {
        if (targetArea.monsterIds.length > 0 && Math.random() < getEncounterChance(player, targetArea)) {
          return startBattle(player, undefined, message, ctx, true);
        }
        return movePlayerToArea(player, targetArea.id);
      }

      // Multi-step: BFS pathfinding
      const fullPath = findPathBFS(
        player.areaId,
        targetId,
        DEFAULT_MMORPG_CONTENT.areas,
        MMORPG_RULEBOOK.travel.maxPathSteps
      );

      if (!fullPath) {
        // Truly unreachable — no path at all
        throw new Error(`无法到达 ${targetArea.name}，当前世界地图中没有通往该区域的路径。`);
      }

      // fullPath[0] is current area, fullPath[1..n-1] are intermediate, fullPath[n] is target
      const steps = fullPath.length - 1;
      const indices = menuIndexMap ?? buildAreaIndexMap(player.pendingMenu);
      const pathText = formatPathWithIndices(fullPath, indices, DEFAULT_MMORPG_CONTENT.areas);

      const totalSeconds = steps * MMORPG_RULEBOOK.travel.baseSecondsPerStep;
      const target = resolveMessageTarget(message);

      // Lock travel and run async multi-step movement
      setTravelLock(player.userId, totalSeconds * 1000 + 5000);

      (async () => {
        try {
          const durLabel = totalSeconds < 60 ? `${totalSeconds}秒` : `${Math.floor(totalSeconds / 60)}分${totalSeconds % 60}秒`;
          await ctx.sendMessage(target, `🚶 开始旅途：${pathText}\n预计 ${durLabel} 后到达，旅途结束后将自动通知你。`);

          for (let i = 1; i < fullPath.length; i++) {
            // Guard: if the player was moved externally (e.g. death teleport), abort travel
            if (player.areaId !== fullPath[i - 1]) {
              await ctx.sendMessage(target, `旅途被中断（你可能在途中被传送），当前位于 ${requireArea(player.areaId).name}。`);
              return;
            }

            const stepAreaId = fullPath[i];
            const stepArea = requireArea(stepAreaId);

            player.areaId = stepAreaId;
            if (isSafeArea(stepArea)) healPlayer(player);
            const completions = updateQuestProgressFromState(player);

            const party = resolvePartyForPlayer(player);
            if (party && party.leaderUserId === player.userId) {
              party.currentAreaId = stepAreaId;
              rt.stateStore!.saveParty(party);
            }
            savePlayer(player);

            // Roll for encounter when entering a monster area (not the final destination)
            if (stepArea.monsterIds.length > 0 && i < fullPath.length - 1 && Math.random() < getEncounterChance(player, stepArea)) {
              await ctx.sendMessage(target, `⚠️ 途经 ${stepArea.name} 时遭遇了怪物！`);
              rt.travelLock.delete(player.userId);
              const battleMsg = await startBattle(player, undefined, message, ctx, true);
              await ctx.sendMessage(target, battleMsg);
              return;
            }

            // Delay between steps (skip after the final step)
            if (i < fullPath.length - 1) {
              const delayMs = MMORPG_RULEBOOK.travel.baseSecondsPerStep * 1000;
              await new Promise((r) => setTimeout(r, delayMs));

              // Guard: re-check after delay
              if (player.areaId !== stepAreaId) {
                await ctx.sendMessage(target, `旅途被中断，当前位于 ${requireArea(player.areaId).name}。`);
                return;
              }

              await ctx.sendMessage(target, `途经 ${stepArea.name}…`);
            }
          }

          // Final arrival notification
          const finalArea = requireArea(fullPath[fullPath.length - 1]);
          const safeNote = isSafeArea(finalArea) ? "\n你已进入安全区域，HP 已完全恢复。" : "";
          await ctx.sendMessage(target, `🎯 旅途结束！你已到达 ${finalArea.name}。${safeNote}\n${formatAreaSummary(finalArea)}`);
        } catch (err) {
          await ctx.sendMessage(target, `旅途出错：${err instanceof Error ? err.message : String(err)}\n你当前停留在 ${requireArea(player.areaId).name}。`);
        } finally {
          rt.travelLock.delete(player.userId);
        }
      })();

      // Return immediate feedback to the dispatch caller
      const durLabel = totalSeconds < 60 ? `${totalSeconds}秒` : `${Math.floor(totalSeconds / 60)}分${totalSeconds % 60}秒`;
      return `🚶 开始旅途 → ${targetArea.name}\n路径：${pathText}\n预计 ${durLabel} 后到达，到达后将自动通知你。`;
    }
    case "talk": {
      const npc = requireLocalNpc(player, action.targetId!);

      // Always update talk progress first — even if the NPC has a dialogue tree,
      // talking to them should count towards "talk" quest objectives.
      const talkUpdate = markTalkProgress(player, npc.id);
      savePlayer(player);

      // Check if this NPC has dialogue trees
      if (npc.dialogueTreeIds && npc.dialogueTreeIds.length > 0) {
        const playerFlags = new Set(player.dialogueFlags ?? []);
        const allTrees = DEFAULT_MMORPG_CONTENT.dialogueTrees ?? {};
        const tree = resolveDialogueTree(npc.dialogueTreeIds, allTrees, playerFlags);
        if (tree) {
          const menu = buildDialogueMenu(tree, tree.entryNodeId, npc.name, playerFlags);
          if (menu) {
            setAndSavePendingMenu(player, menu);
            await sendMenuImage(message, menu);
            return talkUpdate ?? "";
          }
        }
      }

      // Fallback: normal talk behaviour
      return [formatNpcDetail(player, npc), talkUpdate].filter(Boolean).join("\n");
    }
    case "hunt": return startBattle(player, action.targetId, message, ctx);
    case "dialogue_choice": {
      const treeId = action.targetId!;
      const nodeId = action.extra?.nodeId;
      const choiceIndexStr = action.extra?.choiceIndex;
      if (!treeId || !nodeId || choiceIndexStr === undefined) throw new Error("对话数据不完整。");
      const tree = DEFAULT_MMORPG_CONTENT.dialogueTrees?.[treeId];
      if (!tree) throw new Error("对话不存在。");
      const node = tree.nodes[nodeId];
      if (!node) throw new Error("对话节点不存在。");
      const choiceIndex = parseInt(choiceIndexStr, 10);
      const choice = node.choices[choiceIndex];
      if (!choice) throw new Error("对话选项无效。");

      // Apply effects from the chosen option
      const playerFlags = new Set(player.dialogueFlags ?? []);
      const effectMessages = applyDialogueEffects(
        choice.effects ?? [],
        player,
        playerFlags,
        {
          addItem: (itemId, qty) => { addPlayerItem(player, itemId, qty); return true; },
          acceptQuest: (questId) => acceptQuest(player, questId),
          grantGold: (amount) => { player.currencies.gold = (player.currencies.gold ?? 0) + amount; },
        },
      );

      // Persist updated dialogue flags back to player state
      player.dialogueFlags = Array.from(playerFlags);

      // If the tree has setFlagOnComplete and we reached a terminal node, mark it
      const isTerminal = !choice.nextNodeId;
      if (isTerminal && tree.setFlagOnComplete) {
        playerFlags.add(tree.setFlagOnComplete);
        player.dialogueFlags = Array.from(playerFlags);
      }

      savePlayer(player);

      // If there is a next node, show it
      if (choice.nextNodeId) {
        const nextMenu = buildDialogueMenu(tree, choice.nextNodeId, tree.nodes[choice.nextNodeId]?.speaker ?? "", playerFlags);
        if (nextMenu) {
          setAndSavePendingMenu(player, nextMenu);
          await sendMenuImage(message, nextMenu);
          return effectMessages.length > 0 ? effectMessages.join("\n") : "";
        }
      }

      // Dialogue ended — return summary
      const summary = effectMessages.length > 0 ? effectMessages.join("\n") : "对话结束。";
      return summary;
    }
    case "gather": return gatherResource(player, action.targetId);
    case "fish": return handleFishing(player);
    case "accept_quest": return acceptQuest(player, action.targetId!);
    case "turn_in_quest": return turnInQuest(player, action.targetId!, ctx);
    case "abandon_quest": return abandonQuest(player, action.targetId!);
    case "equip": {
      const idOrInstanceId = action.targetId!;
      let baseItemId = idOrInstanceId;
      let instanceId: string | undefined = undefined;

      if (player.itemInstances && player.itemInstances[idOrInstanceId]) {
        baseItemId = player.itemInstances[idOrInstanceId].itemId;
        instanceId = idOrInstanceId;
      }

      const item = DEFAULT_MMORPG_CONTENT.items[baseItemId];
      if (!item?.equipSlot) throw new Error("该物品不可装备。");

      if (item.allowedClasses && item.allowedClasses.length > 0 && !item.allowedClasses.includes(player.classId)) {
        throw new Error("你的职业无法装备该物品。");
      }

      if (!removePlayerItem(player, baseItemId, 1, instanceId)) {
        throw new Error(`背包中没有 ${describeInstanceOrItem(player, idOrInstanceId)}。`);
      }

      const isFashion = item.category === "fashion";
      const target = isFashion ? (player.fashionEquipment ??= {}) : player.equipment;
      const oldEquipId = target[item.equipSlot];
      if (oldEquipId) {
        let oldBaseId = oldEquipId;
        let oldInstId: string | undefined = undefined;
        if (player.itemInstances && player.itemInstances[oldEquipId]) {
          oldBaseId = player.itemInstances[oldEquipId].itemId;
          oldInstId = oldEquipId;
        }
        addPlayerItem(player, oldBaseId, 1, oldInstId);
      }

      target[item.equipSlot] = idOrInstanceId;
      savePlayer(player);
      return `已装备 ${describeInstanceOrItem(player, idOrInstanceId)}（${isFashion ? "时装-" : ""}${item.equipSlot}）。`;
    }
    case "unequip": {
      const slot = action.targetId! as keyof typeof player.equipment;
      const equipId = player.equipment[slot];
      const fashionId = player.fashionEquipment?.[slot as keyof typeof player.fashionEquipment];

      if (!equipId && !fashionId) throw new Error("该槽位没有装备。");

      if (fashionId) {
        let baseItemId = fashionId;
        let instanceId: string | undefined = undefined;
        if (player.itemInstances && player.itemInstances[fashionId]) {
          baseItemId = player.itemInstances[fashionId].itemId;
          instanceId = fashionId;
        }
        addPlayerItem(player, baseItemId, 1, instanceId);
        player.fashionEquipment![slot as keyof typeof player.fashionEquipment] = undefined;
        savePlayer(player);
        return `已卸下 ${describeInstanceOrItem(player, fashionId)}。`;
      }

      let baseItemId = equipId!;
      let instanceId: string | undefined = undefined;
      if (player.itemInstances && player.itemInstances[equipId!]) {
        baseItemId = player.itemInstances[equipId!].itemId;
        instanceId = equipId!;
      }

      addPlayerItem(player, baseItemId, 1, instanceId);
      player.equipment[slot] = undefined;
      savePlayer(player);
      return `已卸下 ${describeInstanceOrItem(player, equipId!)}。`;
    }
    case "guide_step": {
      const stepId = action.targetId!;
      if (stepId === "complete") {
        player.guideCompleted = true;
        const rewards = generateStarterRewards(player);
        if (!player.itemInstances) player.itemInstances = {};
        player.itemInstances[rewards.weaponInstanceId] = rewards.weaponInstance;
        player.inventory.push({ itemId: rewards.weaponInstance.itemId, quantity: 1, instanceId: rewards.weaponInstanceId });
        grantBridgedCoins(player.userId, rewards.coins, ctx);
        for (const entry of rewards.items) {
          addPlayerItem(player, entry.itemId, entry.quantity);
        }
        if (!player.questLog.some(q => q.questId === rewards.autoQuestId)) {
          player.questLog.push({
            questId: rewards.autoQuestId,
            status: "active",
            counters: {},
          });
        }

        // ── 补偿经验瓶（数据迁移后重新完成引导时发放）──
        let compensationText = "";
        if (player.pendingCompensationExp && player.pendingCompensationExp > 0) {
          const compExpAmount = Math.min(25000, player.pendingCompensationExp);
          const bottleInstId = "inst_" + randomUUID().slice(0, 8);
          player.itemInstances[bottleInstId] = {
            id: bottleInstId,
            itemId: "exp_bottle",
            enhancement: 0,
            rarity: "legendary",
            substats: { strength: 0, defense: 0, charm: 0, agility: 0, eloquence: 0, endurance: 0, life: 0 },
            suffix: "之回忆",
            expAmount: compExpAmount,
          };
          player.inventory.push({ itemId: "exp_bottle", quantity: 1, instanceId: bottleInstId });
          player.pendingCompensationExp = 0;
          compensationText += `\n\n🧪 补偿奖励：经验瓶 x1（蕴含 ${compExpAmount} 经验值）`;
        }

        // ── 补偿钱袋（数据迁移后重新完成引导时发放）──
        if (player.pendingCompensationGold && player.pendingCompensationGold > 0) {
          const compGoldAmount = player.pendingCompensationGold;
          const bagInstId = "inst_" + randomUUID().slice(0, 8);
          player.itemInstances[bagInstId] = {
            id: bagInstId,
            itemId: "gold_bag",
            enhancement: 0,
            rarity: "epic",
            substats: { strength: 0, defense: 0, charm: 0, agility: 0, eloquence: 0, endurance: 0, life: 0 },
            suffix: "之积蓄",
            goldAmount: compGoldAmount,
          };
          player.inventory.push({ itemId: "gold_bag", quantity: 1, instanceId: bagInstId });
          player.pendingCompensationGold = 0;
          compensationText += `\n💰 补偿奖励：钱袋 x1（内含 ${compGoldAmount} 金币）`;
        }

        if (compensationText) {
          compensationText += "\n打开背包使用补偿道具即可获得其中的奖励！";
        }

        savePlayer(player);
        const weaponName = describeInstanceOrItem(player, rewards.weaponInstanceId);
        return `🎉 恭喜你完成新手引导！\n\n已获得新手大礼包：\n- 武器：${weaponName}\n- 金币：${rewards.coins}g\n- 消耗品：小治疗药水 x5，布绷带 x5\n- 材料：铁矿石 x5\n\n已自动为你接取第一个主线任务：【觉醒之始】。请发送 ${rt.menuPlugin.getPrefix()}mmo 查看！${compensationText}`;
      } else {
        const stepVal = parseInt(stepId, 10);
        const menu = buildGuideMenu(player, stepVal);
        setAndSavePendingMenu(player, menu);
        try {
          await sendDetailMenuImage(message, {
            title: menu.title,
            context: menu.context,
            details: getGuideStepDetails(stepVal),
            menu,
          });
        } catch {
          const text = getGuideStepDetails(stepVal).map((d) => `${d.label}: ${d.value}`).join("\n");
          await ctx.replyText(message as never, `新手引导：\n${text}\n\n请输入 $mmo-pick 1 进行下一步`);
        }
        return "";
      }
    }
    case "use_item": {
      // Resolve targetId: could be an itemId or an instanceId
      const idOrInstanceId = action.targetId!;
      let baseItemId = idOrInstanceId;
      let instanceId: string | undefined = undefined;
      if (player.itemInstances && player.itemInstances[idOrInstanceId]) {
        baseItemId = player.itemInstances[idOrInstanceId].itemId;
        instanceId = idOrInstanceId;
      }

      const item = DEFAULT_MMORPG_CONTENT.items[baseItemId];
      if (!item || item.category !== "consumable") throw new Error("该物品不可使用。");

      // ── 经验瓶特殊处理 ──
      if (item.id === "exp_bottle") {
        if (player.level < 30) throw new Error(`经验瓶需要达到 30 级才能开启（当前 ${player.level} 级）。`);
        if (!instanceId) throw new Error("缺少经验瓶实例数据，无法使用。");
        const inst = player.itemInstances?.[instanceId];
        if (!inst || inst.itemId !== "exp_bottle") throw new Error("经验瓶实例不存在。");
        const expAmount = Math.min(25000, inst.expAmount ?? 0);
        if (!removePlayerItem(player, item.id, 1, instanceId)) throw new Error(`背包中没有该经验瓶。`);
        // Clean up instance data
        if (player.itemInstances) delete player.itemInstances[instanceId];
        if (expAmount <= 0) {
          savePlayer(player);
          return `使用了 ${item.name}，但瓶中空空如也，什么也没发生。`;
        }
        const lr = grantExperience(player, expAmount);
        savePlayer(player);
        const parts = [`使用了 ${item.name}，获得 ${expAmount} 经验值。`];
        if (lr.levelsGained > 0) parts.push(`升级！+${lr.levelsGained} 级，当前等级 ${player.level}。`);
        if (lr.newlyUnlockedAchievementIds.length > 0) {
          parts.push(`解锁成就：${lr.newlyUnlockedAchievementIds.join("、")}`);
        }
        return parts.join("\n");
      }

      // ── 钱袋特殊处理 ──
      if (item.id === "gold_bag") {
        if (player.level < 30) throw new Error(`钱袋需要达到 30 级才能开启（当前 ${player.level} 级）。`);
        if (!instanceId) throw new Error("缺少钱袋实例数据，无法使用。");
        const inst = player.itemInstances?.[instanceId];
        if (!inst || inst.itemId !== "gold_bag") throw new Error("钱袋实例不存在。");
        const goldAmount = inst.goldAmount ?? 0;
        if (!removePlayerItem(player, item.id, 1, instanceId)) throw new Error(`背包中没有该钱袋。`);
        if (player.itemInstances) delete player.itemInstances[instanceId];
        if (goldAmount <= 0) {
          savePlayer(player);
          return `使用了 ${item.name}，但袋中空无一文。`;
        }
        grantBridgedCoins(player.userId, goldAmount, ctx);
        savePlayer(player);
        return `使用了 ${item.name}，获得 ${goldAmount} 金币！`;
      }

      // ── 通用消耗品 ──
      if (!removePlayerItem(player, item.id, 1, instanceId)) throw new Error(`背包中没有 ${item.name}。`);
      const heal = 20 + player.level * 3;
      player.resources.hp = Math.min(player.resources.hp + heal, 9999);
      savePlayer(player);
      return `使用了 ${item.name}，恢复 ${heal} HP。`;
    }
    case "buy": {
      const extra = action.extra;

      // MMO Mall purchase (gold sink shop, not tied to NPC location)
      if (extra?.source === "mall") {
        if (!extra?.itemId) throw new Error("未指定要购买的物品。");
        const shopItem = DEFAULT_MMORPG_CONTENT.items[extra.itemId];
        if (!shopItem) throw new Error("未知物品。");
        const mallEntry = MMORPG_RULEBOOK.mmoShop.items.find((e) => e.itemId === extra.itemId);
        if (!mallEntry) throw new Error("该物品不在商城中。");
        const qty = Number(extra.quantity ?? "1");
        if (!Number.isFinite(qty) || qty < 1) throw new Error(`购买数量无效。`);
        const total = mallEntry.price * qty;
        syncPlayerEconomy(player.userId, player);
        if ((player.currencies.gold ?? 0) < total) throw new Error(`金币不足：需要 ${total}，当前 ${player.currencies.gold}。`);
        const profile = rt.store.getUserData(player.userId);
        profile.coins -= total;
        rt.store.saveUserData(player.userId, profile);
        rt.stateStore!.recordMMOCoinsGranted(player.userId, -total, profile.coins);
        player.currencies.gold = profile.coins;
        addPlayerItem(player, shopItem.id, qty);
        savePlayer(player);
        return `从 MMO 商城购买了 ${shopItem.name} x${qty}，花费 ${total} 金币。`;
      }

      // NPC shop purchase
      const npc = requireLocalNpc(player, action.targetId!);
      if (!extra?.itemId) {
        const list = npc.shopItemIds.map((id) => describeItem(id)).join("、");
        return `${npc.name} 的商店：${list || "暂无商品"}`;
      }
      const shopItem = DEFAULT_MMORPG_CONTENT.items[extra.itemId];
      if (!shopItem || !npc.shopItemIds.includes(shopItem.id)) throw new Error("该 NPC 不出售此物品。");
      const price = shopItem.sellPrice ?? 10;
      const qty = Number(extra.quantity ?? "1");
      if (!Number.isFinite(qty) || qty < 1) throw new Error(`购买数量无效：${extra.quantity ?? ""}`);
      const total = price * qty;
      syncPlayerEconomy(player.userId, player);
      if ((player.currencies.gold ?? 0) < total) throw new Error(`金币不足：需要 ${total}，当前 ${player.currencies.gold}。`);
      const profile = rt.store.getUserData(player.userId);
      profile.coins -= total;
      rt.store.saveUserData(player.userId, profile);
      rt.stateStore!.recordMMOCoinsGranted(player.userId, -total, profile.coins);
      player.currencies.gold = profile.coins;
      addPlayerItem(player, shopItem.id, qty);
      savePlayer(player);
      return `购买了 ${shopItem.name} x${qty}，花费 ${total} 金币。`;
    }
    case "sell": {
      const item = DEFAULT_MMORPG_CONTENT.items[action.targetId!];
      if (!item?.sellPrice) throw new Error("该物品不可出售。");
      if (item.category === "quest") throw new Error("任务物品不可出售。");
      if (!removePlayerItem(player, item.id, 1)) throw new Error(`背包中没有 ${item.name}。`);
      // NPCs buy back at a discounted rate vs sell price — closes the buy/sell parity
      // arbitrage where players could buy and resell at no loss (infinite gold loop).
      const sellBackAmount = Math.max(1, Math.floor(item.sellPrice * MMORPG_RULEBOOK.economy.npcSellBackRate));
      grantBridgedCoins(player.userId, sellBackAmount, ctx);
      savePlayer(player);
      return `出售了 ${item.name}，获得 ${sellBackAmount} 金币（NPC 以 ${(MMORPG_RULEBOOK.economy.npcSellBackRate * 100) | 0}% 折价回收）。`;
    }
    case "enter_dungeon": {
      requireNotInCombat(player);
      const dungeon = DEFAULT_MMORPG_CONTENT.dungeons[action.targetId!];
      if (!dungeon) throw new Error("未知副本。");
      if (dungeon.areaId !== player.areaId) throw new Error(`副本入口在 ${describeArea(dungeon.areaId)}。`);
      if (player.level < dungeon.requiredLevel) throw new Error(`需要达到 ${dungeon.requiredLevel} 级。`);
      const dungeonDecay = getLevelDecayMultiplier(player.level, dungeon.requiredLevel);
      const rewards = applyRewardBonuses(player, Math.floor(dungeon.requiredLevel * 30 * dungeonDecay), Math.floor(dungeon.requiredLevel * 15 * dungeonDecay));
      const lr = grantExperience(player, rewards.exp);
      if (rewards.coins > 0) grantBridgedCoins(player.userId, rewards.coins, ctx);
      for (const itemId of dungeon.rewardItemIds) addPlayerItem(player, itemId, 1);
      const newlyUnlocked = checkAchievementsOnDungeonClear(player, dungeon.id);
      // Update kill progress for dungeon boss monsters (sync, before save)
      for (const bossId of dungeon.bossMonsterIds) {
        incrementKillProgress(player, bossId);
      }
      savePlayer(player);
      // Dungeon cooldown: prevent instant re-entry (60s base)
      setCombatLock(player.userId, 60_000);
      return [
        `挑战副本：${dungeon.name}`,
        `击败了 ${dungeon.bossMonsterIds.map((id) => describeMonster(id)).join("、") || "所有敌人"}`,
        `获得经验：${rewards.exp}`,
        `获得金币：${rewards.coins}`,
        dungeon.rewardItemIds.length > 0 ? `奖励物品：${dungeon.rewardItemIds.map((id) => describeItem(id)).join("、")}` : undefined,
        lr.levelsGained > 0 ? `升级：+${lr.levelsGained}，当前等级 ${player.level}` : undefined,
        formatNewlyUnlocked([...newlyUnlocked, ...lr.newlyUnlockedAchievementIds]) || undefined,
        dungeonDecay < 1 ? `⚠ 等级差距衰减：你比副本推荐等级高 ${player.level - dungeon.requiredLevel} 级，奖励仅获得 ${Math.round(dungeonDecay * 100)}%。` : undefined,
      ].filter(Boolean).join("\n");
    }
    case "guild_create": {
      if (player.guildId) throw new Error("你已经在公会中。");
      const name = action.extra?.name ?? `${player.userId} 的公会`;
      const guild = rt.stateStore!.createGuild({ name, leaderUserId: player.userId });
      player.guildId = guild.id;
      savePlayer(player);
      return `已创建公会「${name}」。`;
    }
    case "guild_join": {
      if (player.guildId) throw new Error("你已经在公会中。");
      const guild = rt.stateStore!.findGuildByName(action.extra?.name ?? "");
      if (!guild) throw new Error("未找到该公会。");
      guild.memberUserIds.push(player.userId);
      rt.stateStore!.saveGuild(guild);
      player.guildId = guild.id;
      savePlayer(player);
      return `已加入公会「${guild.name}」。`;
    }
    case "guild_leave": {
      if (!player.guildId) throw new Error("你不在任何公会中。");
      const guild = rt.stateStore!.getGuild(player.guildId);
      if (!guild) { player.guildId = undefined; savePlayer(player); return "公会已不存在。"; }
      guild.memberUserIds = guild.memberUserIds.filter((id) => id !== player.userId);
      if (guild.memberUserIds.length === 0) rt.stateStore!.removeGuild(guild.id);
      else rt.stateStore!.saveGuild(guild);
      player.guildId = undefined;
      savePlayer(player);
      return `已离开公会「${guild.name}」。`;
    }
    case "guild_donate": {
      if (!player.guildId) throw new Error("你不在任何公会中。");
      const guild = rt.stateStore!.getGuild(player.guildId);
      if (!guild) throw new Error("公会不存在。");
      const amount = Number(action.extra?.amount ?? "100");
      if (!Number.isFinite(amount) || amount < 1) throw new Error(`捐赠金额无效：${action.extra?.amount ?? ""}`);
      syncPlayerEconomy(player.userId, player);
      if ((player.currencies.gold ?? 0) < amount) throw new Error(`金币不足。`);
      const profile = rt.store.getUserData(player.userId);
      profile.coins -= amount;
      rt.store.saveUserData(player.userId, profile);
      rt.stateStore!.recordMMOCoinsGranted(player.userId, -amount, profile.coins);
      player.currencies.gold = profile.coins;
      guild.treasury.gold = (guild.treasury.gold ?? 0) + amount;
      rt.stateStore!.saveGuild(guild);
      savePlayer(player);
      return `已向公会捐赠 ${amount} 金币。公会金库：${guild.treasury.gold}`;
    }
    case "equip_skill": {
      const skillId = action.targetId!;
      const result = equipSkill(player, skillId);
      return result.message;
    }
    case "unequip_skill": {
      const skillId = action.targetId!;
      const result = unequipSkillById(player, skillId);
      return result.message;
    }
    case "open_skill_slots": {
      autoFillEmptySlots(player);
      const status = formatSkillSlotStatus(player);
      const available = getUnequippedSkills(player);
      const groups: MenuGroup[] = [];
      // Equipped skills (click to unequip)
      if (player.equippedSkillIds.length > 0) {
        groups.push({
          label: "已装备（点击卸下）",
          category: "system",
          items: player.equippedSkillIds.map((id, i) => {
            const sk = DEFAULT_MMORPG_CONTENT.skills[id];
            return {
              label: `槽位${i + 1}：${sk?.name ?? id}`,
              description: sk ? formatSkillSummary(sk) : "",
              action: { type: "unequip_skill" as const, targetId: id },
            };
          }),
        });
      }
      // Unequipped available skills (click to equip)
      if (available.length > 0) {
        groups.push({
          label: "可装备（点击装备）",
          category: "interact",
          items: available.map((sk) => ({
            label: sk.name,
            description: formatSkillSummary(sk),
            action: { type: "equip_skill" as const, targetId: sk.id },
          })),
        });
      }
      groups.push({ label: "导航", category: "system", items: [{ label: "返回", action: { type: "back" } }] });
      const maxSlots = getMaxSkillSlots(player);
      const subMenu: PendingMenu = {
        context: `${player.equippedSkillIds.length}/${maxSlots} 槽位`,
        title: "技能槽位管理",
        groups,
        createdAt: new Date().toISOString(),
      };
      setAndSavePendingMenu(player, subMenu);
      try {
        await sendMenuImage(message, subMenu);
        return "";
      } catch {
        return status;
      }
    }
    case "view_npc": {
      const npc = requireNpc(action.targetId!);
      return formatNpcDetail(player, npc);
    }
    case "view_item": {
      const item = DEFAULT_MMORPG_CONTENT.items[action.targetId!];
      if (!item) throw new Error("未知物品。");
      const qty = getPlayerItemQuantity(player, item.id);
      return [`${item.name}（${item.id}）`, `类别：${item.category}`, `描述：${item.description}`, item.equipSlot ? `装备槽：${item.equipSlot}` : undefined, item.sellPrice ? `售价：${item.sellPrice} 金币` : undefined, `持有：${qty}`].filter(Boolean).join("\n");
    }
    case "view_skill": {
      const skill = DEFAULT_MMORPG_CONTENT.skills[action.targetId!];
      if (!skill) throw new Error("未知技能。");
      return formatSkillDetail(skill);
    }
    case "view_monster": {
      const monster = requireMonster(action.targetId!);
      return [`${monster.name}（${monster.id}）`, `等级：${monster.level}`, `描述：${monster.description}`, `掉落：${monster.lootItemIds.map((id) => describeItem(id)).join("、") || "无"}`].join("\n");
    }
    case "view_faction": {
      const faction = DEFAULT_MMORPG_CONTENT.factions[action.targetId!];
      if (!faction) throw new Error("未知阵营。");
      const rep = player.factionReputation[faction.id] ?? 0;
      const tierName = getReputationTierName(rep);
      const next = getNextReputationTier(rep);
      const claimable = canClaimFactionReward(player, faction.id, rep);
      const items: PendingMenuItem[] = [];
      items.push({ label: `当前声望：${rep}（${tierName}）`, description: next ? `下一级：${next.name} ${next.threshold}` : "已达最高", action: { type: "noop" } });
      if (claimable.canClaim) {
        items.push({ label: `领取奖励（${claimable.reward} 金币）`, action: { type: "claim_faction_reward" as const, targetId: faction.id } });
      }
      items.push({ label: "返回", action: { type: "back" } });
      const subMenu: PendingMenu = {
        context: faction.description,
        title: faction.name,
        groups: [{ label: "声望", category: "interact", items }],
        createdAt: new Date().toISOString(),
      };
      setAndSavePendingMenu(player, subMenu);
      await sendMenuImage(message, subMenu);
      return "";
    }
    case "view_achievement": {
      const ach = DEFAULT_MMORPG_CONTENT.achievements[action.targetId!];
      if (!ach) throw new Error("未知成就。");
      const status = getAchievementStatus(player, ach.id);
      const items: PendingMenuItem[] = [
        { label: `描述：${ach.description}`, description: `奖励：${ach.rewardCoins} 金币`, action: { type: "noop" } },
        { label: `状态：${status === "claimed" ? "已领取" : status === "unlocked" ? "可领取 ✓" : "未解锁"}`, action: { type: "noop" } },
      ];
      if (status === "unlocked") {
        items.push({ label: `领取奖励（${ach.rewardCoins} 金币）`, action: { type: "claim_achievement" as const, targetId: ach.id } });
      }
      items.push({ label: "返回", action: { type: "back" } });
      const subMenu: PendingMenu = {
        context: `${ach.name}（${ach.id}）`,
        title: "成就详情",
        groups: [{ label: "信息", category: "interact", items }],
        createdAt: new Date().toISOString(),
      };
      setAndSavePendingMenu(player, subMenu);
      await sendMenuImage(message, subMenu);
      return "";
    }
    case "open_bag": {
      // Show the actual inventory contents (equipment / consumables / sellable),
      // each item wired to its real action (equip / use_item / sell).
      const bagMenu = buildBagMenu(player);
      const fishCount = player.fishBasket.length;
      // Append navigation: equipment management, fish basket, and back.
      const navItems: PendingMenuItem[] = [
        { label: "装备 / 卸下管理", action: { type: "open_equip" } },
      ];
      if (fishCount > 0) {
        const fishEstimate = player.fishBasket.reduce((sum, fi) => {
          const sp = DEFAULT_MMORPG_CONTENT.fishSpecies[fi.speciesId];
          return sum + (sp?.baseValue ?? 5);
        }, 0);
        navItems.push({ label: `查看鱼篓（${fishCount}条 · 估值${fishEstimate}g）`, description: "查看鱼获详情", action: { type: "view_fish_basket" } });
        navItems.push({ label: "出售全部鱼", description: `估值约 ${fishEstimate}g`, action: { type: "sell_all_fish" } });
      }
      navItems.push({ label: "返回", action: { type: "back" } });
      bagMenu.groups.push({ label: "操作", category: "system", items: navItems });
      setAndSavePendingMenu(player, bagMenu);
      try {
        await sendMenuImage(message, bagMenu, "背包");
      } catch {
        const allItems = bagMenu.groups.flatMap((g) => g.items);
        const text = allItems.map((it, i) => `${i + 1}. ${it!.label}${it!.description ? " - " + it!.description : ""}`).join("\n");
        return `背包管理：\n${text}`;
      }
      return "";
    }
    case "open_equip": {
      const eqMenu = buildEquipMenu(player);
      // Add back navigation
      eqMenu.groups.push({ label: "导航", category: "system", items: [{ label: "返回", action: { type: "back" } }] });
      setAndSavePendingMenu(player, eqMenu);
      await sendMenuImage(message, eqMenu);
      return "";
    }
    case "open_skills": {
      // Group skills by category and surface resource cost + cooldown.
      const resolved = player.unlockedSkillIds
        .map((id) => DEFAULT_MMORPG_CONTENT.skills[id])
        .filter((sk): sk is NonNullable<typeof sk> => Boolean(sk));
      const byCat = (cat: "active" | "passive" | "utility") =>
        resolved.filter((sk) => sk.category === cat)
          .map((sk) => ({ label: sk.name, description: formatSkillSummary(sk), action: { type: "view_skill" as const, targetId: sk.id } }));
      const activeItems = byCat("active");
      const passiveItems = byCat("passive");
      const utilityItems = byCat("utility");
      const navItems: PendingMenuItem[] = [
        { label: "公会系统", action: { type: "open_guild" } },
        { label: "成就列表", action: { type: "open_achievements" } },
        { label: "返回", action: { type: "back" } },
      ];
      const groups: MenuGroup[] = [];
      if (activeItems.length) groups.push({ label: `主动（${activeItems.length}）`, category: "combat", items: activeItems });
      if (passiveItems.length) groups.push({ label: `被动（${passiveItems.length}）`, category: "interact", items: passiveItems });
      if (utilityItems.length) groups.push({ label: `辅助（${utilityItems.length}）`, category: "interact", items: utilityItems });
      groups.push({ label: "导航", category: "system", items: navItems });
      const subMenu: PendingMenu = {
        context: `已解锁 ${player.unlockedSkillIds.length}（主动 ${activeItems.length} · 被动 ${passiveItems.length} · 辅助 ${utilityItems.length}）`,
        title: "技能与更多",
        groups,
        createdAt: new Date().toISOString(),
      };
      setAndSavePendingMenu(player, subMenu);
      await sendMenuImage(message, subMenu);
      return "";
    }
    case "open_guild": {
      const groups: MenuGroup[] = [];
      if (player.guildId) {
        const guild = rt.stateStore!.getGuild(player.guildId);
        if (guild) {
          groups.push({ label: "我的公会", category: "interact", items: [
            { label: guild.name, description: `成员 ${guild.memberUserIds.length}，金库 ${guild.treasury.gold ?? 0}`, action: { type: "noop" } },
            { label: "捐赠金币", action: { type: "guild_donate", extra: { amount: "100" } } },
            { label: "离开公会", action: { type: "guild_leave" } },
          ] });
        }
      } else {
        groups.push({ label: "操作", category: "system", items: [
          { label: "创建公会", action: { type: "guild_create" } },
        ] });
        const allGuilds = Object.values(rt.stateStore!.getState().guilds);
        if (allGuilds.length > 0) {
          groups.push({ label: "可加入", category: "interact", items: allGuilds.map((g) => ({
            label: g.name, description: `${g.memberUserIds.length}人`, action: { type: "guild_join" as const, extra: { name: g.name } },
          })) });
        }
      }
      groups.push({ label: "导航", category: "system", items: [{ label: "返回", action: { type: "back" } }] });
      const subMenu: PendingMenu = { context: "公会", title: "公会系统", groups, createdAt: new Date().toISOString() };
      setAndSavePendingMenu(player, subMenu);
      await sendMenuImage(message, subMenu);
      return "";
    }
    case "open_achievements": {
      const achItems: PendingMenuItem[] = Object.values(DEFAULT_MMORPG_CONTENT.achievements).map((ach) => {
        const status = getAchievementStatus(player, ach.id);
        const statusDesc = status === "claimed" ? "已领取" : status === "unlocked" ? "可领取 ✓" : "未解锁";
        if (status === "unlocked") {
          return {
            label: `💰 ${ach.name}`,
            description: `${ach.description} · ${statusDesc} · ${ach.rewardCoins}g`,
            action: { type: "claim_achievement" as const, targetId: ach.id },
          };
        }
        return {
          label: ach.name,
          description: `${ach.description} · ${statusDesc} · ${ach.rewardCoins}g`,
          action: { type: "view_achievement" as const, targetId: ach.id },
        };
      });
      const subMenu: PendingMenu = {
        context: "成就",
        title: "成就列表",
        groups: [
          { label: "成就", category: "interact", items: achItems },
          { label: "导航", category: "system", items: [{ label: "返回", action: { type: "back" } }] },
        ],
        createdAt: new Date().toISOString(),
      };
      setAndSavePendingMenu(player, subMenu);
      await sendMenuImage(message, subMenu);
      return "";
    }
    case "back": {
      const menu = buildLocationMenu(player);
      setAndSavePendingMenu(player, menu);
      await sendMenuImage(message, menu);
      return "";
    }
    case "recover_gold": {
      if (!player.deathMarker) {
        return "你没有需要拾回的金币。";
      }
      const deathArea = requireArea(player.deathMarker.areaId);
      if (player.areaId !== player.deathMarker.areaId) {
        player.areaId = player.deathMarker.areaId;
      }
      const recoverAmount = Math.floor(player.deathMarker.goldDropped * MMORPG_RULEBOOK.monster.deathGoldRecoverRate);
      const profile = rt.store.getUserData(player.userId);
      profile.coins += recoverAmount;
      rt.store.saveUserData(player.userId, profile);
      player.currencies.gold = profile.coins;
      player.deathMarker = undefined;
      savePlayer(player);
      return `你来到了 ${deathArea.name}，拾回了 ${recoverAmount} 金币。`;
    }
    case "open_quest_log": {
      updateQuestProgressFromState(player);
      savePlayer(player);
      const questMenu = buildQuestMenu(player);
      setAndSavePendingMenu(player, questMenu);
      try {
        const active = player.questLog.filter((e) => e.status === "active" || e.status === "completed");
        await sendDetailMenuImage(message, {
          title: "任务日志",
          context: `进行中 ${active.length} / 已交付 ${player.questLog.filter((e) => e.status === "turned_in").length}`,
          details: active.slice(0, 4).map((entry) => {
            const quest = DEFAULT_MMORPG_CONTENT.quests[entry.questId];
            return { label: quest?.name ?? entry.questId, value: entry.status === "completed" ? "已完成" : (quest ? quest.objectives.map((o) => `${o.type}${"count" in o ? ":" + o.count : ""}`).join(", ") : "") };
          }),
          menu: questMenu,
        });
      } catch {
        return "任务日志功能暂时不可用，请使用命令查看。";
      }
      return "";
    }
    case "view_fish_basket": {
      const fishCount = player.fishBasket.length;
      if (fishCount === 0) return "你的鱼篓是空的。";
      const items: PendingMenuItem[] = player.fishBasket.map((fi, i) => {
        const sp = DEFAULT_MMORPG_CONTENT.fishSpecies[fi.speciesId];
        return {
          label: `${i + 1}. ${fi.speciesName}`,
          description: `${fi.rarity} · ${fi.lengthCm}cm · ${fi.price}g`,
          action: { type: "noop" },
        };
      });
      const totalValue = player.fishBasket.reduce((sum, fi) => sum + fi.price, 0);
      items.push({ label: `出售全部鱼（总计 ${totalValue}g）`, action: { type: "sell_all_fish" } });
      items.push({ label: "返回", action: { type: "back" } });
      const subMenu: PendingMenu = {
        context: `${fishCount}条鱼 · 估值 ${totalValue}g`,
        title: "鱼篓",
        groups: [{ label: "鱼获", category: "interact", items }],
        createdAt: new Date().toISOString(),
      };
      setAndSavePendingMenu(player, subMenu);
      try {
        await sendMenuImage(message, subMenu);
      } catch {
        return formatFishBasket(player);
      }
      return "";
    }
    case "sell_all_fish": {
      if (player.fishBasket.length === 0) return "你的鱼篓是空的，没有鱼可卖。";
      const result = sellFish(player, "all", ctx);
      savePlayer(player);
      // Re-open bag menu after selling
      const bagMenu = buildBagMenu(player);
      setAndSavePendingMenu(player, bagMenu);
      try {
        await sendMenuImage(message, bagMenu, "背包");
      } catch { /* ignore */ }
      return `卖鱼完成！${result}\n已返回背包菜单。`;
    }
    case "claim_achievement": {
      const achievementId = action.targetId!;
      const result = claimAchievement(player, achievementId, (amount) => grantBridgedCoins(player.userId, amount, ctx));
      if (result.success) {
        savePlayer(player);
      }
      // Re-open achievements menu after claiming
      const achItems: PendingMenuItem[] = Object.values(DEFAULT_MMORPG_CONTENT.achievements).map((ach) => {
        const status = getAchievementStatus(player, ach.id);
        const statusDesc = status === "claimed" ? "已领取" : status === "unlocked" ? "可领取 ✓" : "未解锁";
        if (status === "unlocked") {
          return {
            label: `💰 ${ach.name}`,
            description: `${ach.description} · ${statusDesc} · ${ach.rewardCoins}g`,
            action: { type: "claim_achievement" as const, targetId: ach.id },
          };
        }
        return {
          label: ach.name,
          description: `${ach.description} · ${statusDesc} · ${ach.rewardCoins}g`,
          action: { type: "view_achievement" as const, targetId: ach.id },
        };
      });
      const subMenu: PendingMenu = {
        context: "成就",
        title: "成就列表",
        groups: [
          { label: "成就", category: "interact", items: achItems },
          { label: "导航", category: "system", items: [{ label: "返回", action: { type: "back" } }] },
        ],
        createdAt: new Date().toISOString(),
      };
      setAndSavePendingMenu(player, subMenu);
      try {
        await sendMenuImage(message, subMenu);
      } catch { /* ignore */ }
      return result.message;
    }
    case "claim_faction_reward": {
      const factionId = action.targetId!;
      const faction = DEFAULT_MMORPG_CONTENT.factions[factionId];
      if (!faction) throw new Error("未知阵营。");
      const rep = player.factionReputation[factionId] ?? 0;
      const result = claimFactionReward(player, factionId, rep);
      if (result.success) {
        grantBridgedCoins(player.userId, result.reward, ctx);
        savePlayer(player);
      }
      return result.message;
    }
    case "noop": return "该操作暂无实际效果。";
    default: return `未知操作类型：${(action as { type: string }).type}`;
  }
}
