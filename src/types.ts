import { z } from "zod";
import type { BotToolRegistration } from "./tooling.js";
import type { Browser, Page } from "puppeteer-core";
import type { LLMClient } from "./llm.js";

// ==================== OneBot v11 类型 ====================

export type TargetType = "private" | "group";

export type NotifyTarget = {
  type: TargetType;
  id: string;
};

export type OneBotMessageSegment = {
  type: string;
  data: Record<string, unknown>;
};

export type OneBotInboundEvent = {
  post_type?: string;
  message_type?: TargetType;
  self_id?: number | string;
  user_id?: number | string;
  group_id?: number | string;
  message_id?: number | string;
  message?: string | OneBotMessageSegment[];
  raw_message?: string;
  [key: string]: unknown;
};

export type BotMessage = {
  id?: string;
  type: TargetType;
  selfId?: string;
  userId?: string;
  groupId?: string;
  text: string;
  replyToMessageId?: string;
  forwardId?: string;
  raw: OneBotInboundEvent;
};

// ==================== 配置类型 ====================

export const oneBotConfigSchema = z.object({
  url: z.string().url(),
  accessToken: z.string().default(""),
  connectionTimeoutMs: z.number().int().positive().default(30000),
  reconnectIntervalMs: z.number().int().positive().default(5000),
  actionTimeoutMs: z.number().int().positive().default(10000),
});

export const llmConfigSchema = z.object({
  name: z.string().optional(),
  provider: z.enum(["openai", "deepseek", "ollama", "custom"]).default("openai"),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().default(""),
  model: z.string().default("gpt-4o-mini"),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().default(2048),
  systemPrompt: z.string().default("你是一个友好的AI助手。请用中文回复。"),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  supportsImages: z.boolean().default(false),
  supportsVideo: z.boolean().default(false),
  supportsVoice: z.boolean().default(false),
  /** 模型上下文窗口大小（token）。用于计算压缩阈值，不同模型可配不同值 */
  contextWindow: z.number().int().positive().default(128000),
});

export const memoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxHistoryLength: z.number().int().positive().default(20),
  extraction: z.object({
    enabled: z.boolean().default(false),
    turnsThreshold: z.number().int().positive().default(8),
  }).default({}),
});

export const authConfigSchema = z.object({
  adminUserIds: z.array(z.coerce.string()).default([]),
});

export const blackListConfigSchema = z.object({
  enabled: z.boolean().default(true),
  blockedUserIds: z.array(z.coerce.string()).default([]),
  blockedGroupIds: z.array(z.coerce.string()).default([]),
});

export const pluginsConfigSchema = z.object({
  blacklist: z.boolean().default(true),
  groupTrigger: z.boolean().default(true),
  reply: z.boolean().default(true),
  atMention: z.boolean().default(true),
  markdownImage: z.boolean().default(true),
  fftImage: z.boolean().default(true),
  split: z.boolean().default(true),
  debounce: z.boolean().default(true),
  webfetch: z.boolean().default(false),
  search: z.boolean().default(true),
  browser: z.boolean().default(true),
  dailyReport: z.boolean().default(true),
  fileWorkspace: z.boolean().default(true),
  adminAssist: z.boolean().default(true),
  todo: z.boolean().default(true),
  mmorpgFramework: z.boolean().default(true),
  moderation: z.boolean().default(false),
  chatSearch: z.boolean().default(true),
  music: z.boolean().default(true),
  flowmusic: z.boolean().default(false),
  imgGen: z.boolean().default(true),
  githubIssue: z.boolean().default(false),
  farm: z.boolean().default(true),
  agently: z.boolean().default(false),
  neteaseMusic: z.boolean().default(true),
  codingTools: z.boolean().default(false),
  uno: z.boolean().default(true),
  sgsCard: z.boolean().default(true),
});

export const contextManagementConfigSchema = z.object({
  enabled: z.boolean().default(true),
  compressionThresholdTokens: z.number().int().positive().default(100000),
  maxToleranceTokens: z.number().int().positive().default(170000),
  idleCompressionMinutes: z.number().int().positive().default(30),
  maxModelContextTokens: z.number().int().positive().default(128000),
  outputReserveTokens: z.number().int().positive().default(4096),
  toolReserveTokens: z.number().int().nonnegative().default(2048),
  chunkSegmentThresholdTokens: z.number().int().positive().default(8000),
  recentChunksToKeep: z.number().int().positive().default(5),
  tokenizer: z.enum(["auto", "character"]).default("auto"),
  maxMessageChars: z.number().int().positive().default(2000),
});

export const pluginSettingsSchema = z.object({
  coreCommand: z.object({
    prefix: z.string().min(1).default("$"),
  }).default({}),
  dailyReport: z.object({
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("00:00"),
    sendToActiveGroups: z.boolean().default(true),
    topUsersLimit: z.number().int().min(3).max(10).default(5),
    minLlmMessageThreshold: z.number().int().nonnegative().default(10),
  }).default({}),
  fileWorkspace: z.object({
    rootDir: z.string().default("data/chat-files"),
    expirationDays: z.number().int().min(1).max(365).default(10),
    maxViewChars: z.number().int().min(200).max(20000).default(4000),
  }).default({}),
  groupTrigger: z.object({
    enabled: z.boolean().default(true),
    requireMention: z.boolean().default(true),
    keywords: z.array(z.string()).default(["bot", "Bot"]),
  }).default({}),
  adminAssist: z.object({
    adminUserIds: z.array(z.coerce.string()).default([]),
    mentionTimeoutSeconds: z.number().int().min(3).max(300).default(30),
    activityLookbackMinutes: z.number().int().min(1).max(120).default(15),
    activitySampleIntervalSeconds: z.number().int().min(3).max(60).default(15),
    awayIdleThresholdSeconds: z.number().int().min(30).max(1800).default(120),
    maxSummarySegments: z.number().int().min(1).max(10).default(5),
    steamApiKey: z.string().default(""),
    steamUserIds: z.record(z.string(), z.string()).default({}),
  }).default({}),
  todo: z.object({
    dataFile: z.string().default("data/todos.json"),
    maxItemsPerChat: z.number().int().min(10).max(500).default(100),
    schedulerLookaheadSeconds: z.number().int().min(5).max(300).default(30),
    defaultReminderPrefix: z.string().min(1).default("[待办提醒]"),
  }).default({}),
  animeGuessr: z.object({
    dataFile: z.string().default("data/anime-characters.json"),
    contributionFile: z.string().default("data/anime-guessr-contributions.json"),
    searchCacheFile: z.string().default("data/anime-guessr-search-cache.json"),
    bangumiToken: z.string().default(""),
    bangumiProxy: z.string().default(""),
    backgroundCharactersPerWork: z.number().int().min(0).max(100).default(30),
    searchCacheTtlDays: z.number().int().min(1).max(3650).default(90),
    searchNegativeCacheTtlDays: z.number().int().min(1).max(365).default(7),
    bangumiSearchMinIntervalMs: z.number().int().min(250).max(60000).default(1000),
    bangumiSearchDailyLimit: z.number().int().min(1).max(100000).default(300),
  }).default({}),
  mmorpgFramework: z.object({
    dataFile: z.string().default("data/mmorpg-state.json"),
    autoValidateOnLoad: z.boolean().default(true),
    defaultStartingClassId: z.string().default("warrior"),
    defaultStartingAreaId: z.string().default("starter_village"),
    imageApiBaseUrl: z.string().default(""),
    imageApiKey: z.string().default(""),
    imageApiModel: z.string().default("gpt-image-2"),
    imageApiNewBaseUrl: z.string().default(""),
    imageApiCookie: z.string().default(""),
  }).default({}),
  moderation: z.object({
    apiKey: z.string().default(""),
    baseUrl: z.string().url().default("https://api.openai.com/v1"),
    model: z.string().default("omni-moderation-latest"),
    timeoutMs: z.number().int().positive().default(10000),
    blockFlagged: z.boolean().default(true),
    replyOnBlocked: z.boolean().default(true),
    ownerName: z.string().default("大妖精"),
    replyMessage: z.string().default("对不起，{ownerName}禁止我对这类问题做出回答。"),
    replySuffix: z.string().default("[消息已被系统拦截，simplest-bot默认会对所有输入进行审查，如有特殊需求请在设置中关闭]"),
    categoryReplies: z.record(z.string(), z.string()).default({}),
    failClosed: z.boolean().default(false),
    logScores: z.boolean().default(true),
  }).default({}),
  search: z.object({
    providers: z.array(z.object({
      name: z.string().min(1),
      baseUrl: z.string().url(),
      apiKey: z.string().default(""),
      model: z.string().default("gpt-4o"),
      systemPrompt: z.string().default("你是一个网络搜索助手。当用户提出问题时，你会进行网络搜索并返回准确、简洁的答案。请注明信息来源。"),
    })).default([
      {
        name: "default",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o",
        systemPrompt: "你是一个网络搜索助手。当用户提出问题时，你会进行网络搜索并返回准确、简洁的答案。请注明信息来源。",
      },
    ]),
    defaultProvider: z.string().default("default"),
    maxResultChars: z.number().int().positive().default(5000),
  }).default({}),
  browser: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().positive().default(9222),
    connectTimeoutMs: z.number().int().positive().default(10000),
    navigationTimeoutMs: z.number().int().positive().default(30000),
    maxAgentSteps: z.number().int().positive().default(20),
    viewportWidth: z.number().int().positive().default(1280),
    viewportHeight: z.number().int().positive().default(720),
    screenshotFormat: z.enum(["png", "jpeg"]).default("png"),
    chromePath: z.string().default(""),
    headless: z.boolean().default(true),
    launchArgs: z.array(z.string()).default([]),
    userDataDir: z.string().default(""),
  }).default({}),
  markdownImage: z.object({
    outputDir: z.string().default("data/markdown-images"),
    format: z.enum(["png", "webp"]).default("webp"),
    quality: z.number().int().min(60).max(100).default(88),
    cleanupDelayMs: z.number().int().positive().default(120000),
  }).default({}),
  fftImage: z.object({
    outputDir: z.string().default("data/fft-images"),
    cacheDir: z.string().default("data/fft-cache"),
    maxTransformSize: z.number().int().min(64).max(1024).default(256),
    renderScale: z.number().min(1).max(4).default(1.5),
    resultCleanupDelayMs: z.number().int().positive().default(120000),
    cacheRetentionHours: z.number().int().min(1).max(24 * 30).default(72),
  }).default({}),
  imgGen: z.object({
    baseUrl: z.string().default(""),
    apiKey: z.string().default(""),
    model: z.string().default("gpt-image-2"),
    newApiBaseUrl: z.string().default(""),
    cookie: z.string().default(""),
    legacyEditPath: z.string().default("/images/edits"),
    newApiEditPath: z.string().default("/api-proxy/images/edits"),
    synthIdRemoval: z.object({
      enabled: z.boolean().default(false),
      strength: z.enum(["gentle", "final", "nuke"]).default("final"),
    }).default({}),
    superResolution: z.object({
      enabled: z.boolean().default(false),
      model: z.enum(["realesrgan-x4plus-anime", "realesrgan-x4plus", "realesr-animevideov3-x4"]).default("realesrgan-x4plus-anime"),
      scale: z.number().int().min(2).max(4).default(4),
      denoise: z.number().int().min(0).max(3).default(0),
      strategy: z.enum(["auto", "ai", "safe"]).default("auto"),
      preserveTextAndLogo: z.boolean().default(true),
      safeScale: z.number().int().min(2).max(4).default(2),
    }).default({}),
  }).default({}),
  githubIssue: z.object({
    token: z.string().default(""),
  }).default({}),
  sgsCard: z.object({
    outputDir: z.string().default("data/sgs-card"),
    commandPrefix: z.string().min(1).default("sgs"),
    maxNicknameSimplifiedChars: z.number().int().positive().default(20),
    maxBackstoryChars: z.number().int().positive().default(150),
  }).default({}),
  codingTools: z.object({
    workspaceRoot: z.string().default("."),
    maxFileBytes: z.number().int().positive().default(131072),
    maxSearchResults: z.number().int().positive().default(1000),
    maxLinesPerFile: z.number().int().positive().default(2000),
    commandTimeoutMs: z.number().int().positive().default(30000),
  }).default({}),
});

export const personaConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** 数据目录（相对 cwd）。画像 JSON 存放于此。 */
  dataDir: z.string().default("data"),
  /** 进化循环间隔（小时）。软核心评估受 softCoreIntervalHours 进一步约束。 */
  evolutionIntervalHours: z.number().positive().default(24),
  /** 软核心评估间隔（小时）。比全局风格更慢。 */
  softCoreIntervalHours: z.number().positive().default(24 * 7),
  /** 进化评估窗口长度（小时），即回看多少小时的数据。 */
  evaluationWindowHours: z.number().positive().default(24),
  // ── 四道约束 ────────────────────────────────────────────────────────────
  /** 软核心单字段单次微调最大幅度（绝对值）。 */
  softCoreMaxAbsDelta: z.number().positive().default(0.03),
  /** 软核心累积确认：连续多少次同向评估才生效。 */
  softCoreRequiredConsecutive: z.number().int().min(1).default(3),
  /** 软核心累计漂移预算上限（各字段 |Δ| 之和）。 */
  softCoreDriftBudget: z.number().positive().default(0.3),
  /** 全局风格单字段单次变化最大幅度（绝对值）。 */
  globalStyleMaxAbsDelta: z.number().positive().default(0.15),
  /** rapport 单字段偏移量硬上限（绝对值）。去偏闸①。 */
  rapportMaxAbsOffset: z.number().positive().default(0.15),
  // ── 去偏 cap ────────────────────────────────────────────────────────────
  /** 单个用户对软核心进化的贡献上限（百分比，0-1）。去偏闸②。 */
  singleUserInfluenceCap: z.number().min(0).max(1).default(0.2),
  /** 收集的 AI 发言样本上限（条）。 */
  maxBotSamples: z.number().int().positive().default(30),
  /** 单条样本最大字符数。 */
  maxBotSampleChars: z.number().int().positive().default(200),
  // ── 防重复 / 防近义 / 容量与老化 ─────────────────────────────────────────
  /** 数组字段（fillerWords/signatures/topicHints/knownMembers）近义去重阈值（0-1，相似度 ≥ 此值视为重复）。 */
  dedupeSimilarityThreshold: z.number().min(0).max(1).default(0.85),
  /** 最大保留 rapport 用户数。超过时按 updatedAt 淘汰最旧。 */
  maxRapports: z.number().int().positive().default(200),
  /** 最大保留群画像数。超过时按 updatedAt 淘汰最旧。 */
  maxGroups: z.number().int().positive().default(50),
  /** rapport 多少天未更新则触发老化衰减（偏移向 0 收缩）。0 表示不老化。 */
  rapportStaleDays: z.number().min(0).default(90),
  /** group 画像多少天未更新则触发老化清理。0 表示不老化。 */
  groupStaleDays: z.number().min(0).default(180),
}).default({});

export const botConfigSchema = z.object({
  oneBot: oneBotConfigSchema,
  llm: llmConfigSchema,
  llmFallbacks: z.array(llmConfigSchema).default([]),
  memory: memoryConfigSchema,
  auth: authConfigSchema,
  blacklist: blackListConfigSchema,
  plugins: pluginsConfigSchema,
  pluginSettings: pluginSettingsSchema.default({}),
  contextManagement: contextManagementConfigSchema.default({}),
  persona: personaConfigSchema.default({}),
  messageTruncateThreshold: z.number().int().positive().default(2000),
});

export type OneBotConfig = z.infer<typeof oneBotConfigSchema>;
export type LLMConfig = z.infer<typeof llmConfigSchema>;
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type BlackListConfig = z.infer<typeof blackListConfigSchema>;
export type PluginsConfig = z.infer<typeof pluginsConfigSchema>;
export type ContextManagementConfig = z.infer<typeof contextManagementConfigSchema>;
export type PersonaConfig = z.infer<typeof personaConfigSchema>;
export type PluginSettings = z.infer<typeof pluginSettingsSchema>;
export type BotConfig = z.infer<typeof botConfigSchema>;

export type ProviderInfo = {
  index: number;
  name: string;
  model: string;
  provider: string;
  baseUrl?: string;
  healthy: boolean;
  isActive: boolean;
};

// ==================== 插件系统类型 ====================

export type PluginContext = {
  config: BotConfig;
  sendMessage: (target: NotifyTarget, text: string) => Promise<void>;
  sendImage: (target: NotifyTarget, filePath: string, caption?: string) => Promise<void>;
  sendVoice: (target: NotifyTarget, filePath: string) => Promise<void>;
  sendFile: (target: NotifyTarget, filePath: string, name?: string) => Promise<void>;
  replyText: (message: BotMessage, text: string) => Promise<void>;
  recallMessage: (messageId: string) => Promise<void>;
  getImageFilePath: (fileId: string) => Promise<string | null>;
  getGroupNickname: (userId: string, groupId?: string) => Promise<string>;
  getBrowser: () => Promise<Browser>;
  newPage: () => Promise<Page>;
  getUserFacts?: (userId: string) => Promise<string[]>;
};

export type PromptBuildInput =
  | { mode: "single"; message: BotMessage }
  | { mode: "batch"; messages: BotMessage[] };

export type ResponseTransform = {
  segments: OneBotMessageSegment[];
  remainingText: string;
};

export type TransformContext = {
  groupId?: string;
};

export type Plugin = {
  name: string;
  description: string;
  systemPromptAppend?: string;
  onLoad?: (ctx: PluginContext) => void | Promise<void>;
  onMessage?: (message: BotMessage, ctx: PluginContext) => Promise<boolean | void>;
  onShouldReply?: (message: BotMessage, ctx?: PluginContext) => boolean | Promise<boolean>;
  onTransformResponse?: (text: string, context?: TransformContext) => ResponseTransform | null | Promise<ResponseTransform | null>;
  onSplit?: (text: string) => string[] | null | Promise<string[] | null>;
  onBuildSystemPrompt?: (input: PromptBuildInput) => string | Promise<string>;
};

// 黑名单插件扩展类型
export type BlacklistPlugin = Plugin & {
  addUser: (userId: string) => void;
  removeUser: (userId: string) => void;
  addGroup: (groupId: string) => void;
  removeGroup: (groupId: string) => void;
  getBlockedUsers: () => string[];
  getBlockedGroups: () => string[];
};

// 群聊触发插件扩展类型
export type GroupTriggerPlugin = Plugin & {
  getKeywords: (ctx: PluginContext) => string[];
  addKeyword: (keyword: string, ctx: PluginContext) => void;
  removeKeyword: (keyword: string, ctx: PluginContext) => void;
};

// 防抖插件类型
export type DebounceHandler = {
  shouldReplyCheck: (message: BotMessage) => Promise<boolean>;
  chatBatch: (messages: BotMessage[], triggerIndex: number) => Promise<string>;
  sendResponse: (target: NotifyTarget, text: string, context?: TransformContext) => Promise<void>;
};

export type DebouncePlugin = Plugin & {
  setHandler: (handler: DebounceHandler) => void;
};

export type MentionTrackerHandler = {
  evaluateAndReply: (context: {
    targetUserId: string;
    groupId: string;
    botMessage: string;
    collectedMessages: BotMessage[];
  }) => Promise<void>;
  sendAutoPrompt: (groupId: string, targetUserId: string) => Promise<void>;
  reduceAffinity: (userId: string) => void;
};

export type MentionTrackerPlugin = Plugin & {
  setHandler: (handler: MentionTrackerHandler) => void;
  trackMention: (targetUserId: string, groupId: string, botMessage: string) => void;
};

export type CoreCommandOptions = {
  adminOnly?: boolean;
};

export type MenuCommandOptions = CoreCommandOptions & {
  hidden?: boolean;
  group?: string;
  aliases?: string[];
};

export type MenuCommandEntry = {
  name: string;
  description: string;
  shortDescription?: string;
  adminOnly: boolean;
};

// ==================== 核心插件类型 ====================

export type UserProfile = {
  coins: number;
  lastCheckin: string | null;
  checkinStreak: number;
  lastAutoCheckinNoticeDate?: string | null;
  /** Tracks daily gift count for the gift limit system. Format: { date: "YYYY-MM-DD", count: number } */
  dailyGifts?: { date: string; count: number };
  /** Timestamp (ms) of last affinity decay tick. */
  lastAffinityDecayAt?: number;
  inventory: Record<string, number>;
  affinity: {
    ai: number;
    users: Record<string, number>;
  };
  interactionStats: {
    ai: {
      gifts: number;
      chats: number;
    };
    users: Record<string, {
      gifts: number;
      mentions: number;
      replies: number;
    }>;
  };
  /** Seven-day welfare progress for new/returning players. */
  sevenDayWelfare?: {
    startDate: string | null;
    claimedDays: number[];
    lastClaimDate: string | null;
  };
  /** Monthly cumulative-checkin bonus tracking (resets each calendar month). */
  monthlyCheckin?: {
    month: string;
    totalDays: number;
    claimedMilestones: number[];
  };
  /** Last date the user was active (YYYY-MM-DD), used for return-reward detection. */
  lastActiveDate?: string | null;
  /** Level milestones already claimed (player level thresholds). */
  claimedLevelMilestones?: number[];
  /** True once the return reward for the current absence has been claimed. Resets on next activity. */
  returnRewardClaimedForAbsence?: boolean;
};

export type ItemDef = {
  id: string;
  name: string;
  description: string;
  price: number;
};

export type DataStorePlugin = Plugin & {
  getUserData(userId: string): UserProfile;
  saveUserData(userId: string, data: UserProfile): void;
  flush: () => void;
  getAllUserEntries(): Array<{ userId: string; profile: UserProfile }>;
  getItem(itemId: string): ItemDef | undefined;
  getAllItems(): ItemDef[];
  addItem(item: ItemDef): void;
};

export type CoreCommandHandler = (
  message: BotMessage,
  args: string[],
  ctx: PluginContext
) => Promise<void> | void;

export type CoreCommandPlugin = Plugin & {
  register(name: string, handler: CoreCommandHandler, options?: CoreCommandOptions): void;
  getPrefix(): string;
};

export type MenuCommandGroup = {
  id: string;
  label: string;
  description?: string;
};

export type MenuPlugin = Plugin & {
  registerCommand: (
    name: string,
    description: string,
    handler: CoreCommandHandler,
    options?: MenuCommandOptions
  ) => void;
  registerCommandGroup(id: string, label: string, description?: string): void;
  getCommands(): MenuCommandEntry[];
  getGroups(): MenuCommandGroup[];
  getMenuText(): string;
  getPrefix(): string;
};

export type SgsCardPluginDeps = {
  llm: LLMClient;
  menu: MenuPlugin;
  getUserFacts?: (userId: string) => Promise<string[]>;
};

export type InventorySubMenu = {
  name: string;
  getItems(userId: string): Array<{ itemId: string; name: string; quantity: number }>;
};

export type InventoryPlugin = Plugin & {
  addItem(userId: string, itemId: string, quantity: number): void;
  removeItem(userId: string, itemId: string, quantity: number): boolean;
  getInventory(userId: string): Record<string, number>;
  hasItem(userId: string, itemId: string, quantity: number): boolean;
  getItemDef(itemId: string): ItemDef | undefined;
  getAllItemDefs(): ItemDef[];
  registerSubMenu(menu: InventorySubMenu): void;
  getSubMenus(): InventorySubMenu[];
};

export type ImgGenPlugin = Plugin & {
  generateImageFile(
    prompt: string,
    outputDir: string,
    fileName: string,
    options?: { size?: string; quality?: string },
  ): Promise<{ filePath: string; generatedAt: string }>;
  editImageFile(
    inputPath: string,
    prompt: string,
    outputDir: string,
    fileName: string,
    options?: { size?: string; quality?: string },
  ): Promise<{ filePath: string; generatedAt: string }>;
};

export type SocialPlugin = Plugin & {
  addAIAffinity(userId: string, amount: number): void;
  getAIAffinity(userId: string): number;
  addUserAffinity(userId1: string, userId2: string, amount: number): void;
  getUserAffinity(userId1: string, userId2: string): number;
  applyAffinityDecay(userId: string): void;
  recordInteraction: (
    userId: string,
    targetId: string,
    kind: "gift" | "mention" | "reply" | "chat",
    amount?: number
  ) => void;
  getInteractionSummary: (
    userId: string,
    targetId?: string
  ) => { gifts: number; mentions: number; replies: number; chats: number };
  getToolRegistrations: () => BotToolRegistration[];
  getAffinityMultiplier: (userId: string) => number;
};

export type CheckinPlugin = Plugin & {
  checkin(userId: string): { coins: number; streak: number; bonus: number };
  canCheckin(userId: string): boolean;
  tryAutoCheckin(userId: string): { didCheckin: boolean; coins: number; streak: number; bonus: number };
  shouldSendAutoCheckinNotice(userId: string): boolean;
  markAutoCheckinNoticeSent(userId: string): void;
};

export type ShopPlugin = Plugin & {
  buyItem(userId: string, itemId: string, quantity?: number): boolean;
  giftItem(fromUserId: string, toUserId: string, itemId: string, quantity?: number): boolean;
  getRemainingDailyGifts(userId: string): number;
  getShopText(): string;
};

/** Result of a single welfare claim operation. */
export type WelfareClaimResult = {
  success: boolean;
  message: string;
  coinsGranted: number;
  itemsGranted: Array<{ itemId: string; quantity: number }>;
};

/**
 * Welfare reward system: seven-day progressive rewards, monthly cumulative-checkin
 * milestones, return rewards for lapsed players, and level milestone bonuses.
 * All methods are idempotent and safe to call repeatedly.
 */
export type WelfareRewardSystemPlugin = Plugin & {
  /** Render the welfare center overview for a user. */
  getWelfareCenterText(userId: string): string;
  /** Claim the seven-day welfare for the given day (1-7), or the next eligible day if omitted. */
  claimSevenDay(userId: string, day?: number): WelfareClaimResult;
  /** Claim any available monthly cumulative-checkin milestone. */
  claimMonthlyMilestones(userId: string): WelfareClaimResult;
  /** Claim the return reward if the user qualifies (based on absence duration). */
  claimReturnReward(userId: string): WelfareClaimResult;
  /** Check and auto-grant any newly-reached level milestones. Returns aggregated result. */
  checkLevelMilestones(userId: string, currentLevel: number): WelfareClaimResult;
  /** Whether the user currently has a pending return reward to claim. */
  hasPendingReturnReward(userId: string): boolean;
  /** Mark today as an active day (called on daily first interaction). */
  markActiveToday(userId: string): void;
};
