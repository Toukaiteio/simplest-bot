/**
 * 猜动漫人物 - 统计模块
 * 持久化存储玩家数据，提供排行计算
 */

import fs from "node:fs";
import path from "node:path";

// ===== 类型 =====

export type GroupStats = {
  gamesPlayed: number;
  gamesWon: number;
};

export type PlayerStats = {
  userId: string;
  name: string;
  gamesPlayed: number;
  gamesWon: number;
  totalGuesses: number;
  bestStreak: number;
  currentStreak: number;
  fastestWinMs: number | null;  // 最快猜中用时
  lastPlayedAt: number;
  groups: Record<string, GroupStats>; // groupId -> stats
};

export type StatsStore = {
  players: Record<string, PlayerStats>;
  version: number;
};

// ===== 存储 =====

const STATS_VERSION = 1;
let store: StatsStore | null = null;
let storePath: string = "";
let saveTimer: NodeJS.Timeout | null = null;

export function initStats(filePath: string): void {
  storePath = path.resolve(process.cwd(), filePath);
  if (fs.existsSync(storePath)) {
    try {
      store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    } catch {
      store = { players: {}, version: STATS_VERSION };
    }
  } else {
    store = { players: {}, version: STATS_VERSION };
  }
}

function ensureStore(): StatsStore {
  if (!store) throw new Error("Stats not initialized. Call initStats first.");
  return store;
}

function persistSoon(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!store) return;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
    saveTimer = null;
  }, 500);
}

// ===== 记录操作 =====

export function getPlayerStats(userId: string): PlayerStats {
  const s = ensureStore();
  if (!s.players[userId]) {
    s.players[userId] = {
      userId,
      name: "",
      gamesPlayed: 0,
      gamesWon: 0,
      totalGuesses: 0,
      bestStreak: 0,
      currentStreak: 0,
      fastestWinMs: null,
      lastPlayedAt: 0,
      groups: {},
    };
  }
  return s.players[userId];
}

/** 记录一局游戏结束 */
export function recordGameResult(
  userId: string,
  name: string,
  groupId: string,
  won: boolean,
  guessCount: number,
  timeMs: number | null,
): void {
  const p = getPlayerStats(userId);
  p.name = name;
  p.gamesPlayed += 1;
  p.totalGuesses += guessCount;
  p.lastPlayedAt = Date.now();

  // 群内统计
  if (!p.groups[groupId]) {
    p.groups[groupId] = { gamesPlayed: 0, gamesWon: 0 };
  }
  p.groups[groupId].gamesPlayed += 1;

  if (won) {
    p.gamesWon += 1;
    p.currentStreak += 1;
    if (p.currentStreak > p.bestStreak) p.bestStreak = p.currentStreak;
    p.groups[groupId].gamesWon += 1;
    if (timeMs !== null) {
      if (p.fastestWinMs === null || timeMs < p.fastestWinMs) {
        p.fastestWinMs = timeMs;
      }
    }
  } else {
    p.currentStreak = 0;
  }

  persistSoon();
}

/** 更新玩家名称 */
export function updateName(userId: string, name: string): void {
  const p = getPlayerStats(userId);
  if (name && p.name !== name) {
    p.name = name;
    persistSoon();
  }
}

// ===== 排行计算 =====

export type RankEntry = {
  userId: string;
  name: string;
  gamesPlayed: number;
  gamesWon: number;
  winRate: number;
  bestStreak: number;
  totalGuesses: number;
};

/** 全服排行（按胜场数排序） */
export function getGlobalRanking(limit = 20): RankEntry[] {
  const s = ensureStore();
  return Object.values(s.players)
    .filter((p) => p.gamesPlayed > 0)
    .map((p) => ({
      userId: p.userId,
      name: p.name || p.userId,
      gamesPlayed: p.gamesPlayed,
      gamesWon: p.gamesWon,
      winRate: p.gamesPlayed > 0 ? p.gamesWon / p.gamesPlayed : 0,
      bestStreak: p.bestStreak,
      totalGuesses: p.totalGuesses,
    }))
    .sort((a, b) => b.gamesWon - a.gamesWon || b.winRate - a.winRate)
    .slice(0, limit);
}

/** 群内排行 */
export function getGroupRanking(groupId: string, limit = 20): RankEntry[] {
  const s = ensureStore();
  return Object.values(s.players)
    .filter((p) => p.groups[groupId] && p.groups[groupId].gamesPlayed > 0)
    .map((p) => ({
      userId: p.userId,
      name: p.name || p.userId,
      gamesPlayed: p.groups[groupId].gamesPlayed,
      gamesWon: p.groups[groupId].gamesWon,
      winRate: p.groups[groupId].gamesPlayed > 0 ? p.groups[groupId].gamesWon / p.groups[groupId].gamesPlayed : 0,
      bestStreak: p.bestStreak,
      totalGuesses: p.totalGuesses,
    }))
    .sort((a, b) => b.gamesWon - a.gamesWon || b.winRate - a.winRate)
    .slice(0, limit);
}

/** 获取某玩家在全服/群内的排名 */
export function getPlayerRank(userId: string, groupId?: string): { global: number; group: number | null } {
  const globalList = getGlobalRanking(9999);
  const globalIdx = globalList.findIndex((e) => e.userId === userId);

  let groupIdx: number | null = null;
  if (groupId) {
    const groupList = getGroupRanking(groupId, 9999);
    const idx = groupList.findIndex((e) => e.userId === userId);
    groupIdx = idx >= 0 ? idx + 1 : null;
  }

  return {
    global: globalIdx >= 0 ? globalIdx + 1 : globalList.length + 1,
    group: groupIdx,
  };
}

// ===== 雷达图数据计算 =====

export type RadarDimension = {
  title: string;
  sub: string;
  value: number;  // 0-1 归一化
  display: string;
};

/** 计算六维雷达数据 */
export function computeRadar(userId: string): RadarDimension[] {
  const p = getPlayerStats(userId);
  const totalPlayers = Object.keys(ensureStore().players).length || 1;

  // 1. 胜率
  const winRate = p.gamesPlayed > 0 ? p.gamesWon / p.gamesPlayed : 0;

  // 2. 效率（平均猜测次数越少越好，归一化：1次=满分，7次=0）
  const avgGuesses = p.gamesWon > 0 ? p.totalGuesses / p.gamesWon : 7;
  const efficiency = Math.max(0, Math.min(1, (7 - avgGuesses) / 6));

  // 3. 速度（最快猜中，30秒内=满分，5分钟=0）
  const speed = p.fastestWinMs !== null
    ? Math.max(0, Math.min(1, 1 - (p.fastestWinMs - 30000) / (300000 - 30000)))
    : 0;

  // 4. 活跃度（参与场次，50场=满分）
  const participation = Math.min(1, p.gamesPlayed / 50);

  // 5. 精准度（猜中率 = 胜场/总猜测次数）
  const accuracy = p.totalGuesses > 0 ? Math.min(1, p.gamesWon / p.totalGuesses * 3) : 0;

  // 6. 连胜（最高连胜，10连胜=满分）
  const streak = Math.min(1, p.bestStreak / 10);

  return [
    { title: "Win Rate", sub: "胜率", value: winRate, display: `${(winRate * 100).toFixed(1)}%` },
    { title: "Efficiency", sub: "效率", value: efficiency, display: `${avgGuesses.toFixed(1)} 次/胜` },
    { title: "Speed", sub: "速度", value: speed, display: p.fastestWinMs ? `${(p.fastestWinMs / 1000).toFixed(0)}s` : "-" },
    { title: "Activity", sub: "活跃度", value: participation, display: `${p.gamesPlayed} 场` },
    { title: "Accuracy", sub: "精准度", value: accuracy, display: `${(accuracy * 100).toFixed(0)}%` },
    { title: "Streak", sub: "连胜", value: streak, display: `${p.bestStreak} 连胜` },
  ];
}
