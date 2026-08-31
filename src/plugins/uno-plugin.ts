import fs from "node:fs";
import path from "node:path";
import type { BotMessage, MenuPlugin, Plugin, PluginContext } from "../types.js";
import type { OneBotClient } from "../onebot.js";
import { MessageStore } from "../message-store.js";
import { screenshotHtml } from "./mmorpg/screenshot.js";

// ==================== Types ====================

type UnoColor = "red" | "yellow" | "green" | "blue";
type UnoCardType = "number" | "skip" | "reverse" | "draw2" | "wild" | "wild_draw4";
type UnoCard = {
  id: number;
  color: UnoColor | "wild";
  type: UnoCardType;
  value: number | null;
};

type UnoPlayer = {
  userId: string;
  name: string;
  hand: UnoCard[];
  saidUno: boolean;
};

type UnoGame = {
  groupId: string;
  state: "waiting" | "playing" | "ended";
  players: UnoPlayer[];
  creatorId: string;
  currentPlayerIndex: number;
  direction: 1 | -1;
  deck: UnoCard[];
  discardPile: UnoCard[];
  currentColor: UnoColor;
  drawStack: number;
  drawStackType: "draw2" | "draw4" | null;
  lastActionAt: number;
  winner: string | null;
  drewThisTurn: boolean;
  unoPendingIndex: number | null;
  nextCardId: number;
};

// ==================== Constants ====================

const COLORS: UnoColor[] = ["red", "yellow", "green", "blue"];
const COLOR_NAMES: Record<UnoColor, string> = { red: "红", yellow: "黄", green: "绿", blue: "蓝" };
const COLOR_EMOJI: Record<UnoColor, string> = { red: "🔴", yellow: "🟡", green: "🟢", blue: "🔵" };
const TURN_TIMEOUT_MS = 60_000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;
const INITIAL_HAND_SIZE = 7;
const STORE_PREFIX = "uno:";

// ==================== Card Utilities ====================

function createDeck(nextId: () => number): UnoCard[] {
  const deck: UnoCard[] = [];
  for (const color of COLORS) {
    deck.push({ id: nextId(), color, type: "number", value: 0 });
    for (let v = 1; v <= 9; v++) {
      deck.push({ id: nextId(), color, type: "number", value: v });
      deck.push({ id: nextId(), color, type: "number", value: v });
    }
    for (const type of ["skip", "reverse", "draw2"] as UnoCardType[]) {
      deck.push({ id: nextId(), color, type, value: null });
      deck.push({ id: nextId(), color, type, value: null });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: nextId(), color: "wild", type: "wild", value: null });
    deck.push({ id: nextId(), color: "wild", type: "wild_draw4", value: null });
  }
  return deck;
}

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function cardText(card: UnoCard): string {
  if (card.color === "wild") return card.type === "wild_draw4" ? "+4" : "★";
  if (card.type === "number") return String(card.value);
  if (card.type === "skip") return "禁";
  if (card.type === "reverse") return "反";
  if (card.type === "draw2") return "+2";
  return "?";
}

function cardLabel(card: UnoCard): string {
  if (card.color === "wild") return card.type === "wild_draw4" ? "🌈+4" : "🌈万能";
  const e = COLOR_EMOJI[card.color];
  if (card.type === "number") return `${e}${card.value}`;
  if (card.type === "skip") return `${e}禁`;
  if (card.type === "reverse") return `${e}反`;
  if (card.type === "draw2") return `${e}+2`;
  return "?";
}

function cardColorClass(card: UnoCard): string {
  if (card.color === "wild") return "uno-card-wild";
  return `uno-card-${card.color}`;
}

function canPlay(card: UnoCard, topCard: UnoCard, currentColor: UnoColor, drawStackType: "draw2" | "draw4" | null): boolean {
  if (drawStackType) {
    if (drawStackType === "draw2" && card.type === "draw2") return true;
    if (drawStackType === "draw4" && card.type === "wild_draw4") return true;
    return false;
  }
  if (card.color === "wild") return true;
  if (card.color === currentColor) return true;
  if (topCard.color !== "wild") {
    if (card.type === "number" && topCard.type === "number") return card.value === topCard.value;
    if (card.type === topCard.type && card.type !== "number") return true;
  }
  return false;
}

function hasPlayableCard(player: UnoPlayer, game: UnoGame): boolean {
  const top = game.discardPile[game.discardPile.length - 1];
  return player.hand.some((c) => canPlay(c, top, game.currentColor, game.drawStackType));
}

function drawFromDeck(game: UnoGame, count: number): UnoCard[] {
  const drawn: UnoCard[] = [];
  for (let i = 0; i < count; i++) {
    if (game.deck.length === 0) {
      if (game.discardPile.length <= 1) break;
      const top = game.discardPile.pop()!;
      game.deck = shuffle(game.discardPile);
      game.discardPile = [top];
    }
    if (game.deck.length === 0) break;
    drawn.push(game.deck.pop()!);
  }
  return drawn;
}

function parseColor(input: string): UnoColor | null {
  const s = input.toLowerCase();
  if (s === "red" || s === "r" || input === "红") return "red";
  if (s === "yellow" || s === "y" || input === "黄") return "yellow";
  if (s === "green" || s === "g" || input === "绿") return "green";
  if (s === "blue" || s === "b" || input === "蓝") return "blue";
  return null;
}

// ==================== Game State Persistence ====================

function loadGame(ms: MessageStore, groupId: string): UnoGame | null {
  const data = ms.getContextState(STORE_PREFIX + groupId) as UnoGame | null;
  if (!data) return null;
  data.drewThisTurn ??= false;
  data.unoPendingIndex ??= null;
  data.drawStackType ??= null;
  data.drawStack ??= 0;
  return data;
}

function saveGame(ms: MessageStore, game: UnoGame): void {
  game.lastActionAt = Date.now();
  ms.saveContextState(STORE_PREFIX + game.groupId, game);
}

function loadRegistry(ms: MessageStore): string[] {
  const data = ms.getContextState("uno:active-groups");
  return Array.isArray(data) ? data : [];
}

function saveRegistry(ms: MessageStore, groups: string[]): void {
  ms.saveContextState("uno:active-groups", groups);
}

function addToRegistry(ms: MessageStore, groupId: string): void {
  const groups = loadRegistry(ms);
  if (!groups.includes(groupId)) {
    groups.push(groupId);
    saveRegistry(ms, groups);
  }
}

function removeFromRegistry(ms: MessageStore, groupId: string): void {
  saveRegistry(ms, loadRegistry(ms).filter((g) => g !== groupId));
}

// ==================== Turn Helpers ====================

function advanceTurn(game: UnoGame, skip = false): void {
  const steps = skip ? 2 : 1;
  const n = game.players.length;
  game.currentPlayerIndex = ((game.currentPlayerIndex + game.direction * steps) % n + n) % n;
  game.drewThisTurn = false;
}

function closeUnoWindow(game: UnoGame): void {
  game.unoPendingIndex = null;
}

// ==================== Image Rendering ====================

const UNO_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0f1117; font-family: "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif; }
.gc { background: #0f1117; color: #e6edf3; padding: 14px 16px; border-radius: 12px; width: fit-content; }
.gc-hd { font-size: 14px; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
.gc-sub { font-size: 11px; color: #8b949e; margin-left: auto; font-weight: 400; }
.gc-cards { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.gc-card-w { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.uno-card { width: 58px; height: 88px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 22px; box-shadow: 0 2px 6px rgba(0,0,0,0.4); position: relative; overflow: hidden; }
.uno-card::before { content: ""; position: absolute; width: 42px; height: 64px; border-radius: 50%; background: rgba(255,255,255,0.13); }
.uno-card span { position: relative; z-index: 1; text-shadow: 0 1px 2px rgba(0,0,0,0.3); }
.uno-card-red { background: #e74c3c; color: #fff; }
.uno-card-yellow { background: #f1c40f; color: #2c3e50; }
.uno-card-green { background: #27ae60; color: #fff; }
.uno-card-blue { background: #2980b9; color: #fff; }
.uno-card-wild { background: conic-gradient(from 45deg, #e74c3c, #f1c40f, #27ae60, #2980b9, #e74c3c); color: #fff; }
.gc-idx { font-size: 10px; color: #8b949e; font-family: monospace; }
.gc-ft { font-size: 10px; color: #6e7681; margin-top: 8px; padding-top: 6px; border-top: 1px solid #21262d; line-height: 1.5; }
.gc-table { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
.gc-info { font-size: 12px; color: #8b949e; line-height: 1.7; }
.gc-players { font-size: 12px; line-height: 1.9; }
.gc-pl { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
.gc-pl-cur { color: #58a6ff; font-weight: 600; }
.gc-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; margin-left: 4px; }
.gc-badge-cur { background: rgba(31,111,235,0.2); color: #58a6ff; }
.gc-badge-uno { background: rgba(240,136,62,0.2); color: #f0883e; }
.gc-badge-warn { background: rgba(248,81,73,0.2); color: #f85149; }
.gc-stack { color: #f85149; font-weight: 600; }
`;

function renderCardHtml(card: UnoCard): string {
  return `<div class="uno-card ${cardColorClass(card)}"><span>${cardText(card)}</span></div>`;
}

function renderHandCards(game: UnoGame, player: UnoPlayer): string {
  const top = game.discardPile[game.discardPile.length - 1];
  return player.hand
    .map((card, i) => {
      const playable = canPlay(card, top, game.currentColor, game.drawStackType);
      const op = playable ? "" : ' style="opacity:0.35"';
      return `<div class="gc-card-w"${op}>${renderCardHtml(card)}<div class="gc-idx">[${i}]</div></div>`;
    })
    .join("");
}

function renderPlayersList(game: UnoGame): string {
  return game.players
    .map((p, i) => {
      const isCur = i === game.currentPlayerIndex;
      const isUno = p.hand.length === 1 && p.saidUno;
      const isPending = i === game.unoPendingIndex;
      const badges: string[] = [];
      if (isCur) badges.push('<span class="gc-badge gc-badge-cur">出牌中</span>');
      if (isUno) badges.push('<span class="gc-badge gc-badge-uno">UNO!</span>');
      if (isPending) badges.push('<span class="gc-badge gc-badge-warn">未喊UNO</span>');
      return `<div class="gc-pl${isCur ? " gc-pl-cur" : ""}">${isCur ? "▶ " : ""}${p.name}: ${p.hand.length}张${badges.join("")}</div>`;
    })
    .join("");
}

/** Combined image: table state + player's hand in one view (for current player). */
function renderCombinedImage(game: UnoGame, player: UnoPlayer): string {
  const top = game.discardPile[game.discardPile.length - 1];
  const dirText = game.direction === 1 ? "↻" : "↺";
  const stackText = game.drawStack > 0 ? ` | <span class="gc-stack">累积罚牌:${game.drawStack}</span>` : "";
  const cardsHtml = renderHandCards(game, player);
  const playersHtml = renderPlayersList(game);

  return `<!DOCTYPE html><html><head><style>${UNO_CSS}</style></head><body>
<div class="gc">
<div class="gc-hd">🎮 UNO <span class="gc-sub">桌面:${cardLabel(top)} | ${COLOR_EMOJI[game.currentColor]}${dirText}${stackText}</span></div>
<div class="gc-table">
${renderCardHtml(top)}
<div class="gc-info">颜色: ${COLOR_NAMES[game.currentColor]}${COLOR_EMOJI[game.currentColor]} | ${dirText}${stackText ? `<br>${stackText}` : ""}</div>
</div>
<div class="gc-players">${playersHtml}</div>
<div class="gc-hd" style="margin-top:10px;border-top:1px solid #21262d;padding-top:8px">🃏 你的手牌 <span class="gc-sub">${player.hand.length}张</span></div>
<div class="gc-cards">${cardsHtml}</div>
<div class="gc-ft">$uno play &lt;序号&gt; [颜色] | $uno draw 摸牌 | $uno pass 跳过 | $uno uno 喊UNO</div>
</div></body></html>`;
}

/** Table-only image (for status / non-current players). */
function renderTableImage(game: UnoGame): string {
  const top = game.discardPile[game.discardPile.length - 1];
  const dirText = game.direction === 1 ? "↻ 顺时针" : "↺ 逆时针";
  const stackHtml = game.drawStack > 0 ? `<div class="gc-stack">累积罚牌: ${game.drawStack}张</div>` : "";
  const playersHtml = renderPlayersList(game);

  return `<!DOCTYPE html><html><head><style>${UNO_CSS}</style></head><body>
<div class="gc">
<div class="gc-hd">🎮 UNO 游戏进行中 <span class="gc-sub">${game.players.length}人</span></div>
<div class="gc-table">
${renderCardHtml(top)}
<div class="gc-info">当前颜色: ${COLOR_NAMES[game.currentColor]}${COLOR_EMOJI[game.currentColor]}<br>${dirText}${stackHtml}</div>
</div>
<div class="gc-players">${playersHtml}</div>
</div></body></html>`;
}

/** Hand-only image (for $uno hand command). */
function renderHandImage(game: UnoGame, player: UnoPlayer): string {
  const top = game.discardPile[game.discardPile.length - 1];
  const dirText = game.direction === 1 ? "↻" : "↺";
  const stackText = game.drawStack > 0 ? ` | <span class="gc-stack">累积罚牌:${game.drawStack}</span>` : "";
  const cardsHtml = renderHandCards(game, player);

  return `<!DOCTYPE html><html><head><style>${UNO_CSS}</style></head><body>
<div class="gc">
<div class="gc-hd">🃏 你的手牌 <span class="gc-sub">${player.hand.length}张 | 桌面:${cardLabel(top)} | ${dirText}${stackText}</span></div>
<div class="gc-cards">${cardsHtml}</div>
<div class="gc-ft">$uno play &lt;序号&gt; [颜色] 出牌 | $uno draw 摸牌 | $uno pass 跳过 | $uno uno 喊UNO</div>
</div></body></html>`;
}

async function renderToImage(html: string): Promise<string> {
  const dir = path.resolve("data/uno-images");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `uno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`);
  await screenshotHtml(html, fp, { format: "webp", quality: 85 });
  return fp;
}

// ==================== Plugin ====================

export function createUnoPlugin(
  menuPlugin: MenuPlugin,
  messageStore: MessageStore,
  onebot: OneBotClient,
): Plugin {
  const playerGameMap = new Map<string, string>();
  const turnTimers = new Map<string, NodeJS.Timeout>();
  let pluginCtx: PluginContext | null = null;

  // ── Player map management ──

  function rebuildPlayerMap(): void {
    playerGameMap.clear();
    for (const groupId of loadRegistry(messageStore)) {
      const game = loadGame(messageStore, groupId);
      if (game && game.state !== "ended") {
        for (const p of game.players) playerGameMap.set(p.userId, groupId);
      }
    }
  }

  function findPlayerGame(userId: string): UnoGame | null {
    const gid = playerGameMap.get(userId);
    if (!gid) return null;
    return loadGame(messageStore, gid);
  }

  // ── Private message helpers ──

  /** Send a text message to a single user via private chat. */
  async function pm(userId: string, text: string): Promise<void> {
    if (!pluginCtx) return;
    try {
      await pluginCtx.sendMessage({ type: "private", id: userId }, text);
    } catch { /* ignore */ }
  }

  /** Broadcast a text message to all players in the game via private chat. */
  async function broadcastText(game: UnoGame, text: string): Promise<void> {
    for (const p of game.players) {
      await pm(p.userId, text);
    }
  }

  /** Send an image to a single user via private chat. */
  async function pmImage(userId: string, html: string, caption?: string): Promise<void> {
    if (!pluginCtx) return;
    const fp = await renderToImage(html);
    try {
      await pluginCtx.sendImage({ type: "private", id: userId }, fp, caption);
    } catch { /* ignore */ }
    fs.unlink(fp, () => {});
  }

  // ── Turn timer ──

  function clearTurnTimer(groupId: string): void {
    const t = turnTimers.get(groupId);
    if (t) {
      clearTimeout(t);
      turnTimers.delete(groupId);
    }
  }

  function startTurnTimer(groupId: string): void {
    clearTurnTimer(groupId);
    const timer = setTimeout(() => handleTimeout(groupId), TURN_TIMEOUT_MS);
    turnTimers.set(groupId, timer);
  }

  async function handleTimeout(groupId: string): Promise<void> {
    if (!pluginCtx) return;
    const game = loadGame(messageStore, groupId);
    if (!game || game.state !== "playing") return;

    closeUnoWindow(game);

    const player = game.players[game.currentPlayerIndex];
    if (!player) return;

    // Auto-draw
    if (game.drawStack > 0) {
      const drawn = drawFromDeck(game, game.drawStack);
      player.hand.push(...drawn);
      game.drawStack = 0;
      game.drawStackType = null;
    } else {
      const drawn = drawFromDeck(game, 1);
      player.hand.push(...drawn);
    }
    game.drewThisTurn = false;

    advanceTurn(game);
    saveGame(messageStore, game);

    const nextPlayer = game.players[game.currentPlayerIndex];
    await broadcastText(game, `⏰ ${player.name} 超时未操作，自动摸牌跳过 → 轮到 ${nextPlayer.name}`);
    await announceTurn(game);
  }

  // ── Notification helpers ──

  async function sendPlayerHand(game: UnoGame, player: UnoPlayer, extra?: string): Promise<void> {
    const html = renderHandImage(game, player);
    await pmImage(player.userId, html, extra);
  }

  /**
   * Announce a new turn efficiently:
   * - Current player: ONE combined image (table + hand)
   * - Other players: no extra message (action text already sent by caller)
   */
  async function announceTurn(game: UnoGame): Promise<void> {
    if (!pluginCtx) return;
    const player = game.players[game.currentPlayerIndex];
    if (!player) return;

    // Combined image to current player only
    const html = renderCombinedImage(game, player);
    const hasPlayable = hasPlayableCard(player, game);
    const hint = hasPlayable ? "轮到你了！" : "轮到你了！⚠️ 没有可出的牌，请 $uno draw 摸牌";
    await pmImage(player.userId, html, hint);

    startTurnTimer(game.groupId);
  }

  // ── Resolve player name ──

  async function resolveName(groupId: string, userId: string): Promise<string> {
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      return info.card || info.nickname || userId;
    } catch {
      return userId;
    }
  }

  // ── End game cleanup ──

  function endGameCleanup(game: UnoGame): void {
    game.state = "ended";
    clearTurnTimer(game.groupId);
    removeFromRegistry(messageStore, game.groupId);
    for (const p of game.players) playerGameMap.delete(p.userId);
  }

  // ── Command handler ──

  async function handleUno(message: BotMessage, args: string[], ctx: PluginContext): Promise<void> {
    const sub = (args[0] ?? "").toLowerCase();
    const prefix = menuPlugin.getPrefix();
    const uid = message.userId!;

    switch (sub) {
      // ── Create / view game ──
      case "":
      case "create": {
        if (message.type !== "group") {
          await showHelp(message, ctx);
          return;
        }
        const existing = loadGame(messageStore, message.groupId!);
        if (existing && existing.state !== "ended") {
          await showGameStatus(existing, uid);
          return;
        }
        const name = await resolveName(message.groupId!, uid);
        const game: UnoGame = {
          groupId: message.groupId!,
          state: "waiting",
          players: [{ userId: uid, name, hand: [], saidUno: false }],
          creatorId: uid,
          currentPlayerIndex: 0,
          direction: 1,
          deck: [],
          discardPile: [],
          currentColor: "red",
          drawStack: 0,
          drawStackType: null,
          lastActionAt: Date.now(),
          winner: null,
          drewThisTurn: false,
          unoPendingIndex: null,
          nextCardId: 0,
        };
        playerGameMap.set(uid, game.groupId);
        saveGame(messageStore, game);
        addToRegistry(messageStore, game.groupId);
        await pm(uid, `🎮 UNO游戏已创建！房主: ${name}\n其他玩家在群里发送 ${prefix}uno join 加入。\n房主发送 ${prefix}uno start 开始。（${MIN_PLAYERS}-${MAX_PLAYERS}人）`);
        return;
      }

      // ── Join ──
      case "join": {
        if (message.type !== "group") {
          await pm(uid, "请在群聊中使用: $uno join");
          return;
        }
        const game = loadGame(messageStore, message.groupId!);
        if (!game) {
          await pm(uid, `当前没有UNO游戏，发送 ${prefix}uno 创建。`);
          return;
        }
        if (game.state !== "waiting") {
          await pm(uid, "游戏已经开始，无法加入。");
          return;
        }
        if (game.players.length >= MAX_PLAYERS) {
          await pm(uid, `游戏已满（最多${MAX_PLAYERS}人）。`);
          return;
        }
        if (game.players.some((p) => p.userId === uid)) {
          await pm(uid, "你已经加入游戏了。");
          return;
        }
        if (playerGameMap.has(uid)) {
          await pm(uid, "你已在其他UNO游戏中，请先 $uno leave");
          return;
        }
        const name = await resolveName(message.groupId!, uid);
        game.players.push({ userId: uid, name, hand: [], saidUno: false });
        playerGameMap.set(uid, game.groupId);
        saveGame(messageStore, game);
        await broadcastText(game, `${name} 加入了游戏！当前(${game.players.length}人): ${game.players.map((p) => p.name).join("、")}`);
        return;
      }

      // ── Start ──
      case "start": {
        if (message.type !== "group") {
          await pm(uid, "请在群聊中使用: $uno start");
          return;
        }
        const game = loadGame(messageStore, message.groupId!);
        if (!game) {
          await pm(uid, `当前没有UNO游戏，发送 ${prefix}uno 创建。`);
          return;
        }
        if (game.state !== "waiting") {
          await pm(uid, "游戏已经开始。");
          return;
        }
        if (game.creatorId !== uid) {
          await pm(uid, "只有房主可以开始游戏。");
          return;
        }
        if (game.players.length < MIN_PLAYERS) {
          await pm(uid, `至少需要${MIN_PLAYERS}人。`);
          return;
        }

        // Init deck & deal
        game.deck = shuffle(createDeck(() => game.nextCardId++));
        game.discardPile = [];
        for (const p of game.players) {
          p.hand = drawFromDeck(game, INITIAL_HAND_SIZE);
        }

        // First card: keep drawing until number card
        let firstCard: UnoCard | undefined;
        for (let attempt = 0; attempt < 60; attempt++) {
          firstCard = drawFromDeck(game, 1)[0];
          if (firstCard && firstCard.type === "number") break;
          if (firstCard) {
            game.deck.push(firstCard);
            game.deck = shuffle(game.deck);
          }
        }
        if (!firstCard) firstCard = drawFromDeck(game, 1)[0];
        if (!firstCard) {
          await pm(uid, "牌堆初始化失败，请重试。");
          return;
        }
        game.discardPile.push(firstCard);
        game.currentColor = firstCard.color as UnoColor;
        game.state = "playing";
        game.currentPlayerIndex = 0;
        game.direction = 1;
        saveGame(messageStore, game);

        await broadcastText(game, `🎮 UNO开始！${game.players.length}人，每人${INITIAL_HAND_SIZE}张。首张: ${cardLabel(firstCard)}`);
        await announceTurn(game);
        return;
      }

      // ── Status ──
      case "status": {
        if (message.type !== "group") {
          await pm(uid, "请在群聊中使用: $uno status");
          return;
        }
        const game = loadGame(messageStore, message.groupId!);
        if (!game) {
          await pm(uid, "当前没有UNO游戏。");
          return;
        }
        await showGameStatus(game, uid);
        return;
      }

      // ── End ──
      case "end": {
        if (message.type !== "group") {
          await pm(uid, "请在群聊中使用: $uno end");
          return;
        }
        const game = loadGame(messageStore, message.groupId!);
        if (!game) {
          await pm(uid, "当前没有UNO游戏。");
          return;
        }
        const isAdmin = ctx.config.auth.adminUserIds.includes(uid);
        if (game.creatorId !== uid && !isAdmin) {
          await pm(uid, "只有房主或管理员可以结束游戏。");
          return;
        }
        await broadcastText(game, "UNO游戏已结束。");
        endGameCleanup(game);
        saveGame(messageStore, game);
        return;
      }

      // ── Leave ──
      case "leave": {
        const game = findPlayerGame(uid);
        if (!game) {
          await pm(uid, "你不在任何UNO游戏中。");
          return;
        }
        const idx = game.players.findIndex((p) => p.userId === uid);
        if (idx === -1) return;
        const player = game.players[idx];

        // If it's this player's turn, advance first
        if (game.state === "playing" && game.currentPlayerIndex === idx) {
          closeUnoWindow(game);
          advanceTurn(game);
        }

        // Return cards to deck
        game.deck.push(...player.hand);
        game.deck = shuffle(game.deck);
        game.players.splice(idx, 1);
        playerGameMap.delete(player.userId);

        if (game.players.length < MIN_PLAYERS) {
          await broadcastText(game, `${player.name} 离开，玩家不足，游戏结束。`);
          endGameCleanup(game);
          saveGame(messageStore, game);
          return;
        }

        // Adjust index
        if (idx < game.currentPlayerIndex) game.currentPlayerIndex--;
        if (game.currentPlayerIndex >= game.players.length) game.currentPlayerIndex = 0;

        // Transfer creator
        if (game.creatorId === player.userId) game.creatorId = game.players[0].userId;

        saveGame(messageStore, game);
        await broadcastText(game, `${player.name} 离开了游戏。`);

        if (game.state === "playing") {
          const nextPlayer = game.players[game.currentPlayerIndex];
          await broadcastText(game, `▶ 轮到 ${nextPlayer.name}`);
          await announceTurn(game);
        }
        return;
      }

      // ── Hand (private) ──
      case "hand": {
        const game = findPlayerGame(uid);
        if (!game) {
          await pm(uid, "你不在任何UNO游戏中。");
          return;
        }
        if (game.state !== "playing") {
          await pm(uid, "游戏还未开始。");
          return;
        }
        const player = game.players.find((p) => p.userId === uid);
        if (!player) return;
        await sendPlayerHand(game, player);
        return;
      }

      // ── Play (private) ──
      case "play": {
        const game = findPlayerGame(uid);
        if (!game) {
          await pm(uid, "你不在任何UNO游戏中。");
          return;
        }
        if (game.state !== "playing") {
          await pm(uid, "游戏还未开始。");
          return;
        }
        const player = game.players.find((p) => p.userId === uid);
        if (!player) return;

        if (game.players[game.currentPlayerIndex]?.userId !== uid) {
          await pm(uid, "还没轮到你出牌。");
          return;
        }
        if (game.drawStack > 0) {
          const canStack =
            (game.drawStackType === "draw2" && player.hand.some((c) => c.type === "draw2")) ||
            (game.drawStackType === "draw4" && player.hand.some((c) => c.type === "wild_draw4"));
          if (!canStack) {
            await pm(uid, `你被罚牌${game.drawStack}张，没有可叠的牌，请 $uno draw 摸牌。`);
            return;
          }
        }

        const index = parseInt(args[1] ?? "", 10);
        if (isNaN(index) || index < 0 || index >= player.hand.length) {
          await pm(uid, `无效序号。手牌0-${player.hand.length - 1}。`);
          return;
        }

        // After drawing, can only play the drawn card (last in hand)
        if (game.drewThisTurn && index !== player.hand.length - 1) {
          await pm(uid, "摸牌后只能出摸到的那张牌（手牌最后一张）。");
          return;
        }

        const card = player.hand[index];
        const top = game.discardPile[game.discardPile.length - 1];

        if (!canPlay(card, top, game.currentColor, game.drawStackType)) {
          await pm(uid, `这张牌不能出。桌面: ${cardLabel(top)}，颜色: ${COLOR_NAMES[game.currentColor]}。`);
          return;
        }

        // Wild card color choice
        let chosenColor: UnoColor | null = null;
        if (card.color === "wild") {
          if (!args[2]) {
            await pm(uid, `万能牌需指定颜色: ${prefix}uno play ${index} <red|yellow|green|蓝|...>`);
            return;
          }
          chosenColor = parseColor(args[2]);
          if (!chosenColor) {
            await pm(uid, `无效颜色: ${args[2]}。可用: red/yellow/green/blue 或 红/黄/绿/蓝`);
            return;
          }
        }

        // Close UNO window (next player's action)
        closeUnoWindow(game);

        // Remove card from hand, add to discard
        player.hand.splice(index, 1);
        game.discardPile.push(card);
        game.currentColor = card.color === "wild" ? chosenColor! : card.color;

        // Handle special cards
        let skipNext = false;
        let extra = "";

        if (card.type === "skip") {
          skipNext = true;
          extra = " 跳过下家！";
        } else if (card.type === "reverse") {
          if (game.players.length === 2) {
            skipNext = true;
            extra = " 反转(双人=跳过)！";
          } else {
            game.direction *= -1;
            extra = " 反转方向！";
          }
        } else if (card.type === "draw2") {
          game.drawStack += 2;
          game.drawStackType = "draw2";
          extra = ` 累积罚牌${game.drawStack}张！`;
        } else if (card.type === "wild_draw4") {
          game.drawStack += 4;
          game.drawStackType = "draw4";
          extra = ` 累积罚牌${game.drawStack}张！`;
        }

        // Check win
        if (player.hand.length === 0) {
          await broadcastText(game, `🎉 ${player.name} 出完了所有牌，赢得本局UNO！`);
          endGameCleanup(game);
          saveGame(messageStore, game);
          return;
        }

        // Check UNO
        if (player.hand.length === 1) {
          game.unoPendingIndex = game.currentPlayerIndex;
          player.saidUno = false;
        }

        game.drewThisTurn = false;
        advanceTurn(game, skipNext);
        saveGame(messageStore, game);

        // Broadcast to all players
        const colorNote = card.color === "wild" ? `（选${COLOR_NAMES[chosenColor!]}色）` : "";
        const nextPlayer = game.players[game.currentPlayerIndex];
        await broadcastText(game, `${player.name} 出了 ${cardLabel(card)}${colorNote}${extra} → 轮到 ${nextPlayer.name}`);

        await announceTurn(game);
        return;
      }

      // ── Draw (private) ──
      case "draw": {
        const game = findPlayerGame(uid);
        if (!game) {
          await pm(uid, "你不在任何UNO游戏中。");
          return;
        }
        if (game.state !== "playing") {
          await pm(uid, "游戏还未开始。");
          return;
        }
        const player = game.players.find((p) => p.userId === uid);
        if (!player) return;

        if (game.players[game.currentPlayerIndex]?.userId !== uid) {
          await pm(uid, "还没轮到你。");
          return;
        }
        if (game.drewThisTurn) {
          await pm(uid, "你已经摸过牌了，请出牌或 $uno pass 跳过。");
          return;
        }

        // Close UNO window
        closeUnoWindow(game);

        // Draw stack: draw all and skip
        if (game.drawStack > 0) {
          const drawn = drawFromDeck(game, game.drawStack);
          player.hand.push(...drawn);
          const cnt = drawn.length;
          game.drawStack = 0;
          game.drawStackType = null;
          game.drewThisTurn = false;

          await pm(uid, `你被迫摸了 ${cnt} 张牌并跳过回合。`);

          advanceTurn(game);
          saveGame(messageStore, game);

          const nextPlayer = game.players[game.currentPlayerIndex];
          await broadcastText(game, `${player.name} 摸了 ${cnt} 张罚牌并跳过 → 轮到 ${nextPlayer.name}`);
          await announceTurn(game);
          return;
        }

        // Normal draw: 1 card
        const drawn = drawFromDeck(game, 1);
        if (drawn.length === 0) {
          await pm(uid, "牌堆已空，无法摸牌。请出牌或 $uno pass 跳过。");
          return;
        }
        player.hand.push(drawn[0]);
        game.drewThisTurn = true;

        const top = game.discardPile[game.discardPile.length - 1];
        const playable = canPlay(drawn[0], top, game.currentColor, game.drawStackType);

        if (playable) {
          saveGame(messageStore, game);
          await sendPlayerHand(game, player, `你摸到了 ${cardLabel(drawn[0])}，可以出这张牌或 $uno pass 跳过`);
        } else {
          // Auto-pass
          game.drewThisTurn = false;
          advanceTurn(game);
          saveGame(messageStore, game);
          await pm(uid, `你摸到了 ${cardLabel(drawn[0])}，无法出牌，自动跳过。`);
          const nextPlayer = game.players[game.currentPlayerIndex];
          await broadcastText(game, `${player.name} 摸牌后跳过 → 轮到 ${nextPlayer.name}`);
          await announceTurn(game);
        }
        return;
      }

      // ── Pass (private) ──
      case "pass": {
        const game = findPlayerGame(uid);
        if (!game) {
          await pm(uid, "你不在任何UNO游戏中。");
          return;
        }
        if (game.state !== "playing") {
          await pm(uid, "游戏还未开始。");
          return;
        }
        if (game.players[game.currentPlayerIndex]?.userId !== uid) {
          await pm(uid, "还没轮到你。");
          return;
        }
        if (!game.drewThisTurn) {
          await pm(uid, "你还没摸牌，无法跳过。请出牌或 $uno draw 摸牌。");
          return;
        }

        closeUnoWindow(game);
        game.drewThisTurn = false;
        advanceTurn(game);
        saveGame(messageStore, game);

        const passerName = game.players.find((p) => p.userId === uid)?.name ?? "玩家";
        await pm(uid, "你选择了跳过。");
        const nextPlayer = game.players[game.currentPlayerIndex];
        await broadcastText(game, `${passerName} 摸牌后跳过 → 轮到 ${nextPlayer.name}`);

        await announceTurn(game);
        return;
      }

      // ── UNO call (private or group) ──
      case "uno": {
        const game = findPlayerGame(uid);
        if (!game) {
          await pm(uid, "你不在任何UNO游戏中。");
          return;
        }
        if (game.state !== "playing") {
          await pm(uid, "游戏还未开始。");
          return;
        }
        const player = game.players.find((p) => p.userId === uid);
        if (!player) return;

        if (player.hand.length !== 1) {
          await pm(uid, `你有${player.hand.length}张牌，不需要喊UNO。`);
          return;
        }
        if (player.saidUno) {
          await pm(uid, "你已经喊过UNO了。");
          return;
        }

        player.saidUno = true;
        game.unoPendingIndex = null;
        saveGame(messageStore, game);

        await pm(uid, "🎉 UNO！");
        await broadcastText(game, `🎉 ${player.name} 喊了UNO！只剩1张牌！`);
        return;
      }

      // ── Catch UNO (group) ──
      case "catch": {
        if (message.type !== "group") {
          await pm(uid, "请在群聊中使用: $uno catch @玩家");
          return;
        }
        const game = loadGame(messageStore, message.groupId!);
        if (!game || game.state !== "playing") {
          await pm(uid, "当前没有进行中的UNO游戏。");
          return;
        }
        if (game.unoPendingIndex === null) {
          await pm(uid, "当前没有人需要喊UNO。");
          return;
        }

        // Parse target
        const raw = args[1] ?? "";
        const m = raw.match(/^@?(\d+)$/) || raw.match(/\[CQ:at,qq=(\d+)/) || raw.match(/\[AT:(\d+)\]/);
        const targetId = m?.[1];
        if (!targetId) {
          await pm(uid, "请 @ 要抓的玩家: $uno catch @玩家");
          return;
        }

        const pending = game.players[game.unoPendingIndex];
        if (!pending || pending.userId !== targetId) {
          await pm(uid, "该玩家不需要喊UNO。");
          return;
        }
        if (pending.saidUno) {
          await pm(uid, `${pending.name} 已经喊过UNO了。`);
          return;
        }

        // Penalty: draw 2
        const drawn = drawFromDeck(game, 2);
        pending.hand.push(...drawn);
        game.unoPendingIndex = null;
        saveGame(messageStore, game);

        const caller = game.players.find((p) => p.userId === uid);
        await broadcastText(game, `🚨 ${pending.name} 忘记喊UNO，被 ${caller?.name ?? "玩家"} 抓到了！罚摸2张！`);
        return;
      }

      // ── Help ──
      case "help":
      default: {
        await showHelp(message, ctx);
        return;
      }
    }
  }

  async function showHelp(message: BotMessage, ctx: PluginContext): Promise<void> {
    const p = menuPlugin.getPrefix();
    const text = [
      "🎮 UNO卡牌游戏",
      "",
      "【群聊命令】",
      `${p}uno - 创建/查看游戏`,
      `${p}uno join - 加入游戏`,
      `${p}uno start - 开始游戏（房主）`,
      `${p}uno status - 查看状态`,
      `${p}uno end - 结束游戏（房主/管理）`,
      `${p}uno leave - 离开游戏`,
      `${p}uno catch @人 - 抓没喊UNO的人`,
      "",
      "【私聊命令】",
      `${p}uno hand - 查看手牌`,
      `${p}uno play <序号> [颜色] - 出牌`,
      `${p}uno draw - 摸牌`,
      `${p}uno pass - 摸牌后跳过`,
      `${p}uno uno - 喊UNO`,
      "",
      "【示例】",
      `${p}uno play 0 - 出序号0的牌`,
      `${p}uno play 3 red - 出万能牌选红色`,
      "",
      "【规则】",
      "颜色或数字相同即可出牌",
      "万能牌可随时出，需指定颜色",
      "+2可叠+2，+4可叠+4",
      "剩1张牌需喊UNO，否则罚2张",
      "60秒未操作自动摸牌跳过",
      "",
      "【注意】所有游戏消息通过私聊发送，请先添加机器人为好友。",
    ].join("\n");
    await ctx.replyText(message, text);
  }

  async function showGameStatus(game: UnoGame, userId: string): Promise<void> {
    if (game.state === "waiting") {
      const creator = game.players.find((p) => p.userId === game.creatorId);
      const list = game.players.map((p) => p.name).join("、");
      await pm(userId, `🎮 UNO等待开始\n房主: ${creator?.name ?? "?"}\n玩家(${game.players.length}): ${list}\n房主发送 $uno start 开始`);
    } else if (game.state === "playing") {
      const player = game.players.find((p) => p.userId === userId);
      // If requester is in game, show combined view; otherwise table only
      const html = player ? renderCombinedImage(game, player) : renderTableImage(game);
      await pmImage(userId, html);
    } else {
      await pm(userId, "游戏已结束。发送 $uno 创建新游戏。");
    }
  }

  // ── Plugin object ──

  return {
    name: "uno",
    description: "UNO卡牌游戏：群聊创建/加入，私聊出牌",

    onLoad(ctx: PluginContext) {
      pluginCtx = ctx;
      rebuildPlayerMap();

      menuPlugin.registerCommandGroup("uno", "UNO游戏", "群聊创建/加入，私聊出牌");
      menuPlugin.registerCommand(
        "uno",
        "UNO卡牌游戏：$uno 创建/加入 | $uno start 开始 | $uno hand 手牌(私聊) | $uno play <序号> 出牌(私聊) | $uno help 帮助",
        handleUno,
      );
    },
  };
}
