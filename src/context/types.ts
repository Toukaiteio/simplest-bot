export type ChunkRole = "system" | "memory" | "user" | "assistant" | "tool";

export type ChunkStability = "immutable" | "stable" | "volatile";

export type CompressionPolicy = "never" | "summarize" | "drop";

export type ContextChunk = {
  /** 全局唯一标识，用于去重、分段引用等 */
  id: string;

  /** message role */
  role: ChunkRole;

  /** 纯文本内容 */
  content: string;

  /** 是否已经过本地 tokenizer 预计算 */
  tokenCount?: number;

  /** chunk 创建时间戳 */
  timestamp: number;

  /** 稳定性级别：immutable 最稳定，volatile 最易变 */
  stability: ChunkStability;

  /** 压缩策略 */
  compressionPolicy: CompressionPolicy;

  /** 来源用户（user/memory chunk 使用） */
  sourceUserId?: string;

  /** 该 chunk 包含哪些 memory_id，用于增量去重 */
  memoryIds?: string[];

  /** 是否是当前需要回复的触发消息 */
  isTrigger?: boolean;

  /** 是否已经被压缩/摘要过 */
  isSummarized?: boolean;

  /** 原始 chunk 被分段后的子段（如果该 chunk 过长） */
  segments?: ContextChunkSegment[];
};

export type ContextChunkSegment = {
  id: string;
  index: number;
  total: number;
  summary: string;
  content: string;
  tokenCount?: number;
};

export type BuildContextOptions = {
  /** 当前需要回复的触发消息，会作为最后一个 chunk 的核心 */
  triggerMessage: {
    userId?: string;
    text: string;
    id?: string;
    replyToMessageId?: string;
    timestamp?: number;
  };

  /** 同一 burst/窗口内的其他消息 */
  surroundingMessages?: Array<{
    userId?: string;
    text: string;
    id?: string;
    timestamp?: number;
    isTrigger?: boolean;
  }>;

  /** 按发言者检索到的记忆 */
  speakerMemories?: SpeakerMemorySet[];

  /** 全局/跨用户记忆 */
  globalMemories?: string[];

  /** 动态追加的场景或插件系统提示 */
  dynamicSystemAppends?: string[];

  /** 工具定义文本，放在 immutable system chunk 中 */
  toolDefinitions?: string;

  /** 当前群聊上下文（群名、发送者群名片等） */
  groupContext?: GroupContext;

  /** 持久化的对话历史，用于在首次构建上下文时填充 working chunks */
  conversationHistory?: HistoryMessage[];

  /**
   * 是否将本次上下文状态写入持久化存储。真实环境流只保留进程内状态，
   * 避免把物理环境中的消息、路径或命令输出写入普通会话数据库。
   */
  persist?: boolean;
};

/** 对话历史消息（与 MemoryMessage 结构一致，避免 context 模块依赖 memory 模块） */
export type HistoryMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type GroupMemberInfo = {
  card?: string;
  nickname?: string;
};

export type GroupContext = {
  groupId?: string;
  groupName?: string;
  /** 当前触发回复的用户；旧版单成员 fallback 只能用于该用户。 */
  triggerUserId?: string;
  /** 触发消息发送者的名片（兼容旧用法） */
  memberCard?: string;
  memberNickname?: string;
  /** 群内多个用户的名片信息（推荐） */
  members?: Record<string, GroupMemberInfo>;
};

export type SpeakerMemorySet = {
  userId: string;
  memories: string[];
  memoryIds: string[];
};

export type ContextBuildResult = {
  chunks: ContextChunk[];
  totalTokens: number;
  compressed: boolean;
  droppedChunkIds: string[];
};
