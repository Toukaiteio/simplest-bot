/**
 * 猜动漫人物插件
 *
 * 命令:
 *   $guessr          — 创建/加入游戏（群聊）
 *   $guessr join     — 加入游戏
 *   $guessr start    — 房主开始游戏
 *   $guessr guess <名字> — 猜测角色
 *   $guessr board    — 查看当前面板
 *   $guessr end      — 房主结束游戏
 *   $guessr help     — 帮助
 */

import fs from "node:fs";
import path from "node:path";
import type { BotMessage, MenuPlugin, Plugin, PluginContext } from "../../types.js";
import type { OneBotClient } from "../../onebot.js";
import { screenshotHtml } from "../mmorpg/screenshot.js";
import type { AnimeAppearance, AnimeCharacter, AnimeWork, Contribution, Game, PlayerState, GuessrConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { generateFeedback, isCorrectGuess, pickRandomAnswer } from "./logic.js";
import { buildSearchIndex, searchIndex, searchWorks, getCharactersByWork } from "./search-index.js";
import { fetchCharacterById, fetchWorkContribution, initDynamicFetch, searchBangumiCharacterCandidates } from "./dynamic-fetch.js";
import { renderGameHtml, renderLobbyHtml, renderSearchResults, renderWorkCharacters, renderInfoCard, renderSelectMenu, renderHelpCard } from "./render.js";
import { loadCharacterDatabase } from "./data.js";
import { initStats, recordGameResult, getPlayerStats, getGlobalRanking, getGroupRanking, getPlayerRank, computeRadar, updateName } from "./stats.js";
import { renderPlayerCard, renderLeaderboard } from "./stats-render.js";
import { ContributionStore } from "./contribution-store.js";
import { CharacterResolver, type ResolvedCharacterCandidate } from "./character-resolver.js";

// ===== 游戏存储 =====

const games = new Map<string, Game>(); // key: groupId
const pendingChoices = new Map<string, ResolvedCharacterCandidate[]>(); // key: groupId:userId
const idleTracker = new Map<string, Map<string, number>>(); // groupId -> (userId -> 连续未猜测局数)
const quickContributions = new Set<string>(); // userId:work，防止重复提交同一拉取任务

// ===== 工具函数 =====

function getGame(groupId: string): Game | undefined {
  return games.get(groupId);
}

function removeGame(groupId: string): void {
  games.delete(groupId);
}

// ===== 插件工厂 =====

export function createAnimeGuessrPlugin(
  menuPlugin: MenuPlugin,
  onebot: OneBotClient,
  config?: Partial<GuessrConfig>,
): Plugin {
  const cfg: GuessrConfig = { ...DEFAULT_CONFIG, ...config };
  let pluginCtx: PluginContext;
  let database: AnimeCharacter[] = [];
  let contributionStore: ContributionStore;
  let characterResolver: CharacterResolver;

  function rebuildAndPersistDatabase(): void {
    buildSearchIndex(database);
    const target = path.resolve(process.cwd(), cfg.dataFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(database, null, 2), "utf8");
    fs.renameSync(temp, target);
  }

  function initializeDatabase(): void {
    database = loadCharacterDatabase(cfg.dataFile);
    buildSearchIndex(database);
    const works = new Map<number, AnimeWork>();
    for (const character of database) {
      for (const appearance of character.appearances) works.set(appearance.id, { ...appearance, source: "bangumi" });
    }
    contributionStore ??= new ContributionStore(cfg.contributionFile, [...works.values()]);
    initDynamicFetch(database, cfg.dataFile, () => buildSearchIndex(database), {
      proxy: cfg.bangumiProxy, token: cfg.bangumiToken, backgroundCharactersPerWork: cfg.backgroundCharactersPerWork,
      onWorkDiscovered: (work) => contributionStore.upsertWork(work),
    });
    characterResolver ??= new CharacterResolver({
      cacheFile: cfg.searchCacheFile,
      positiveTtlDays: cfg.searchCacheTtlDays,
      negativeTtlDays: cfg.searchNegativeCacheTtlDays,
      minRemoteIntervalMs: cfg.bangumiSearchMinIntervalMs,
      dailyRemoteLimit: cfg.bangumiSearchDailyLimit,
      searchLocal: searchIndex,
      findLocalById: (id) => database.find((character) => character.id === id),
      searchRemote: searchBangumiCharacterCandidates,
      fetchDetail: fetchCharacterById,
    });
  }

  // 发送图片辅助
  async function sendHtmlAsImage(message: BotMessage, html: string): Promise<void> {
    const tmpDir = path.resolve("data/guessr-images");
    fs.mkdirSync(tmpDir, { recursive: true });
    const imgPath = path.join(tmpDir, `guessr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.webp`);
    await screenshotHtml(html, imgPath, { format: "webp", quality: 85 });
    const target = message.type === "group"
      ? { type: "group" as const, id: message.groupId! }
      : { type: "private" as const, id: message.userId! };
    await pluginCtx.sendImage(target, imgPath);
    // 清理临时文件
    setTimeout(() => { try { fs.unlinkSync(imgPath); } catch {} }, 60_000);
  }

  async function replyText(message: BotMessage, text: string): Promise<void> {
    await pluginCtx.replyText(message, text);
  }

  /** 短消息也用图片卡片 */
  async function replyCard(message: BotMessage, title: string, text: string): Promise<void> {
    const html = renderInfoCard(title, text.split("\n"));
    await sendHtmlAsImage(message, html);
  }

  // ===== 命令处理 =====

  async function handleGuessr(message: BotMessage, args: string[]): Promise<void> {
    const earlySubCmd = (args[0] ?? "").toLowerCase();
    if (earlySubCmd === "contribute" || earlySubCmd === "投稿") {
      await handleContribute(message, args.slice(1));
      return;
    }
    if (earlySubCmd === "review" || earlySubCmd === "审核") {
      await handleReview(message, args.slice(1));
      return;
    }
    if (message.type !== "group") {
      await replyCard(message, "提示", "猜动漫人物只能在群聊中游玩。");
      return;
    }

    const groupId = message.groupId!;
    const userId = message.userId!;
    const subCmd = (args[0] ?? "").toLowerCase();

    switch (subCmd) {
      case "":
      case "join":
        await handleJoin(message, groupId, userId);
        break;
      case "start":
        await handleStart(message, groupId, userId);
        break;
      case "guess":
      case "g":
        await handleGuess(message, groupId, userId, args.slice(1).join(" "));
        break;
      case "board":
      case "b":
        await handleBoard(message, groupId, userId);
        break;
      case "end":
        await handleEnd(message, groupId, userId);
        break;
      case "search":
      case "s":
        await handleSearch(message, args.slice(1).join(" "));
        break;
      case "rank":
        await handleRank(message, groupId, args[1]?.toLowerCase());
        break;
      case "me":
      case "stats":
        await handleMe(message, groupId, userId);
        break;
      case "help":
      case "h":
        await handleHelp(message);
        break;
      default:
        // 如果没有子命令但有参数，视为直接猜测
        if (args.length > 0) {
          await handleGuess(message, groupId, userId, args.join(" "));
        } else {
          await handleJoin(message, groupId, userId);
        }
    }
  }

  // ----- 加入 -----
  async function handleJoin(message: BotMessage, groupId: string, userId: string): Promise<void> {
    let game = getGame(groupId);

    if (!game) {
      // 创建新游戏
      const name = await pluginCtx.getGroupNickname(userId, groupId);
      game = {
        groupId,
        state: "waiting",
        answer: null,
        players: new Map(),
        creatorId: userId,
        round: 0,
        startedAt: 0,
        endedAt: null,
      };
      game.players.set(userId, {
        userId,
        name,
        guesses: [],
        maxAttempts: cfg.maxAttempts,
        finished: false,
        won: false,
      });
      games.set(groupId, game);
      const html = renderLobbyHtml(game);
      await sendHtmlAsImage(message, html);
      return;
    }

    if (game.state === "playing") {
      // 游戏进行中也可以加入
      if (game.players.has(userId)) {
        const html = renderGameHtml(game, userId);
        await sendHtmlAsImage(message, html);
        return;
      }
      const name = await pluginCtx.getGroupNickname(userId, groupId);
      game.players.set(userId, {
        userId,
        name,
        guesses: [],
        maxAttempts: cfg.maxAttempts,
        finished: false,
        won: false,
      });
      const html = renderInfoCard("已加入游戏", [
        `当前第 ${game.round} 局，进行中`,
        `发送 $guessr guess <角色名> 开始猜测`,
        `支持拼音 / 首字母 / 别名`,
      ]);
      await sendHtmlAsImage(message, html);
      return;
    }

    if (game.state === "ended") {
      // 上一局已结束，创建新局
      removeGame(groupId);
      await handleJoin(message, groupId, userId);
      return;
    }

    // waiting 状态
    if (game.players.has(userId)) {
      const html = renderLobbyHtml(game);
      await sendHtmlAsImage(message, html);
      return;
    }
    const name = await pluginCtx.getGroupNickname(userId, groupId);
    game.players.set(userId, {
      userId,
      name,
      guesses: [],
      maxAttempts: cfg.maxAttempts,
      finished: false,
      won: false,
    });

    const html = renderLobbyHtml(game);
    await sendHtmlAsImage(message, html);
  }

  // ----- 开始 -----
  async function handleStart(message: BotMessage, groupId: string, userId: string): Promise<void> {
    const game = getGame(groupId);
    if (!game) {
      await replyCard(message, "提示", "没有进行中的游戏。发送 $guessr 创建。");
      return;
    }
    if (game.creatorId !== userId) {
      await replyCard(message, "提示", "只有房主可以开始游戏。");
      return;
    }
    if (game.state === "playing") {
      await replyCard(message, "提示", "游戏已经在进行中了。");
      return;
    }

    // 加载数据库
    try {
      initializeDatabase();
    } catch (e) {
      await replyCard(message, "提示", `❌ 数据加载失败: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // 选取答案
    game.answer = pickRandomAnswer(database, cfg.minPopularity);
    game.state = "playing";
    game.round += 1;
    game.startedAt = Date.now();

    // 超时退出：连续 3 局未猜测的玩家自动移出
    if (!idleTracker.has(groupId)) idleTracker.set(groupId, new Map());
    const idleMap = idleTracker.get(groupId)!;
    const removed: string[] = [];
    for (const [uid] of game.players) {
      const idle = (idleMap.get(uid) ?? 0) + 1;
      idleMap.set(uid, idle);
      if (idle >= 3) {
        removed.push(game.players.get(uid)?.name ?? uid);
        game.players.delete(uid);
        idleMap.delete(uid);
      }
    }
    if (removed.length > 0) {
      await replyCard(message, "提示", `${removed.join(", ")} 因连续 3 局未参与已被移出。`);
    }

    // 重置所有玩家状态
    for (const player of game.players.values()) {
      player.guesses = [];
      player.finished = false;
      player.won = false;
    }

    const startHtml = renderInfoCard(`第 ${game.round} 局开始`, [
      `答案已选定，${game.players.size} 位玩家参与`,
      `每人 ${cfg.maxAttempts} 次机会`,
      ``,
      `$guessr guess <角色名> 进行猜测`,
      `支持中文名 / 日文名 / 拼音 / 首字母 / 别名`,
    ]);
    await sendHtmlAsImage(message, startHtml);
  }

  // ----- 猜测 -----
  async function handleGuess(message: BotMessage, groupId: string, userId: string, query: string): Promise<void> {
    const game = getGame(groupId);
    if (!game || game.state !== "playing") {
      await replyCard(message, "提示", "当前没有进行中的游戏。");
      return;
    }
    if (!game.answer) {
      await replyCard(message, "提示", "游戏异常：答案未设定。");
      return;
    }

    let player = game.players.get(userId);
    if (!player) {
      // 自动加入
      const name = await pluginCtx.getGroupNickname(userId, groupId);
      player = { userId, name, guesses: [], maxAttempts: cfg.maxAttempts, finished: false, won: false };
      game.players.set(userId, player);
    }

    if (player.finished) {
      await replyCard(message, "提示", player.won ? "你已经猜中了！👑" : "你的次数已用完。💀");
      return;
    }

    if (!query.trim()) {
      await replyCard(message, "提示", "请输入角色名。例如: $guessr guess 夜神月");
      return;
    }

    // 歧义菜单后的序号必须先处理，否则数字会被当作角色名搜索。
    const choiceKey = `${groupId}:${userId}`;
    const selectedNumber = Number(query.trim());
    if (Number.isInteger(selectedNumber) && pendingChoices.has(choiceKey)) {
      const choices = pendingChoices.get(choiceKey)!;
      if (selectedNumber >= 1 && selectedNumber <= choices.length) {
        pendingChoices.delete(choiceKey);
        const selected = await characterResolver.materialize(choices[selectedNumber - 1]);
        if (!selected) {
          await replyCard(message, "角色资料获取失败", "Bangumi 返回了该候选，但暂时无法获取其完整动画角色资料。请稍后重新猜测。");
          return;
        }
        await executeGuess(message, game, player, selected);
      } else {
        await replyCard(message, "提示", `序号无效，请输入 1-${choices.length}。`);
      }
      return;
    }

    const resolution = await characterResolver.resolve(query, 5);
    const matches = resolution.candidates;

    if (matches.length === 0) {
      await replyCard(message, "未找到", `数据库中没有「${query}」相关角色\n支持中文名/日文名/别名/拼音/首字母`);
      return;
    }

    if (resolution.ambiguous) {
      const options = matches.slice(0, 4).map((r) => ({
        label: r.nameCn ?? r.name,
        sub: [
          r.character?.appearances[0]?.nameCn ?? r.character?.appearances[0]?.name ?? "选定后获取作品资料",
          `热度 ${r.popularity}`,
          r.matchedField,
        ].join(" · "),
      }));
      const selHtml = renderSelectMenu(query, options);
      await sendHtmlAsImage(message, selHtml);
      pendingChoices.set(choiceKey, matches.slice(0, 4));
      return;
    }

    pendingChoices.delete(choiceKey);

    const guessed = await characterResolver.materialize(matches[0]);
    if (!guessed) {
      await replyCard(message, "角色资料获取失败", "已经找到候选，但暂时无法获取其完整动画角色资料。请稍后重试。");
      return;
    }
    await executeGuess(message, game, player, guessed);
  }

  // ----- 执行猜测（公共逻辑） -----
  async function executeGuess(message: BotMessage, game: Game, player: PlayerState, guessed: AnimeCharacter): Promise<void> {
    if (!game.answer) return;

    // 检查重复
    if (player.guesses.some((g) => g.character.id === guessed.id)) {
      await replyCard(message, "提示", `你已经猜过「${guessed.nameCn ?? guessed.name}」了。`);
      return;
    }

    // 重置空闲计数
    const idleMap = idleTracker.get(game.groupId);
    if (idleMap) idleMap.set(player.userId, 0);

    const correct = isCorrectGuess(guessed, game.answer);
    const feedback = generateFeedback(guessed, game.answer);

    player.guesses.push({
      character: guessed,
      feedback,
      isCorrect: correct,
      timestamp: Date.now(),
    });

    if (correct) {
      player.finished = true;
      player.won = true;
    } else if (player.guesses.length >= player.maxAttempts) {
      player.finished = true;
      player.won = false;
    }

    // 渲染并发送（仅当前用户视角）
    const html = renderGameHtml(game, player.userId);
    await sendHtmlAsImage(message, html);

    if (correct) {
      checkGameEnd(game);
    } else if (player.finished) {
      checkGameEnd(game);
    }
  }

  // ----- 查看面板 -----
  async function handleBoard(message: BotMessage, groupId: string, userId: string): Promise<void> {
    const game = getGame(groupId);
    if (!game) {
      await replyCard(message, "提示", "没有进行中的游戏。");
      return;
    }

    if (game.state === "waiting") {
      const html = renderLobbyHtml(game);
      await sendHtmlAsImage(message, html);
      return;
    }

    const html = renderGameHtml(game, userId);
    await sendHtmlAsImage(message, html);
  }

  // ----- 结束 -----
  async function handleEnd(message: BotMessage, groupId: string, userId: string): Promise<void> {
    const game = getGame(groupId);
    if (!game) {
      await replyCard(message, "提示", "没有进行中的游戏。");
      return;
    }
    if (game.creatorId !== userId) {
      await replyCard(message, "提示", "只有房主可以结束游戏。");
      return;
    }

    game.state = "ended";
    game.endedAt = Date.now();
    recordAllStats(game);

    const html = renderGameHtml(game, userId);
    await sendHtmlAsImage(message, html);
  }

  // ----- 社区投稿 -----
  const contributionHelp = [
    "所有投稿都要经过管理员审核，审核前不会改动正式资料。",
    "",
    "最快方式（推荐）：",
    "$guessr contribute quick 作品名",
    "例如：$guessr contribute quick 葬送的芙莉莲",
    "机器人会自动从 Bangumi 获取作品及相关角色。",
    "",
    "新建角色：",
    "$guessr contribute character 中文名 | 原名 | 男/女/未知 | 别名1,别名2",
    "例如：$guessr contribute character 夜神月 | 夜神月 | 男 | Kira,Yagami Light",
    "",
    "修改角色：",
    "$guessr contribute edit 角色名 | 字段 | 新内容",
    "字段可用：中文名、原名、性别、别名、发色、瞳色、图片",
    "",
    "新建作品：",
    "$guessr contribute work 中文名 | 原名 | 年份",
    "",
    "把角色加入作品：",
    "$guessr contribute link 角色名 | 作品名 | 主角/配角/客串",
    "",
    "查看自己的投稿：$guessr contribute mine",
  ];
  const characterContributionUsage = "新建角色：\n$guessr contribute character 中文名 | 原名 | 男/女/未知 | 别名1,别名2\n例如：$guessr contribute character 夜神月 | 夜神月 | 男 | Kira,Yagami Light";
  const editContributionUsage = "修改角色：\n$guessr contribute edit 角色名 | 字段 | 新内容\n字段可用：中文名、原名、性别、别名、发色、瞳色、图片";
  const workContributionUsage = "新建作品：\n$guessr contribute work 中文名 | 原名 | 年份";
  const linkContributionUsage = "把角色加入作品：\n$guessr contribute link 角色名 | 作品名 | 主角/配角/客串";

  function splitFields(args: string[]): string[] {
    return args.join(" " ).split("|").map((item) => item.trim());
  }

  function normalizeGender(value: string): "male" | "female" | null | undefined {
    const normalized = value.trim().toLowerCase();
    if (["男", "male", "m"].includes(normalized)) return "male";
    if (["女", "female", "f"].includes(normalized)) return "female";
    if (["未知", "不明", "unknown", "null", ""].includes(normalized)) return null;
    return undefined;
  }

  function findCharacter(query: string): AnimeCharacter | undefined {
    const id = Number(query);
    if (Number.isInteger(id)) {
      const byId = database.find((item) => item.id === id);
      if (byId) return byId;
    }
    const match = searchIndex(query, 1)[0];
    return match?.score >= 60 ? match.char : undefined;
  }

  async function handleContribute(message: BotMessage, args: string[]): Promise<void> {
    if (!contributionStore) {
      try { initializeDatabase(); } catch (error) {
        await replyCard(message, "投稿暂不可用", `角色库加载失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    const sub = (args[0] ?? "help").toLowerCase();
    const userId = message.userId!;
    const userName = message.type === "group" ? await pluginCtx.getGroupNickname(userId, message.groupId!) : userId;
    if (["help", "h", "帮助"].includes(sub)) {
      await replyCard(message, "资料投稿帮助", contributionHelp.join("\n"));
      return;
    }
    if (["mine", "我的", "status"].includes(sub)) {
      const items = contributionStore.listByUser(userId);
      if (!items.length) { await replyCard(message, "我的投稿", "还没有投稿记录。发送 $guessr contribute help 查看简单示例。"); return; }
      const status = { pending: "待审核", approved: "已同意", rejected: "已拒绝" } as const;
      await replyCard(message, "我的投稿", items.map((item) => `#${item.id} [${status[item.status]}] ${item.summary}${item.reviewNote ? `（${item.reviewNote}）` : ""}`).join("\n"));
      return;
    }
    const fields = splitFields(args.slice(1));
    let item: Contribution | null = null;
    if (["quick", "快速", "一键", "auto"].includes(sub)) {
      const workQuery = args.slice(1).join(" " ).trim();
      if (!workQuery) {
        await replyCard(message, "请提供作品名", "用法：$guessr contribute quick 作品名\n例如：$guessr contribute quick 葬送的芙莉莲");
        return;
      }
      const taskKey = `${userId}:${workQuery.toLowerCase()}`;
      if (quickContributions.has(taskKey)) {
        await replyCard(message, "正在获取中", `「${workQuery}」的快速投稿已经在处理，请不要重复发送。`);
        return;
      }
      quickContributions.add(taskKey);
      await replyCard(message, "开始快速投稿", `正在从 Bangumi 查找「${workQuery}」并收集作品与角色资料。\n角色较多时可能需要几十秒，完成后我会再次通知你。`);
      try {
        const preview = await fetchWorkContribution(workQuery, cfg.backgroundCharactersPerWork || 30);
        if (!preview) {
          await replyCard(message, "快速投稿未完成", `Bangumi 中没有找到动画作品「${workQuery}」。\n请尝试更完整的中文名、日文原名，或使用普通投稿命令。`);
          return;
        }
        if (!preview.characters.length) {
          await replyCard(message, "快速投稿未完成", `找到了作品「${preview.work.nameCn}」，但没有获取到可用角色资料，因此没有创建投稿。`);
          return;
        }
        const duplicate = contributionStore.listPending(undefined, 1000).find((pending) =>
          pending.type === "import_work" && Number((pending.payload.work as { id?: unknown } | undefined)?.id) === preview.work.id
        );
        if (duplicate) {
          await replyCard(message, "已经有人投稿过", `作品「${preview.work.nameCn}」已有待审核的快速投稿 #${duplicate.id}，无需重复提交。`);
          return;
        }
        item = contributionStore.submit(userId, userName, "import_work", {
          query: workQuery, work: preview.work, characters: preview.characters, totalRelatedCharacters: preview.totalRelatedCharacters,
        }, `从 Bangumi 导入「${preview.work.nameCn}」及 ${preview.characters.length} 个角色`);
        await replyCard(message, "快速投稿完成", `已找到：${preview.work.nameCn}（Bangumi #${preview.work.id}）\n已收集：${preview.characters.length} 个角色${preview.totalRelatedCharacters > preview.characters.length ? `（该作品共有 ${preview.totalRelatedCharacters} 个角色，本次按上限收集）` : ""}\n投稿编号：#${item.id}\n当前状态：等待管理员审核`);
        return;
      } catch (error) {
        console.warn(`[AnimeGuessr] 快速投稿「${workQuery}」失败:`, error);
        await replyCard(message, "快速投稿失败", `获取「${workQuery}」时发生错误：${error instanceof Error ? error.message : String(error)}\n稍后可以直接重试同一命令。`);
        return;
      } finally {
        quickContributions.delete(taskKey);
      }
    } else if (["character", "char", "角色"].includes(sub)) {
      const [nameCn, name = nameCn, genderText = "未知", aliasesText = ""] = fields;
      const gender = normalizeGender(genderText);
      if (!nameCn || gender === undefined) { await replyCard(message, "格式不正确", characterContributionUsage); return; }
      item = contributionStore.submit(userId, userName, "create_character", { nameCn, name, gender, aliases: aliasesText.split(/[,，]/).map((v) => v.trim()).filter(Boolean) }, `新建角色「${nameCn}」`);
    } else if (["edit", "修改", "update"].includes(sub)) {
      const [characterQuery, field, value] = fields;
      const allowed: Record<string, string> = { 中文名: "nameCn", 原名: "name", 性别: "gender", 别名: "aliases", 发色: "hairColor", 瞳色: "eyeColor", 图片: "image" };
      if (!characterQuery || !allowed[field] || value === undefined || value === "") { await replyCard(message, "格式不正确", editContributionUsage); return; }
      const character = findCharacter(characterQuery);
      if (!character) { await replyCard(message, "找不到角色", `正式角色库中没有「${characterQuery}」。请先用新建角色投稿。`); return; }
      let parsed: unknown = value;
      if (allowed[field] === "gender") { parsed = normalizeGender(value); if (parsed === undefined) { await replyCard(message, "性别格式不正确", "请填写：男、女或未知。"); return; } }
      if (allowed[field] === "aliases") parsed = value.split(/[,，]/).map((v) => v.trim()).filter(Boolean);
      item = contributionStore.submit(userId, userName, "update_character", { characterId: character.id, field: allowed[field], value: parsed }, `修改「${character.nameCn ?? character.name}」的${field}`);
    } else if (["work", "作品"].includes(sub)) {
      const [nameCn, name = nameCn, yearText = ""] = fields;
      const year = yearText ? Number(yearText) : null;
      if (!nameCn || (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200))) { await replyCard(message, "格式不正确", workContributionUsage); return; }
      item = contributionStore.submit(userId, userName, "create_work", { nameCn, name, year }, `新建作品「${nameCn}」`);
    } else if (["link", "加入作品", "关联"].includes(sub)) {
      const [characterQuery, workQuery, staff = "配角"] = fields;
      if (!characterQuery || !workQuery || !["主角", "配角", "客串"].includes(staff)) { await replyCard(message, "格式不正确", linkContributionUsage); return; }
      const character = findCharacter(characterQuery);
      const work = contributionStore.findWork(workQuery);
      if (!character) { await replyCard(message, "找不到角色", `没有找到「${characterQuery}」，请先创建角色并等待审核。`); return; }
      if (!work) { await replyCard(message, "找不到作品", `没有找到「${workQuery}」，请先创建作品并等待审核。`); return; }
      item = contributionStore.submit(userId, userName, "link_character_work", { characterId: character.id, workId: work.id, staff }, `把「${character.nameCn ?? character.name}」加入「${work.nameCn}」`);
    } else {
      await replyCard(message, "不认识这个投稿操作", contributionHelp.join("\n"));
      return;
    }
    await replyCard(message, "投稿成功", `编号 #${item.id}：${item.summary}\n当前状态：等待管理员审核\n可用 $guessr contribute mine 查看进度。`);
  }

  function contributionTypeName(item: Contribution): string {
    return ({ create_character: "新角色", update_character: "改角色", create_work: "新作品", link_character_work: "加入作品", import_work: "快速导入" })[item.type];
  }

  function validateContribution(item: Contribution): string | null {
    if (item.type === "import_work") {
      const work = item.payload.work as Partial<AnimeWork> | undefined;
      const characters = item.payload.characters;
      if (!work || !Number.isInteger(work.id) || !work.name || !work.nameCn) return "快速导入的作品资料不完整";
      if (!Array.isArray(characters) || characters.length === 0) return "快速导入没有可用角色";
    }
    if (item.type === "update_character" || item.type === "link_character_work") {
      if (!database.some((character) => character.id === Number(item.payload.characterId))) return "目标角色已经不存在";
    }
    if (item.type === "link_character_work" && !contributionStore.findWork(String(item.payload.workId))) return "目标作品已经不存在";
    return null;
  }

  function validateContributionBatch(items: Contribution[]): string[] {
    const errors: string[] = [];
    const characterNames = new Set(database.flatMap((character) => [character.name, character.nameCn].filter(Boolean).map((name) => name!.trim().toLowerCase())));
    const workNames = new Set(contributionStore.getWorks().flatMap((work) => [work.name, work.nameCn].map((name) => name.trim().toLowerCase())));
    for (const item of items) {
      const baseError = validateContribution(item);
      if (baseError) { errors.push(`#${item.id}：${baseError}`); continue; }
      if (item.type === "create_character") {
        const names = [String(item.payload.name), String(item.payload.nameCn)].map((name) => name.trim().toLowerCase());
        if (names.some((name) => characterNames.has(name))) errors.push(`#${item.id}：同名角色已存在或也在本批次中`);
        else names.forEach((name) => characterNames.add(name));
      }
      if (item.type === "create_work") {
        const names = [String(item.payload.name), String(item.payload.nameCn)].map((name) => name.trim().toLowerCase());
        if (names.some((name) => workNames.has(name))) errors.push(`#${item.id}：同名作品已存在或也在本批次中`);
        else names.forEach((name) => workNames.add(name));
      }
    }
    return errors;
  }

  function applyContribution(item: Contribution): void {
    if (item.type === "create_character") {
      const name = String(item.payload.name);
      const nameCn = String(item.payload.nameCn);
      if (database.some((character) => character.name === name || character.nameCn === nameCn)) throw new Error("同名角色已存在");
      database.push({ id: -item.id, name, nameCn, aliases: item.payload.aliases as string[], gender: item.payload.gender as "male" | "female" | null, hairColor: null, eyeColor: null, popularity: 0, worksCount: 0, highestRating: null, latestYear: null, earliestYear: null, voiceActors: [], appearances: [], tags: [], image: "", tier: "community" });
    } else if (item.type === "update_character") {
      const character = database.find((entry) => entry.id === Number(item.payload.characterId))!;
      const field = String(item.payload.field) as keyof AnimeCharacter;
      (character as unknown as Record<string, unknown>)[field] = item.payload.value;
    } else if (item.type === "create_work") {
      const name = String(item.payload.name);
      const nameCn = String(item.payload.nameCn);
      if (contributionStore.findWork(name) || contributionStore.findWork(nameCn)) throw new Error("同名作品已存在");
      contributionStore.upsertWork({ id: -item.id, name, nameCn, year: item.payload.year as number | null, rating: 0, studio: null, source: "community" });
    } else if (item.type === "link_character_work") {
      const character = database.find((entry) => entry.id === Number(item.payload.characterId))!;
      const work = contributionStore.findWork(String(item.payload.workId))!;
      if (!character.appearances.some((appearance) => appearance.id === work.id)) {
        const appearance: AnimeAppearance = { id: work.id, name: work.name, nameCn: work.nameCn, year: work.year, rating: work.rating, studio: work.studio, staff: String(item.payload.staff) };
        character.appearances.push(appearance);
        character.worksCount = character.appearances.length;
        const years = character.appearances.map((entry) => entry.year).filter((year): year is number => year !== null);
        character.earliestYear = years.length ? Math.min(...years) : null;
        character.latestYear = years.length ? Math.max(...years) : null;
      }
    } else {
      const work = item.payload.work as AnimeWork;
      const characters = item.payload.characters as AnimeCharacter[];
      contributionStore.upsertWork({ ...work, source: "bangumi" });
      for (const incoming of characters) {
        const existing = database.find((character) => character.id === incoming.id);
        if (!existing) {
          database.push(incoming);
          continue;
        }
        existing.name = incoming.name || existing.name;
        existing.nameCn = incoming.nameCn || existing.nameCn;
        existing.aliases = [...new Set([...(existing.aliases ?? []), ...(incoming.aliases ?? [])])];
        existing.gender = incoming.gender ?? existing.gender;
        existing.hairColor = incoming.hairColor ?? existing.hairColor;
        existing.eyeColor = incoming.eyeColor ?? existing.eyeColor;
        existing.popularity = incoming.popularity || existing.popularity;
        existing.voiceActors = [...new Set([...(existing.voiceActors ?? []), ...(incoming.voiceActors ?? [])])];
        existing.tags = [...new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])])];
        existing.image = incoming.image || existing.image;
        const appearances = new Map(existing.appearances.map((appearance) => [appearance.id, appearance]));
        for (const appearance of incoming.appearances ?? []) appearances.set(appearance.id, { ...appearances.get(appearance.id), ...appearance });
        existing.appearances = [...appearances.values()];
        existing.worksCount = Math.max(incoming.worksCount, existing.appearances.length);
        const years = existing.appearances.map((appearance) => appearance.year).filter((year): year is number => year !== null);
        const ratings = existing.appearances.map((appearance) => appearance.rating).filter((rating) => rating > 0);
        existing.earliestYear = years.length ? Math.min(...years) : null;
        existing.latestYear = years.length ? Math.max(...years) : null;
        existing.highestRating = ratings.length ? Math.max(...ratings) : null;
      }
    }
  }

  async function handleReview(message: BotMessage, args: string[]): Promise<void> {
    if (!cfg.adminUserIds.includes(message.userId!)) { await replyCard(message, "无权操作", "审核命令仅管理员可用。普通用户可以使用 $guessr contribute 投稿。"); return; }
    if (!contributionStore) initializeDatabase();
    const action = (args[0] ?? "list").toLowerCase();
    const filterType = (args[1] ?? "").toLowerCase();
    const filterValue = args[2];
    const getSelected = (): Contribution[] => {
      if (filterType === "user" || filterType === "用户") return contributionStore.listPending({ userId: filterValue }, 1000);
      if (filterType === "before" || filterType === "时间") {
        const before = new Date(`${filterValue}T23:59:59+08:00`).getTime();
        return Number.isFinite(before) ? contributionStore.listPending({ before }, 1000) : [];
      }
      const ids = args.slice(1).map(Number).filter(Number.isInteger);
      return contributionStore.listPending(undefined, 1000).filter((item) => ids.includes(item.id));
    };
    if (["list", "列表", "pending"].includes(action)) {
      let items = contributionStore.listPending(undefined, 30);
      if (filterType === "user" || filterType === "用户") items = contributionStore.listPending({ userId: filterValue }, 30);
      if (filterType === "before" || filterType === "时间") { const before = new Date(`${filterValue}T23:59:59+08:00`).getTime(); items = Number.isFinite(before) ? contributionStore.listPending({ before }, 30) : []; }
      if (!items.length) { await replyCard(message, "待审核投稿", "当前筛选条件下没有待审核投稿。"); return; }
      const lines = items.map((item) => `#${item.id} [${contributionTypeName(item)}] ${item.summary}\n投稿人：${item.userName} (${item.userId}) · ${new Date(item.createdAt).toLocaleString("zh-CN")}`);
      lines.push("", "同意编号：$guessr review approve 1 2", "按用户同意：$guessr review approve user QQ号", "按日期拒绝：$guessr review reject before 2026-07-28");
      await replyCard(message, "待审核投稿", lines.join("\n"));
      return;
    }
    const approved = ["approve", "同意", "通过"].includes(action);
    const rejected = ["reject", "拒绝"].includes(action);
    if (!approved && !rejected) { await replyCard(message, "审核帮助", "查看：$guessr review list\n按编号同意：$guessr review approve 1 2\n按用户批量同意：$guessr review approve user QQ号\n按日期批量拒绝：$guessr review reject before 2026-07-28"); return; }
    const selected = getSelected();
    if (!selected.length) { await replyCard(message, "没有可审核的投稿", "请检查编号、QQ 号或日期。可先发送 $guessr review list 查看。"); return; }
    if (approved) {
      const invalid = validateContributionBatch(selected);
      if (invalid.length) { await replyCard(message, "无法批量同意", invalid.join("\n")); return; }
      try {
        for (const item of selected) applyContribution(item);
        rebuildAndPersistDatabase();
      } catch (error) { await replyCard(message, "应用投稿失败", error instanceof Error ? error.message : String(error)); return; }
    }
    contributionStore.review(selected.map((item) => item.id), approved ? "approved" : "rejected", message.userId!, null);
    await replyCard(message, approved ? "审核完成：已同意" : "审核完成：已拒绝", `共处理 ${selected.length} 条投稿：${selected.map((item) => `#${item.id}`).join("、")}`);
  }

  // ----- 帮助 -----
  async function handleHelp(message: BotMessage): Promise<void> {
    const html = renderHelpCard(cfg.maxAttempts);
    await sendHtmlAsImage(message, html);
  }

  // ----- 搜索 -----
  async function handleSearch(message: BotMessage, query: string): Promise<void> {
    if (!query.trim()) {
      await replyCard(message, "提示", "用法: $guessr search <角色名/作品名/拼音>\n例如: $guessr search 夜神\n$guessr search yeshenyue\n$guessr search 死亡笔记");
      return;
    }

    // 先尝试搜索作品名
    const works = searchWorks(query, 5);
    if (works.length > 0 && works[0].score >= 80) {
      // 作品名精确/前缀匹配，显示该作品的角色列表
      const work = works[0];
      const html = renderWorkCharacters(work.nameCn || work.name, work.characters);
      await sendHtmlAsImage(message, html);
      return;
    }

    const resolution = await characterResolver.resolve(query, 15);
    const results = resolution.candidates;

    if (results.length === 0) {
      await replyCard(message, "未找到", `没有与「${query}」匹配的角色或作品`);
      return;
    }

    const html = renderSearchResults(
      query,
      results.map((r) => ({ name: r.name, nameCn: r.nameCn, matchedField: r.matchedField, popularity: r.popularity })),
      results.length,
    );
    await sendHtmlAsImage(message, html);
  }

  // ----- 排行榜 -----
  async function handleRank(message: BotMessage, groupId: string, scope?: string): Promise<void> {
    if (scope === "group" || scope === "g") {
      const entries = getGroupRanking(groupId, 15);
      if (entries.length === 0) {
        await replyCard(message, "提示", "本群还没有人玩过猜动漫人物。");
        return;
      }
      const html = renderLeaderboard(entries, "群内排行");
      await sendHtmlAsImage(message, html);
    } else {
      const entries = getGlobalRanking(15);
      if (entries.length === 0) {
        await replyCard(message, "提示", "还没有人玩过猜动漫人物。");
        return;
      }
      const html = renderLeaderboard(entries, "全服排行");
      await sendHtmlAsImage(message, html);
    }
  }

  // ----- 个人数据 -----
  async function handleMe(message: BotMessage, groupId: string, userId: string): Promise<void> {
    const stats = getPlayerStats(userId);
    if (stats.gamesPlayed === 0) {
      await replyCard(message, "提示", "你还没有游玩记录。发送 $guessr 开始第一局！");
      return;
    }
    const radar = computeRadar(userId);
    const rank = getPlayerRank(userId, groupId);
    const html = renderPlayerCard(stats, radar, rank, "群内");
    await sendHtmlAsImage(message, html);
  }

  // ----- 检查游戏是否自然结束 + 记录统计 -----
  function checkGameEnd(game: Game): void {
    const allFinished = [...game.players.values()].every((p) => p.finished);
    if (allFinished && game.players.size > 0) {
      game.state = "ended";
      game.endedAt = Date.now();
      recordAllStats(game);
    }
  }

  /** 记录所有玩家的统计数据 */
  function recordAllStats(game: Game): void {
    if (!game.answer) return;
    for (const player of game.players.values()) {
      const timeMs = player.won && player.guesses.length > 0
        ? player.guesses[player.guesses.length - 1].timestamp - game.startedAt
        : null;
      recordGameResult(
        player.userId,
        player.name,
        game.groupId,
        player.won,
        player.guesses.length,
        timeMs,
      );
    }
  }

  // ===== Plugin 对象 =====

  return {
    name: "anime-guessr",
    description: "猜动漫人物游戏：群聊多人异步猜测，图形化反馈面板",

    onLoad(ctx: PluginContext) {
      pluginCtx = ctx;

      // 初始化统计存储
      initStats("data/guessr-stats.json");

      // 预加载数据库
      try {
        initializeDatabase();
        console.log(`[AnimeGuessr] 数据库加载成功: ${database.length} 个角色，搜索索引已构建`);
      } catch (e) {
        console.warn(`[AnimeGuessr] 数据库加载失败（游戏开始时重试）: ${e}`);
      }

      menuPlugin.registerCommand(
        "guessr",
        "猜动漫人物：$guessr 创建/加入 | guess <名字> 猜测 | search 搜索 | contribute 投稿资料 | review 管理员审核",
        async (message, args) => {
          await handleGuessr(message, args);
        },
      );
    },
  };
}
