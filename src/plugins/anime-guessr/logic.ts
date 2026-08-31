/**
 * 猜动漫人物 - 核心游戏逻辑
 */

import type {
  AnimeCharacter,
  FeedbackLevel,
  GenderFeedback,
  GuessFeedback,
} from "./types.js";

// ===== 数值比较反馈 =====

function numericFeedback(
  guess: number | null,
  answer: number | null,
  closeThreshold: number,
  farThreshold: number,
): FeedbackLevel {
  if (guess === null || answer === null) return "?";
  const diff = guess - answer;
  if (Math.abs(diff) <= closeThreshold) return "=";
  if (diff > 0) return diff <= farThreshold ? "+" : "++";
  return diff >= -farThreshold ? "-" : "--";
}

// ===== 各维度比较 =====

function compareGender(guess: string | null, answer: string | null): GenderFeedback {
  if (!guess || !answer) return "unknown";
  return guess === answer ? "yes" : "no";
}

function comparePopularity(guess: number, answer: number): FeedbackLevel {
  const fivePercent = answer * 0.05;
  const twentyPercent = answer * 0.2;
  return numericFeedback(guess, answer, fivePercent, twentyPercent);
}

function compareWorksCount(guess: number, answer: number): FeedbackLevel {
  return numericFeedback(guess, answer, 0, 2);
}

function compareRating(guess: number | null, answer: number | null): FeedbackLevel {
  if (guess === null || answer === null) return "?";
  const rounded = Math.round((guess - answer) * 100) / 100;
  return numericFeedback(rounded, 0, 0.3, 1.0);
}

function compareYear(guess: number | null, answer: number | null): FeedbackLevel {
  if (guess === null || answer === null) return "?";
  return numericFeedback(guess, answer, 0, 2);
}

function findShared(guessList: string[], answerList: string[]): string[] {
  const answerSet = new Set(answerList);
  return guessList.filter((item) => answerSet.has(item));
}

// ===== 主比较函数 =====

export function generateFeedback(
  guess: AnimeCharacter,
  answer: AnimeCharacter,
): GuessFeedback {
  const sharedVoiceActors = findShared(guess.voiceActors, answer.voiceActors);

  const guessStudios = guess.appearances
    .map((a) => a.studio)
    .filter((s): s is string => s !== null);
  const answerStudios = answer.appearances
    .map((a) => a.studio)
    .filter((s): s is string => s !== null);
  const sharedStudios = findShared(guessStudios, answerStudios);

  // 共同出演作品（按作品 ID 匹配，返回作品名）
  const answerWorkIds = new Set(answer.appearances.map((a) => a.id));
  const sharedWorks = guess.appearances
    .filter((a) => answerWorkIds.has(a.id))
    .map((a) => a.nameCn || a.name);

  // 标签交集（含发色/瞳色）
  const sharedTags = findShared(guess.tags, answer.tags);

  return {
    gender: compareGender(guess.gender, answer.gender),
    popularity: comparePopularity(guess.popularity, answer.popularity),
    worksCount: compareWorksCount(guess.worksCount, answer.worksCount),
    highestRating: compareRating(guess.highestRating, answer.highestRating),
    latestYear: compareYear(guess.latestYear, answer.latestYear),
    earliestYear: compareYear(guess.earliestYear, answer.earliestYear),
    sharedVoiceActors,
    sharedStudios,
    sharedWorks,
    sharedTags,
  };
}

// ===== 判断是否猜中 =====

export function isCorrectGuess(guess: AnimeCharacter, answer: AnimeCharacter): boolean {
  return guess.id === answer.id;
}

// ===== 角色搜索（支持别名） =====

export type SearchResult = {
  char: AnimeCharacter;
  score: number;
  matchedField: string; // 匹配来源描述
};

/**
 * 根据名称搜索角色（支持日文名、中文名、别名、模糊匹配）
 * 返回按相关度排序的结果，附带匹配来源信息用于歧义提示。
 */
export function searchCharacter(
  query: string,
  database: AnimeCharacter[],
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: SearchResult[] = [];

  for (const char of database) {
    let score = 0;
    let matchedField = "";
    const nameJp = char.name.toLowerCase();
    const nameCn = (char.nameCn ?? "").toLowerCase();

    // 完全匹配（最高优先级）
    if (nameJp === q) { score = 100; matchedField = "日文名"; }
    else if (nameCn === q) { score = 100; matchedField = "中文名"; }
    // 别名完全匹配
    else {
      const aliasMatch = (char.aliases ?? []).find((a) => a.toLowerCase() === q);
      if (aliasMatch) { score = 95; matchedField = `别名: ${aliasMatch}`; }
    }

    // 包含匹配
    if (score === 0) {
      if (nameJp.includes(q) || nameCn.includes(q)) {
        score = 80; matchedField = "部分匹配";
      } else if ((char.aliases ?? []).some((a) => a.toLowerCase().includes(q))) {
        score = 75; matchedField = "别名部分匹配";
      }
    }

    // 反向包含
    if (score === 0) {
      if (q.includes(nameJp) && nameJp.length > 1) { score = 60; matchedField = "反向匹配"; }
      else if (nameCn && q.includes(nameCn) && nameCn.length > 1) { score = 60; matchedField = "反向匹配"; }
    }

    if (score > 0) {
      results.push({ char, score, matchedField });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || b.char.popularity - a.char.popularity)
    .slice(0, 5);
}

// ===== 随机选取答案 =====

export function pickRandomAnswer(
  database: AnimeCharacter[],
  minPopularity: number,
): AnimeCharacter {
  const eligible = database.filter((c) => c.popularity >= minPopularity);
  if (eligible.length === 0) {
    throw new Error("数据库中没有满足条件的角色");
  }
  return eligible[Math.floor(Math.random() * eligible.length)];
}
