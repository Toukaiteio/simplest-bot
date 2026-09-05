import { z } from "zod";
import type { BotToolRegistration } from "./tooling.js";
import type { Browser, Page } from "puppeteer-core";
import type { LLMClient } from "./llm.js";
import type { AgentEnvironment, AgentIdentity } from "./security/access-control.js";

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

/**
 * Global outbound HTTP proxy configuration. `system` first uses the standard
 * proxy environment variables and falls back to `url` when they are absent.
 */
export const proxyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(["system", "custom"]).default("system"),
  url: z.string().url().default("http://127.0.0.1:55268"),
  noProxy: z.string().default("localhost,127.0.0.1"),
}).default({});

export const llmConfigSchema = z.object({
  name: z.string().optional(),
  provider: z.enum(["openai", "deepseek", "ollama", "custom"]).default("openai"),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().default(""),
  model: z.string().default("gpt-4o-mini"),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().default(2048),
  systemPrompt: z.string().default("你是一个面向实际工作的 AI Agent。请用中文，语言简练、干练，先给结论，再给必要细节。表达自然、克制，默认少用 emoji、颜文字、装饰性符号和连续标点；只有确实有助于表达语气时才少量使用。代码、命令、路径和必要的 Markdown 符号应保留。"),
  reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  supportsImages: z.boolean().default(false),
  supportsVideo: z.boolean().default(false),
  supportsVoice: z.boolean().default(false),
  /** 模型上下文窗口大小（token）。用于计算压缩阈值，不同模型可配不同值 */
  contextWindow: z.number().int().positive().default(128000),
});

/**
 * 思考/推理强度档位，与 @mariozechner/pi-agent-core 的 ThinkingLevel 对齐：
 * `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`。
 * 注意：`minimal`/`xhigh` 仅部分模型家族支持，请结合具体模型能力选择。
 */
export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
  chat: z.boolean().default(true),
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
  todo: z.boolean().default(true),
  mmorpgFramework: z.boolean().default(true),
  moderation: z.boolean().default(false),
  chatSearch: z.boolean().default(true),
  tts: z.boolean().default(false),
  /** gemini-web2api 的 Node.js 内嵌重写：进程内 OpenAI 兼容纯文本通道（普通聊天模型来源）。 */
  geminiRelay: z.boolean().default(false),
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
    /** 群聊临时文件默认按发送者隔离；仅在明确需要时开启群共享。 */
    sharedGroupWorkspace: z.boolean().default(false),
  }).default({}),
  groupTrigger: z.object({
    enabled: z.boolean().default(true),
    requireMention: z.boolean().default(true),
    keywords: z.array(z.string()).default(["bot", "Bot"]),
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
    /** tavily | serper | duckduckgo；保留 string 以兼容旧版 default 配置。 */
    defaultProvider: z.string().default("duckduckgo"),
    maxResults: z.number().int().min(1).max(20).default(5),
    timeoutMs: z.number().int().positive().default(15000),
    tavily: z.object({
      baseUrl: z.string().url().default("https://api.tavily.com"),
      apiKey: z.string().default(""),
      searchDepth: z.enum(["basic", "advanced"]).default("basic"),
      topic: z.enum(["general", "news", "finance"]).default("general"),
      includeAnswer: z.boolean().default(true),
      includeRawContent: z.boolean().default(false),
      /** 追加的多个 Tavily 兼容端点：自动负载均衡与失败回退。 */
      endpoints: z.array(z.object({
        name: z.string().optional(),
        baseUrl: z.string().url(),
        apiKey: z.string().default(""),
        enabled: z.boolean().optional(),
      })).default([]),
    }).default({}),
    serper: z.object({
      baseUrl: z.string().url().default("https://google.serper.dev"),
      apiKey: z.string().default(""),
      gl: z.string().default("cn"),
      hl: z.string().default("zh-cn"),
    }).default({}),
    duckduckgo: z.object({
      baseUrl: z.string().url().default("https://api.duckduckgo.com"),
      region: z.string().default("wt-wt"),
      safeSearch: z.enum(["strict", "moderate", "off"]).default("moderate"),
    }).default({}),
    /** 旧版“LLM 代理搜索”配置，仅为平滑读取旧配置保留，不再作为搜索实现。 */
    providers: z.array(z.object({
      name: z.string().min(1),
      baseUrl: z.string().url(),
      apiKey: z.string().default(""),
      model: z.string().default("gpt-4o"),
      systemPrompt: z.string().default("你是一个网络搜索助手。当用户提出问题时，你会进行网络搜索并返回准确、简洁的答案。请注明信息来源。"),
    })).default([]),
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
    longTextThreshold: z.number().int().min(200).max(10000).default(450),
    cleanupDelayMs: z.number().int().positive().default(120000),
  }).default({}),
  chatAgent: z.object({
    /** 任务开始且无首段正文时，追加到触发消息上的 emoji 回应编号（NapCat set_msg_emoji_like 的 QQ 表情 id）。170 ≈ 👀。 */
    taskStartEmojiId: z.number().int().positive().default(170),
    /** chat 层独立的 LLM 提供商配置（如进程内 gemini-web2api 纯文本通道）。standard 模式优先使用，失败回退全局 llm 提供商。 */
    llm: llmConfigSchema.optional(),
    /** 图片消息原文注册表数据文件：记录 bot 渲染成图片发送的原文，用于引用回溯（持久化，重启后仍可查）。 */
    sentImageTextsDataFile: z.string().default("data/sent-image-texts.json"),
  }).default({}),
  /** gemini-web2api Node.js 内嵌重写（进程内 OpenAI 兼容纯文本通道）。 */
  geminiRelay: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(8081),
    /** 上游 Cookie 文件（单行 Cookie 串或 {"cookie","sapisid"} JSON）；留空匿名工作。 */
    cookieFile: z.string().default(""),
    xsrfToken: z.string().default(""),
    authUser: z.string().default(""),
    geminiBl: z.string().default("boq_assistant-bard-web-server_20260716.08_p0"),
    defaultModel: z.string().default("gemini-3.6-flash"),
    requestTimeoutSec: z.number().int().min(1).max(600).default(180),
    retryAttempts: z.number().int().min(1).max(10).default(3),
    retryDelaySec: z.number().int().min(0).max(60).default(2),
    logRequests: z.boolean().default(true),
    temporaryChats: z.boolean().default(false),
    /** 非空时启用鉴权：Authorization Bearer / x-api-key / x-goog-api-key / ?key=。 */
    apiKeys: z.array(z.string()).default([]),
    /**
     * 上游 gemini.google.com 的专用代理。未设置（undefined）时沿用全局 fetch
     * （已被 configureGlobalProxy 包装）；设置后 relay 用独立 dispatcher，
     * 与 bot 其它出站流量解耦（例如全局直连、而 Gemini 上游需要代理）。
     */
    proxy: proxyConfigSchema.optional(),
  }).default({}),
  tts: z.object({
    /** Fish Audio API base URL; the plugin appends /v1/tts. */
    baseUrl: z.string().url().default("https://api.fish.audio"),
    apiKey: z.string().default(""),
    model: z.string().min(1).default("s2.1-pro-free"),
    referenceId: z.string().min(1).default("c5c17c9709384ba9a4b294662a2af0b1"),
    format: z.enum(["mp3", "wav", "pcm", "opus"]).default("mp3"),
    maxTextChars: z.number().int().min(1).max(10000).default(2000),
    timeoutMs: z.number().int().min(1000).max(120000).default(60000),
    outputDir: z.string().default("data/tts"),
    /** 语音消息内容注册表数据文件：记录 bot 已发送的语音与其朗读文本，用于引用回溯。 */
    voiceRegistryDataFile: z.string().default("data/voice-message-map.json"),
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
    /** 普通/管理员普通 Agent 的受限根目录；运行时还会按用户拆分子目录。 */
    workspaceRoot: z.string().default("data/agent-workspaces"),
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
  proxy: proxyConfigSchema,
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
export type ProxyConfig = z.infer<typeof proxyConfigSchema>;
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
  sendVoice: (target: NotifyTarget, filePath: string) => Promise<string | undefined>;
  sendFile: (target: NotifyTarget, filePath: string, name?: string) => Promise<void>;
  replyText: (message: BotMessage, text: string) => Promise<void>;
  recallMessage: (messageId: string) => Promise<void>;
  getImageFilePath: (fileId: string) => Promise<string | null>;
  getGroupNickname: (userId: string, groupId?: string) => Promise<string>;
  getBrowser: () => Promise<Browser>;
  newPage: () => Promise<Page>;
  getUserFacts?: (userId: string) => Promise<string[]>;
  getAgentIdentity?: (message: BotMessage) => AgentIdentity;
  getAgentEnvironment?: (message: BotMessage) => AgentEnvironment;
  getAgentSessionKey?: (message: BotMessage) => string;
};

export type PromptBuildInput =
  | { mode: "single"; message: BotMessage; environment?: AgentEnvironment }
  | { mode: "batch"; messages: BotMessage[]; triggerIndex?: number; environment?: AgentEnvironment };

export type ChatDeliveryOptions = {
  /** Quote the triggering message when the transport supports it. */
  quote?: boolean;
  /** Force this run's reply to be delivered as voice via send_voice_message_tts. */
  voice?: boolean;
  /**
   * 会话模式：standard 标准 AI 助手（无工具、无工作协议，默认）；agent 工具工作代理。
   * 会话上下文按路径独立维护：standard / voice（$voice）/ agent（$work、$agent-real）。
   */
  mode?: "standard" | "agent";
  /**
   * 内部回传通道：每条物理消息发送成功后回调其真实 message_id（可能多条）。
   * chat 层用它把最终交付与真实 message_id 关联，随 ChatRunResult.deliveredMessageIds
   * 返回给宿主做持久化（用户引用该消息时可回溯）。宿主 sendReply 需透传给渲染管线。
   */
  onSentMessageIds?: (messageIds: string[]) => void;
};

export type ChatRunResult = {
  /** The text persisted as the assistant result for this run. */
  text: string;
  /** True when the chat agent already submitted the response to the transport. */
  delivered: boolean;
  /** 实际发出的 message_id（可能多条，如 图片+链接文本 两段）；未交付时为空。 */
  deliveredMessageIds?: string[];
};

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
  chatBatch: (messages: BotMessage[], triggerIndex: number) => Promise<ChatRunResult>;
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
