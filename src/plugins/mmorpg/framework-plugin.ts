import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BotMessage,
  DataStorePlugin,
  InventoryPlugin,
  ItemDef as StoreItemDef,
  MenuPlugin,
  Plugin,
  PluginContext,
  SocialPlugin,
  WelfareRewardSystemPlugin,
} from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";
import { DEFAULT_MMORPG_CONTENT } from "./default-content.js";
import {
  MMORPG_RULEBOOK,
  calculateCombatPower,
  createBaseResources,
  createBaseStats,
  getExpRequiredForLevel,
  getMaxResources,
  summarizeFramework,
  affinityToPercent,
  applyRebirthBonus,
} from "./rulebook.js";
import type {
  AreaDef,
  ClassDef,
  FishCatch,
  FishRarity,
  FishSpeciesDef,
  InventoryEntry,
  MenuAction,
  MenuGroup,
  MonsterDef,
  ItemDef,
  NpcDef,
  PartyState,
  PendingMenu,
  PendingMenuItem,
  PlayerState,
  QuestDef,
  QuestObjective,
  QuestProgress,
  ResourceNodeDef,
  StatBlock,
  ValidationReport,
} from "./schema.js";
import { renderMenuToImage, renderDetailMenuToImage, renderBattleLogToImage, renderProfileCardToImage, renderTextCardToImage } from "./menu-renderer.js";
import { buildMenuHtml } from "./menu-templates.js";
import { MMORPGStateStore } from "./state-store.js";
import { validateMMORPGContent } from "./validator.js";
import {
  simulateBattle,
  formatBattleSummary,
  formatBattleLog,
  type BattleResult,
} from "./battle-simulator.js";
import { generateAndSaveImage, type ImageGenConfig } from "./image-gen-client.js";
import { convertImageToWebp, closeBrowser, screenshotHtml } from "./screenshot.js";
import { resolveDialogueTree, buildDialogueMenu, applyDialogueEffects } from "./dialogue-engine.js";
import {
  buildGuideMenu,
  checkGuideCompleted,
  checkGuideEnforcement,
  generateStarterRewards,
  getGuideStepDetails,
} from "./framework/guide.js";
import { formatWikiResults, searchWikiEntries } from "./framework/wiki.js";
import {
  buildAreaIndexMap,
  findPathBFS,
  formatPathWithIndices,
} from "./framework/pathfinding.js";
import {
  checkAchievementsOnAreaVisit,
  checkAchievementsOnDungeonClear,
  checkAchievementsOnFishCatch,
  checkAchievementsOnKill,
  checkAchievementsOnLevelUp,
  checkAchievementsOnMarriage,
  checkAchievementsOnPartyJoin,
  checkAchievementsOnProfessions,
  checkAchievementsOnReputations,
  claimAchievement,
  formatAchievementLabel,
  formatNewlyUnlocked,
  getAchievementStatus,
  unlockAchievements,
} from "./framework/achievements.js";
import {
  describeArea,
  describeFaction,
  describeFishSpecies,
  describeItem,
  describeMonster,
  describeNpc,
  describeObjective,
  describeProfession,
  describeQuest,
  describeResourceNode,
  formatFishCatch,
  formatFishingStatusText,
  formatFishRarity,
  getRarityRank,
} from "./framework/descriptions.js";
import {
  formatMailDetail,
  formatMailList,
  formatMailSent,
} from "./framework/mail.js";
import {
  calculateDailyBossRewards,
  createDailyBoss,
  formatWorldStatus,
  isDailyBossDefeated,
  markDailyBossDefeated,
} from "./framework/world.js";
import {
  calculateFactionReward,
  canClaimFactionReward,
  claimFactionReward,
  getNextReputationTier,
  getReputationTierName,
} from "./framework/factions.js";
import {
  makeTool,
  ensureContext,
  resolveInputUserId,
  requireString,
  optionalString,
  normalizeOptionalUserId,
  decodeTextToken,
  randomInt,
  randomFloat,
  roundToOneDecimal,
  clamp,
  isFormation,
  formatPercent,
  getObjectiveKey,
  getObjectiveTarget,
  formatValidationReport,
} from "./framework/utils.js";
import {
  formatCreationOptions,
  buildCreateOptionsMenu,
  buildFieldErrorMenu,
  formatMMOInventory,
  formatFishBasket,
  formatQuestStatus,
  formatQuestObjectives,
  formatConnectedAreaNames,
  formatConnectedAreaNamesWithIndices,
  formatAreaSummary,
  formatWorldMapOverview,
} from "./framework/format.js";
import {
  getAreaTier,
  buildWorldMapSvg,
} from "./framework/world-map.js";
import {
  rt, initRuntime, setRuntimeContext, setRuntimeStateStore, setRuntimeValidationReport,
} from "./framework/runtime.js";
import {
  savePlayer, getExistingPlayer, requirePlayer, requirePlayerFromMessage,
  requireRace, requireClass, requireArea, requireGender,
  requireNpc, requireQuest, requireMonster, requireResourceNode,
  requireFishSpecies, requireLocalNpc, getQuestProgress,
} from "./framework/player-access.js";
import {
  isPlayerInCombat, setCombatLock, releaseCombatLock, requireNotInCombat,
  isSafeArea, isPlayerTravelling, setTravelLock, requireNotTravelling,
  countActivePlayersInArea, checkMonsterPool, recordMonsterKill,
  checkResourcePool, recordResourceGather,
  healPlayer, handlePlayerDeath, getDeathPosition,
} from "./framework/combat.js";
import {
  assertClassUnlocked, buildCharacterStats, getBaseItemId,
  getItemBaseStats, getPlayerEffectiveStats, calculatePlayerCombatPower,
  formatPlayerSnapshot, describeInstanceOrItem, formatItemDetail, statsFrom,
  formatSkillSummary, formatSkillDetail, getMaxSkillSlots, formatSkillCompare,
} from "./framework/stats.js";
import {
  equipSkill, unequipSkill, getUnequippedSkills,
  autoFillEmptySlots, formatSkillSlotStatus, isEquipableSkill,
} from "./framework/skill-slots.js";
import {
  syncPlayerEconomy, grantBridgedCoins, consumeFrameworkItem,
  validateMarriageEligibility, findProposal, resolvePartyForPlayer,
  getPlayerItemQuantity, addPlayerItem, removePlayerItem,
} from "./framework/economy.js";
import {
  applyRewardBonuses, getLevelDecayMultiplier, grantExperience, getActiveBonuses,
} from "./framework/progression.js";
import {
  getObjectiveCounter, updateQuestProgressFromState, refreshQuestProgress,
  markTalkProgress, incrementKillProgress, canAcceptQuest,
  getLocalAvailableQuests, formatLocalNpcList, formatNpcDetail,
  formatQuestJournal, acceptQuest, turnInQuest, abandonQuest, gatherResource,
  resolveLocalMonster, resolveLocalResourceNode,
} from "./framework/quest.js";
import {
  getFishSpeciesForArea, handleFishing, sellFish, rollFishCatch,
  weightedPickRarity, calculateFishPrice, formatFishingStatus,
} from "./framework/fishing.js";
import {
  buildLocationMenu, buildNpcMenu, buildBagMenu, buildQuestMenu,
  buildEquipMenu, flattenMenuGroups, buildProfileDetails, buildProfileMenu,
  formatMarriageStatus, formatPartyStatus,
} from "./framework/menus.js";
import {
  createCharacter, movePlayerToArea, formatAreaStatus,
} from "./framework/character.js";
import {
  resolveMessageTarget, sendMenuImage, sendDetailMenuImage, replyCard,
  setAndSavePendingMenu,
} from "./framework/messenger.js";
import { startBattle } from "./framework/battle.js";
import { dispatchMenuAction } from "./framework/actions.js";

type MMORPGFrameworkPlugin = Plugin & {
  getToolRegistrations: () => BotToolRegistration[];
  flush: () => void;
};

export function createMMORPGFrameworkPlugin(
  store: DataStorePlugin,
  inventory: InventoryPlugin,
  social: SocialPlugin,
  menuPlugin: MenuPlugin,
  welfare?: WelfareRewardSystemPlugin
): MMORPGFrameworkPlugin {
  let ctxRef: PluginContext | null = null;
  let stateStore: MMORPGStateStore | null = null;
  let validationReport: ValidationReport = validateMMORPGContent(DEFAULT_MMORPG_CONTENT);

  const STARTER_AREA_ID = "starter_village";

  // In-memory battle log storage (userId → last battle result)
  const battleLogStore = rt.battleLogStore;

  // In-memory portrait generation rate limit (userId → last generation timestamp ms)
  const portraitRateLimitMap = new Map<string, number>();

  // In-memory combat lock (userId → timestamp when the battle ends)
  // While the lock is active, the player cannot perform most actions.
  const combatLock = new Map<string, number>();

  // ── Travel lock (multi-step movement) ────────────────────────────
  const travelLock = new Map<string, number>();

  // ── pathfinding helpers are imported from ./framework/pathfinding.js ──
  /**
   * Count distinct players currently located in the given area.
   * Used to scale monster pool refresh rate.
   */
  /**
   * Check whether the monster pool for an area still has available monsters.
   *
   * The pool model:
   * - Each area has a `poolSize` (number of monsters that can be alive at once).
   * - Each kill records a timestamp. Dead monsters regenerate after a refresh interval.
   * - The refresh interval shrinks when more players are active in the area,
   *   but never below `poolMinRefreshMinutes`.
   * - If all pool slots are occupied by un-refreshed kills, the pool is exhausted.
   */
  /**
   * Record a monster kill in the area's pool.
   * Must be called synchronously after battle simulation confirms a player victory
   * (not in the delayed reward callback) to prevent race conditions.
   */
  const plugin: MMORPGFrameworkPlugin = {
    name: "mmorpg-framework",
    description: "文字冒险 MMORPG 框架：先建号、全局共享账号态、婚姻与组队规则骨架",
    systemPromptAppend: [
      "文字冒险 MMORPG 框架已启用：玩家数据、公会、队伍、婚姻、拍卖行与邮件为全局共享账号态，不按群隔离。",
      "新用户必须先创建角色，之后才能进入 MMORPG 玩法。",
      "MMORPG 金币已与 Bot 经济系统桥接：Bot coins 是唯一真实余额，MMORPG gold 为同步镜像。",
      `婚姻系统要求双方 ${MMORPG_RULEBOOK.social.marriageRequiredLevel} 级以上、互相亲密度至少 ${affinityToPercent(MMORPG_RULEBOOK.social.marriageRequiredAffinity)}，并消耗誓约戒指。`,
      "婚姻基础加成为经验与金币各 +5%，若夫妻处于同一队伍，则该婚姻加成提升为 +30%。所有加成结果均向下取整。",
      `最高等级 ${MMORPG_RULEBOOK.progression.maxLevel} 级，满级后可轮回（最多 ${MMORPG_RULEBOOK.rebirth.maxRebirths} 次），每次轮回重置等级但永久提升基础属性。`,
      `每日最多赠送 ${MMORPG_RULEBOOK.affinity.dailyGiftLimit} 个礼物。好感度会随时间缓慢衰减。`,
    ].join("\n"),

    async onLoad(ctx) {
      ctxRef = ctx;
      stateStore = new MMORPGStateStore(path.resolve(process.cwd(), ctx.config.pluginSettings.mmorpgFramework.dataFile));
      validationReport = validateMMORPGContent(DEFAULT_MMORPG_CONTENT);
      registerFrameworkItems();
      // Initialize the runtime singleton so extracted framework modules can
      // access the shared dependencies/state without closure coupling.
      initRuntime(store, inventory, social, menuPlugin, welfare ?? null);
      setRuntimeContext(ctx);
      setRuntimeStateStore(stateStore);
      setRuntimeValidationReport(validationReport);

      if (ctx.config.pluginSettings.mmorpgFramework.autoValidateOnLoad) {
        if (validationReport.errors.length > 0) {
          console.error("[MMORPG] 内容校验失败:", validationReport.errors);
        } else {
          console.log(`[MMORPG] 内容校验通过，种族 ${validationReport.stats.races}，职业 ${validationReport.stats.classes}，任务 ${validationReport.stats.quests}`);
        }
      }

      async function handleLocationMenu(message: BotMessage, ctx: PluginContext) {
        const player = requirePlayerFromMessage(message, true);
        if (!checkGuideCompleted(player)) {
          const menu = buildGuideMenu(player, 0);
          setAndSavePendingMenu(player, menu);
          try {
            await sendDetailMenuImage(message, {
              title: menu.title,
              context: menu.context,
              details: getGuideStepDetails(0),
              menu,
            });
          } catch {
            const text = getGuideStepDetails(0).map((d) => `${d.label}: ${d.value}`).join("\n");
            await ctx.replyText(message, `新手引导：\n${text}\n\n请输入 $mmo-pick 1 进行下一步`);
          }
          return;
        }
        const menu = buildLocationMenu(player);
        setAndSavePendingMenu(player, menu);
        try {
          const areaIdxMap = buildAreaIndexMap(menu);
          await sendDetailMenuImage(message, {
            title: requireArea(player.areaId).name,
            context: `推荐 Lv.${requireArea(player.areaId).recommendedLevel[0]}-${requireArea(player.areaId).recommendedLevel[1]}`,
            details: [
              { label: "描述", value: requireArea(player.areaId).description },
              { label: "推荐等级", value: `${requireArea(player.areaId).recommendedLevel[0]}-${requireArea(player.areaId).recommendedLevel[1]}` },
              { label: "阵营", value: requireArea(player.areaId).factionId ? describeFaction(requireArea(player.areaId).factionId!) : "无" },
              { label: "可前往", value: formatConnectedAreaNamesWithIndices(requireArea(player.areaId), areaIdxMap) },
            ],
            menu,
          });
        } catch {
          await ctx.replyText(message, formatAreaStatus(player));
        }
      }

      menuPlugin.registerCommand("mmo", "查看新手引导或当前位置（图片菜单）", async (message, args, ctx) => {
        await handleLocationMenu(message, ctx);
      });

      menuPlugin.registerCommand("mmo-framework", "查看文字冒险 MMORPG 框架摘要", async (message) => {
        const lines = [
          ...summarizeFramework(DEFAULT_MMORPG_CONTENT).map((line) => `- ${line}`),
          "- 角色创建字段：种族、职业、性别、外貌、个人宣言。",
          "- 组队设计：最多 5 人，额外成员与职业多样性提供额外经验/金币加成。",
          "- 婚姻设计：常驻 +5%，夫妻同队时婚姻加成提升到 +30%。",
          `- 内容校验：${validationReport.errors.length === 0 ? "通过" : `失败 ${validationReport.errors.length} 项`}`,
        ];
        await replyCard(message, "MMORPG 框架摘要", lines.join("\n"));
      });

      // ── 数据迁移命令：重置所有玩家进度并发放补偿经验瓶 ──
      menuPlugin.registerCommand("mmo-migrate-reset", "[管理员] 重置所有玩家进度，发放补偿经验瓶", async (message) => {
        if (!stateStore) {
          await replyCard(message as never, "迁移失败", "状态存储未初始化。");
          return;
        }
        const result = stateStore.migrateResetAllPlayers();
        stateStore.flush();
        await replyCard(
          message as never,
          "数据迁移完成",
          `已重置 ${result.reset} 位玩家的进度。\n跳过（已迁移）：${result.skipped} 位。\n\n所有玩家需要重新完成新手引导以获取补偿经验瓶。`,
        );
      });

      menuPlugin.registerCommand("mmo-wiki", `查看游戏百科说明：${menuPlugin.getPrefix()}mmo-wiki <关键词>`, async (message, args) => {
        const query = args.join(" ").trim();
        if (!query) {
          const entries = Object.values(DEFAULT_MMORPG_CONTENT.wikiEntries);
          const categories = new Map<string, string[]>();
          for (const entry of entries) {
            const cat = entry.category ?? "其他";
            if (!categories.has(cat)) categories.set(cat, []);
            categories.get(cat)!.push(entry.title);
          }
          const lines = [
            `可使用 ${menuPlugin.getPrefix()}mmo-wiki <关键词> 搜索具体条目，例如：${menuPlugin.getPrefix()}mmo-wiki 强化`,
            "",
            ...Array.from(categories.entries()).map(([cat, titles]) => `【${cat}】${titles.join("、")}`),
          ];
          await replyCard(message, "游戏百科目录", lines.join("\n"));
          return;
        }
        const results = searchWikiEntries(query);
        await replyCard(message, `百科：${query}`, formatWikiResults(query, results));
      });

      menuPlugin.registerCommand("mmo-create-options", "查看可创建的种族、职业与性别选项（图片菜单）", async (message) => {
        try {
          await sendMenuImage(message as never, buildCreateOptionsMenu());
        } catch {
          await replyCard(message, "角色创建选项", formatCreationOptions());
        }
      });

      menuPlugin.registerCommand("mmo-create", `创建角色：${menuPlugin.getPrefix()}mmo-create <raceId> <classId> <genderId> <appearance> [personalDeclaration...]`, async (message, args) => {
        await handleCreateCharacterCommand(message, args, ctx, "mmo-create");
      });

      menuPlugin.registerCommand("mmo-create-character", `创建角色（别名）：${menuPlugin.getPrefix()}mmo-create-character <raceId> <classId> <genderId> <appearance> [personalDeclaration...]`, async (message, args) => {
        await handleCreateCharacterCommand(message, args, ctx, "mmo-create-character");
      });

      menuPlugin.registerCommand("mmo-profile", "查看角色档案（图片卡片），可指定玩家：$mmo-profile [@用户/用户ID]", async (message, args) => {
        const targetUserId = args?.length > 0 ? normalizeOptionalUserId(args[0]) ?? message.userId : message.userId;
        if (!targetUserId) {
          await replyCard(message as never, "角色档案", "无法确定用户身份。");
          return;
        }
        const sender = requirePlayerFromMessage(message);
        const player = getExistingPlayer(targetUserId);
        if (!player) {
          if (targetUserId === message.userId) {
            await replyCard(message as never, "角色档案", `你还没有创建角色。先使用 ${menuPlugin.getPrefix()}mmo-create 创建角色。`);
          } else {
            await replyCard(message as never, "角色档案", "该用户还没有创建 MMORPG 角色。");
          }
          return;
        }
        const menu = buildProfileMenu(player);
        setAndSavePendingMenu(sender, menu);
        syncPlayerEconomy(player.userId, player);

        // Read portrait as base64 data URI if available
        let portraitSrc: string | undefined;
        if (player.portraitPath && fs.existsSync(player.portraitPath)) {
          const imgData = fs.readFileSync(player.portraitPath);
          const ext = path.extname(player.portraitPath).slice(1) || "png";
          const mime = ext === "webp" ? "image/webp" : "image/png";
          portraitSrc = `data:${mime};base64,${imgData.toString("base64")}`;
        }

        let renderSuccess = false;
        try {
          const race = DEFAULT_MMORPG_CONTENT.races[player.raceId];
          const cls = DEFAULT_MMORPG_CONTENT.classes[player.classId];
          const gender = DEFAULT_MMORPG_CONTENT.genders[player.genderId];
          const expNeeded = getExpRequiredForLevel(player.level);
          const eff = getPlayerEffectiveStats(player);
          const effRes = getMaxResources(eff);
          const STAT_LABELS: Record<string, string> = { strength: "力量", defense: "防御", charm: "魅力", agility: "敏捷", eloquence: "口才", endurance: "耐力", life: "生命" };
          const formatStat = (key: keyof StatBlock) => {
            const base = player.stats[key];
            const bonus = eff[key] - base;
            return bonus > 0 ? `${base} (+${bonus})` : `${base}`;
          };

          const imgPath = await renderProfileCardToImage({
            title: `${race?.name ?? ""} ${cls?.name ?? ""}`.trim() || player.userId,
            level: `Lv.${player.level}${player.rebirthCount > 0 ? ` (轮回${player.rebirthCount})` : ""}`,
            charInfo: [
              { label: "种族", value: race?.name ?? player.raceId },
              { label: "职业", value: `${cls?.name ?? player.classId} | ${gender?.name ?? player.genderId}` },
              { label: "位置", value: describeArea(player.areaId) },
              { label: "外观", value: player.appearance },
            ],
            stats: [
              ...(["strength", "defense", "charm", "agility", "eloquence", "endurance", "life"] as const).map((key) => ({
                label: STAT_LABELS[key],
                value: formatStat(key),
              })),
              { label: "HP", value: `${player.resources.hp}/${effRes.maxHp}` },
              { label: "Focus", value: `${player.resources.focus}/${effRes.maxFocus}` },
              { label: "Stamina", value: `${player.resources.stamina}/${effRes.maxStamina}` },
              { label: "经验", value: `${player.exp}/${expNeeded}` },
              { label: "金币", value: String(player.currencies.gold) },
              { label: "战力", value: String(calculatePlayerCombatPower(player)) },
            ],
            portraitSrc,
            groups: menu.groups,
          }, process.cwd());

          const target = resolveMessageTarget(message);
          await ctx.sendImage(target, imgPath);
          renderSuccess = true;
        } catch (err) {
          console.error("[MMORPG] Profile card render failed:", err);
          await ctx.replyText(message, formatPlayerSnapshot(player));
        }
        // 无论图片渲染成功与否，确保 pendingMenu 已设定到消息发送者。
        setAndSavePendingMenu(sender, menu);
        if (renderSuccess) {
          console.log(`[MMORPG] Profile sent OK for ${targetUserId}, menu items: ${menu.groups.reduce((s, g) => s + g.items.length, 0)}`);
        }
      });

      menuPlugin.registerCommand("mmo-location", "查看当前位置与区域详情（图片菜单）", async (message, args, ctx) => {
        await handleLocationMenu(message, ctx);
      });

      menuPlugin.registerCommand("mmo-map", `查看世界地图或指定区域：${menuPlugin.getPrefix()}mmo-map [areaId]`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        const requestedAreaId = args[0]?.trim();

        if (requestedAreaId) {
          const area = requireArea(requestedAreaId);
          const groups: MenuGroup[] = [];

          // 连接区域
          if (area.connectedAreaIds.length > 0) {
            const moveItems: PendingMenuItem[] = area.connectedAreaIds
              .map((id) => DEFAULT_MMORPG_CONTENT.areas[id])
              .filter((a): a is NonNullable<typeof a> => !!a)
              .map((a) => ({
                label: a.name,
                description: `Lv.${a.recommendedLevel[0]}-${a.recommendedLevel[1]}`,
                action: { type: "move" as const, targetId: a.id },
              }));
            if (moveItems.length) groups.push({ label: "可前往", category: "move", items: moveItems });
          }

          // 怪物
          if (area.monsterIds.length > 0) {
            const items: PendingMenuItem[] = area.monsterIds
              .map((id) => DEFAULT_MMORPG_CONTENT.monsters[id])
              .filter((m): m is NonNullable<typeof m> => !!m)
              .map((m) => ({ label: m.name, description: `Lv.${m.level}`, action: { type: "hunt" as const, targetId: m.id } }));
            if (items.length) groups.push({ label: "怪物", category: "combat", items });
          }

          // NPC
          if (area.npcIds.length > 0) {
            const items: PendingMenuItem[] = area.npcIds
              .map((id) => DEFAULT_MMORPG_CONTENT.npcs[id])
              .filter((n): n is NonNullable<typeof n> => !!n)
              .map((n) => ({ label: n.name, description: n.role, action: { type: "talk" as const, targetId: n.id } }));
            if (items.length) groups.push({ label: "NPC", category: "talk", items });
          }

          // 资源点
          if (area.resourceNodeIds.length > 0) {
            const items: PendingMenuItem[] = area.resourceNodeIds
              .map((id) => DEFAULT_MMORPG_CONTENT.resourceNodes[id])
              .filter((n): n is NonNullable<typeof n> => !!n)
              .map((n) => ({ label: `采集 ${n.name}`, description: describeProfession(n.professionId), action: { type: "gather" as const, targetId: n.id } }));
            if (items.length) groups.push({ label: "资源", category: "interact", items });
          }

          if (groups.length === 0) {
            await replyCard(message as never, "区域详情", formatAreaSummary(area));
            return;
          }

          const menu: PendingMenu = {
            context: `推荐 Lv.${area.recommendedLevel[0]}-${area.recommendedLevel[1]}`,
            title: area.name,
            groups,
            createdAt: new Date().toISOString(),
          };
          setAndSavePendingMenu(player, menu);
          try {
            const areaIdxMap = buildAreaIndexMap(menu);
            await sendDetailMenuImage(message, {
              title: area.name,
              context: `推荐 Lv.${area.recommendedLevel[0]}-${area.recommendedLevel[1]}`,
              details: [
                { label: "描述", value: area.description },
                { label: "阵营", value: area.factionId ? describeFaction(area.factionId) : "无" },
                { label: "连接", value: formatConnectedAreaNamesWithIndices(area, areaIdxMap) },
              ],
              menu,
            });
          } catch {
            await replyCard(message as never, "区域详情", formatAreaSummary(area));
          }
          return;
        }

        // 世界地图：列出当前等级区可见的区域作为可交互菜单
        const currentArea = requireArea(player.areaId);
        const currentTier = getAreaTier(currentArea);

        // BFS to get the visible areas for the local map
        const depths = new Map<string, number>();
        depths.set(player.areaId, 0);
        const queue = [player.areaId];
        while (queue.length > 0) {
          const id = queue.shift()!;
          const d = depths.get(id)!;
          const area = DEFAULT_MMORPG_CONTENT.areas[id];
          if (!area) continue;
          if (getAreaTier(area) !== currentTier) continue;
          for (const nid of area.connectedAreaIds) {
            if (!depths.has(nid) && DEFAULT_MMORPG_CONTENT.areas[nid]) {
              depths.set(nid, d + 1);
              queue.push(nid);
            }
          }
        }

        const allAreas = Object.values(DEFAULT_MMORPG_CONTENT.areas);
        const groups: MenuGroup[] = [];

        // 当前区域 & 快捷操作
        const quickItems: PendingMenuItem[] = [
          { label: `${currentArea.name}（当前）`, description: `Lv.${currentArea.recommendedLevel[0]}-${currentArea.recommendedLevel[1]}`, action: { type: "move", targetId: currentArea.id } },
        ];
        if (player.areaId !== STARTER_AREA_ID) {
          const starter = requireArea(STARTER_AREA_ID);
          quickItems.push({ label: `返回${starter.name}`, description: "安全区域，HP 完全恢复", action: { type: "move", targetId: STARTER_AREA_ID } });
        }
        if (player.deathMarker) {
          quickItems.push({ label: "拾回掉落金币", description: `前往死亡地点`, action: { type: "recover_gold" } });
        }
        groups.push({ label: "快捷", category: "system", items: quickItems });

        // 只列出在地图上可见的其它区域（排除当前区域）
        const otherAreas = allAreas.filter((a) => a.id !== player.areaId && depths.has(a.id));
        if (otherAreas.length > 0) {
          const areaItems: PendingMenuItem[] = otherAreas.map((a) => {
            const isGateway = getAreaTier(a) !== currentTier;
            const labelText = isGateway ? `[跨区] 前往 ${a.name}` : `前往 ${a.name}`;
            return {
              label: labelText,
              description: `Lv.${a.recommendedLevel[0]}-${a.recommendedLevel[1]}`,
              action: { type: "move" as const, targetId: a.id },
            };
          });
          groups.push({ label: "可前往区域", category: "move", items: areaItems });
        }

        const menu: PendingMenu = {
          context: `当前位置：${currentArea.name}`,
          title: "世界地图",
          groups,
          createdAt: new Date().toISOString(),
        };
        setAndSavePendingMenu(player, menu);
        try {
          // Map each area to its selection sequence number (1-based index in the rendered menu)
          const areaIndexMap = new Map<string, number>();
          areaIndexMap.set(player.areaId, 1);
          otherAreas.forEach((a, i) => {
            areaIndexMap.set(a.id, quickItems.length + i + 1);
          });

          const svg = buildWorldMapSvg(player.areaId, areaIndexMap, 760, 660);
          const menuHtml = buildMenuHtml(menu);

          // Extract style block from menuHtml to preserve dark theme colors
          const styleMatch = menuHtml.match(/<style>([\s\S]*?)<\/style>/);
          const menuStyle = styleMatch ? styleMatch[1] : "";

          // Extract body content from menuHtml and combine with SVG
          const menuBodyMatch = menuHtml.match(/<body>([\s\S]*?)<\/body>/);
          const menuBody = menuBodyMatch ? menuBodyMatch[1] : "";
          const combinedHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
${menuStyle}
.wm { background: #0f1117; padding: 16px 20px; width: 800px; box-sizing: border-box; }
.wm-graph { display: block; margin: 0 auto 12px; max-width: 100%; height: auto; }
.m { width: 100% !important; max-width: 760px; margin: 0 auto; display: grid; grid-template-columns: repeat(3, 1fr); column-gap: 20px; row-gap: 8px; }
.hd, .ft, .inf, .gh { grid-column: 1 / -1; }
</style></head>
<body>
<div class="wm">
<div class="wm-graph">${svg}</div>
${menuBody}
</div>
</body></html>`;
          const tmpDir = path.resolve("mmorpg-menus");
          fs.mkdirSync(tmpDir, { recursive: true });
          const imagePath = path.join(tmpDir, `worldmap-${Date.now()}.webp`);
          await screenshotHtml(combinedHtml, imagePath, { width: 800, format: "webp", quality: 85 });
          const target = resolveMessageTarget(message);
          await ctxRef!.sendImage(target, imagePath);
        } catch {
          await ctx.replyText(message, formatWorldMapOverview());
        }
      });

      menuPlugin.registerCommand("mmo-back", `返回 ${requireArea(STARTER_AREA_ID).name}（根据距离消耗时间）`, async (message) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        if (player.areaId === STARTER_AREA_ID) {
          await replyCard(message as never, "返回", `你已经在 ${requireArea(STARTER_AREA_ID).name}。`);
          return;
        }
        const fullPath = findPathBFS(
          player.areaId,
          STARTER_AREA_ID,
          DEFAULT_MMORPG_CONTENT.areas,
          MMORPG_RULEBOOK.travel.maxPathSteps,
        );
        if (!fullPath) {
          const currentArea = requireArea(player.areaId);
          throw new Error(`从 ${currentArea.name} 无法找到返回 ${requireArea(STARTER_AREA_ID).name} 的路径。`);
        }
        const steps = fullPath.length - 1;
        const totalSeconds = Math.max(steps, 1) * MMORPG_RULEBOOK.travel.baseSecondsPerStep;
        setTravelLock(player.userId, totalSeconds * 1000 + 5000);
        const target = resolveMessageTarget(message);
        const durLabel = totalSeconds < 60 ? `${totalSeconds}秒` : `${Math.floor(totalSeconds / 60)}分${totalSeconds % 60}秒`;
        (async () => {
          try {
            await ctx.sendMessage(target, `🚶 开始返回 ${requireArea(STARTER_AREA_ID).name}，距离 ${steps} 步，预计 ${durLabel} 后到达。`);
            await new Promise((r) => setTimeout(r, totalSeconds * 1000));
            const freshPlayer = getExistingPlayer(player.userId);
            if (!freshPlayer) return;
            freshPlayer.areaId = STARTER_AREA_ID;
            healPlayer(freshPlayer);
            savePlayer(freshPlayer);
            await ctx.sendMessage(target, `🎯 你回到了 ${requireArea(STARTER_AREA_ID).name}，HP 已完全恢复。`);
          } catch (err) {
            await ctx.sendMessage(target, `返回途中出错：${err instanceof Error ? err.message : String(err)}`);
          } finally {
            rt.travelLock.delete(player.userId);
          }
        })();
        await replyCard(message as never, "返回", `🚶 开始返回 ${requireArea(STARTER_AREA_ID).name}，预计 ${durLabel} 后到达。`);
      });

      menuPlugin.registerCommand("mmo-guide", `查询前往某地点的路线：${menuPlugin.getPrefix()}mmo-guide <地点名称>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        const keyword = args.join("").trim();
        if (!keyword) {
          await replyCard(message as never, "路线指引", `用法：${menuPlugin.getPrefix()}mmo-guide <地点名称>\n例如：${menuPlugin.getPrefix()}mmo-guide 低语森林`);
          return;
        }
        const areas = DEFAULT_MMORPG_CONTENT.areas;
        const matches = Object.values(areas).filter((a) => a.name.includes(keyword));
        if (matches.length === 0) {
          await replyCard(message as never, "路线指引", `未找到名称包含"${keyword}"的地点。`);
          return;
        }
        if (matches.length > 1) {
          const list = matches.map((a) => `  · ${a.name}`).join("\n");
          await replyCard(message as never, "路线指引", `找到多个匹配的地点：\n${list}\n\n请指定更精确的名称。`);
          return;
        }
        const target = matches[0];
        if (target.id === player.areaId) {
          await replyCard(message as never, "路线指引", `你现在就在 **${target.name}**。`);
          return;
        }
        if (areas[player.areaId].connectedAreaIds.includes(target.id)) {
          await replyCard(message as never, "路线指引", `**${target.name}** 与当前区域相连，可以直接前往。`);
          return;
        }
        const fullPath = findPathBFS(player.areaId, target.id, areas, MMORPG_RULEBOOK.travel.maxPathSteps);
        if (!fullPath) {
          await replyCard(message as never, "路线指引", `从当前位置无法到达 **${target.name}**。`);
          return;
        }
        const pathText = fullPath.map((id) => areas[id]?.name ?? id).join(" → ");
        const steps = fullPath.length - 1;
        await replyCard(message as never, "路线指引", [
          `📍 前往 **${target.name}** 的路线：`,
          ``,
          `${pathText}`,
          ``,
          `共 ${steps} 步，预计耗时 ${steps * MMORPG_RULEBOOK.travel.baseSecondsPerStep} 秒。`,
          `可使用移动菜单或 ${menuPlugin.getPrefix()}mmo-move <序号> 前往。`,
        ].join("\n"));
      });

      menuPlugin.registerCommand("mmo-recover", `前往死亡地点拾回部分掉落金币`, async (message) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        if (!player.deathMarker) {
          await replyCard(message as never, "拾回金币", "你没有需要拾回的金币。");
          return;
        }
        const deathArea = requireArea(player.deathMarker.areaId);
        if (player.areaId !== player.deathMarker.areaId) {
          player.areaId = player.deathMarker.areaId;
          savePlayer(player);
        }
        const recoverAmount = Math.floor(player.deathMarker.goldDropped * MMORPG_RULEBOOK.monster.deathGoldRecoverRate);
        const profile = store.getUserData(player.userId);
        profile.coins += recoverAmount;
        store.saveUserData(player.userId, profile);
        player.currencies.gold = profile.coins;
        player.deathMarker = undefined;
        savePlayer(player);
        await replyCard(message as never, "拾回金币", `你来到了 ${deathArea.name}，拾回了 ${recoverAmount} 金币。`);
      });

      menuPlugin.registerCommand("mmo-bag", "查看 MMORPG 角色背包（图片菜单）", async (message) => {
        const player = requirePlayerFromMessage(message);
        const menu = buildBagMenu(player);
        if (menu.groups.length === 0) {
          await ctx.replyText(message, formatMMOInventory(player));
          return;
        }
        setAndSavePendingMenu(player, menu);
        try {
          const BAG_SLOT_LABELS: Record<string, string> = { weapon: "武器", offhand: "副手", head: "头部", body: "身体", legs: "腿部", accessory: "饰品" };
          const details = [
            { label: "物品数", value: String(player.inventory.length) },
            { label: "金币", value: String(player.currencies.gold) },
            { label: "鱼篓", value: `${player.fishBasket.length} 条` },
            ...(["weapon", "offhand", "head", "body", "legs", "accessory"] as const).map((slot) => ({
              label: BAG_SLOT_LABELS[slot],
              value: player.equipment[slot] ? describeInstanceOrItem(player, player.equipment[slot]!) : "—",
            })),
            ...(["weapon", "offhand", "head", "body", "legs", "accessory"] as const).map((slot) => ({
              label: `时装·${BAG_SLOT_LABELS[slot]}`,
              value: player.fashionEquipment?.[slot] ? describeInstanceOrItem(player, player.fashionEquipment[slot]!) : "—",
            })),
          ];
          await sendDetailMenuImage(message, { title: "背包", context: `Lv.${player.level} ${describeItem(player.classId)}`, details, menu });
        } catch {
          await ctx.replyText(message, formatMMOInventory(player));
        }
      });

      menuPlugin.registerCommand("mmo-npc", `查看当前区域 NPC 或指定 NPC：${menuPlugin.getPrefix()}mmo-npc [npcId]`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        const npcId = args[0]?.trim();
        if (!npcId) {
          // Show NPC list as menu
          const area = requireArea(player.areaId);
          if (area.npcIds.length === 0) {
            await replyCard(message as never, "NPC", "当前区域没有可互动的 NPC。");
            return;
          }
          const npcItems = area.npcIds.map<PendingMenuItem | null>((id) => {
            const n = DEFAULT_MMORPG_CONTENT.npcs[id];
            if (!n) return null;
            return { label: n.name, description: n.role, action: { type: "talk", targetId: n.id } };
          }).filter((x): x is PendingMenuItem => x !== null);
          const menu: PendingMenu = { context: area.name, title: `${area.name} - NPC`, groups: [{ label: "NPC", category: "talk", items: npcItems }], createdAt: new Date().toISOString() };
          setAndSavePendingMenu(player, menu);
          try {
            await sendMenuImage(message, menu, `${area.name} NPC 列表`);
          } catch {
            await ctx.replyText(message, formatLocalNpcList(player));
          }
          return;
        }
        const npc = requireLocalNpc(player, npcId);
        const menu = buildNpcMenu(player, npc);
        setAndSavePendingMenu(player, menu);
        try {
          await sendDetailMenuImage(message, {
            title: npc.name,
            context: npc.role,
            details: [
              { label: "描述", value: npc.description },
              ...(npc.shopItemIds.length > 0
                ? [{ label: "商品", value: npc.shopItemIds.map((id) => { const item = DEFAULT_MMORPG_CONTENT.items[id]; return item ? `${item.name}${item.sellPrice ?? "?"}g` : null; }).filter(Boolean).join(" ") }]
                : []),
            ],
            menu,
          });
        } catch {
          await ctx.replyText(message, formatNpcDetail(player, npc));
        }
      });

      menuPlugin.registerCommand("mmo-quests", "查看当前任务日志与本区域可接任务（图片菜单）", async (message) => {
        const player = requirePlayerFromMessage(message);
        updateQuestProgressFromState(player);
        savePlayer(player);
        const menu = buildQuestMenu(player);
        if (menu.groups.length === 0) {
          await ctx.replyText(message, formatQuestJournal(player));
          return;
        }
        setAndSavePendingMenu(player, menu);
        const active = player.questLog.filter((e) => e.status === "active" || e.status === "completed");
        try {
          await sendDetailMenuImage(message, {
            title: "任务日志",
            context: `进行中 ${active.length} / 已交付 ${player.questLog.filter((e) => e.status === "turned_in").length}`,
            details: active.slice(0, 4).map((entry) => {
              const quest = DEFAULT_MMORPG_CONTENT.quests[entry.questId];
              return { label: quest?.name ?? entry.questId, value: entry.status === "completed" ? "已完成" : formatQuestObjectives(quest!, entry) };
            }),
            menu,
          });
        } catch {
          await ctx.replyText(message, formatQuestJournal(player));
        }
      });

      menuPlugin.registerCommand("mmo-abandon-quest", `放弃当前任务：${menuPlugin.getPrefix()}mmo-abandon-quest <questId>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const questId = args[0]?.trim();
        if (!questId) {
          // List active quests that can be abandoned
          const active = player.questLog.filter((e) => e.status !== "turned_in");
          if (active.length === 0) {
            await replyCard(message as never, "放弃任务", "你当前没有进行中的任务。");
            return;
          }
          const list = active.map((e) => {
            const q = DEFAULT_MMORPG_CONTENT.quests[e.questId];
            return `  · ${q?.name ?? e.questId}（${e.questId}）[${e.status}]`;
          }).join("\n");
          await replyCard(message as never, "放弃任务", `可放弃的任务：\n${list}\n\n用法：${menuPlugin.getPrefix()}mmo-abandon-quest <questId>`);
          return;
        }
        try {
          const result = abandonQuest(player, questId);
          await replyCard(message as never, "放弃任务", result);
        } catch (err) {
          await replyCard(message as never, "放弃任务失败", err instanceof Error ? err.message : String(err));
        }
      });

      menuPlugin.registerCommand("mmo-hunt", `狩猎当前区域怪物：${menuPlugin.getPrefix()}mmo-hunt [monsterId]`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        const monsterId = args[0]?.trim();
        try {
          const result = await startBattle(player, monsterId, message, ctx);
          await replyCard(message as never, "狩猎", result);
        } catch (err) {
          await replyCard(message as never, "狩猎失败", err instanceof Error ? err.message : String(err));
        }
      });

      menuPlugin.registerCommand("mmo-gather", `采集当前区域资源：${menuPlugin.getPrefix()}mmo-gather [resourceNodeId]`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const nodeId = args[0]?.trim();

        // Quick pool check before locking
        const area = requireArea(player.areaId);
        const poolBlocked = checkResourcePool(area.id);
        if (poolBlocked) {
          await replyCard(message as never, "采集", poolBlocked);
          return;
        }

        setTravelLock(player.userId, MMORPG_RULEBOOK.gathering.baseSecondsPerGather * 1000 + 1000);
        const target = resolveMessageTarget(message);
        const gatherSec = MMORPG_RULEBOOK.gathering.baseSecondsPerGather;
        (async () => {
          try {
            await ctx.sendMessage(target, `⛏️ 开始采集，预计 ${gatherSec} 秒后完成…`);
            await new Promise((r) => setTimeout(r, gatherSec * 1000));
            const freshPlayer = getExistingPlayer(player.userId);
            if (!freshPlayer) return;
            const result = gatherResource(freshPlayer, nodeId);
            await ctx.sendMessage(target, result);
          } catch (err) {
            await ctx.sendMessage(target, `采集出错：${err instanceof Error ? err.message : String(err)}`);
          } finally {
            rt.travelLock.delete(player.userId);
          }
        })();
        await replyCard(message as never, "采集", `⛏️ 开始采集，预计 ${gatherSec} 秒后完成…\n采集结束后将自动通知你。`);
      });

      menuPlugin.registerCommand("mmo-fish", "开始钓鱼、查看等待状态或收杆", async (message) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        await replyCard(message as never, "钓鱼", handleFishing(player));
      });

      menuPlugin.registerCommand("mmo-fish-basket", "查看鱼篓里的鱼获", async (message) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        await replyCard(message as never, "鱼篓", formatFishBasket(player));
      });

      menuPlugin.registerCommand("mmo-fish-sell", `卖鱼：${menuPlugin.getPrefix()}mmo-fish-sell <fishId|all>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const target = args[0]?.trim();
        if (!target) {
          await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}mmo-fish-sell <fishId|all>`);
          return;
        }
        await replyCard(message as never, "卖鱼", sellFish(player, target, ctx));
      });

      menuPlugin.registerCommand("mmo-dungeon-list", `查看当前/指定区域副本：${menuPlugin.getPrefix()}mmo-dungeon-list [areaId]`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        const areaId = args[0]?.trim() || player.areaId;
        const area = requireArea(areaId);
        const list = Object.values(DEFAULT_MMORPG_CONTENT.dungeons).filter((d) => d.areaId === area.id);
        if (list.length === 0) {
          await replyCard(message as never, "副本", `${area.name} 暂时没有副本。`);
          return;
        }
        const lines = list.map((d) => `• ${d.name}（${d.id}）Lv.${d.requiredLevel} 推荐 ${d.partySize} 人`);
        await replyCard(message as never, `${area.name} 副本`, lines.join("\n"));
      });

      menuPlugin.registerCommand("mmo-dungeon-enter", `挑战副本：${menuPlugin.getPrefix()}mmo-dungeon-enter <dungeonId>`, async (message, args, ctx) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const dungeonId = args[0]?.trim();
        if (!dungeonId) {
          await replyCard(message as never, "副本", `格式：${menuPlugin.getPrefix()}mmo-dungeon-enter <dungeonId>`);
          return;
        }
        const dungeon = DEFAULT_MMORPG_CONTENT.dungeons[dungeonId];
        if (!dungeon) {
          await replyCard(message as never, "副本", "未知副本。");
          return;
        }
        if (dungeon.areaId !== player.areaId) {
          await replyCard(message as never, "副本", `副本入口在 ${describeArea(dungeon.areaId)}。`);
          return;
        }
        if (player.level < dungeon.requiredLevel) {
          await replyCard(message as never, "副本", `需要达到 ${dungeon.requiredLevel} 级。`);
          return;
        }
        if (dungeon.partySize > 1) {
          const party = player.partyId ? stateStore!.getParty(player.partyId) : null;
          const partySize = party?.memberUserIds.length ?? 1;
          if (partySize < dungeon.partySize) {
            await replyCard(message as never, "副本", `该副本推荐 ${dungeon.partySize} 人队伍，当前队伍 ${partySize} 人。请先使用 $mmo-party-create 组队。`);
            return;
          }
        }
        const result = await dispatchMenuAction(player, { type: "enter_dungeon", targetId: dungeon.id }, message, ctx);
        if (result) await replyCard(message as never, "副本挑战", result);
      });

      menuPlugin.registerCommand("mmo-world", "查看当前世界事件与日常 Boss 状态", async (message) => {
        requirePlayerFromMessage(message);
        const world = stateStore!.getWorld();
        await replyCard(message as never, "世界状态", formatWorldStatus(world));
      });

      menuPlugin.registerCommand("mmo-daily-boss", "挑战今日世界 Boss（每日一次）", async (message, args, ctx) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const world = stateStore!.getWorld();
        if (isDailyBossDefeated(world)) {
          await replyCard(message as never, "日常 Boss", "你今日已经击败过世界 Boss，请明日再来。");
          return;
        }
        const boss = createDailyBoss(player);
        const result = simulateBattle(player, boss, DEFAULT_MMORPG_CONTENT.skills, resolvePartyForPlayer(player)?.formation ?? "balanced");
        player.resources.hp = Math.max(0, result.playerHpRemaining);
        let lines = [
          `⚔️ 挑战世界 Boss：${boss.name}（Lv.${boss.level}）`,
          result.victory ? "🎉 胜利！" : "💀 战败…",
          `战斗回合：${result.totalTurns}`,
        ];
        if (result.victory) {
          const rewards = calculateDailyBossRewards(player, "epic");
          const lr = grantExperience(player, rewards.exp);
          grantBridgedCoins(player.userId, rewards.coins, ctx);
          player.currencies.honor = (player.currencies.honor ?? 0) + rewards.honor;
          markDailyBossDefeated(world);
          stateStore!.saveWorld(world);
          lines = [
            ...lines,
            `获得经验：${rewards.exp}${lr.levelsGained > 0 ? `，升级 +${lr.levelsGained}` : ""}`,
            `获得金币：${rewards.coins}`,
            `获得荣誉：${rewards.honor}`,
          ];
        } else if (player.resources.hp <= 0) {
          const deathMsg = handlePlayerDeath(player, ctx);
          lines.push(deathMsg);
        }
        savePlayer(player);
        await replyCard(message as never, "日常 Boss", lines.join("\n"));
      });

      menuPlugin.registerCommand("mmo-declaration", `修改个人宣言：${menuPlugin.getPrefix()}mmo-declaration <文本|clear>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        const text = args.join(" ").trim();
        player.personalDeclaration = !text || text.toLowerCase() === "clear" ? undefined : text;
        savePlayer(player);
        await replyCard(message as never, "个人宣言", `个人宣言已更新：${player.personalDeclaration ?? "已清空"}`);
      });

      menuPlugin.registerCommand("mmo-change-class", `更换职业：${menuPlugin.getPrefix()}mmo-change-class <classId>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const classId = args[0];
        if (!classId) {
          await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}mmo-change-class <classId>`);
          return;
        }
        const classDef = requireClass(classId);
        try {
          assertClassUnlocked(classDef, player);
        } catch (e: any) {
          await replyCard(message as never, "转职", e.message);
          return;
        }
        if (!classDef.requiredRebirths && !classDef.unlockQuestId && player.level >= 15) {
          await replyCard(message as never, "转职", "普通职业 15 级后不能再自由更换。");
          return;
        }
        player.classId = classDef.id;
        player.stats = buildCharacterStats(player.raceId, classDef, player.level, player.rebirthBonus);
        player.resources = createBaseResources(player.stats);
        player.unlockedSkillIds = Array.from(new Set([...player.unlockedSkillIds, ...classDef.starterSkillIds]));
        // Auto-equip any newly-acquired active/utility skills that fit the slot budget.
        const newSkills = classDef.starterSkillIds.filter((id) => !player.equippedSkillIds.includes(id));
        for (const skillId of newSkills) {
          equipSkill(player, skillId);
        }
        savePlayer(player);
        await replyCard(message as never, "转职", `职业已变更为 ${classDef.name}。新职业的初始技能已自动装备到空余槽位。`);
      });

      menuPlugin.registerCommand("mmo-change-race", `消耗种族重塑卷轴：${menuPlugin.getPrefix()}mmo-change-race <raceId>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const raceId = args[0];
        if (!raceId) {
          await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}mmo-change-race <raceId>`);
          return;
        }
        consumeFrameworkItem(player.userId!, MMORPG_RULEBOOK.economy.raceChangeItemId);
        const race = requireRace(raceId);
        player.raceId = race.id;
        player.stats = buildCharacterStats(player.raceId, requireClass(player.classId), player.level, player.rebirthBonus);
        player.resources = createBaseResources(player.stats);
        savePlayer(player);
        await replyCard(message as never, "种族变更", `种族已变更为 ${race.name}。`);
      });

      menuPlugin.registerCommand("mmo-change-gender", `消耗性别映照镜：${menuPlugin.getPrefix()}mmo-change-gender <genderId>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const genderId = args[0];
        if (!genderId) {
          await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}mmo-change-gender <genderId>`);
          return;
        }
        consumeFrameworkItem(player.userId!, MMORPG_RULEBOOK.economy.genderChangeItemId);
        const gender = requireGender(genderId);
        player.genderId = gender.id;
        savePlayer(player);
        await replyCard(message as never, "性别变更", `性别已变更为 ${gender.name}。`);
      });

      menuPlugin.registerCommand("mmo-change-appearance", `消耗造型改造券：${menuPlugin.getPrefix()}mmo-change-appearance <appearance>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const appearance = decodeTextToken(args.join(" ").trim());
        if (!appearance) {
          await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}mmo-change-appearance <appearance>`);
          return;
        }
        consumeFrameworkItem(player.userId!, MMORPG_RULEBOOK.economy.appearanceChangeItemId);
        player.appearance = appearance;
        savePlayer(player);
        await replyCard(message as never, "外貌变更", `外貌描述已更新为：${appearance}`);
      });

      menuPlugin.registerCommand("mmo-marriage", "查看婚姻状态与当前婚姻加成", async (message) => {
        const player = requirePlayerFromMessage(message);
        await replyCard(message as never, "婚姻状态", formatMarriageStatus(player));
      });

      menuPlugin.registerCommand("mmo-propose", `求婚：${menuPlugin.getPrefix()}mmo-propose <userId>`, async (message, args) => {
        const proposer = requirePlayerFromMessage(message);
        requireNotInCombat(proposer);
        const targetUserId = normalizeOptionalUserId(args[0]);
        if (!targetUserId) {
          await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}mmo-propose <userId>`);
          return;
        }
        const target = requirePlayer(targetUserId);
        validateMarriageEligibility(proposer, target);
        if (findProposal(proposer.userId, target.userId)) {
          await replyCard(message as never, "求婚", "你已经向该玩家发出过求婚请求。");
          return;
        }
        stateStore!.saveMarriageProposal({
          proposerUserId: proposer.userId,
          targetUserId: target.userId,
          ringItemId: MMORPG_RULEBOOK.economy.marriageRingItemId,
        });
        await replyCard(message as never, "求婚", `已向 ${target.userId} 发出求婚请求。对方可使用 ${menuPlugin.getPrefix()}mmo-accept-proposal ${proposer.userId} 接受。`);
      });

      menuPlugin.registerCommand("mmo-accept-proposal", `接受求婚：${menuPlugin.getPrefix()}mmo-accept-proposal <proposerUserId>`, async (message, args) => {
        const target = requirePlayerFromMessage(message);
        requireNotInCombat(target);
        const proposerUserId = normalizeOptionalUserId(args[0]);
        if (!proposerUserId) {
          await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}mmo-accept-proposal <proposerUserId>`);
          return;
        }
        const proposer = requirePlayer(proposerUserId);
        const proposal = findProposal(proposer.userId, target.userId);
        if (!proposal) {
          await replyCard(message as never, "接受求婚", "未找到对应的求婚请求。");
          return;
        }
        validateMarriageEligibility(proposer, target);
        consumeFrameworkItem(proposer.userId, proposal.ringItemId);
        const marriedAt = new Date().toISOString();
        proposer.marriage = { spouseUserId: target.userId, marriedAt, ringItemId: proposal.ringItemId };
        target.marriage = { spouseUserId: proposer.userId, marriedAt, ringItemId: proposal.ringItemId };
        const newlyUnlockedProposer = checkAchievementsOnMarriage(proposer);
        const newlyUnlockedTarget = checkAchievementsOnMarriage(target);
        savePlayer(proposer);
        savePlayer(target);
        stateStore!.removeMarriageProposal(proposal.id);
        const messages = [
          `${proposer.userId} 与 ${target.userId} 已结为伴侣。基础婚姻加成已生效；若同队则婚姻加成提升为 30%。`,
          formatNewlyUnlocked([...newlyUnlockedProposer, ...newlyUnlockedTarget]) || undefined,
        ].filter(Boolean);
        await replyCard(message as never, "结婚", messages.join("\n"));
      });

      menuPlugin.registerCommand("mmo-party-create", `创建队伍：${menuPlugin.getPrefix()}mmo-party-create [balanced|aggressive|guarded] [objective...]`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        if (stateStore!.findPartyByMember(player.userId)) {
          await replyCard(message as never, "创建队伍", "你已经在队伍中。");
          return;
        }
        const maybeFormation = args[0];
        const formation = isFormation(maybeFormation) ? maybeFormation : "balanced";
        const objective = (isFormation(maybeFormation) ? args.slice(1) : args).join(" ").trim() || undefined;
        const party = stateStore!.createParty({
          leaderUserId: player.userId,
          memberUserIds: [player.userId],
          currentAreaId: player.areaId,
          formation,
          objective,
          recruiting: true,
        });
        player.partyId = party.id;
        savePlayer(player);
        await replyCard(message as never, "创建队伍", `已创建队伍 ${party.id}，阵型 ${party.formation}。${party.objective ? `当前目标：${party.objective}` : ""}`);
      });

      menuPlugin.registerCommand("mmo-party-join", `加入队伍：${menuPlugin.getPrefix()}mmo-party-join <leaderUserId>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const leaderUserId = normalizeOptionalUserId(args[0]);
        if (!leaderUserId) {
          await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}mmo-party-join <leaderUserId>`);
          return;
        }
        if (stateStore!.findPartyByMember(player.userId)) {
          await replyCard(message as never, "加入队伍", "你已经在队伍中。");
          return;
        }
        const party = stateStore!.findPartyByMember(leaderUserId);
        if (!party || !party.recruiting) {
          await replyCard(message as never, "加入队伍", "未找到可加入的队伍。");
          return;
        }
        if (party.memberUserIds.length >= MMORPG_RULEBOOK.social.maxPartySize) {
          await replyCard(message as never, "加入队伍", "该队伍人数已满。");
          return;
        }
        party.memberUserIds.push(player.userId);
        stateStore!.saveParty(party);
        player.partyId = party.id;
        const newlyUnlocked = checkAchievementsOnPartyJoin(player);
        savePlayer(player);
        await replyCard(message as never, "加入队伍", `已加入队伍 ${party.id}。${formatNewlyUnlocked(newlyUnlocked)}`);
      });

      menuPlugin.registerCommand("mmo-party-leave", "离开当前队伍", async (message) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const party = resolvePartyForPlayer(player);
        if (!party) {
          await replyCard(message as never, "离开队伍", "你当前不在队伍中。");
          return;
        }
        party.memberUserIds = party.memberUserIds.filter((userId) => userId !== player.userId);
        player.partyId = undefined;
        savePlayer(player);

        if (party.memberUserIds.length === 0) {
          stateStore!.removeParty(party.id);
        } else {
          if (party.leaderUserId === player.userId) {
            party.leaderUserId = party.memberUserIds[0];
          }
          stateStore!.saveParty(party);
        }
        await replyCard(message as never, "离开队伍", "已离开当前队伍。");
      });

      menuPlugin.registerCommand("mmo-party", "查看当前队伍与组队加成设计", async (message) => {
        const player = requirePlayerFromMessage(message);
        const party = resolvePartyForPlayer(player);
        if (!party) {
          await replyCard(message as never, "队伍", "你当前不在队伍中。");
          return;
        }
        await replyCard(message as never, "队伍状态", formatPartyStatus(party));
      });

      menuPlugin.registerCommand("mmo-coins", "查看 MMORPG 与 Bot 共享金币余额", async (message) => {
        const player = syncPlayerEconomy(message.userId!, requirePlayerFromMessage(message));
        await replyCard(message as never, "金币余额",
          [
            `共享金币余额：${player.currencies.gold}`,
            `MMORPG 累计产出金币：${player.coinsEarnedFromMMO}`,
            `当前奖励加成：经验 +${formatPercent(getActiveBonuses(player).expRate)}，金币 +${formatPercent(getActiveBonuses(player).goldRate)}`,
          ].join("\n")
        );
      });

      menuPlugin.registerCommand("mmo-grant-coins", "管理员测试桥接：$mmo-grant-coins <amount> [userId]", async (message, args) => {
        const amount = Number(args[0]);
        if (!Number.isFinite(amount) || amount <= 0) {
          await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}mmo-grant-coins <amount> [userId]`);
          return;
        }
        const userId = normalizeOptionalUserId(args[1]) ?? message.userId;
        if (!userId) {
          await ctx.replyText(message, "无法确定目标用户。");
          return;
        }
        const result = grantBridgedCoins(userId, amount, ctx);
        await ctx.replyText(message, `已通过 MMORPG 框架为 ${userId} 发放 ${amount} 金币。\n共享余额：${result.currencies.gold}\nMMORPG 累计产出：${result.coinsEarnedFromMMO}`);
      }, { adminOnly: true });

      menuPlugin.registerCommand("mmo-validate", "校验 MMORPG 内容注册表", async (message) => {
        validationReport = validateMMORPGContent(DEFAULT_MMORPG_CONTENT);
        await ctx.replyText(message, formatValidationReport(validationReport));
      }, { adminOnly: true });

      menuPlugin.registerCommand("mmo-pick", `选择菜单中的操作：${menuPlugin.getPrefix()}mmo-pick <序号>`, async (message, args) => {
        const player = requirePlayerFromMessage(message, true);
        requireNotInCombat(player);
        if (!player.pendingMenu) {
          console.warn(`[MMORPG] $mmo-pick: no pendingMenu for ${player.userId}, pendingMenu=${JSON.stringify(player.pendingMenu)}`);
          await replyCard(message as never, "菜单操作", "当前没有可操作的菜单。请先使用 $mmo-location 等命令打开菜单。");
          return;
        }
        console.log(`[MMORPG] $mmo-pick: pendingMenu context="${player.pendingMenu.context}", groups=${player.pendingMenu.groups.length}, items=${player.pendingMenu.groups.reduce((s, g) => s + g.items.length, 0)}`);
        const allItems = flattenMenuGroups(player.pendingMenu.groups);
        const index = parseInt(args[0], 10);
        if (isNaN(index) || index < 1 || index > allItems.length) {
          await replyCard(message as never, "菜单操作", `请输入 1-${allItems.length} 之间的序号。`);
          return;
        }
        const selected = allItems[index - 1];

        // Guide enforcement in pick
        if (!checkGuideCompleted(player) && selected.action.type !== "guide_step") {
          await replyCard(message as never, "操作失败", `⚠️ 你必须先完成新手引导！请发送 ${menuPlugin.getPrefix()}mmo 进入新手引导。`);
          return;
        }

        const menuBeforeClear = player.pendingMenu;
        player.pendingMenu = undefined;
        savePlayer(player);
        try {
          const areaIdxMap = buildAreaIndexMap(menuBeforeClear);
          const result = await dispatchMenuAction(player, selected.action, message, ctx, areaIdxMap);
          if (result) await replyCard(message as never, "操作结果", result);
        } catch (error) {
          await replyCard(message as never, "操作失败", error instanceof Error ? error.message : String(error));
        }
      });

      menuPlugin.registerCommand("mmo-check", `查看菜单中物品的属性：${menuPlugin.getPrefix()}mmo-check <序号>`, async (message, args) => {
        const player = requirePlayerFromMessage(message, true);
        if (!player.pendingMenu) {
          await replyCard(message as never, "物品属性", "当前没有可操作的菜单。请先使用 $mmo-location 等命令打开菜单。");
          return;
        }
        const allItems = flattenMenuGroups(player.pendingMenu.groups);
        const index = parseInt(args[0], 10);
        if (isNaN(index) || index < 1 || index > allItems.length) {
          await replyCard(message as never, "物品属性", `请输入 1-${allItems.length} 之间的序号。`);
          return;
        }
        const selected = allItems[index - 1];
        const action = selected.action;

        // Resolve item ID from different action types
        let itemId: string | undefined;
        if (action.type === "buy" && action.extra?.itemId) {
          itemId = action.extra.itemId;
        } else if ((action.type === "equip" || action.type === "use_item" || action.type === "sell" || action.type === "view_item") && action.targetId) {
          itemId = action.extra?.itemId;
          if (!itemId) {
            const baseId = getBaseItemId(player, action.targetId);
            itemId = DEFAULT_MMORPG_CONTENT.items[baseId]?.id ?? (DEFAULT_MMORPG_CONTENT.items[action.targetId] ? action.targetId : undefined);
          }
        }

        if (!itemId || !DEFAULT_MMORPG_CONTENT.items[itemId]) {
          await replyCard(message as never, "物品属性", `序号 ${index}（${selected.label}）不是可以查看属性的物品。`);
          return;
        }

        const detail = formatItemDetail(player, itemId);
        await replyCard(message as never, "物品属性", detail);
      });

      function canPlayerEquipItem(player: PlayerState, item: ItemDef): boolean {
        if (!item.allowedClasses || item.allowedClasses.length === 0) return true;
        for (const cls of item.allowedClasses) {
          const classDef = DEFAULT_MMORPG_CONTENT.classes[cls];
          if (!classDef) continue;
          if (classDef.isUnlocked && !classDef.isUnlocked(player)) continue;
          if (player.classId === cls) return true;
        }
        return false;
      }

      menuPlugin.registerCommand("mmo-shop", "打开当前区域 NPC 商店菜单", async (message) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const area = requireArea(player.areaId);
        const merchants = area.npcIds
          .map((id) => DEFAULT_MMORPG_CONTENT.npcs[id])
          .filter((n) => n && n.shopItemIds.length > 0);
        if (merchants.length === 0) {
          await replyCard(message as never, "商店", "当前区域没有商店。");
          return;
        }
        const npc = merchants[0];
        const shopItems = npc.shopItemIds.map<PendingMenuItem | null>((itemId) => {
          const item = DEFAULT_MMORPG_CONTENT.items[itemId];
          if (!item) return null;
          if (!canPlayerEquipItem(player, item)) return null;
          return {
            label: item.name,
            description: `${item.sellPrice ?? "?"}g${item.description ? " · " + item.description : ""}`,
            action: { type: "buy", targetId: npc.id, extra: { itemId: item.id, quantity: "1" } },
          };
        }).filter((x): x is PendingMenuItem => x !== null);
        const menu: PendingMenu = {
          context: npc.role || "商店",
          title: `${npc.name}的商店`,
          groups: shopItems.length > 0 ? [{ label: "商品", category: "interact", items: shopItems }] : [],
          createdAt: new Date().toISOString(),
        };
        setAndSavePendingMenu(player, menu);
        try {
          await sendMenuImage(message, menu, `${npc.name} 的商店`);
        } catch {
          const text = shopItems.map((it, i) => `${i + 1}. ${it!.label} - ${it!.description}`).join("\n");
          await ctx.replyText(message, `${npc.name} 的商店：\n${text}\n\n输入 $mmo-pick <序号> 购买`);
        }
      });

      menuPlugin.registerCommand("mmo-equip", "打开装备管理菜单", async (message) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const menu = buildEquipMenu(player);
        if (menu.groups.length === 0) {
          await replyCard(message as never, "装备管理", "背包中没有可装备或可卸下的物品。");
          return;
        }
        setAndSavePendingMenu(player, menu);
        try {
          await sendMenuImage(message, menu, "装备管理");
        } catch {
          const text = flattenMenuGroups(menu.groups).map((it, i) => `${i + 1}. ${it.label}`).join("\n");
          await ctx.replyText(message, `装备管理：\n${text}\n\n输入 $mmo-pick <序号> 选择`);
        }
      });

      menuPlugin.registerCommand("mmo-enhance", "强化装备部位：$mmo-enhance <部位>", async (message, args) => {
        let player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const slot = args[0]?.trim().toLowerCase();
        if (!slot) {
          await replyCard(message as never, "强化失败", "请输入要强化的装备部位（可选：weapon, offhand, head, body, legs, accessory）");
          return;
        }

        const validSlots = ["weapon", "offhand", "head", "body", "legs", "accessory"];
        if (!validSlots.includes(slot)) {
          await replyCard(message as never, "强化失败", `无效的部位。可选：${validSlots.join(", ")}`);
          return;
        }

        const idOrInstanceId = player.equipment[slot as keyof typeof player.equipment];
        if (!idOrInstanceId) {
          await replyCard(message as never, "强化失败", `当前部位 ${slot} 没有装备任何道具。`);
          return;
        }

        if (!player.itemInstances) player.itemInstances = {};
        let instance = player.itemInstances[idOrInstanceId];
        if (!instance) {
          const itemDef = DEFAULT_MMORPG_CONTENT.items[idOrInstanceId];
          if (!itemDef) {
            await replyCard(message as never, "强化失败", "未找到装备数据。");
            return;
          }
          const instId = "inst_" + randomUUID().slice(0, 8);
          instance = {
            id: instId,
            itemId: idOrInstanceId,
            enhancement: 0,
            rarity: "common",
            substats: { strength: 0, defense: 0, charm: 0, agility: 0, eloquence: 0, endurance: 0, life: 0 },
          };
          player.itemInstances[instId] = instance;
          player.equipment[slot as keyof typeof player.equipment] = instId;
        }

        const itemDef = DEFAULT_MMORPG_CONTENT.items[instance.itemId];
        if (!itemDef) {
          await replyCard(message as never, "强化失败", "未找到装备数据。");
          return;
        }

        const currentEnhance = instance.enhancement ?? 0;
        if (currentEnhance >= 20) {
          await replyCard(message as never, "强化失败", "该装备已达到最高强化等级 +20。");
          return;
        }

        const basePrice = itemDef.sellPrice ?? 10;
        const goldCost = Math.round(basePrice * (2 + currentEnhance * 1.0));
        const oreCost = 1 + Math.floor(currentEnhance / 4);

        player = syncPlayerEconomy(player.userId, player);
        if ((player.currencies.gold ?? 0) < goldCost) {
          await replyCard(message as never, "强化失败", `金币不足。本次强化需要 ${goldCost} 金币，你只有 ${player.currencies.gold} 金币。`);
          return;
        }

        const currentOres = getPlayerItemQuantity(player, "iron_ore");
        if (currentOres < oreCost) {
          await replyCard(message as never, "强化失败", `材料不足。本次强化需要 铁矿石 x${oreCost}，你的背包里只有 x${currentOres}。`);
          return;
        }

        grantBridgedCoins(player.userId, -goldCost, ctx);
        removePlayerItem(player, "iron_ore", oreCost);

        let successRate = 1.0;
        if (currentEnhance >= 17) successRate = 0.10;
        else if (currentEnhance >= 13) successRate = 0.20;
        else if (currentEnhance >= 9) successRate = 0.40;
        else if (currentEnhance >= 5) successRate = 0.60;
        else if (currentEnhance >= 4) successRate = 0.85;

        const roll = Math.random();
        const success = roll < successRate;

        let resultMsg = "";
        if (success) {
          instance.enhancement = currentEnhance + 1;
          resultMsg = `✨ 强化成功！【${describeInstanceOrItem(player, instance.id)}】强化等级提升至 +${instance.enhancement}！`;
        } else {
          if (currentEnhance >= 5) {
            instance.enhancement = currentEnhance - 1;
            resultMsg = `💥 强化失败！装备冒出一股黑烟，强化等级降至 +${instance.enhancement}。`;
          } else {
            resultMsg = `❌ 强化失败！本次强化未能成功，强化等级保持为 +${currentEnhance}。`;
          }
        }

        savePlayer(player);
        await replyCard(message as never, "装备强化", [
          `装备：${describeInstanceOrItem(player, instance.id)}`,
          `消耗：金币 ${goldCost}g，铁矿石 x${oreCost}`,
          resultMsg
        ].join("\n"));
      });

      menuPlugin.registerCommand("mmo-recycle", "低价回收背包物品：$mmo-recycle <背包序号>", async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const indexStr = args[0]?.trim();
        if (!indexStr) {
          await replyCard(message as never, "回收失败", "请指定要回收的背包物品序号。");
          return;
        }

        const index = parseInt(indexStr, 10);
        if (isNaN(index) || index < 1 || index > player.inventory.length) {
          await replyCard(message as never, "回收失败", `请输入有效的背包物品序号 (1-${player.inventory.length})。`);
          return;
        }

        const entry = player.inventory[index - 1];
        const itemDef = DEFAULT_MMORPG_CONTENT.items[entry.itemId];
        if (!itemDef) {
          await replyCard(message as never, "回收失败", "未找到该物品的定义数据。");
          return;
        }

        if (itemDef.category === "quest" || itemDef.id === MMORPG_RULEBOOK.economy.marriageRingItemId) {
          await replyCard(message as never, "回收失败", `【${itemDef.name}】是重要物品或任务物品，不可出售！`);
          return;
        }

        const baseSellPrice = itemDef.sellPrice ?? 0;
        if (baseSellPrice <= 0) {
          await replyCard(message as never, "回收失败", `【${itemDef.name}】没有回收价值。`);
          return;
        }

        // Recycle applies a base discount (gold sink) before rarity/enhance multipliers.
        // Without this the recycle price equalled the shop sell price — no economic sink.
        const recycleBaseRate = MMORPG_RULEBOOK.economy.recycleBaseRate;
        let finalPrice = Math.floor(baseSellPrice * recycleBaseRate * entry.quantity);

        if (entry.instanceId && player.itemInstances?.[entry.instanceId]) {
          const inst = player.itemInstances[entry.instanceId];
          let rarityMult = 1.0;
          if (inst.rarity === "uncommon") rarityMult = 1.5;
          else if (inst.rarity === "rare") rarityMult = 2.2;
          else if (inst.rarity === "epic") rarityMult = 3.5;
          else if (inst.rarity === "legendary") rarityMult = 5.5;

          // Enhance multiplier per level aligned closer to the linearly-scaling enhance
          // cost (1 + level × 0.5). Raised from 0.1 to recycleEnhanceMultiplierPerLevel.
          const enhanceMult = 1.0 + (inst.enhancement ?? 0) * MMORPG_RULEBOOK.economy.recycleEnhanceMultiplierPerLevel;
          finalPrice = Math.round(baseSellPrice * recycleBaseRate * rarityMult * enhanceMult * entry.quantity);
        }

        const itemName = entry.instanceId ? describeInstanceOrItem(player, entry.instanceId) : itemDef.name;
        const qty = entry.quantity;

        player.inventory.splice(index - 1, 1);
        grantBridgedCoins(player.userId, finalPrice, ctx);
        savePlayer(player);

        await replyCard(message as never, "回收成功", `♻️ 回收商以底价回收了你的【${itemName}】x${qty}，获得了 ${finalPrice} 金币。`);
      });

      menuPlugin.registerCommand("mmo-decompose", `分解装备获得材料：${menuPlugin.getPrefix()}mmo-decompose <背包序号>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const indexStr = args?.[0];
        if (!indexStr) {
          await replyCard(message as never, "分解", `用法：${menuPlugin.getPrefix()}mmo-decompose <背包序号>\n分解装备获得锻造材料。`);
          return;
        }
        const index = parseInt(indexStr, 10);
        if (isNaN(index) || index < 1 || index > player.inventory.length) {
          await replyCard(message as never, "分解失败", `请输入有效的背包物品序号 (1-${player.inventory.length})。`);
          return;
        }
        const entry = player.inventory[index - 1];
        const itemDef = DEFAULT_MMORPG_CONTENT.items[entry.itemId];
        if (!itemDef) {
          await replyCard(message as never, "分解失败", "未知物品。");
          return;
        }
        if (itemDef.category !== "weapon" && itemDef.category !== "armor") {
          await replyCard(message as never, "分解失败", "只能分解武器和防具。");
          return;
        }
        if (!entry.instanceId || !player.itemInstances?.[entry.instanceId]) {
          await replyCard(message as never, "分解失败", "只能分解具有随机属性的装备。");
          return;
        }
        const inst = player.itemInstances[entry.instanceId];
        const rarityMult = inst.rarity === "legendary" ? 5 : inst.rarity === "epic" ? 3.5 : inst.rarity === "rare" ? 2.2 : inst.rarity === "uncommon" ? 1.5 : 1;
        const baseMats = Math.max(1, Math.floor((itemDef.sellPrice ?? 10) / 20));
        const matCount = Math.max(1, Math.round(baseMats * rarityMult));
        const matItemIds = ["iron_ore", "ancient_stone", "shadow_essence", "void_shard"];
        const matId = matItemIds[Math.min(Math.floor(inst.rarity === "legendary" ? 3 : inst.rarity === "epic" ? 2 : inst.rarity === "rare" ? 1 : 0), matItemIds.length - 1)];
        addPlayerItem(player, matId, matCount);
        delete player.itemInstances[entry.instanceId];
        player.inventory.splice(index - 1, 1);
        savePlayer(player);
        const itemName = describeInstanceOrItem(player, entry.instanceId);
        const matName = DEFAULT_MMORPG_CONTENT.items[matId]?.name ?? matId;
        await replyCard(message as never, "分解成功", `🔨 分解了【${itemName}】，获得了 ${matName} x${matCount}。`);
      });

      menuPlugin.registerCommand("mmo-auction-list", "查看拍卖行在售商品列表：$mmo-auction-list", async (message) => {
        const player = requirePlayerFromMessage(message);
        const listings = Object.values(stateStore!.getState().marketListings);
        if (listings.length === 0) {
          await replyCard(message as never, "拍卖行", "当前拍卖行没有任何在售商品。");
          return;
        }

        const lines = listings.map((lst) => {
          const itemDef = DEFAULT_MMORPG_CONTENT.items[lst.itemId];
          if (!itemDef) return null;
          
          let itemName = itemDef.name;
          if (lst.instanceId && player.itemInstances && player.itemInstances[lst.instanceId]) {
            itemName = describeInstanceOrItem(player, lst.instanceId);
          } else if (lst.instanceId) {
            const sellerPlayer = stateStore!.getPlayer(lst.sellerUserId);
            if (sellerPlayer && sellerPlayer.itemInstances && sellerPlayer.itemInstances[lst.instanceId]) {
              itemName = describeInstanceOrItem(sellerPlayer, lst.instanceId);
            } else {
              itemName = `[未知品质] ${itemDef.name} (装备实例)`;
            }
          }
          
          return `🔹 【${lst.id}】${itemName} x${lst.quantity} · 单价: ${lst.pricePerUnit}g (总计: ${lst.pricePerUnit * lst.quantity}g) · 卖家: ${lst.sellerUserId}`;
        }).filter(Boolean);

        await replyCard(message as never, "拍卖大厅", ["当前拍卖行在售商品：", ...lines, `\n使用 $mmo-auction-buy <商品编号> 购买；使用 $mmo-auction-cancel <商品编号> 下架。`].join("\n"));
      });

      menuPlugin.registerCommand("mmo-auction-sell", "上架商品到拍卖行：$mmo-auction-sell <背包序号> <单价> [数量]", async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);

        const indexStr = args[0]?.trim();
        const priceStr = args[1]?.trim();
        const qtyStr = args[2]?.trim();

        if (!indexStr || !priceStr) {
          await replyCard(message as never, "上架失败", "用法：$mmo-auction-sell <背包序号> <单价> [数量]");
          return;
        }

        const index = parseInt(indexStr, 10);
        if (isNaN(index) || index < 1 || index > player.inventory.length) {
          await replyCard(message as never, "上架失败", `请输入有效的背包物品序号 (1-${player.inventory.length})。`);
          return;
        }

        const pricePerUnit = parseInt(priceStr, 10);
        if (isNaN(pricePerUnit) || pricePerUnit <= 0) {
          await replyCard(message as never, "上架失败", "价格必须为正整数金币。");
          return;
        }

        const entry = player.inventory[index - 1];
        const itemDef = DEFAULT_MMORPG_CONTENT.items[entry.itemId];
        if (!itemDef) {
          await replyCard(message as never, "上架失败", "未找到该物品的定义。");
          return;
        }

        if (itemDef.category === "quest" || itemDef.id === MMORPG_RULEBOOK.economy.marriageRingItemId) {
          await replyCard(message as never, "上架失败", `【${itemDef.name}】是重要或专属物品，不可交易！`);
          return;
        }

        let quantity = entry.instanceId ? 1 : (qtyStr ? parseInt(qtyStr, 10) : entry.quantity);
        if (isNaN(quantity) || quantity <= 0 || quantity > entry.quantity) {
          await replyCard(message as never, "上架失败", "上架数量无效或超出拥有数量。");
          return;
        }

        const instanceId = entry.instanceId;
        removePlayerItem(player, entry.itemId, quantity, instanceId);

        const listingId = "lst_" + randomUUID().slice(0, 8);
        const listing = {
          id: listingId,
          sellerUserId: player.userId,
          itemId: entry.itemId,
          quantity,
          pricePerUnit,
          createdAt: new Date().toISOString(),
          instanceId: instanceId || undefined,
        };

        stateStore!.saveMarketListing(listing);
        savePlayer(player);

        const itemName = instanceId ? describeInstanceOrItem(player, instanceId) : itemDef.name;

        await replyCard(message as never, "上架成功", `📦 成功将【${itemName}】x${quantity} 上架到拍卖行！\n单价：${pricePerUnit}g，商品编号：${listingId}。`);
      });

      menuPlugin.registerCommand("mmo-auction-buy", "从拍卖行购买商品：$mmo-auction-buy <商品编号>", async (message, args) => {
        let buyer = requirePlayerFromMessage(message);
        requireNotInCombat(buyer);

        const listingId = args[0]?.trim();
        if (!listingId) {
          await replyCard(message as never, "购买失败", "请指定商品编号。");
          return;
        }

        const listing = stateStore!.getState().marketListings[listingId];
        if (!listing) {
          await replyCard(message as never, "购买失败", "商品已售出或已下架。");
          return;
        }

        if (listing.sellerUserId === buyer.userId) {
          await replyCard(message as never, "购买失败", "你不能购买自己上架的商品。如需收回请使用 $mmo-auction-cancel 命令。");
          return;
        }

        const totalCost = listing.pricePerUnit * listing.quantity;
        buyer = syncPlayerEconomy(buyer.userId, buyer);
        if ((buyer.currencies.gold ?? 0) < totalCost) {
          await replyCard(message as never, "购买失败", `金币不足。购买该商品需要 ${totalCost} 金币，你只有 ${buyer.currencies.gold} 金币。`);
          return;
        }

        const seller = stateStore!.getPlayer(listing.sellerUserId);
        if (seller) {
          syncPlayerEconomy(seller.userId, seller);
          grantBridgedCoins(seller.userId, totalCost, ctx);

          if (listing.instanceId) {
            if (!buyer.itemInstances) buyer.itemInstances = {};
            if (seller.itemInstances && seller.itemInstances[listing.instanceId]) {
              buyer.itemInstances[listing.instanceId] = { ...seller.itemInstances[listing.instanceId] };
              delete seller.itemInstances[listing.instanceId];
            }
          }
          savePlayer(seller);
        } else {
          const sellerProfile = store.getUserData(listing.sellerUserId);
          sellerProfile.coins += totalCost;
          store.saveUserData(listing.sellerUserId, sellerProfile);
        }

        grantBridgedCoins(buyer.userId, -totalCost, ctx);
        addPlayerItem(buyer, listing.itemId, listing.quantity, listing.instanceId);
        stateStore!.removeMarketListing(listingId);
        savePlayer(buyer);

        const itemDef = DEFAULT_MMORPG_CONTENT.items[listing.itemId];
        const itemName = (listing.instanceId && buyer.itemInstances?.[listing.instanceId])
          ? describeInstanceOrItem(buyer, listing.instanceId)
          : (itemDef?.name ?? listing.itemId);

        await replyCard(message as never, "购买成功", `🛍️ 成功以 ${totalCost} 金币购买了【${itemName}】x${listing.quantity}！`);
      });

      menuPlugin.registerCommand("mmo-auction-cancel", "撤回/下架拍卖行商品：$mmo-auction-cancel <商品编号>", async (message, args) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);

        const listingId = args[0]?.trim();
        if (!listingId) {
          await replyCard(message as never, "下架失败", "请指定商品编号。");
          return;
        }

        const listing = stateStore!.getState().marketListings[listingId];
        if (!listing) {
          await replyCard(message as never, "下架失败", "未找到该商品，可能已售出。");
          return;
        }

        if (listing.sellerUserId !== player.userId) {
          await replyCard(message as never, "下架失败", "你只能下架自己出售的商品。");
          return;
        }

        addPlayerItem(player, listing.itemId, listing.quantity, listing.instanceId);
        stateStore!.removeMarketListing(listingId);
        savePlayer(player);

        const itemDef = DEFAULT_MMORPG_CONTENT.items[listing.itemId];
        const itemName = (listing.instanceId && player.itemInstances?.[listing.instanceId])
          ? describeInstanceOrItem(player, listing.instanceId)
          : (itemDef?.name ?? listing.itemId);

        await replyCard(message as never, "下架成功", `📦 成功将【${itemName}】x${listing.quantity} 下架，物品已返回背包。`);
      });

      menuPlugin.registerCommand("mmo-mail", `查看邮件收件箱：${menuPlugin.getPrefix()}mmo-mail`, async (message) => {
        const player = requirePlayerFromMessage(message);
        const mails = stateStore!.listMailsForUser(player.userId);
        await replyCard(message as never, `邮件（${mails.length}）`, formatMailList(mails));
      });

      menuPlugin.registerCommand("mmo-mail-send", `发送邮件：${menuPlugin.getPrefix()}mmo-mail-send <userId> [itemId quantity] <标题> [正文...]`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        if (args.length < 2) {
          await replyCard(message as never, "发送邮件", `格式：${menuPlugin.getPrefix()}mmo-mail-send <userId> [itemId quantity] <标题> [正文...]`);
          return;
        }
        const targetUserId = args[0]!.trim();

        let titleIndex = 1;
        let attachments: InventoryEntry[] = [];
        if (args.length >= 3 && /^\d+$/.test(args[2]!.trim())) {
          const itemId = args[1]!.trim();
          const quantity = parseInt(args[2]!.trim(), 10);
          const item = DEFAULT_MMORPG_CONTENT.items[itemId];
          if (!item) {
            await replyCard(message as never, "发送邮件", `未知物品：${itemId}`);
            return;
          }
          if (quantity < 1) {
            await replyCard(message as never, "发送邮件", "附件数量无效。");
            return;
          }
          if (!removePlayerItem(player, itemId, quantity)) {
            await replyCard(message as never, "发送邮件", `背包中没有足够的 ${item.name}。`);
            return;
          }
          attachments = [{ itemId, quantity }];
          titleIndex = 3;
        }

        const title = args[titleIndex]?.trim();
        const body = args.slice(titleIndex + 1).join(" ").trim();
        if (!targetUserId || !title) {
          await replyCard(message as never, "发送邮件", "收件人和标题不能为空。");
          return;
        }
        requirePlayer(targetUserId);
        const mail = stateStore!.createMail({
          fromUserId: player.userId,
          toUserId: targetUserId,
          title,
          body,
          attachments,
        });
        savePlayer(player);
        await replyCard(message as never, "发送成功", formatMailSent(mail));
      });

      menuPlugin.registerCommand("mmo-mail-claim", `领取/标记已读邮件：${menuPlugin.getPrefix()}mmo-mail-claim <邮件ID>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        const mailId = args[0]?.trim();
        if (!mailId) {
          await replyCard(message as never, "邮件", `格式：${menuPlugin.getPrefix()}mmo-mail-claim <邮件ID>`);
          return;
        }
        const mail = stateStore!.getMail(mailId);
        if (!mail || mail.toUserId !== player.userId) {
          await replyCard(message as never, "邮件", "未找到该邮件或无权限领取。");
          return;
        }
        if (mail.claimedAt) {
          await replyCard(message as never, "邮件", "该邮件已经领取/已读。");
          return;
        }
        let attachmentSummary = "";
        if (mail.attachments.length > 0) {
          for (const entry of mail.attachments) {
            addPlayerItem(player, entry.itemId, entry.quantity);
          }
          attachmentSummary = "\n已领取附件：" + mail.attachments.map((a) => `${DEFAULT_MMORPG_CONTENT.items[a.itemId]?.name ?? a.itemId} x${a.quantity}`).join("、");
          savePlayer(player);
        }
        mail.claimedAt = new Date().toISOString();
        stateStore!.saveMail(mail);
        await replyCard(message as never, "邮件已领取", formatMailDetail(mail) + attachmentSummary);
      });

      menuPlugin.registerCommand("mmo-guild", "打开公会菜单", async (message, _args, ctx) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const result = await dispatchMenuAction(player, { type: "open_guild" }, message, ctx);
        if (result) await replyCard(message as never, "公会", result);
      });

      menuPlugin.registerCommand("mmo-guild-create", `创建公会：${menuPlugin.getPrefix()}mmo-guild-create <公会名称>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        if (player.guildId) throw new Error("你已经在公会中。");
        const name = args.join(" ").trim();
        if (!name) throw new Error("公会名称不能为空。");
        if (stateStore!.findGuildByName(name)) throw new Error("该公会名称已存在。");
        const guild = stateStore!.createGuild({ name, leaderUserId: player.userId });
        player.guildId = guild.id;
        savePlayer(player);
        await replyCard(message as never, "公会", `已创建公会「${name}」。`);
      });

      menuPlugin.registerCommand("mmo-guild-join", `加入公会：${menuPlugin.getPrefix()}mmo-guild-join <公会名称>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        if (player.guildId) throw new Error("你已经在公会中。");
        const name = args.join(" ").trim();
        if (!name) throw new Error("请输入公会名称。");
        const guild = stateStore!.findGuildByName(name);
        if (!guild) throw new Error("未找到该公会。");
        guild.memberUserIds.push(player.userId);
        stateStore!.saveGuild(guild);
        player.guildId = guild.id;
        savePlayer(player);
        await replyCard(message as never, "公会", `已加入公会「${guild.name}」。`);
      });

      menuPlugin.registerCommand("mmo-guild-leave", `离开当前公会：${menuPlugin.getPrefix()}mmo-guild-leave`, async (message) => {
        const player = requirePlayerFromMessage(message);
        if (!player.guildId) throw new Error("你不在任何公会中。");
        const guild = stateStore!.getGuild(player.guildId);
        if (!guild) {
          player.guildId = undefined;
          savePlayer(player);
          await replyCard(message as never, "公会", "公会已不存在。");
          return;
        }
        const guildName = guild.name;
        guild.memberUserIds = guild.memberUserIds.filter((id) => id !== player.userId);
        if (guild.memberUserIds.length === 0) stateStore!.removeGuild(guild.id);
        else stateStore!.saveGuild(guild);
        player.guildId = undefined;
        savePlayer(player);
        await replyCard(message as never, "公会", `已离开公会「${guildName}」。`);
      });

      menuPlugin.registerCommand("mmo-guild-donate", `向公会捐赠金币：${menuPlugin.getPrefix()}mmo-guild-donate <金额>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        if (!player.guildId) throw new Error("你不在任何公会中。");
        const guild = stateStore!.getGuild(player.guildId);
        if (!guild) throw new Error("公会不存在。");
        const amount = Number(args[0]);
        if (!Number.isFinite(amount) || amount < 1) throw new Error("捐赠金额无效。");
        syncPlayerEconomy(player.userId, player);
        if ((player.currencies.gold ?? 0) < amount) throw new Error("金币不足。");
        const profile = store.getUserData(player.userId);
        profile.coins -= amount;
        store.saveUserData(player.userId, profile);
        stateStore!.recordMMOCoinsGranted(player.userId, -amount, profile.coins);
        player.currencies.gold = profile.coins;
        guild.treasury.gold = (guild.treasury.gold ?? 0) + amount;
        stateStore!.saveGuild(guild);
        savePlayer(player);
        await replyCard(message as never, "公会", `已向公会捐赠 ${amount} 金币。公会金库：${guild.treasury.gold}`);
      });

      menuPlugin.registerCommand("mmo-guild-kick", `会长踢出成员：${menuPlugin.getPrefix()}mmo-guild-kick <userId>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        if (!player.guildId) throw new Error("你不在任何公会中。");
        const guild = stateStore!.getGuild(player.guildId);
        if (!guild) throw new Error("公会不存在。");
        if (guild.leaderUserId !== player.userId) throw new Error("只有会长可以踢人。");
        const targetUserId = args[0]?.trim();
        if (!targetUserId) throw new Error("请输入要踢出的用户ID。");
        if (targetUserId === player.userId) throw new Error("不能踢出自己。");
        if (!guild.memberUserIds.includes(targetUserId)) throw new Error("该成员不在公会中。");
        guild.memberUserIds = guild.memberUserIds.filter((id) => id !== targetUserId);
        stateStore!.saveGuild(guild);
        const targetPlayer = getExistingPlayer(targetUserId);
        if (targetPlayer) {
          targetPlayer.guildId = undefined;
          savePlayer(targetPlayer);
        }
        await replyCard(message as never, "公会", `已将 ${targetUserId} 移出公会。`);
      });

      menuPlugin.registerCommand("mmo-skills", "查看已解锁技能", async (message) => {
        const player = requirePlayerFromMessage(message);
        autoFillEmptySlots(player);
        if (player.unlockedSkillIds.length === 0) {
          await replyCard(message as never, "技能列表", "你还没有解锁任何技能。");
          return;
        }
        const maxSlots = getMaxSkillSlots(player);
        const equippedSet = new Set(player.equippedSkillIds);
        // Group skills by category, annotated with equip status.
        const resolved = player.unlockedSkillIds
          .map((id) => DEFAULT_MMORPG_CONTENT.skills[id])
          .filter((sk): sk is NonNullable<typeof sk> => Boolean(sk));
        const byCat = (cat: "active" | "passive" | "utility") =>
          resolved.filter((sk) => sk.category === cat)
            .map((sk) => {
              let tag: string;
              if (sk.category === "passive") {
                tag = "[被动·生效中]";
              } else if (equippedSet.has(sk.id)) {
                tag = "[已装备]";
              } else if (player.equippedSkillIds.length < maxSlots) {
                tag = "[可装备]";
              } else {
                tag = "[槽位已满]";
              }
              return {
                label: `${sk.name} ${tag}`,
                description: formatSkillSummary(sk),
                action: { type: "view_skill" as const, targetId: sk.id },
              };
            });
        const activeItems = byCat("active");
        const passiveItems = byCat("passive");
        const utilityItems = byCat("utility");
        const groups: MenuGroup[] = [];
        if (activeItems.length) groups.push({ label: `主动技能（${activeItems.length}）`, category: "combat", items: activeItems });
        if (passiveItems.length) groups.push({ label: `被动技能（${passiveItems.length}，永久生效）`, category: "interact", items: passiveItems });
        if (utilityItems.length) groups.push({ label: `辅助技能（${utilityItems.length}）`, category: "interact", items: utilityItems });
        groups.push({ label: `槽位 ${player.equippedSkillIds.length}/${maxSlots}`, category: "system", items: [{ label: "管理技能槽位", action: { type: "open_skill_slots" as const } }] });
        const menu: PendingMenu = {
          context: `已解锁 ${player.unlockedSkillIds.length} · 槽位 ${player.equippedSkillIds.length}/${maxSlots}（主动 ${activeItems.length} · 被动 ${passiveItems.length} · 辅助 ${utilityItems.length}）`,
          title: "技能列表",
          groups,
          createdAt: new Date().toISOString(),
        };
        setAndSavePendingMenu(player, menu);
        try {
          await sendMenuImage(message, menu, "技能列表");
        } catch {
          const allItems = [...activeItems, ...passiveItems, ...utilityItems];
          const text = allItems.map((it, i) => `${i + 1}. ${it!.label} — ${it!.description}`).join("\n");
          await ctx.replyText(message, `技能列表：\n${text}\n\n输入 $mmo-pick <序号> 查看技能详情（消耗 / 冷却 / 描述）`);
        }
      });

      menuPlugin.registerCommand("mmo-skill-slots", "查看技能槽位状态", async (message) => {
        const player = requirePlayerFromMessage(message);
        autoFillEmptySlots(player);
        await replyCard(message as never, "技能槽位", formatSkillSlotStatus(player));
      });

      menuPlugin.registerCommand("mmo-equip-skill", `装备技能：${menuPlugin.getPrefix()}mmo-equip-skill <skillId>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        const skillId = args[0];
        if (!skillId) {
          await replyCard(message as never, "装备技能", `用法：${menuPlugin.getPrefix()}mmo-equip-skill <skillId>\n使用 ${menuPlugin.getPrefix()}mmo-skill-slots 查看可装备技能。`);
          return;
        }
        const result = equipSkill(player, skillId);
        await replyCard(message as never, "装备技能", result.message);
      });

      menuPlugin.registerCommand("mmo-unequip-skill", `卸下技能：${menuPlugin.getPrefix()}mmo-unequip-skill <槽位编号>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        const slotIndex = parseInt(args[0] ?? "", 10);
        if (isNaN(slotIndex) || slotIndex < 1) {
          await replyCard(message as never, "卸下技能", `用法：${menuPlugin.getPrefix()}mmo-unequip-skill <槽位编号>\n使用 ${menuPlugin.getPrefix()}mmo-skill-slots 查看槽位编号。`);
          return;
        }
        const result = unequipSkill(player, slotIndex);
        await replyCard(message as never, "卸下技能", result.message);
      });

      menuPlugin.registerCommand("mmo-skill-info", `查看技能详情：${menuPlugin.getPrefix()}mmo-skill-info <skillId>`, async (message, args) => {
        const skillId = args[0];
        if (!skillId) {
          await replyCard(message as never, "技能详情", `用法：${menuPlugin.getPrefix()}mmo-skill-info <skillId>`);
          return;
        }
        const skill = DEFAULT_MMORPG_CONTENT.skills[skillId];
        if (!skill) {
          await replyCard(message as never, "技能详情", `未知技能：${skillId}`);
          return;
        }
        await replyCard(message as never, "技能详情", formatSkillDetail(skill));
      });

      menuPlugin.registerCommand("mmo-skill-compare", `比较两个技能：${menuPlugin.getPrefix()}mmo-skill-compare <skillIdA> <skillIdB>`, async (message, args) => {
        const [aId, bId] = args;
        if (!aId || !bId) {
          await replyCard(message as never, "技能对比", `用法：${menuPlugin.getPrefix()}mmo-skill-compare <skillIdA> <skillIdB>`);
          return;
        }
        const skA = DEFAULT_MMORPG_CONTENT.skills[aId];
        const skB = DEFAULT_MMORPG_CONTENT.skills[bId];
        if (!skA) { await replyCard(message as never, "技能对比", `未知技能：${aId}`); return; }
        if (!skB) { await replyCard(message as never, "技能对比", `未知技能：${bId}`); return; }
        await replyCard(message as never, "技能对比", formatSkillCompare(skA, skB));
      });

      menuPlugin.registerCommand("mmo-factions", "查看阵营声望", async (message) => {
        const player = requirePlayerFromMessage(message);
        const newlyUnlocked = checkAchievementsOnReputations(player);
        if (newlyUnlocked.length > 0) savePlayer(player);
        const factionItems: PendingMenuItem[] = Object.values(DEFAULT_MMORPG_CONTENT.factions).map((faction) => {
          const rep = player.factionReputation[faction.id] ?? 0;
          const tierName = getReputationTierName(rep);
          const next = getNextReputationTier(rep);
          const nextHint = next ? `（下一级：${next.name} ${next.threshold}）` : "（已达最高）";
          const claimable = canClaimFactionReward(player, faction.id, rep);
          const claimHint = claimable.canClaim ? " 💰可领奖励" : "";
          return { label: faction.name, description: `${tierName} · 声望 ${rep}${nextHint}${claimHint}`, action: { type: "view_faction" as const, targetId: faction.id } };
        });
        const context = newlyUnlocked.length > 0 ? `阵营声望\n${formatNewlyUnlocked(newlyUnlocked)}` : "阵营声望";
        const menu: PendingMenu = { context, title: "阵营", groups: [{ label: "阵营", category: "interact", items: factionItems }], createdAt: new Date().toISOString() };
        setAndSavePendingMenu(player, menu);
        try {
          await sendMenuImage(message, menu, "阵营声望");
        } catch {
          const text = factionItems.map((it, i) => `${i + 1}. ${it.label} - ${it.description}`).join("\n");
          await ctx.replyText(message, `${context}：\n${text}\n\n输入 $mmo-pick <序号> 查看详情\n使用 ${menuPlugin.getPrefix()}mmo-faction-claim <factionId> 领取奖励`);
        }
      });

      menuPlugin.registerCommand("mmo-faction-claim", `领取阵营声望奖励：${menuPlugin.getPrefix()}mmo-faction-claim <factionId>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        const factionId = args[0]?.trim();
        if (!factionId) {
          await replyCard(message as never, "阵营", `格式：${menuPlugin.getPrefix()}mmo-faction-claim <factionId>`);
          return;
        }
        const faction = DEFAULT_MMORPG_CONTENT.factions[factionId];
        if (!faction) {
          await replyCard(message as never, "阵营", "未知阵营。");
          return;
        }
        const rep = player.factionReputation[factionId] ?? 0;
        const result = claimFactionReward(player, factionId, rep);
        if (result.success) {
          grantBridgedCoins(player.userId, result.reward, ctx);
          savePlayer(player);
        }
        await replyCard(message as never, "阵营", result.message);
      });

      menuPlugin.registerCommand("mmo-professions", "查看副职业等级", async (message) => {
        const player = requirePlayerFromMessage(message);
        const newlyUnlocked = checkAchievementsOnProfessions(player);
        if (newlyUnlocked.length > 0) savePlayer(player);
        const profs = Object.values(DEFAULT_MMORPG_CONTENT.professions);
        if (profs.length === 0) {
          await replyCard(message as never, "副职业", "当前没有副职业数据。");
          return;
        }
        const lines = profs.map((prof) => {
          const level = player.professionLevels[prof.id] ?? 0;
          let title = "见习";
          if (level >= 300) title = "宗师";
          else if (level >= 150) title = "专家";
          else if (level >= 75) title = "熟练";
          else if (level >= 25) title = "进阶";
          else if (level >= 5) title = "入门";
          return `• ${prof.name}：Lv.${level}（${title}）`;
        });
        const achText = formatNewlyUnlocked(newlyUnlocked);
        if (achText) lines.push("", achText.slice(1));
        await replyCard(message as never, "副职业", lines.join("\n"));
      });

      menuPlugin.registerCommand("mmo-achievements", "查看成就列表", async (message) => {
        const player = requirePlayerFromMessage(message);
        const achItems: PendingMenuItem[] = Object.values(DEFAULT_MMORPG_CONTENT.achievements).map((ach) => {
          const status = getAchievementStatus(player, ach.id);
          const statusDesc = status === "claimed" ? "已领取" : status === "unlocked" ? "可领取" : "未解锁";
          return {
            label: formatAchievementLabel(player, ach.id, ach.name),
            description: `${ach.description}（${statusDesc} · 奖励 ${ach.rewardCoins}g）`,
            action: { type: "view_achievement" as const, targetId: ach.id },
          };
        });
        const pendingClaims = player.unlockedAchievementIds.filter((id) => !player.claimedAchievementIds.includes(id)).length;
        const context = pendingClaims > 0 ? `成就列表 · 有 ${pendingClaims} 项成就待领取奖励\n使用 ${menuPlugin.getPrefix()}mmo-achievement-claim <成就ID> 领取` : "成就列表";
        const menu: PendingMenu = { context, title: "成就列表", groups: [{ label: "成就", category: "interact", items: achItems }], createdAt: new Date().toISOString() };
        setAndSavePendingMenu(player, menu);
        try {
          await sendMenuImage(message, menu, "成就列表");
        } catch {
          const text = achItems.map((it, i) => `${i + 1}. ${it.label} - ${it.description}`).join("\n");
          await ctx.replyText(message, `${context}：\n${text}\n\n输入 ${menuPlugin.getPrefix()}mmo-pick <序号> 查看详情`);
        }
      });

      menuPlugin.registerCommand("mmo-achievement-claim", `领取成就奖励：${menuPlugin.getPrefix()}mmo-achievement-claim <成就ID>`, async (message, args) => {
        const player = requirePlayerFromMessage(message);
        const achievementId = args[0]?.trim();
        if (!achievementId) {
          await replyCard(message as never, "成就", `格式：${menuPlugin.getPrefix()}mmo-achievement-claim <成就ID>`);
          return;
        }
        const result = claimAchievement(player, achievementId, (amount) => grantBridgedCoins(player.userId, amount, ctx));
        if (result.success) {
          savePlayer(player);
        }
        await replyCard(message as never, "成就", result.message);
      });

      menuPlugin.registerCommand("mmo-battle-log", "查看上一场战斗的详细日志（图片）", async (message) => {
        const player = requirePlayerFromMessage(message);
        const log = battleLogStore.get(player.userId);
        if (!log) {
          await replyCard(message as never, "战斗记录", "你还没有战斗记录。完成一场战斗后再来查看。");
          return;
        }
        try {
          const imgPath = await renderBattleLogToImage(log, process.cwd());
          const target = resolveMessageTarget(message);
          await ctx.sendImage(target, imgPath);
        } catch {
          await ctx.replyText(message, formatBattleLog(log));
        }
      });

      menuPlugin.registerCommand("mmo-portrait", "生成或查看角色立绘（管理员无限次，普通用户每日一次）", async (message, args) => {
        if (!message.userId) {
          await replyCard(message as never, "立绘", "无法确定当前用户身份。");
          return;
        }
        const player = getExistingPlayer(message.userId);
        if (!player) {
          await replyCard(message as never, "立绘", `你还没有创建角色。先使用 ${menuPlugin.getPrefix()}mmo-create 创建角色。`);
          return;
        }

        const fwConfig = ctx.config.pluginSettings.mmorpgFramework;
        if (!fwConfig.imageApiBaseUrl || !fwConfig.imageApiKey) {
          await replyCard(message as never, "立绘", "立绘生成功能尚未配置。请联系管理员设置 imageApiBaseUrl 和 imageApiKey。");
          return;
        }

        const isAdmin = ctx.config.auth.adminUserIds.includes(message.userId);
        const forceRegen = args.includes("regen");

        // If portrait exists and user is not requesting regeneration, return cached
        if (player.portraitPath && !forceRegen) {
          if (fs.existsSync(player.portraitPath)) {
            const target = resolveMessageTarget(message);
            await ctx.sendImage(target, player.portraitPath, `你的角色立绘（已缓存）。如需重新生成，请使用 ${menuPlugin.getPrefix()}mmo-portrait regen`);
            return;
          }
        }

        // Rate limit check for non-admin users (once per day)
        if (!isAdmin) {
          const lastGen = portraitRateLimitMap.get(message.userId);
          if (lastGen) {
            const now = Date.now();
            const dayMs = 24 * 60 * 60 * 1000;
            if (now - lastGen < dayMs) {
              const remaining = dayMs - (now - lastGen);
              const hours = Math.floor(remaining / (60 * 60 * 1000));
              const minutes = Math.ceil((remaining % (60 * 60 * 1000)) / (60 * 1000));
              await replyCard(message as never, "立绘", `你今天已经生成过立绘了。请 ${hours} 小时 ${minutes} 分钟后再试。\n💡 如果已有立绘，可直接发送 $mmo-portrait 查看缓存。`);
              return;
            }
          }
        }

        // Resolve character info for prompt
        const race = DEFAULT_MMORPG_CONTENT.races[player.raceId];
        const classDef = DEFAULT_MMORPG_CONTENT.classes[player.classId];
        const gender = DEFAULT_MMORPG_CONTENT.genders[player.genderId];

        // Get group nickname from OneBot sender
        const sender = message.raw.sender as { card?: string; nickname?: string } | undefined;
        const groupName = sender?.card?.trim() || sender?.nickname?.trim() || message.userId;

        const prompt = [
          "你是一个专业的日本二次元插画师，你现在的任务是要根据如下角色形象来绘制一个游戏的立绘，画风与配色要贴合角色形象：",
          `名称：${groupName}`,
          `种族 / 职业 / 性别：${race?.name ?? player.raceId} / ${classDef?.name ?? player.classId} / ${gender?.name ?? player.genderId}`,
          `外貌：${player.appearance}`,
          `个人宣言：${player.personalDeclaration || "无"}`,
          "生成的图片要保证高质量与结构合理性、有一定的装扮。立绘角色动作要自然合理，好看美观，光影自然不要出现过度的明暗突变。",
        ].join("\n");

        await ctx.replyText(message, "正在生成角色立绘，请稍候…");

        try {
          const imageGenConfig: ImageGenConfig = {
            baseUrl: fwConfig.imageApiBaseUrl,
            apiKey: fwConfig.imageApiKey,
            model: fwConfig.imageApiModel,
          };

          const portraitDir = path.join(process.cwd(), "data", "portraits");
          const fileName = `portrait_${message.userId}_${Date.now()}.png`;

          const outputPath = await generateAndSaveImage(
            imageGenConfig,
            prompt,
            portraitDir,
            fileName,
            { size: "1024x1024", quality: "high" },
          );

          // Convert PNG to WebP for smaller file size
          let webpPath: string;
          try {
            webpPath = await convertImageToWebp(outputPath);
          } catch {
            webpPath = outputPath; // fallback to PNG
          }

          // Update player state
          player.portraitPath = webpPath;
          player.portraitGeneratedAt = new Date().toISOString();
          savePlayer(player);

          // Record rate limit
          if (!isAdmin) {
            portraitRateLimitMap.set(message.userId, Date.now());
          }

          const target = resolveMessageTarget(message);
          await ctx.sendImage(target, webpPath, "角色立绘生成完成！");
        } catch (err: any) {
          console.error("[MMORPG] 立绘生成失败:", err);
          await replyCard(message as never, "立绘生成失败", `${err?.message ?? "未知错误"}\n请稍后重试。`);
        }
      });

      // ── MMO Mall (金币消费商城) ──
      menuPlugin.registerCommand("mmo-mall", "打开 MMO 金币商城（消耗金币购买道具）", async (message) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);
        const shopItems = MMORPG_RULEBOOK.mmoShop.items;
        const menuItems: PendingMenuItem[] = [];
        for (const entry of shopItems) {
          const item = DEFAULT_MMORPG_CONTENT.items[entry.itemId];
          if (!item) continue;
          menuItems.push({
            label: item.name,
            description: `${entry.price}g${item.description ? " · " + item.description : ""}`,
            action: { type: "buy" as const, targetId: "mmo_mall", extra: { itemId: item.id, quantity: "1", source: "mall" } },
          });
        }
        const menu: PendingMenu = {
          context: `金币：${player.currencies.gold}`,
          title: "MMO 金币商城",
          groups: [{ label: "商城道具", category: "interact", items: menuItems }],
          createdAt: new Date().toISOString(),
        };
        setAndSavePendingMenu(player, menu);
        try {
          await sendMenuImage(message, menu, "MMO 金币商城");
        } catch {
          const text = menuItems.map((it, i) => `${i + 1}. ${it.label} - ${it.description}`).join("\n");
          await ctx.replyText(message, `MMO 金币商城：\n${text}\n\n输入 $mmo-pick <序号> 购买`);
        }
      });

      // ── Rebirth (轮回系统) ──
      menuPlugin.registerCommand("mmo-rebirth", `轮回重生：达到 ${MMORPG_RULEBOOK.progression.maxLevel} 级后可轮回，永久提升基础属性`, async (message) => {
        const player = requirePlayerFromMessage(message);
        requireNotInCombat(player);

        if (player.level < MMORPG_RULEBOOK.progression.maxLevel) {
          await replyCard(message as never, "轮回", `需要达到 ${MMORPG_RULEBOOK.progression.maxLevel} 级才能进行轮回。当前等级：${player.level}。`);
          return;
        }

        if (player.rebirthCount >= MMORPG_RULEBOOK.rebirth.maxRebirths) {
          await replyCard(message as never, "轮回", `已达到最大轮回次数（${MMORPG_RULEBOOK.rebirth.maxRebirths} 次）。无法继续轮回。`);
          return;
        }

        // Perform rebirth
        const newRebirthCount = player.rebirthCount + 1;
        const bonusPerStat = MMORPG_RULEBOOK.rebirth.statBonusPerRebirth;
        const newRebirthBonus: StatBlock = {
          strength: (player.rebirthBonus?.strength ?? 0) + bonusPerStat,
          defense: (player.rebirthBonus?.defense ?? 0) + bonusPerStat,
          charm: (player.rebirthBonus?.charm ?? 0) + bonusPerStat,
          agility: (player.rebirthBonus?.agility ?? 0) + bonusPerStat,
          eloquence: (player.rebirthBonus?.eloquence ?? 0) + bonusPerStat,
          endurance: (player.rebirthBonus?.endurance ?? 0) + bonusPerStat,
          life: (player.rebirthBonus?.life ?? 0) + bonusPerStat,
        };

        // Reset level and exp
        player.level = 1;
        player.exp = 0;
        player.rebirthCount = newRebirthCount;
        player.rebirthBonus = newRebirthBonus;

        // Rebuild stats with new rebirth bonus
        const classDef = requireClass(player.classId);
        player.stats = buildCharacterStats(player.raceId, classDef, 1, newRebirthBonus);
        player.resources = createBaseResources(player.stats);

        // Reset position to starter
        player.areaId = STARTER_AREA_ID;
        healPlayer(player);

        // Clear death marker and fishing session
        player.deathMarker = undefined;
        player.fishingSession = undefined;

        savePlayer(player);

        const bonusText = Object.entries(newRebirthBonus)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}+${v}`)
          .join(", ");

        await replyCard(message as never, "轮回重生", [
          `你已完成第 ${newRebirthCount} 次轮回！`,
          `等级重置为 1 级，但获得了永久的属性加成：`,
          `${bonusText}`,
          `HP 上限额外增加 +${newRebirthCount * MMORPG_RULEBOOK.rebirth.hpBonusPerRebirth}`,
          `当前位置已重置为 ${requireArea(STARTER_AREA_ID).name}。`,
          `轮回次数：${newRebirthCount}/${MMORPG_RULEBOOK.rebirth.maxRebirths}`,
        ].join("\n"));
      });
    },

    getToolRegistrations() {
      return [
        makeTool("mmo_framework_overview", "获取文字冒险 MMORPG 框架模块摘要。", { type: "object", properties: {}, required: [] }, async () => [
          ...summarizeFramework(DEFAULT_MMORPG_CONTENT),
          "角色必须先创建后游玩。",
          "金币已桥接到 Bot 经济系统。",
          `内容校验错误：${validationReport.errors.length}`,
          `内容校验警告：${validationReport.warnings.length}`,
        ].join("\n")),
        makeTool("mmo_character_options", "查看可选种族、职业、性别，以及婚姻/改造道具要求。", { type: "object", properties: {}, required: [] }, async () => formatCreationOptions()),
        makeTool("mmo_create_character", "为当前用户创建 MMORPG 角色。", {
          type: "object",
          properties: {
            raceId: { type: "string" },
            classId: { type: "string" },
            genderId: { type: "string" },
            appearance: { type: "string" },
            personalDeclaration: { type: "string" },
          },
          required: ["raceId", "classId", "genderId", "appearance"],
        }, async (args, input) => {
          const ctx = ensureContext(ctxRef);
          const userId = resolveInputUserId(input);
          if (!userId) {
            throw new Error("当前上下文缺少 userId。");
          }
          const player = createCharacter({
            userId,
            raceId: requireString(args.raceId, "raceId"),
            classId: requireString(args.classId, "classId"),
            genderId: requireString(args.genderId, "genderId"),
            appearance: requireString(args.appearance, "appearance"),
            personalDeclaration: optionalString(args.personalDeclaration),
          }, ctx);
          return formatPlayerSnapshot(player, true);
        }),
        makeTool("mmo_player_snapshot", "获取当前用户的 MMORPG 角色快照。若尚未建号，则返回建号提示。", {
          type: "object",
          properties: {},
          required: [],
        }, async (_args, input) => {
          const userId = resolveInputUserId(input);
          if (!userId) {
            throw new Error("当前上下文缺少 userId。");
          }
          const player = getExistingPlayer(userId);
          return player ? formatPlayerSnapshot(syncPlayerEconomy(userId, player)) : "你还没有创建角色。先创建角色后再查看档案。";
        }),
        makeTool("mmo_current_location", "获取当前用户所在区域与可前往地点。", {
          type: "object",
          properties: {},
          required: [],
        }, async (_args, input) => {
          const userId = resolveInputUserId(input);
          if (!userId) {
            throw new Error("当前上下文缺少 userId。");
          }
          return formatAreaStatus(requirePlayer(userId));
        }),
        makeTool("mmo_fishing_status", "获取当前用户的钓鱼状态与鱼篓概览。", {
          type: "object",
          properties: {},
          required: [],
        }, async (_args, input) => {
          const userId = resolveInputUserId(input);
          if (!userId) {
            throw new Error("当前上下文缺少 userId。");
          }
          const player = requirePlayer(userId);
          return [formatFishingStatus(player), formatFishBasket(player, { compact: true })].join("\n");
        }),
        makeTool("mmo_shared_coin_balance", "获取当前用户共享金币余额和当前加成。", {
          type: "object",
          properties: {},
          required: [],
        }, async (_args, input) => {
          const ctx = ensureContext(ctxRef);
          const userId = resolveInputUserId(input);
          if (!userId) {
            throw new Error("当前上下文缺少 userId。");
          }
          const player = requirePlayer(userId);
          const synced = syncPlayerEconomy(userId, player);
          const bonus = getActiveBonuses(synced);
          return [
            `共享金币余额：${synced.currencies.gold}`,
            `MMORPG 累计产出金币：${synced.coinsEarnedFromMMO}`,
            `当前奖励加成：经验 +${formatPercent(bonus.expRate)}，金币 +${formatPercent(bonus.goldRate)}`,
            "金币桥接说明：Bot coins 为唯一真实余额，MMORPG gold 为同步镜像。",
          ].join("\n");
        }),
      ];
    },

    flush() {
      stateStore?.flush();
      closeBrowser().catch(() => {});
    },
  };

  return plugin;

  function registerFrameworkItems() {
    const bridgeItems: StoreItemDef[] = [
      { id: "race_rewrite_scroll", name: "种族重塑卷轴", description: "修改 MMORPG 角色种族。", price: 288 },
      { id: "gender_mirror", name: "性别映照镜", description: "修改 MMORPG 角色性别。", price: 288 },
      { id: "makeover_ticket", name: "造型改造券", description: "修改 MMORPG 角色外貌。", price: 188 },
      { id: "wedding_ring", name: "誓约戒指", description: "结婚所需特殊道具。", price: 888 },
    ];
    for (const item of bridgeItems) {
      if (!store.getItem(item.id)) {
        store.addItem(item);
      }
    }
  }

  async function handleCreateCharacterCommand(
    message: { type: string; groupId?: string; userId?: string },
    args: string[],
    ctx: PluginContext,
    commandName: string
  ) {
    if (!message.userId) {
      throw new Error("无法确定当前用户身份。");
    }
    if (args.length < 4) {
      await replyCard(message, "创建角色失败", `参数不足。\n用法：${menuPlugin.getPrefix()}${commandName} <raceId> <classId> <genderId> <appearance> [personalDeclaration...]`);
      return;
    }
    const [raceId, classId, genderId, appearanceRaw, ...declarationParts] = args;
    const personalDeclaration = declarationParts.length > 0 ? declarationParts.join(" ") : undefined;
    try {
      const player = createCharacter({
        userId: message.userId,
        raceId,
        classId,
        genderId,
        appearance: appearanceRaw,
        personalDeclaration,
      }, ctx);
      const profileMenu = buildProfileMenu(player);
      setAndSavePendingMenu(player, profileMenu);
      try {
        await sendDetailMenuImage(message, {
          title: profileMenu.title,
          context: profileMenu.context,
          details: buildProfileDetails(player),
          menu: profileMenu,
        });
      } catch {
        await replyCard(message, "角色创建成功", formatPlayerSnapshot(player, true));
      }
    } catch (err) {
      await replyCard(message, "创建角色失败", err instanceof Error ? err.message : String(err));
    }
  }
}
