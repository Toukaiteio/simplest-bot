/**
 * 人格自进化系统的数据模型。
 *
 * 设计层次（详见 docs / 设计讨论）：
 *   第1层  硬底线     ─ config.llm.systemPrompt，永不参与进化
 *   第1层' 软核心     ─ 全局唯一，所有用户加权影响，极慢蠕动（本文件 SoftCore）
 *   第2层  全局风格   ─ 跨所有会话共享的语言风格画像（本文件 GlobalStyle）
 *   第3层' 相处调音   ─ per-user，跟人走，人不在即失效（本文件 RapportProfile）
 *   第3层  群体适配   ─ 每群一份，群氛围/话题（本文件 GroupPersona）
 *
 * 软核心 + 全局风格为 immutable（启动时拼进 personaContent，每次对话都在）。
 * Rapport / 群画像为动态注入（按当前在场用户 / 当前群计算）。
 */

// ── 第1层'：软核心（性格程度参数，全局唯一） ────────────────────────────────
//
// 软核心只存性格的"程度"（0-1），不存性格本身。
// 例如"傲娇"这个属性永远存在，变的只是"傲娇到什么程度"。
// 受四道约束保护：进化频率（低）/ 单次幅度（小）/ 累积确认 / 变化预算。

/** 可进化的软核心性格字段。键名需稳定，渲染端依赖。 */
export type SoftCoreField =
  | "warmth" // 热心程度
  | "tsundere" // 傲娇程度
  | "taciturnity" // 无口/话少程度
  | "toxicity" // 毒舌程度
  | "emotionality"; // 情感外露程度

export const SOFT_CORE_FIELDS: SoftCoreField[] = [
  "warmth",
  "tsundere",
  "taciturnity",
  "toxicity",
  "emotionality",
];

export type SoftCore = {
  /** 各性格字段的程度，范围 [0, 1]。 */
  values: Record<SoftCoreField, number>;
  /** 该字段是否被管理员锁定（锁定后不参与进化）。 */
  locked: Partial<Record<SoftCoreField, boolean>>;
  /**
   * 累积确认状态机：记录每个字段连续多少次评估指向同一方向。
   * 达到 requiredConsecutiveRounds 才会真正生效一次微调。
   */
  pendingDirection: Partial<Record<SoftCoreField, "up" | "down" | "neutral">>;
  pendingStreak: Partial<Record<SoftCoreField, number>>;
  /**
   * 相对出厂基准的累计漂移量（各字段 |Δ| 之和）。
   * 接近 budget 上限时自动收紧单次幅度。
   */
  cumulativeDrift: number;
  /** 进化版本号，每次实际写入 +1。用于 rollback。 */
  version: number;
};

// ── 第2层：全局语言风格画像（全局唯一） ────────────────────────────────────

export type GlobalStyle = {
  /** 正式度 0(口语)-1(书面)。 */
  formality: number;
  /** 热情度 0-1。 */
  warmth: number;
  /** 目标平均句长：'short' | 'medium' | 'long'。 */
  avgLength: "short" | "medium" | "long";
  /** 习惯语气词。 */
  fillerWords: string[];
  /** 自称 / 口头禅。 */
  signatures: string[];
  /** 自由文本补充（回怼用反问句、高兴连发两个表情 等难以结构化的细节）。 */
  notes: string;
  /** 进化版本号。 */
  version: number;
};

// ── 第3层'：相处调音（per-user，ephemeral） ─────────────────────────────────
//
// 每个用户一份：和这个人相处时 AI 倾向往哪个方向调。
// 每个字段是相对软核心基准的偏移量，受幅度上限约束。
// 跟用户走（同用户跨群一致），用户不在场即不参与计算（不污染其他群）。

export type RapportField =
  | "warmth"
  | "playfulness"
  | "verbosity"
  | "respectfulness";

export const RAPPORT_FIELDS: RapportField[] = [
  "warmth",
  "playfulness",
  "verbosity",
  "respectfulness",
];

export type RapportProfile = {
  /** 相对软核心基准的偏移量，每字段范围 [-0.15, 0.15]。 */
  offsets: Partial<Record<RapportField, number>>;
  /** 自由文本：和这个用户相处的特别备注。 */
  notes: string;
  /** 上次更新时间戳（ms）。用于老化衰减。 */
  updatedAt: number;
};

// ── 第3层：群体适配画像（per-group） ────────────────────────────────────────

export type GroupPersona = {
  groupId: string;
  /** 群氛围描述（如"偏技术讨论，节奏快"）。 */
  vibe: string;
  /** AI 在该群的特殊角色（如"工具人+吐槽役"）。 */
  myRole: string;
  /** 话题线索。 */
  topicHints: string[];
  /** 群内核心成员备注。 */
  knownMembers: string[];
  /** 自由文本补充。 */
  notes: string;
  updatedAt: number;
};

// ── 完整画像容器 ────────────────────────────────────────────────────────────

export type PersonaProfile = {
  softCore: SoftCore;
  globalStyle: GlobalStyle;
  /** per-user 相处调音。 */
  rapports: Record<string, RapportProfile>;
  /** per-group 群体画像。 */
  groups: Record<string, GroupPersona>;
  /** 历史快照，用于 rollback（按版本号索引，保留最近 N 个）。 */
  history: PersonaSnapshot[];
};

/** 一次写入前的只读快照。 */
export type PersonaSnapshot = {
  version: number;
  takenAt: number;
  softCore: SoftCore;
  globalStyle: GlobalStyle;
};

// ── 进化引擎：LLM 评估产出 ──────────────────────────────────────────────────

/**
 * LLM 对一次评估窗口的输出结构（JSON）。
 * 引擎会对其中每一项施加四道约束后再合并，不会直接信任。
 */
export type PersonaEvaluation = {
  /** 软核心建议（字段 → 方向；幅度由引擎按预算决定，不接受 LLM 的幅度）。 */
  softCore?: Partial<Record<SoftCoreField, "up" | "down" | "neutral">>;
  /** 全局风格建议（直接给新值，引擎会做幅度限制）。 */
  globalStyle?: Partial<Omit<GlobalStyle, "version">>;
  /** per-user 相处调音建议。 */
  rapports?: Record<string, { offsets?: Partial<Record<RapportField, number>>; notes?: string }>;
  /** 群画像建议（按 groupId）。 */
  groups?: Record<string, Partial<Omit<GroupPersona, "groupId" | "updatedAt">>>;
  /** 评估理由（人类可读，写入日志/管理员可见）。 */
  reasoning?: string;
};

// ── 进化引擎：评估素材 ──────────────────────────────────────────────────────

/** 收集给 LLM 评估的客观行为素材（纯本地计算，不含 LLM 自我审视）。 */
export type EvaluationMaterial = {
  /** 评估时间窗（ms）。 */
  windowStart: number;
  windowEnd: number;
  /** 该窗口内 AI 的发言样本（已截断）。 */
  botSamples: Array<{ text: string; timestamp: number }>;
  /** 该窗口内各用户的行为信号：当前好感度、互动次数、平均发消息间隔等。 */
  userSignals: Array<{
    userId: string;
    /** 当前 AI 对该用户的好感度绝对值（0-10000），作为关系深度的代理指标。 */
    currentAffinity: number;
    interactionCount: number;
    /** 同一用户相邻消息的平均间隔（ms），近似其活跃节奏。 */
    avgMessageIntervalMs: number | null;
  }>;
  /** 该窗口内涉及的群。 */
  groupIds: string[];
};
