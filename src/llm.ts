import { ChatOpenAI, type ChatOpenAICallOptions } from "@langchain/openai";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { LLMConfig, BotMessage, PromptBuildInput, ProviderInfo } from "./types.js";
import { MemoryManager, type MemoryMessage } from "./memory.js";
import type { BotToolRegistration } from "./tooling.js";

import { ContextManager } from "./context/context-manager.js";
import type { BuildContextOptions, GroupContext } from "./context/types.js";
import { sanitizeAssistantOutput } from "./response-sanitizer.js";

type ProviderEntry = {
  config: LLMConfig;
  model: ChatOpenAI;
  name: string;
  healthy: boolean;
};

export class LLMClient {
  private providers: ProviderEntry[] = [];
  private activeIndex = 0;
  private fallbackEnabled = true;
  private config: LLMConfig;
  private memory: MemoryManager;
  private contextManager: ContextManager;
  private tools: NonNullable<ChatOpenAICallOptions["tools"]> = [];
  private toolHandlers = new Map<string, BotToolRegistration["execute"]>();
  private truncatedTexts = new Map<string, string>();
  private truncateThreshold: number;
  private resolveReferencedMessage?: (messageId: string) => Promise<BotMessage | null>;
  private resolveForwardMessage?: (forwardId: string) => Promise<string | null>;
  private resolveGroupContext?: (message: BotMessage) => Promise<GroupContext | null>;
  private resolveInteractionHistory?: (userId: string, limit: number) => Promise<string | null>;

  constructor(
    config: LLMConfig,
    memory: MemoryManager,
    contextManager: ContextManager,
    truncateThreshold = 2000,
    resolveReferencedMessage?: (messageId: string) => Promise<BotMessage | null>,
    resolveGroupContext?: (message: BotMessage) => Promise<GroupContext | null>,
    resolveForwardMessage?: (forwardId: string) => Promise<string | null>,
    resolveInteractionHistory?: (userId: string, limit: number) => Promise<string | null>,
    fallbackConfigs?: LLMConfig[]
  ) {
    this.config = config;
    this.memory = memory;
    this.contextManager = contextManager;
    this.truncateThreshold = truncateThreshold;
    this.resolveReferencedMessage = resolveReferencedMessage;
    this.resolveGroupContext = resolveGroupContext;
    this.resolveForwardMessage = resolveForwardMessage;
    this.resolveInteractionHistory = resolveInteractionHistory;

    this.providers.push({
      config,
      model: LLMClient.createChatModel(config),
      name: config.name ?? `${config.provider}/${config.model}`,
      healthy: true,
    });

    for (const fb of fallbackConfigs ?? []) {
      this.providers.push({
        config: fb,
        model: LLMClient.createChatModel(fb),
        name: fb.name ?? `${fb.provider}/${fb.model}`,
        healthy: true,
      });
    }

    console.log(`[LLM] 已加载 ${this.providers.length} 个提供商: ${this.providers.map(p => p.name).join(", ")}`);
  }

  private static createChatModel(config: LLMConfig): ChatOpenAI {
    return LLMClient.createChatModelWithOverrides(config);
  }

  private static createChatModelWithOverrides(
    config: LLMConfig,
    overrides?: { maxTokens?: number; reasoningEffort?: "low" | "medium" | "high" },
  ): ChatOpenAI {
    const openaiConfig: Record<string, unknown> = {
      modelName: config.model,
      temperature: config.temperature,
      maxTokens: overrides?.maxTokens ?? config.maxTokens,
      modelKwargs: {} as Record<string, unknown>,
    };

    if (config.baseUrl) {
      openaiConfig.configuration = { baseURL: config.baseUrl };
    }

    if (config.apiKey) {
      openaiConfig.apiKey = config.apiKey;
    }

    if (overrides?.reasoningEffort ?? config.reasoningEffort) {
      (openaiConfig.modelKwargs as Record<string, unknown>).reasoning_effort =
        overrides?.reasoningEffort ?? config.reasoningEffort;
    }

    return new ChatOpenAI(openaiConfig);
  }

  async invokeWithCustomConfig(
    messages: (SystemMessage | HumanMessage | AIMessage)[],
    options: { timeout?: number; maxTokens?: number; reasoningEffort?: "low" | "medium" | "high" },
  ): Promise<string> {
    const timeout = options.timeout ?? 300000;
    const result = await Promise.race([
      this.callWithFallback(async (_model, _name) => {
        const provider = this.getActiveProvider();
        const tempModel = LLMClient.createChatModelWithOverrides(provider.config, {
          maxTokens: options.maxTokens,
          reasoningEffort: options.reasoningEffort,
        });
        const response = await tempModel.invoke(messages);
        this.logUsage(response.usage_metadata);
        return typeof response.content === "string" ? response.content : String(response.content);
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`LLM 调用超时 (${timeout / 1000}s)`)), timeout)
      ),
    ]);
    return result;
  }

  setTools(registrations: BotToolRegistration[]) {
    this.tools = registrations.map((registration) => registration.definition);
    this.toolHandlers = new Map(
      registrations.map((registration) => [getToolName(registration.definition), registration.execute])
    );
  }

  getTruncatedFullText(id: string): string | undefined {
    return this.truncatedTexts.get(id);
  }

  private async callWithFallback<T>(fn: (model: ChatOpenAI, name: string) => Promise<T>): Promise<T> {
    const count = this.providers.length;
    const start = this.activeIndex;

    for (let attempt = 0; attempt < count; attempt++) {
      const idx = (start + attempt) % count;
      const entry = this.providers[idx];
      if (!this.fallbackEnabled && attempt > 0) break;

      try {
        const result = await fn(entry.model, entry.name);
        if (!entry.healthy) {
          entry.healthy = true;
          console.log(`[LLM] 提供商 ${entry.name} 恢复正常`);
        }
        if (idx !== this.activeIndex && this.fallbackEnabled) {
          console.log(`[LLM] 切换至备用提供商: ${entry.name}`);
          this.activeIndex = idx;
        }
        return result;
      } catch (error) {
        entry.healthy = false;
        const errMsg = error instanceof Error ? error.message : String(error);
        console.warn(`[LLM] 提供商 ${entry.name} 调用失败: ${errMsg}`);
        if (attempt < count - 1 && this.fallbackEnabled) {
          const next = this.providers[(idx + 1) % count];
          console.log(`[LLM] 尝试切换至: ${next.name}`);
        }
      }
    }

    throw new Error(`所有 LLM 提供商均不可用（已尝试 ${count} 个）`);
  }

  getActiveProvider(): ProviderEntry {
    return this.providers[this.activeIndex];
  }

  listProviders(): ProviderInfo[] {
    return this.providers.map((p, i) => ({
      index: i,
      name: p.name,
      model: p.config.model,
      provider: p.config.provider,
      baseUrl: p.config.baseUrl,
      healthy: p.healthy,
      isActive: i === this.activeIndex,
    }));
  }

  switchProvider(nameOrIndex: string): boolean {
    const byIndex = Number(nameOrIndex);
    if (Number.isInteger(byIndex) && byIndex >= 0 && byIndex < this.providers.length) {
      this.activeIndex = byIndex;
      console.log(`[LLM] 已切换至提供商: ${this.providers[byIndex].name}`);
      return true;
    }
    const idx = this.providers.findIndex(p => p.name === nameOrIndex);
    if (idx >= 0) {
      this.activeIndex = idx;
      console.log(`[LLM] 已切换至提供商: ${this.providers[idx].name}`);
      return true;
    }
    return false;
  }

  setFallback(enabled: boolean): void {
    this.fallbackEnabled = enabled;
    console.log(`[LLM] 自动切换提供商: ${enabled ? "开启" : "关闭"}`);
  }

  isFallbackEnabled(): boolean {
    return this.fallbackEnabled;
  }

  async invokeWithFallback(
    messages: (SystemMessage | HumanMessage | AIMessage)[],
    options?: { timeout?: number }
  ): Promise<string> {
    const timeout = options?.timeout ?? 300000;
    const result = await Promise.race([
      this.callWithFallback(async (model) => {
        const response = await model.invoke(messages);
        this.logUsage(response.usage_metadata);
        return typeof response.content === "string" ? response.content : String(response.content);
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`LLM 调用超时 (${timeout / 1000}s)`)), timeout)
      ),
    ]);
    return result;
  }

  async evaluateMentionContext(botMessage: string, collectedMessages: BotMessage[]): Promise<string | null> {
    const messagesText = collectedMessages
      .map(m => `${m.userId ?? "unknown"}: ${m.text}`)
      .join("\n");

    const prompt =
      `你之前在一个群聊里 @过某个用户，你当时的发言是：\n${botMessage}\n\n` +
      `之后你收集到这些后续消息：\n${messagesText}\n\n` +
      `这些后续消息与你之前 @对方的发言有关联吗？如果有关联，请生成一个自然的回复（直接输出回复内容，不要解释，不要加引号）。如果完全无关，只输出 __NO_REPLY__。`;

    try {
      const response = await this.callWithFallback((model) =>
        model.invoke([new HumanMessage(prompt)])
      );
      const content = typeof response.content === "string" ? response.content : String(response.content);
      const trimmed = content.trim();
      if (trimmed.includes("__NO_REPLY__")) return null;
      return trimmed;
    } catch {
      return null;
    }
  }

  async summarizeHistory(history: MemoryMessage[]): Promise<string> {
    const historyText = history.map(m => `${m.role}: ${m.content}`).join("\n");
    const prompt = `总结以下对话的关键信息（100字内）：\n${historyText}`;

    try {
      const response = await this.callWithFallback((model) =>
        model.invoke([new HumanMessage(prompt)])
      );
      return typeof response.content === "string" ? response.content : String(response.content);
    } catch {
      return "";
    }
  }

  /**
   * 独立 LLM 查询：带 system prompt 的简单一问一答，不涉及对话历史/工具/上下文管理。
   * 适合插件需要让 LLM 做分析/推荐/分类等独立推理的场景。
   */
  async askLlm(
    systemPrompt: string,
    userPrompt: string,
    options?: { maxTokens?: number; reasoningEffort?: "low" | "medium" | "high" },
  ): Promise<string> {
    try {
      if (options && (options.maxTokens || options.reasoningEffort)) {
        const result = await this.invokeWithCustomConfig(
          [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)],
          { maxTokens: options.maxTokens, reasoningEffort: options.reasoningEffort },
        );
        return result;
      }
      const response = await this.callWithFallback((model) =>
        model.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(userPrompt),
        ])
      );
      return typeof response.content === "string" ? response.content : String(response.content);
    } catch {
      return "";
    }
  }

  async askLlmWithFunction(
    systemPrompt: string,
    userPrompt: string,
    fn: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    },
    options?: { maxTokens?: number; reasoningEffort?: "low" | "medium" | "high" },
  ): Promise<Record<string, unknown> | null> {
    try {
      const messages = [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)];
      const invokeOptions = {
        tools: [
          {
            type: "function",
            function: {
              name: fn.name,
              description: fn.description,
              parameters: fn.parameters,
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: fn.name },
        },
      } as ChatOpenAICallOptions;

      const response = await this.callWithFallback(async (model) => {
        const result = await model.invoke(messages, invokeOptions);
        this.logUsage(result.usage_metadata);
        return result;
      });

      const toolCall = response.tool_calls?.find((call) => call.name === fn.name) ?? response.tool_calls?.[0];
      if (!toolCall || !toolCall.args || typeof toolCall.args !== "object") {
        return null;
      }
      return toolCall.args as Record<string, unknown>;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[LLM] 函数调用 ${fn.name} 失败: ${errMsg}`);
      return null;
    }
  }

  async chat(message: BotMessage, dynamicPromptAppends?: string[]): Promise<string> {
    const memories = await this.memory.getRelevantMemories(message);
    const sessionKey = this.getSessionKey(message);
    const contextOptions = await this.buildContextOptions(message, memories, dynamicPromptAppends);

    // 仅在首次构建时注入对话历史，避免每次调用都查询
    if (!this.contextManager.isSeeded(sessionKey)) {
      contextOptions.conversationHistory = this.memory.getConversationHistory(message);
    }

    this.truncatedTexts.clear();

    const contextResult = await this.contextManager.buildContext(sessionKey, contextOptions);
    const promptMessages = this.chunksToLangChainMessages(contextResult.chunks);

    try {
      const content = sanitizeAssistantOutput(
        await this.invokeWithTools(promptMessages, { mode: "single", message }, sessionKey),
      );

      this.contextManager.appendAssistantResponse(sessionKey, content);
      this.memory.addMessage(message, content).catch(err =>
        console.error("[LLM] 存储记忆失败:", err)
      );
      // 扫描 AI 回复中的 [FACT:xxx] 标记，激活对应事实
      if (message.userId) {
        this.memory.processFactMentions(content, message.userId);
      }

      return content;
    } catch (error) {
      console.error("[LLM] 调用失败:", error);
      const errMsg = "抱歉，我暂时无法回复，请稍后再试。";
      // 确保上下文中也有 assistant 回复，避免 workingChunks 中残留孤立触发消息
      try { this.contextManager.appendAssistantResponse(sessionKey, errMsg); } catch {}
      return errMsg;
    }
  }

  async chatBatch(messages: BotMessage[], dynamicPromptAppends?: string[], triggerIndex = messages.length - 1): Promise<string> {
    if (messages.length === 0) return "";

    const primary = messages[Math.max(0, Math.min(triggerIndex, messages.length - 1))];
    const memories = await this.memory.getRelevantMemories(primary);
    const sessionKey = this.getSessionKey(primary);
    const contextOptions = await this.buildBatchContextOptions(messages, memories, dynamicPromptAppends, triggerIndex);

    // 仅在首次构建时注入对话历史，避免每次调用都查询
    if (!this.contextManager.isSeeded(sessionKey)) {
      contextOptions.conversationHistory = this.memory.getConversationHistory(primary);
    }

    this.truncatedTexts.clear();

    const contextResult = await this.contextManager.buildContext(sessionKey, contextOptions);
    const promptMessages = this.chunksToLangChainMessages(contextResult.chunks);

    try {
      const content = sanitizeAssistantOutput(
        await this.invokeWithTools(promptMessages, { mode: "batch", messages }, sessionKey),
      );

      this.contextManager.appendAssistantResponse(sessionKey, content);
      this.memory.addBatch(messages, content).catch(err =>
        console.error("[LLM] 批量存储记忆失败:", err)
      );
      // 扫描 AI 回复中的 [FACT:xxx] 标记，激活对应事实
      if (primary?.userId) {
        this.memory.processFactMentions(content, primary.userId);
      }

      return content;
    } catch (error) {
      console.error("[LLM] Batch 调用失败:", error);
      const errMsg = "抱歉，我暂时无法回复，请稍后再试。";
      // 确保上下文中也有 assistant 回复，避免 workingChunks 中残留孤立触发消息
      try { this.contextManager.appendAssistantResponse(sessionKey, errMsg); } catch {}
      return errMsg;
    }
  }

  private chunksToLangChainMessages(chunks: import("./context/types.js").ContextChunk[]) {
    const messages: (SystemMessage | HumanMessage | AIMessage)[] = [];

    for (const chunk of chunks) {
      if (chunk.role === "system" || chunk.role === "memory") {
        messages.push(new SystemMessage(chunk.content));
      } else if (chunk.role === "assistant") {
        messages.push(new AIMessage(chunk.content));
      } else {
        messages.push(new HumanMessage(chunk.content));
      }
    }

    return messages;
  }

  private async buildContextOptions(
    message: BotMessage,
    memories: string[],
    dynamicPromptAppends?: string[]
  ): Promise<BuildContextOptions> {
    const [referenceText, groupContext, forwardText, interactionHistory] = await Promise.all([
      this.buildReferenceText(message),
      this.resolveGroupContext?.(message) ?? null,
      message.forwardId ? this.buildForwardText(message.forwardId) : Promise.resolve(""),
      message.type === "private" && message.userId && this.resolveInteractionHistory
        ? this.resolveInteractionHistory(message.userId, 8)
        : Promise.resolve(null),
    ]);
    const displayText = this.maybeTruncate(message.text, "current");
    const parts = [
      referenceText ? `[该消息引用了：${referenceText}]` : "",
      displayText,
      forwardText ? `[该消息包含的合并转发内容：\n${forwardText}]` : "",
    ].filter(Boolean);
    const triggerText = parts.join("\n");

    // 私聊时注入近期互动历史
    const appends = [...(dynamicPromptAppends ?? [])];
    if (interactionHistory) {
      appends.unshift(interactionHistory);
    }

    return {
      triggerMessage: {
        userId: message.userId,
        text: triggerText,
        id: message.id,
        replyToMessageId: message.replyToMessageId,
        timestamp: this.getMessageTimestamp(message),
      },
      speakerMemories: message.userId && memories.length > 0
        ? [{ userId: message.userId, memories, memoryIds: memories.map((m) => `mem-${m.slice(0, 32)}`) }]
        : undefined,
      dynamicSystemAppends: appends.length > 0 ? appends : undefined,
      groupContext: groupContext ?? undefined,
    };
  }

  private async buildBatchContextOptions(
    messages: BotMessage[],
    memories: string[],
    dynamicPromptAppends?: string[],
    requestedTriggerIndex = messages.length - 1,
  ): Promise<BuildContextOptions> {
    const triggerIndex = Math.max(0, Math.min(requestedTriggerIndex, messages.length - 1));
    const trigger = messages[triggerIndex];
    const surrounding: BuildContextOptions["surroundingMessages"] = [];

    for (let i = 0; i < messages.length; i += 1) {
      if (i === triggerIndex) continue;
      const m = messages[i];
      const [referenceText, forwardText] = await Promise.all([
        this.buildReferenceText(m),
        m.forwardId ? this.buildForwardText(m.forwardId) : Promise.resolve(""),
      ]);
      const displayText = this.maybeTruncate(m.text, `batch-${i + 1}`);
      const parts = [
        referenceText ? `[该消息引用了：${referenceText}]` : "",
        displayText,
        forwardText ? `[该消息包含的合并转发内容：\n${forwardText}]` : "",
      ].filter(Boolean);
      surrounding.push({
        userId: m.userId,
        text: parts.join("\n"),
        id: m.id,
        timestamp: this.getMessageTimestamp(m),
      });
    }

    const [triggerReferenceText, groupContext, triggerForwardText] = await Promise.all([
      this.buildReferenceText(trigger),
      this.resolveGroupContext && messages.length > 0
        ? this.resolveGroupContext(trigger)
        : null,
      trigger.forwardId ? this.buildForwardText(trigger.forwardId) : Promise.resolve(""),
    ]);
    const triggerDisplayText = this.maybeTruncate(trigger.text, `batch-${messages.length}`);
    const triggerParts = [
      triggerReferenceText ? `[该消息引用了：${triggerReferenceText}]` : "",
      triggerDisplayText,
      triggerForwardText ? `[该消息包含的合并转发内容：\n${triggerForwardText}]` : "",
    ].filter(Boolean);

    return {
      triggerMessage: {
        userId: trigger.userId,
        text: triggerParts.join("\n"),
        id: trigger.id,
        replyToMessageId: trigger.replyToMessageId,
        timestamp: this.getMessageTimestamp(trigger),
      },
      surroundingMessages: surrounding,
      speakerMemories: trigger.userId && memories.length > 0
        ? [{ userId: trigger.userId, memories, memoryIds: memories.map((m) => `mem-${m.slice(0, 32)}`) }]
        : undefined,
      dynamicSystemAppends: dynamicPromptAppends,
      groupContext: groupContext ?? undefined,
    };
  }

  private async buildReferenceText(message: BotMessage): Promise<string> {
    if (!message.replyToMessageId || !this.resolveReferencedMessage) {
      return "";
    }

    const referenced = await this.resolveReferencedMessage(message.replyToMessageId);
    if (!referenced) {
      return `消息 ID ${message.replyToMessageId}（内容暂不可见）`;
    }

    const sender = referenced.userId ?? "unknown";
    const baseText = referenced.text.length > 500
      ? referenced.text.slice(0, 500) + "..."
      : referenced.text;
    const forwardText = referenced.forwardId
      ? await this.buildForwardText(referenced.forwardId)
      : "";
    const text = forwardText ? `${baseText}\n[转发内容展开]\n${forwardText}` : baseText;
    return `${sender}: ${text}`;
  }

  private getMessageTimestamp(message: BotMessage): number {
    const seconds = Number(message.raw?.time);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now();
  }

  private async buildForwardText(forwardId: string): Promise<string> {
    if (!this.resolveForwardMessage) return "（无法展开转发内容）";
    const content = await this.resolveForwardMessage(forwardId);
    if (!content) return "（转发内容不可见或已过期）";
    return content;
  }

  private getSessionKey(message: BotMessage): string {
    return message.type === "private" ? `private:${message.userId}` : `group:${message.groupId}`;
  }

  private logUsage(metadata: unknown): void {
    if (!metadata || typeof metadata !== "object") return;
    const usage = metadata as Record<string, unknown>;

    const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens;
    const cachedTokens =
      usage.cached_tokens ??
      usage.cache_read_input_tokens ??
      usage.prompt_cache_hit_tokens;

    if (inputTokens === undefined || outputTokens === undefined) return;

    const cached = cachedTokens !== undefined ? `，缓存命中 ${cachedTokens} tokens` : "";
    console.log(`[LLM] 请求用量：输入 ${inputTokens} tokens，输出 ${outputTokens} tokens${cached}`);
  }

  private async invokeWithTools(
    messages: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[],
    input: PromptBuildInput,
    sessionKey?: string
  ): Promise<string> {
    const invokeOptions: ChatOpenAICallOptions | undefined = this.tools.length > 0
      ? { tools: this.tools }
      : undefined;

    return this.callWithFallback(async (chatModel) => {
      const conversation = [...messages];

      for (let round = 0; round < 6; round += 1) {
        const response = await chatModel.invoke(conversation, invokeOptions);
        this.logUsage(response.usage_metadata);

        // 将 API 返回的实际输入 token 数报告给 ContextManager，用于压缩判断
        if (sessionKey && response.usage_metadata) {
          const usage = response.usage_metadata as Record<string, unknown>;
          const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
          if (typeof inputTokens === "number") {
            this.contextManager.reportInputTokens(sessionKey, inputTokens);
          }
        }
        const toolCalls = response.tool_calls ?? [];

        if (toolCalls.length === 0) {
          return typeof response.content === "string" ? response.content : String(response.content);
        }

        conversation.push(response);
        const mediaAttachments: Array<{ mime: string; base64: string }> = [];
        let finalToolResult: string | null = null;

        for (const toolCall of toolCalls) {
          const toolName = toolCall.name;
          const toolCallId = toolCall.id ?? `${toolName}-${round}`;
          const handler = this.toolHandlers.get(toolName);

          if (!handler) {
            conversation.push(new ToolMessage({
              content: `工具 ${toolName} 不可用。`,
              tool_call_id: toolCallId,
              status: "error",
            }));
            continue;
          }

          try {
            const rawArgs = toolCall.args;
            const args = rawArgs && typeof rawArgs === "object" ? rawArgs as Record<string, unknown> : {};
            const result = await handler(args, input);

            if (typeof result === "object" && result !== null) {
              const textContent = typeof result.text === "string" ? result.text : "工具执行完成。";
              const mediaList = "media" in result && Array.isArray(result.media) ? result.media : [];

              if (mediaList.length > 0) {
                for (const item of mediaList) {
                  if (item && typeof item === "object" && "type" in item && item.type === "image" && "base64" in item) {
                    mediaAttachments.push({
                      mime: typeof item.mime === "string" ? item.mime : "image/jpeg",
                      base64: String(item.base64),
                    });
                  }
                }
              }

              conversation.push(new ToolMessage({
                content: textContent,
                tool_call_id: toolCallId,
                status: "success",
              }));

              if ("final" in result && result.final === true) {
                finalToolResult = textContent;
              }
            } else {
              conversation.push(new ToolMessage({
                content: typeof result === "string" ? result : String(result),
                tool_call_id: toolCallId,
                status: "success",
              }));
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            conversation.push(new ToolMessage({
              content: `工具 ${toolName} 执行失败：${message}`,
              tool_call_id: toolCallId,
              status: "error",
            }));
          }
        }

        if (finalToolResult !== null) {
          return finalToolResult;
        }

        if (mediaAttachments.length > 0) {
          conversation.push(this.buildMediaUserMessage(mediaAttachments));
        }
      }

      return "抱歉，我暂时无法完成这个请求，请换一种方式描述。";
    });
  }

  private buildMediaUserMessage(
    media: Array<{ mime: string; base64: string }>
  ): HumanMessage {
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: "text", text: "[系统：工具请求查看以下媒体，已为你插入原文件]" },
    ];

    for (const { mime, base64 } of media) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${base64}` },
      });
    }

    return new HumanMessage({ content });
  }

  private maybeTruncate(text: string, id: string): string {
    if (text.length <= this.truncateThreshold) {
      return text;
    }
    this.truncatedTexts.set(id, text);
    const truncated = text.slice(0, this.truncateThreshold);
    return `${truncated}\n\n[系统提示：此消息过长，共 ${text.length} 个字，已仅展示前 ${this.truncateThreshold} 个字。如需查看完整内容，请调用 read_full_message 工具，参数 id 为 "${id}"。]`;
  }
}

function getToolName(definition: BotToolRegistration["definition"]): string {
  if ("function" in definition && definition.function?.name) {
    return definition.function.name;
  }
  throw new Error("仅支持 function 类型工具。");
}
