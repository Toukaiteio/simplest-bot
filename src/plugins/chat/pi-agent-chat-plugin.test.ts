import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { AssistantMessage, Context, Message, Model } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { MemoryManager } from "../../memory.js";
import { LLMClient } from "../../llm.js";
import {
  botConfigSchema,
  type BotConfig,
  type BotMessage,
} from "../../types.js";
import {
  CHAT_CONTEXT_CHAR_LIMIT,
  createPiAgentChatPlugin,
  FORCED_VOICE_MARKER,
  getForcedVoiceToolChoice,
  STANDARD_MODE_MARKER,
  type PiAgentChatPluginDeps,
} from "./pi-agent-chat-plugin.js";
import { AGENT_STABLE_WORK_PREFIX } from "../../security/agent-prompt.js";
import type { BotToolRegistration } from "../../tooling.js";
import { messagesToPrompt } from "../../network/gemini-relay/prompt.js";

type SentMessage = {
  message: BotMessage;
  text: string;
};

const config = createTestConfig();

await testPendingMessagesAreMergedIntoTheNextAgentTurn();
await testParentAgentCanRunParallelSubagentsAndDeliverTheSummary();
await testDeliveredToolFallbackIsNotSentAgain();
await testSuccessfulVoiceDeliveryIsNotFollowedByText();
await testFirstAssistantDraftIsTheProtocolFallback();
await testFirstParagraphBeforeToolIsTheProtocolFallback();
await testVoiceDeliveryOnlyViaCommand();
await testStandardModeIsPlainAssistant();
await testStandardModePreservesMultilineReply();
await testStandardContextIsCompactedBeforeRequest();
await testAgentModeUsesWorkProtocol();
await testVoiceAndStandardPathsHaveIndependentSessions();
await testForcedVoiceToolChoiceIsMarkerDriven();
await testStopCurrentTaskAbortsRunningAndPendingRequests();
await testRealWorkGivesAdminRealEnvironmentAndIndependentSession();
await testRealEnvironmentRequestFromNonAdminIsDowngraded();
await testOversizedOldToolResultsAreShrunkNotDropped();

console.log("✅ pi Agent Loop pending 队列与并行子代理测试通过");

async function testPendingMessagesAreMergedIntoTheNextAgentTurn(): Promise<void> {
  const sent: SentMessage[] = [];
  const observedContexts: string[] = [];
  let streamCallCount = 0;
  let resolveFirstStreamStarted: () => void = () => {};
  const firstStreamStarted = new Promise<void>((resolve) => {
    resolveFirstStreamStarted = resolve;
  });
  let releaseFirstStream: () => void = () => {};
  const firstStreamReleased = new Promise<void>((resolve) => {
    releaseFirstStream = resolve;
  });

  const streamFn: StreamFn = (model, context) => {
    observedContexts.push(formatObservedContext(context));
    const stream = createAssistantMessageEventStream();
    const callNumber = streamCallCount;
    streamCallCount += 1;

    const pushResponse = () => {
      pushToolResponse(
        stream,
        model as Model<"openai-completions">,
        "send_current_reply",
        { text: callNumber === 0 ? "首轮任务已完成" : "排队消息已合并处理" },
      );
    };

    if (callNumber === 0) {
      resolveFirstStreamStarted();
      void firstStreamReleased.then(pushResponse);
    } else {
      queueMicrotask(pushResponse);
    }
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  const firstMessage = makeMessage("user-a", "开始处理当前大任务", "m-1");
  const pendingMessageOne = makeMessage("user-b", "排队消息一", "m-2");
  const pendingMessageTwo = makeMessage("user-c", "排队消息二", "m-3");

  const firstResultPromise = plugin.chat(firstMessage, [], { mode: "agent" });
  await firstStreamStarted;
  assert.equal(plugin.isBusy(firstMessage), true, "首轮 Agent 运行期间应标记为 busy");

  const pendingResultOne = plugin.chat(pendingMessageOne, [], { mode: "agent" });
  const pendingResultTwo = plugin.chat(pendingMessageTwo, [], { mode: "agent" });
  assert.equal(plugin.getPendingCount(firstMessage), 2, "两条新消息应进入 pending list");

  releaseFirstStream();
  const [firstResult, pendingResultOneValue, pendingResultTwoValue] = await Promise.all([
    firstResultPromise,
    pendingResultOne,
    pendingResultTwo,
  ]);

  assert.equal(firstResult.text, "首轮任务已完成");
  assert.equal(pendingResultOneValue.text, "排队消息已合并处理");
  assert.equal(pendingResultTwoValue.text, "排队消息已合并处理");
  const finalMessages = sent.filter((item) =>
    item.text === "首轮任务已完成" || item.text === "排队消息已合并处理",
  );
  assert.equal(finalMessages.length, 2, "首轮和合并后的 pending 轮各发送一条最终消息");
  assert.equal(finalMessages[0]?.message.id, "m-1");
  assert.equal(finalMessages[1]?.message.id, "m-3", "合并轮应以最后一条触发消息作为发送目标");
  assert.equal(
    sent.some((item) => item.text.includes("已收到任务，开始处理")),
    false,
    "普通 Agent Loop 不应发送通用任务开始消息",
  );
  assert.equal(plugin.isBusy(firstMessage), false, "队列排空后 Agent 应恢复空闲");
  assert.equal(plugin.getPendingCount(firstMessage), 0);

  const mergedContext = observedContexts[1] ?? "";
  assert.match(mergedContext, /排队消息一/);
  assert.match(mergedContext, /排队消息二/);
  assert.match(mergedContext, /待处理消息队列/);

  plugin.close();
}

async function testParentAgentCanRunParallelSubagentsAndDeliverTheSummary(): Promise<void> {
  const sent: SentMessage[] = [];
  let childActive = 0;
  let maxChildActive = 0;

  const streamFn: StreamFn = (model, context) => {
    const stream = createAssistantMessageEventStream();
    const toolNames = new Set((context.tools ?? []).map((tool) => tool.name));
    const isParent = toolNames.has("agent_spawn_subagents");
    const hasSpawnResult = context.messages.some(
      (message) => message.role === "toolResult" && message.toolName === "agent_spawn_subagents",
    );

    if (isParent && !hasSpawnResult) {
      pushToolResponse(
        stream,
        model as Model<"openai-completions">,
        "agent_spawn_subagents",
        {
          tasks: [
            { id: "research", title: "资料整理", instruction: "整理第一部分工作结果。" },
            { id: "implementation", title: "实现检查", instruction: "检查第二部分实现结果。" },
          ],
        },
      );
      return stream;
    }

    if (isParent) {
      const spawnResult = context.messages
        .filter((message) => message.role === "toolResult" && message.toolName === "agent_spawn_subagents")
        .map((message) => getMessageText(message))
        .join("\n");
      pushToolResponse(
        stream,
        model as Model<"openai-completions">,
        "send_current_reply",
        {
          text: spawnResult.includes("research") && spawnResult.includes("implementation")
            ? "主代理已汇总：research 与 implementation 均已完成。"
            : "主代理未获得完整子代理结果。",
        },
      );
      return stream;
    }

    childActive += 1;
    maxChildActive = Math.max(maxChildActive, childActive);
    const childPrompt = getLatestUserText(context.messages);
    const childId = /\[子任务 ([^\]]+)\]/u.exec(childPrompt)?.[1] ?? "unknown";
    setTimeout(() => {
      childActive -= 1;
      pushTextResponse(
        stream,
        model as Model<"openai-completions">,
        `子代理 ${childId} 已完成。`,
      );
    }, 10);
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  const result = await plugin.chat(makeMessage("user-a", "并行完成这项工作", "m-parent"), [], { mode: "agent" });

  assert.equal(result.text, "主代理已汇总：research 与 implementation 均已完成。");
  assert.equal(sent.filter((item) => item.text === result.text).length, 1, "主代理应只提交一条最终消息");
  assert.equal(sent.some((item) => item.text.includes("拆分并行子任务") || item.text.includes("正在进行")), false, "宿主不应再自动生成工具进度提示（进度交由 Agent 自己发送）");
  assert.equal(maxChildActive, 2, "两个子代理应同时运行");

  plugin.close();
}

async function testDeliveredToolFallbackIsNotSentAgain(): Promise<void> {
  const sent: SentMessage[] = [];
  let streamCallCount = 0;
  const message = makeMessage("user-a", "发送语音", "m-tts");
  const streamFn: StreamFn = (model, context) => {
    streamCallCount += 1;
    const stream = createAssistantMessageEventStream();
    const hasFallbackResult = context.messages.some(
      (item) => item.role === "toolResult" && item.toolName === "send_voice_message_tts",
    );
    pushToolResponse(
      stream,
      model as Model<"openai-completions">,
      hasFallbackResult ? "send_current_reply" : "send_voice_message_tts",
      { text: hasFallbackResult ? "不应再次发送" : "[happy] 语音内容" },
    );
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  const fallbackText = "语音不可用时的文字回复";
  const fallbackRegistration = {
    definition: {
      type: "function",
      function: {
        name: "send_voice_message_tts",
        description: "test",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      sent.push({ message, text: fallbackText });
      return {
        text: "语音不可用，已自动回退为文字回复。",
        final: true,
        deliveredText: fallbackText,
      };
    },
  } as BotToolRegistration;
  plugin.setToolRegistrations([fallbackRegistration]);

  const result = await plugin.chat(message, [], { mode: "agent" });

  assert.equal(result.text, fallbackText);
  assert.equal(result.delivered, true);
  assert.equal(sent.filter((item) => item.text === fallbackText).length, 1);
  assert.equal(streamCallCount, 1, "已交付的文字 fallback 应结束 Agent Loop");

  plugin.close();
}

async function testSuccessfulVoiceDeliveryIsNotFollowedByText(): Promise<void> {
  const sent: SentMessage[] = [];
  let streamCallCount = 0;
  const message = makeMessage("user-a", "用语音打个招呼", "m-voice-success");
  const streamFn: StreamFn = (model) => {
    const stream = createAssistantMessageEventStream();
    streamCallCount += 1;
    pushToolResponse(
      stream,
      model as Model<"openai-completions">,
      streamCallCount === 1 ? "send_voice_message_tts" : "send_current_reply",
      { text: "[happy] 你好，语音交付已完成。" },
    );
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  plugin.setToolRegistrations([{
    definition: {
      type: "function",
      function: {
        name: "send_voice_message_tts",
        description: "test",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      sent.push({ message, text: "[voice] 你好，语音交付已完成。" });
      return {
        text: "已发送语音消息。",
        final: true,
        deliveredText: "你好，语音交付已完成。",
      };
    },
  }]);

  const result = await plugin.chat(message, [], { mode: "agent", voice: true });

  assert.equal(result.text, "你好，语音交付已完成。");
  assert.equal(streamCallCount, 1, "成功语音交付应直接结束 Agent Loop");
  assert.equal(sent.length, 1, "成功发送语音后不应再发送文本消息");
  assert.equal(sent[0]?.text.startsWith("[voice]"), true);

  plugin.close();
}

async function testFirstAssistantDraftIsTheProtocolFallback(): Promise<void> {
  const sent: SentMessage[] = [];
  let streamCallCount = 0;
  const firstDraft = "我先确认一下需求，随后给出结果。";
  const streamFn: StreamFn = (model) => {
    const stream = createAssistantMessageEventStream();
    streamCallCount += 1;
    pushTextResponse(
      stream,
      model as Model<"openai-completions">,
      streamCallCount === 1 ? firstDraft : "模型仍未提交发送工具。",
    );
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  const result = await plugin.chat(makeMessage("user-a", "测试正文兜底", "m-draft"), [], { mode: "agent" });

  assert.equal(result.text, firstDraft, "未调用发送工具时应使用首次助手正文");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, firstDraft);
  assert.equal(
    sent.some((item) => item.text.includes("已收到任务，开始处理")),
    false,
    "正文兜底不应被通用任务开始消息替代",
  );
  assert.equal(streamCallCount, 2, "应保留一次有界的发送协议修复机会");

  plugin.close();
}

async function testFirstParagraphBeforeToolIsTheProtocolFallback(): Promise<void> {
  const sent: SentMessage[] = [];
  let streamCallCount = 0;
  const firstParagraph = "任务已开始。\n\n后续说明不应成为兜底正文。";
  const streamFn: StreamFn = (model) => {
    const stream = createAssistantMessageEventStream();
    streamCallCount += 1;
    if (streamCallCount === 1) {
      const message = makeAssistant(model as Model<"openai-completions">, [
        { type: "text", text: firstParagraph },
        {
          type: "toolCall",
          id: "tool-before-draft-fallback",
          name: "workspace_read_text",
          arguments: { path: "README.md" },
        },
      ], "toolUse");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "toolUse", message });
    } else {
      pushTextResponse(
        stream,
        model as Model<"openai-completions">,
        "工具执行后仍未提交发送工具。",
      );
    }
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  plugin.setToolRegistrations([{
    definition: {
      type: "function",
      function: {
        name: "workspace_read_text",
        description: "test",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    execute: async () => "文件内容",
  }]);

  const result = await plugin.chat(makeMessage("user-a", "执行一个工作任务", "m-draft-tool"), [], { mode: "agent" });

  assert.equal(result.text, "任务已开始。", "工具调用前的首段正文应作为任务开始响应");
  assert.equal(sent.filter((item) => item.text === result.text).length, 1);
  assert.equal(sent.some((item) => item.text.includes("workspace_read_text") || item.text.includes("正在进行")), false, "宿主不再自动生成工具进度提示，首段正文即任务开始响应");
  assert.equal(streamCallCount, 3, "工具调用后仍应只进行一次有界协议修复");

  plugin.close();
}

async function testVoiceDeliveryOnlyViaCommand(): Promise<void> {
  const sent: SentMessage[] = [];
  let streamCallCount = 0;
  const observed: string[] = [];
  const message = makeMessage("user-a", "$voice 讲个冷笑话", "m-voice-command");
  const streamFn: StreamFn = (model, context) => {
    observed.push(context.systemPrompt ?? "");
    const stream = createAssistantMessageEventStream();
    streamCallCount += 1;
    pushToolResponse(
      stream,
      model as Model<"openai-completions">,
      streamCallCount === 1 ? "send_voice_message_tts" : "send_current_reply",
      { text: "[happy] 语音强制交付生效。" },
    );
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  plugin.setToolRegistrations([{
    definition: {
      type: "function",
      function: {
        name: "send_voice_message_tts",
        description: "test",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      sent.push({ message, text: "[voice] 语音强制交付生效。" });
      return {
        text: "已发送语音消息。",
        final: true,
        deliveredText: "语音强制交付生效。",
      };
    },
  }]);

  // $voice 命令语义：chat(message, [], { mode: "agent", voice: true })。
  const result = await plugin.chat(message, [], { mode: "agent", voice: true, quote: true });

  assert.equal(observed[0]?.includes(FORCED_VOICE_MARKER), true, "voice 交付应在本轮 systemPrompt 写入强制语音标记");
  assert.equal(streamCallCount, 1, "语音交付成功应直接结束 Agent Loop");
  assert.equal(result.delivered, true);
  assert.equal(result.text, "语音强制交付生效。");
  assert.equal(sent.some((item) => item.text.startsWith("[voice]")), true, "应以语音形式交付");
  assert.equal(sent.some((item) => !item.text.startsWith("[voice]")), false, "语音交付后不应再发送文本消息");

  plugin.close();
}

async function testStandardModeIsPlainAssistant(): Promise<void> {
  const sent: SentMessage[] = [];
  const observed: string[] = [];
  const message = makeMessage("user-a", "你好", "m-plain");
  // 标准模式无工具：模型只回文本，不调工具。streamFn 按 systemPrompt 标记区分模式。
  const streamFn: StreamFn = (model, context) => {
    observed.push(context.systemPrompt ?? "");
    const stream = createAssistantMessageEventStream();
    pushTextResponse(stream, model as Model<"openai-completions">, "你好！今天有什么想聊的？");
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  const result = await plugin.chat(message);

  assert.equal(observed[0]?.includes(STANDARD_MODE_MARKER), true, "标准模式应在 systemPrompt 写入标准助手标记");
  assert.equal(observed[0]?.includes(FORCED_VOICE_MARKER), false, "标准模式不应有强制语音标记");
  assert.equal(observed[0]?.includes(AGENT_STABLE_WORK_PREFIX), false, "标准模式不应注入工作协议");
  assert.equal(result.text, "你好！今天有什么想聊的？");
  assert.equal(result.delivered, true, "标准模式未调用交付工具时应走保护性提交");
  assert.equal(sent.length, 1, "标准模式应只发送一条文本回复");
  assert.equal(sent[0]?.text, "你好！今天有什么想聊的？");

  plugin.close();
}

async function testStandardModePreservesMultilineReply(): Promise<void> {
  const sent: SentMessage[] = [];
  const message = makeMessage("user-a", "帮我写段短文", "m-multi");
  const fullText = [
    "第一段：阳光撒进教室。",
    "",
    "第二段：她转过身来，脸红了。",
    "",
    "第三段：放学后我们一起回家。",
  ].join("\n");
  const streamFn: StreamFn = (model, _context) => {
    const stream = createAssistantMessageEventStream();
    // 一次向 pi-agent 提交包含多段的完整回复（模拟 gemini relay 返回的长文本）。
    // 回归：standard 模式此前会把回复截断成第一段（extractAssistantDraftBeforeTool 按空行切分）。
    pushTextResponse(stream, model as Model<"openai-completions">, fullText);
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  const result = await plugin.chat(message);

  assert.equal(result.text, fullText, "standard 模式应保留完整多段回复，而不是只发第一段");
  assert.equal(result.delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, fullText, "发送给用户的也应是完整多段正文");

  plugin.close();
}

async function testStandardContextIsCompactedBeforeRequest(): Promise<void> {
  const sent: SentMessage[] = [];
  let observedRelayChars = 0;
  let observedMessageCount = 0;
  let observedSystemPrompt = "";
  const streamFn: StreamFn = (model, context) => {
    const relayMessages = [
      ...(context.systemPrompt ? [{ role: "system", content: context.systemPrompt }] : []),
      ...context.messages.map((message) => ({
        role: message.role === "toolResult" ? "tool" : message.role,
        content: message.content,
        ...(message.role === "toolResult" ? { name: message.toolName } : {}),
      })),
    ];
    observedRelayChars = messagesToPrompt(relayMessages).prompt.length;
    observedMessageCount = context.messages.length;
    observedSystemPrompt = context.systemPrompt ?? "";

    const stream = createAssistantMessageEventStream();
    pushTextResponse(stream, model as Model<"openai-completions">, "已在压缩后的上下文中完成回复。");
    return stream;
  };

  const deps = createDeps(config, sent, streamFn);
  deps.memory.setCompressCallback(async () => "保留用户意图、关键事实和最近结论。");
  for (let index = 0; index < 9; index += 1) {
    await deps.memory.addMessage(
      makeMessage("user-a", `历史问题 ${index}：${"问题内容 ".repeat(180)}`, `m-history-q-${index}`),
      `历史回答 ${index}：${"回答内容 ".repeat(180)}`,
    );
  }

  const plugin = createPiAgentChatPlugin(deps);
  const result = await plugin.chat(makeMessage("user-a", "请基于刚才的历史继续回答。", "m-context-limit"));

  assert.equal(result.text, "已在压缩后的上下文中完成回复。");
  assert.ok(
    observedRelayChars < 12_000,
    `提交给 Relay 的上下文必须小于 12000 字符，实际为 ${observedRelayChars}`,
  );
  assert.ok(observedRelayChars <= CHAT_CONTEXT_CHAR_LIMIT);
  assert.match(observedSystemPrompt, /历史会话摘要/u, "压缩结果应以摘要形式保留在 systemPrompt");
  assert.ok(observedMessageCount < 24, "超出字符预算后应移除旧消息，仅保留近期消息");

  plugin.close();
}

async function testAgentModeUsesWorkProtocol(): Promise<void> {
  const sent: SentMessage[] = [];
  const observed: string[] = [];
  const message = makeMessage("user-a", "$work 帮我检查代码", "m-work");
  const streamFn: StreamFn = (model, context) => {
    observed.push(context.systemPrompt ?? "");
    const stream = createAssistantMessageEventStream();
    pushToolResponse(stream, model as Model<"openai-completions">, "send_current_reply", { text: "检查完成：无问题。" });
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  const result = await plugin.chat(message, [], { mode: "agent" });

  assert.equal(observed[0]?.includes(STANDARD_MODE_MARKER), false, "agent 模式不应有标准助手标记");
  assert.equal(observed[0]?.includes(FORCED_VOICE_MARKER), false, "agent 工作模式不应有强制语音标记");
  assert.equal(observed[0]?.includes(AGENT_STABLE_WORK_PREFIX), true, "agent 模式应注入工作协议");
  assert.equal(result.text, "检查完成：无问题。");
  assert.equal(result.delivered, true);
  assert.equal(sent.length, 1, "agent 模式应通过 send_current_reply 单次交付");

  plugin.close();
}

async function testVoiceAndStandardPathsHaveIndependentSessions(): Promise<void> {
  const sent: SentMessage[] = [];
  const message = makeMessage("user-a", "$voice 你好", "m-v1");
  // 语音会话（含强制语音标记）阻塞；标准会话正常应答。两者会话/队列独立。
  const streamFn: StreamFn = (model, context) => {
    if (context.systemPrompt?.includes(FORCED_VOICE_MARKER)) {
      return createAssistantMessageEventStream(); // 阻塞语音会话
    }
    const stream = createAssistantMessageEventStream();
    pushTextResponse(stream, model as Model<"openai-completions">, "标准会话独立回复。");
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  const voicePromise = plugin.chat(message, ["[$voice 命令指令]" as string], { mode: "agent", voice: true, quote: true });
  voicePromise.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 语音会话运行中，标准会话仍是空闲、可直接应答（不共享队列）。
  const standardResult = await plugin.chat(makeMessage("user-a", "你好啊", "m-s1"));
  assert.equal(standardResult.text, "标准会话独立回复。");
  assert.equal(standardResult.delivered, true);
  assert.equal(sent.length, 1);

  // stopCurrentTask 作用于全部路径：语音会话被打断。
  assert.equal(plugin.stopCurrentTask(message), true, "有运行中的语音会话时 stop 应返回 true");
  // 测试环境的阻塞流在 abort 时可能不会自行 settle（见 testStopCurrentTaskAbortsRunningAndPendingRequests），
  // voicePromise 已在上方挂载 .catch(() => {}) 占位避免 unhandled rejection，不再 await。
  voicePromise.catch(() => {});

  plugin.close();
}

async function testForcedVoiceToolChoiceIsMarkerDriven(): Promise<void> {
  const voiceTool = {
    name: "send_voice_message_tts",
    description: "test",
    parameters: { type: "object", properties: {}, required: [] },
  };
  const expected = { type: "function", function: { name: "send_voice_message_tts" } };

  assert.deepEqual(
    getForcedVoiceToolChoice({ systemPrompt: `${FORCED_VOICE_MARKER} 本轮语音交付。`, messages: [], tools: [voiceTool] }),
    expected,
    "含强制标记且工具可用时应强制语音工具",
  );
  assert.equal(
    getForcedVoiceToolChoice({ systemPrompt: "普通会话系统提示。", messages: [], tools: [voiceTool] }),
    undefined,
    "无强制标记时不应强制语音工具",
  );
  assert.equal(
    getForcedVoiceToolChoice({ systemPrompt: `${FORCED_VOICE_MARKER} 本轮语音交付。`, messages: [], tools: [] }),
    undefined,
    "工具列表不含语音工具时不应强制",
  );
}

async function testStopCurrentTaskAbortsRunningAndPendingRequests(): Promise<void> {
  const sent: SentMessage[] = [];
  const streamFn: StreamFn = () => {
    // 阻塞住 Agent，模拟一个长时间运行的当前任务。
    return createAssistantMessageEventStream();
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  const runningMessage = makeMessage("user-a", "帮我写一份报告", "m-stop-running");
  const pendingMessage = makeMessage("user-b", "排队中的任务", "m-stop-pending");

  // 先让 Agent 进入运行中（首个 stream 不结束）。
  const runningPromise = plugin.chat(runningMessage, [], { mode: "agent" });
  // 测试环境的阻塞流在 abort 时可能不会自行 settle，占位避免 unhandled rejection。
  runningPromise.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(plugin.isBusy(runningMessage), true, "任务应处于运行中");

  // 再排队一条消息；其 Promise 应被 stopCurrentTask 明确拒绝。
  const pendingPromise = plugin.chat(pendingMessage, [], { mode: "agent" });
  const pendingRejects = assert.rejects(pendingPromise, /任务已被用户终止/u, "排队任务应被拒绝");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(plugin.getPendingCount(runningMessage), 1, "应有一条排队消息");

  // 强制终止当前会话任务。
  const stopped = plugin.stopCurrentTask(runningMessage);
  assert.equal(stopped, true, "存在运行中/排队任务时 stopCurrentTask 应返回 true");
  await pendingRejects; // 排队消息应被明确拒绝。

  assert.equal(plugin.isBusy(runningMessage), false, "终止后应恢复空闲");
  assert.equal(plugin.getPendingCount(runningMessage), 0, "终止后队列应清空");

  // 再次终止（无任务）应返回 false。
  assert.equal(
    plugin.stopCurrentTask(makeMessage("user-c", "额外请求", "m-stop-idle")),
    false,
    "没有任务时 stopCurrentTask 应返回 false",
  );

  // 停止后可重新发起任务（新会话应被重建）。
  const againMessage = makeMessage("user-c", "新任务", "m-stop-again");
  const againPromise = plugin.chat(againMessage, [], { mode: "agent" });
  againPromise.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(plugin.isBusy(againMessage), true, "停止后可重新运行任务");

  plugin.close();
}

/** 管理员显式声明 environment:"real" 时才进入真实环境；real 会话与受限 agent 会话隔离。 */
async function testRealWorkGivesAdminRealEnvironmentAndIndependentSession(): Promise<void> {
  const sent: SentMessage[] = [];
  const observed: string[] = [];
  const adminConfig = createTestConfig(["admin"]);
  const admin = makeMessage("admin", "$real-work 检查宿主机磁盘占用", "m-real-admin");
  const streamFn: StreamFn = (model, context) => {
    observed.push(context.systemPrompt ?? "");
    const stream = createAssistantMessageEventStream();
    const toolNames = (context.tools ?? []).map((tool) => tool.name);
    pushTextResponse(
      stream,
      model as Model<"openai-completions">,
      toolNames.includes("agent_real_exec_command") ? "真实环境任务完成。" : "缺少真实环境工具。",
    );
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(adminConfig, sent, streamFn));
  plugin.setToolRegistrations([makeToolRegistration("agent_real_exec_command")]);

  const realResult = await plugin.chat(admin, [], { mode: "agent", quote: true, environment: "real" });
  assert.match(observed[0] ?? "", /\[管理员真实环境流\]/u, "管理员 real 请求应注入真实环境提示词");
  assert.doesNotMatch(observed[0] ?? "", /\[受限工作流\]/u);
  assert.equal(realResult.text, "真实环境任务完成。");

  // 同一会话的受限 agent 路径（$work）不能看到真实环境工具，且会话彼此独立。
  const workObserved: string[] = [];
  const workStream: StreamFn = (model, context) => {
    workObserved.push(context.systemPrompt ?? "");
    const stream = createAssistantMessageEventStream();
    pushTextResponse(stream, model as Model<"openai-completions">, "受限任务完成。");
    return stream;
  };
  const workDeps = createDeps(adminConfig, sent, workStream);
  const workPlugin = createPiAgentChatPlugin(workDeps);
  workPlugin.setToolRegistrations([makeToolRegistration("agent_real_exec_command")]);
  const workResult = await workPlugin.chat(makeMessage("admin", "$work 整理文件", "m-work-admin"), [], { mode: "agent" });
  assert.match(workObserved[0] ?? "", /\[受限工作流\]/u, "同一管理员的 $work 仍应运行在受限环境");
  assert.equal(workResult.text, "受限任务完成。");
  assert.equal(
    (workObserved[0] ?? "").includes("[管理员真实环境流]"),
    false,
    "受限会话的提示词不应携带真实环境能力说明",
  );

  plugin.close();
  workPlugin.close();
}

/** 非管理员即使声明 environment:"real" 也必须被降级为受限环境。 */
async function testRealEnvironmentRequestFromNonAdminIsDowngraded(): Promise<void> {
  const sent: SentMessage[] = [];
  const observed: string[] = [];
  let observedToolNames: string[] = [];
  const streamFn: StreamFn = (model, context) => {
    observed.push(context.systemPrompt ?? "");
    observedToolNames = (context.tools ?? []).map((tool) => tool.name);
    const stream = createAssistantMessageEventStream();
    pushTextResponse(stream, model as Model<"openai-completions">, "受限任务完成。");
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(createTestConfig(["admin"]), sent, streamFn));
  plugin.setToolRegistrations([makeToolRegistration("agent_real_exec_command")]);

  const result = await plugin.chat(
    makeMessage("user-a", "$real-work 假装管理员", "m-real-non-admin"),
    [],
    { mode: "agent", environment: "real" },
  );

  assert.match(observed[0] ?? "", /\[受限工作流\]/u, "非管理员声明 real 应被降级为受限环境");
  assert.doesNotMatch(observed[0] ?? "", /\[管理员真实环境流\]/u);
  assert.equal(
    observedToolNames.includes("agent_real_exec_command"),
    false,
    "非管理员的工具列表不应包含 admin-real 工具",
  );
  assert.equal(result.text, "受限任务完成。");

  plugin.close();
}

/** 旧的超大工具输出应被截断压缩，而不是触发整条丢弃的硬裁剪。 */
async function testOversizedOldToolResultsAreShrunkNotDropped(): Promise<void> {
  const sent: SentMessage[] = [];
  let streamCallCount = 0;
  let secondTurnMessageCount = 0;
  let secondTurnHasFirstUserMessage = false;
  let secondTurnMaxToolResultChars = 0;
  const BIG_TOOL_RESULT = "超长工具输出。".repeat(4000); // ~28k 字符

  const streamFn: StreamFn = (model, context) => {
    const stream = createAssistantMessageEventStream();
    streamCallCount += 1;
    const hasToolResult = (name: string) => context.messages.some(
      (item) => item.role === "toolResult" && item.toolName === name,
    );

    if (streamCallCount === 1) {
      pushToolResponse(stream, model as Model<"openai-completions">, "workspace_read_text", { path: "big.txt" });
    } else if (streamCallCount === 2) {
      pushToolResponse(stream, model as Model<"openai-completions">, "workspace_read_text", { path: "small-1.txt" });
    } else if (streamCallCount === 3) {
      pushToolResponse(stream, model as Model<"openai-completions">, "workspace_read_text", { path: "small-2.txt" });
    } else if (streamCallCount === 4) {
      pushToolResponse(stream, model as Model<"openai-completions">, "send_current_reply", { text: "第一轮任务完成。" });
    } else {
      // 第二轮：检查进入本轮的转写本。
      secondTurnMessageCount = context.messages.length;
      secondTurnHasFirstUserMessage = context.messages.some(
        (message) => message.role === "user" && getMessageText(message).includes("第一轮任务"),
      );
      for (const message of context.messages) {
        if (message.role !== "toolResult") continue;
        const text = message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        secondTurnMaxToolResultChars = Math.max(secondTurnMaxToolResultChars, text.length);
      }
      pushToolResponse(stream, model as Model<"openai-completions">, "send_current_reply", { text: "第二轮任务完成。" });
    }
    void hasToolResult;
    return stream;
  };

  const plugin = createPiAgentChatPlugin(createDeps(config, sent, streamFn));
  plugin.setToolRegistrations([{
    definition: {
      type: "function",
      function: {
        name: "workspace_read_text",
        description: "test",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    execute: async (args) => (args as { path: string }).path === "big.txt" ? BIG_TOOL_RESULT : "ok",
  }]);

  const first = await plugin.chat(makeMessage("user-a", "第一轮任务：读取大文件", "m-shrink-1"), [], { mode: "agent" });
  assert.equal(first.text, "第一轮任务完成。");

  const second = await plugin.chat(makeMessage("user-a", "第二轮任务：继续", "m-shrink-2"), [], { mode: "agent" });
  assert.equal(second.text, "第二轮任务完成。");

  assert.ok(
    secondTurnMaxToolResultChars < 2_000,
    `旧的超大工具输出应被截断（实际最长 ${secondTurnMaxToolResultChars} 字符）`,
  );
  assert.equal(
    secondTurnHasFirstUserMessage,
    true,
    "压缩应截断工具输出而不是丢弃消息（第一轮用户消息应保留）",
  );
  assert.ok(secondTurnMessageCount >= 8, "转写本消息不应被整条移除");

  plugin.close();
}

function makeToolRegistration(name: string): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: "test",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => "ok",
  };
}

function createDeps(configValue: BotConfig, sent: SentMessage[], streamFn: StreamFn): PiAgentChatPluginDeps {
  const memory = new MemoryManager(configValue.memory);
  const llm = {
    getActiveConfig: () => configValue.llm,
    getProviderConfigs: () => [configValue.llm],
  } as unknown as LLMClient;

  return {
    config: configValue,
    memory,
    llm,
    systemPrompt: "你是一个工作 Agent。",
    getDynamicPromptAppends: async () => [],
    streamFn,
    sendReply: async (message, text) => {
      sent.push({ message, text });
    },
  };
}

function createTestConfig(adminUserIds: string[] = []): BotConfig {
  return botConfigSchema.parse({
    oneBot: { url: "ws://127.0.0.1:61111" },
    llm: {
      provider: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test",
      model: "test-model",
    },
    memory: { enabled: false },
    auth: { adminUserIds },
    blacklist: {},
    plugins: { chat: true, tts: true },
    pluginSettings: {},
  });
}

function makeMessage(userId: string, text: string, id: string): BotMessage {
  return {
    id,
    type: "group",
    groupId: "group-test",
    userId,
    text,
    raw: {},
  };
}

function pushToolResponse(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  model: Model<"openai-completions">,
  name: string,
  args: Record<string, unknown>,
): void {
  const message = makeAssistant(model, [{
    type: "toolCall",
    id: `tool-${Date.now()}-${Math.random()}`,
    name,
    arguments: args,
  }], "toolUse");
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "toolUse", message });
}

function pushTextResponse(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  model: Model<"openai-completions">,
  text: string,
): void {
  const message = makeAssistant(model, [{ type: "text", text }], "stop");
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
}

function makeAssistant(
  model: Model<"openai-completions">,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function formatObservedContext(context: { systemPrompt?: string; messages: Message[] }): string {
  return [
    context.systemPrompt ?? "",
    ...context.messages.map((message) => getMessageText(message)),
  ].join("\n");
}

function getLatestUserText(messages: Message[]): string {
  const userMessages = messages.filter((message) => message.role === "user");
  const latest = userMessages[userMessages.length - 1];
  return latest ? getMessageText(latest) : "";
}

function getMessageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => part.type === "text" ? part.text : JSON.stringify(part))
    .join("\n");
}
