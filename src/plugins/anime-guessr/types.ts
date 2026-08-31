/**
 * 猜动漫人物 - 类型定义
 */

// ===== 角色数据 =====

export type AnimeAppearance = {
  id: number;
  name: string;
  nameCn: string;
  year: number | null;
  rating: number;
  studio: string | null;
  staff: string;
};

export type AnimeCharacter = {
  id: number;
  name: string;
  nameCn: string | null;
  aliases: string[];       // 别名（英文名、昵称、罗马字等）
  gender: "male" | "female" | null;
  hairColor: string | null;
  eyeColor: string | null;
  popularity: number;
  worksCount: number;
  highestRating: number | null;
  latestYear: number | null;
  earliestYear: number | null;
  voiceActors: string[];
  appearances: AnimeAppearance[];
  tags: string[];          // 含发色/瞳色标签
  image: string;
  tier: string;
};

// ===== 游戏反馈 =====

export type FeedbackLevel = "=" | "+" | "++" | "-" | "--" | "?";

export type GenderFeedback = "yes" | "no" | "unknown";

export type GuessFeedback = {
  gender: GenderFeedback;
  popularity: FeedbackLevel;
  worksCount: FeedbackLevel;
  highestRating: FeedbackLevel;
  latestYear: FeedbackLevel;
  earliestYear: FeedbackLevel;
  sharedVoiceActors: string[];
  sharedStudios: string[];
  sharedWorks: string[];    // 共同出演作品名（用于作品名着色）
  sharedTags: string[];     // 共享标签（含发色/瞳色）
};

// ===== 猜测记录 =====

export type GuessRecord = {
  character: AnimeCharacter;
  feedback: GuessFeedback;
  isCorrect: boolean;
  timestamp: number;
};

// ===== 玩家状态 =====

export type PlayerState = {
  userId: string;
  name: string;
  guesses: GuessRecord[];
  maxAttempts: number;
  finished: boolean;
  won: boolean;
};

// ===== 游戏状态 =====

export type GameState = "waiting" | "playing" | "ended";

export type Game = {
  groupId: string;
  state: GameState;
  answer: AnimeCharacter | null;
  players: Map<string, PlayerState>;
  creatorId: string;
  round: number;
  startedAt: number;
  endedAt: number | null;
};

// ===== 配置 =====

export type GuessrConfig = {
  maxAttempts: number;
  minPopularity: number;
  dataFile: string;
  contributionFile: string;
  searchCacheFile: string;
  adminUserIds: string[];
  bangumiToken: string | null;
  bangumiProxy: string | null;
  backgroundCharactersPerWork: number;
  searchCacheTtlDays: number;
  searchNegativeCacheTtlDays: number;
  bangumiSearchMinIntervalMs: number;
  bangumiSearchDailyLimit: number;
};

export const DEFAULT_CONFIG: GuessrConfig = {
  maxAttempts: 7,
  minPopularity: 100,
  dataFile: "data/anime-characters.json",
  contributionFile: "data/anime-guessr-contributions.json",
  searchCacheFile: "data/anime-guessr-search-cache.json",
  adminUserIds: [],
  bangumiToken: process.env.BGM_TOKEN ?? null,
  bangumiProxy: process.env.BGM_PROXY ?? null,
  backgroundCharactersPerWork: 30,
  searchCacheTtlDays: 90,
  searchNegativeCacheTtlDays: 7,
  bangumiSearchMinIntervalMs: 1000,
  bangumiSearchDailyLimit: 300,
};

export type AnimeWork = {
  id: number;
  name: string;
  nameCn: string;
  year: number | null;
  rating: number;
  studio: string | null;
  source: "bangumi" | "community";
};

export type ContributionType = "create_character" | "update_character" | "create_work" | "link_character_work" | "import_work";
export type ContributionStatus = "pending" | "approved" | "rejected";

export type Contribution = {
  id: number;
  userId: string;
  userName: string;
  type: ContributionType;
  payload: Record<string, unknown>;
  summary: string;
  status: ContributionStatus;
  createdAt: number;
  reviewedAt: number | null;
  reviewedBy: string | null;
  reviewNote: string | null;
};
