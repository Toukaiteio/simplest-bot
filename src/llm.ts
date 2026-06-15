import { ChatOpenAI, type ChatOpenAICallOptions } from "@langchain/openai";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { LLMConfig, BotMessage, PromptBuildInput } from "./types.js";
import { MemoryManager, type MemoryMessage } from "./memory.js";
import type { BotToolRegistration } from "./tooling.js";

import { ContextManager } from "./context/context-manager.js";
import type { BuildContextOptions, GroupContext } from "./context/types.js";

const ASSISTANT_PREFIX = /^(?:\[ASSISTANT\]|ASSISTANT\])[\s\n]*/;

export class LLMClient {
  private chatModel: ChatOpenAI;
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

  constructor(
    config: LLMConfig,
    memory: MemoryManager,
    contextManager: ContextManager,
    truncateThreshold = 2000,
    resolveReferencedMessage?: (messageId: string) => Promise<BotMessage | null>,
    resolveGroupContext?: (message: BotMessage) => Promise<GroupContext | null>,
    resolveForwardMessage?: (forwardId: string) => Promise<string | null>
  ) {
    this.config = config;
    this.memory = memory;
    this.contextManager = contextManager;
    this.truncateThreshold = truncateThreshold;

    const openaiConfig: Record<string, unknown> = {
      modelName: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      modelKwargs: {} as Record<string, unknown>,
    };

    if (config.baseUrl) {
      openaiConfig.configuration = { baseURL: config.baseUrl };
    }

    if (config.apiKey) {
      openaiConfig.apiKey = config.apiKey;
    }

    if (config.reasoningEffort) {
      (openaiConfig.modelKwargs as Record<string, unknown>).reasoning_effort = config.reasoningEffort;
    }

    this.chatModel = new ChatOpenAI(openaiConfig);
    this.resolveReferencedMessage = resolveReferencedMessage;
    this.resolveGroupContext = resolveGroupContext;
    this.resolveForwardMessage = resolveForwardMessage;
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

  async evaluateMentionContext(botMessage: string, collectedMessages: BotMessage[]): Promise<string | null> {
    const messagesText = collectedMessages
      .map(m => `${m.userId ?? "unknown"}: ${m.text}`)
      .join("\n");

    const prompt =
      `你之前在一个群聊里 @过某个用户，你当时的发言是：\n${botMessage}\n\n` +
      `之后你收集到这些后续消息：\n${messagesText}\n\n` +
      `这些后续消息与你之前 @对方的发言有关联吗？如果有关联，请生成一个自然的回复（直接输出回复内容，不要解释，不要加引号）。如果完全无关，只输出 __NO_REPLY__。`;

    try {
      const response = await this.chatModel.invoke([new HumanMessage(prompt)]);
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
      const response = await this.chatModel.invoke([new HumanMessage(prompt)]);
      return typeof response.content === "string" ? response.content : String(response.content);
    } catch {
      return "";
    }
  }

  async chat(message: BotMessage, dynamicPromptAppends?: string[]): Promise<string> {
    const memories = await this.memory.getRelevantMemories(message);
    const sessionKey = this.getSessionKey(message);
    const contextOptions = await this.buildContextOptions(message, memories, dynamicPromptAppends);

    this.truncatedTexts.clear();

    const contextResult = await this.contextManager.buildContext(sessionKey, contextOptions);
    const promptMessages = this.chunksToLangChainMessages(contextResult.chunks);

    try {
      let content = await this.invokeWithTools(promptMessages, { mode: "single", message });
      content = content.replace(ASSISTANT_PREFIX, "");

      this.contextManager.appendAssistantResponse(sessionKey, content);
      this.memory.addMessage(message, content).catch(err =>
        console.error("[LLM] 存储记忆失败:", err)
      );

      return content;
    } catch (error) {
      console.error("[LLM] 调用失败:", error);
      return "抱歉，我暂时无法回复，请稍后再试。";
    }
  }

  async chatBatch(messages: BotMessage[], dynamicPromptAppends?: string[]): Promise<string> {
    if (messages.length === 0) return "";

    const primary = messages[messages.length - 1];
    const memories = await this.memory.getRelevantMemories(primary);
    const sessionKey = this.getSessionKey(primary);
    const contextOptions = await this.buildBatchContextOptions(messages, memories, dynamicPromptAppends);

    this.truncatedTexts.clear();

    const contextResult = await this.contextManager.buildContext(sessionKey, contextOptions);
    const promptMessages = this.chunksToLangChainMessages(contextResult.chunks);

    try {
      let content = await this.invokeWithTools(promptMessages, { mode: "batch", messages });
      content = content.replace(ASSISTANT_PREFIX, "");

      this.contextManager.appendAssistantResponse(sessionKey, content);
      this.memory.addBatch(messages, content).catch(err =>
        console.error("[LLM] 批量存储记忆失败:", err)
      );

      return content;
    } catch (error) {
      console.error("[LLM] Batch 调用失败:", error);
      return "抱歉，我暂时无法回复，请稍后再试。";
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
    const [referenceText, groupContext, forwardText] = await Promise.all([
      this.buildReferenceText(message),
      this.resolveGroupContext?.(message) ?? null,
      message.forwardId ? this.buildForwardText(message.forwardId) : Promise.resolve(""),
    ]);
    const displayText = this.maybeTruncate(message.text, "current");
    const parts = [
      referenceText ? `[该消息引用了：${referenceText}]` : "",
      displayText,
      forwardText ? `[该消息包含的合并转发内容：\n${forwardText}]` : "",
    ].filter(Boolean);
    const triggerText = parts.join("\n");

    return {
      triggerMessage: {
        userId: message.userId,
        text: triggerText,
        id: message.id,
        replyToMessageId: message.replyToMessageId,
        timestamp: Date.now(),
      },
      speakerMemories: message.userId
        ? [{ userId: message.userId, memories, memoryIds: memories.map((m) => `mem-${m.slice(0, 32)}`) }]
        : undefined,
      dynamicSystemAppends: dynamicPromptAppends,
      groupContext: groupContext ?? undefined,
    };
  }

  private async buildBatchContextOptions(
    messages: BotMessage[],
    memories: string[],
    dynamicPromptAppends?: string[]
  ): Promise<BuildContextOptions> {
    const trigger = messages[messages.length - 1];
    const surrounding: BuildContextOptions["surroundingMessages"] = [];

    for (let i = 0; i < messages.length - 1; i += 1) {
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
        timestamp: Date.now(),
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
        timestamp: Date.now(),
      },
      surroundingMessages: surrounding,
      speakerMemories: trigger.userId
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
    input: PromptBuildInput
  ): Promise<string> {
    const invokeOptions: ChatOpenAICallOptions | undefined = this.tools.length > 0
      ? { tools: this.tools }
      : undefined;

    const conversation = [...messages];

    for (let round = 0; round < 6; round += 1) {
      const response = await this.chatModel.invoke(conversation, invokeOptions);
      this.logUsage(response.usage_metadata);
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
