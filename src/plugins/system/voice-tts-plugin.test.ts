import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  botConfigSchema,
  type BotConfig,
  type BotMessage,
  type PluginContext,
} from "../../types.js";
import {
  createVoiceTtsPlugin,
  FishAudioTtsProvider,
  prepareSpeechText,
  type TtsProvider,
  type TtsSynthesisRequest,
} from "./voice-tts-plugin.js";

await testFishAudioRequestFormat();
await testSpeechTextNormalization();
await testVoiceToolSendsAndCleansUpAudio();
await testVoiceToolFallsBackToText();

console.log("✅ Fish Audio TTS 请求格式、情绪标签与语音发送测试通过");

async function testSpeechTextNormalization(): Promise<void> {
  const maxChars = createTestConfig().pluginSettings.tts.maxTextChars;

  const delighted = prepareSpeechText("太好了！(≧▽≦)♡", maxChars);
  assert.equal(delighted.speechText, "[delighted] 太好了！");
  assert.equal(delighted.fallbackText, "太好了！");
  assert.equal(delighted.emotion, "delighted");

  const sad = prepareSpeechText("(╥﹏╥)", maxChars);
  assert.equal(sad.speechText, "[sad] 我有点难过。");
  assert.equal(sad.fallbackText, "我有点难过。");
  assert.equal(sad.emotion, "sad");

  const formatted = prepareSpeechText(
    "[happy] **你好呀** (´,,•ω•,,)♡ https://example.com",
    maxChars,
  );
  assert.equal(formatted.speechText, "[happy] 你好呀");
  assert.equal(formatted.fallbackText, "你好呀");
  assert.equal(formatted.emotion, "happy");

  const standalone = prepareSpeechText("T_T 任务失败了", maxChars);
  assert.equal(standalone.speechText, "[sad] 任务失败了");
  assert.equal(standalone.fallbackText, "任务失败了");
  assert.equal(standalone.emotion, "sad");

  // ～ 归一化（与 data/tts-ab 的 A/B 试听结论一致）：句中转逗号，句尾收束为终止标点。
  const tilde = prepareSpeechText(
    "原来如此！是林俊杰的歌呀，本女仆记住了呢～谢谢主人～",
    maxChars,
    "happy",
  );
  assert.equal(tilde.speechText, "[happy] 原来如此！是林俊杰的歌呀，本女仆记住了呢，谢谢主人！");
  assert.equal(tilde.fallbackText, "原来如此！是林俊杰的歌呀，本女仆记住了呢，谢谢主人！");

  const tildeTrailing = prepareSpeechText("晚安～", maxChars);
  assert.equal(tildeTrailing.speechText, "[happy] 晚安！");

  const tildeBeforePunct = prepareSpeechText("好～！好！", maxChars);
  assert.equal(tildeBeforePunct.speechText, "[excited] 好！好！");

  const tildeRange = prepareSpeechText("大概要等3~5分钟哦", maxChars);
  assert.equal(tildeRange.speechText, "[calm] 大概要等3到5分钟哦");

  const onomatopoeia = prepareSpeechText("咕…咕～嘎～ 噶！", maxChars);
  assert.equal(onomatopoeia.speechText, "[excited] 咕…咕，嘎，噶！");
  assert.equal(onomatopoeia.fallbackText, "咕…咕，嘎，噶！");
}

async function testFishAudioRequestFormat(): Promise<void> {
  const config = createTestConfig();
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;

  const provider = new FishAudioTtsProvider(
    config.pluginSettings.tts,
    async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    },
  );

  const audio = await provider.synthesize({
    text: "[happy] 任务已经完成。",
    model: "s2.1-pro-free",
    referenceId: config.pluginSettings.tts.referenceId,
    format: "mp3",
  });

  assert.deepEqual([...audio], [1, 2, 3]);
  assert.equal(requestedUrl, "https://api.fish.audio/v1/tts");
  const headers = new Headers(requestedInit?.headers);
  assert.equal(headers.get("authorization"), "Bearer test-fish-key");
  assert.equal(headers.get("model"), "s2.1-pro-free");
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    text: "[happy] 任务已经完成。",
    reference_id: config.pluginSettings.tts.referenceId,
    format: "mp3",
  });
}

async function testVoiceToolSendsAndCleansUpAudio(): Promise<void> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "simplest-bot-tts-test-"));
  const config = createTestConfig({ outputDir });
  const sent: { target: string; bytes: number[] }[] = [];
  const requests: TtsSynthesisRequest[] = [];
  const provider: TtsProvider = {
    synthesize: async (request) => {
      requests.push(request);
      return Uint8Array.from([0x49, 0x44, 0x33, 0x04]);
    },
  };

  try {
    const plugin = createVoiceTtsPlugin({ provider });
    const context = { config } as unknown as PluginContext;
    await plugin.onLoad?.(context);
    const tool = plugin.getToolRegistrations().find((candidate) => {
      const definition = candidate.definition as { function?: { name?: string } };
      return definition.function?.name === "send_voice_message_tts";
    });
    assert.ok(tool, "应注册 send_voice_message_tts 工具");

    const message = makeMessage();
    const sendContext = {
      ...context,
      sendVoice: async (target: { type: "group" | "private"; id: string }, filePath: string) => {
        sent.push({ target: `${target.type}:${target.id}`, bytes: [...await fs.readFile(filePath)] });
      },
    } as unknown as PluginContext;
    await plugin.onLoad?.(sendContext);

    const sourceText = "太好了！(≧▽≦)♡";
    const prepared = prepareSpeechText(sourceText, config.pluginSettings.tts.maxTextChars);
    const result = await tool.execute(
      { text: sourceText, emotion: "delighted" },
      { mode: "single", message, environment: "restricted" },
    );

    // execute 不阻塞：立即返回“已排队”。
    assert.deepEqual(result, {
      text: `语音已排队，将在后台合成并发送（${prepared.speechText.length} 字，s2.1-pro-free）。`,
      final: true,
      deliveredText: prepared.fallbackText,
    });
    // 等待后台异步合成/发送完成后再断言副作用。
    await Promise.all(plugin.inflight());
    assert.deepEqual(sent, [{ target: "group:group-test", bytes: [0x49, 0x44, 0x33, 0x04] }]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.text, prepared.speechText);
    assert.equal(requests[0]?.text, "[delighted] 太好了！");
    assert.deepEqual(await fs.readdir(outputDir), [], "发送后临时音频应被清理");
    assert.deepEqual(plugin.inflight(), [], "后台任务完成后应被清出 in-flight 列表");
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

async function testVoiceToolFallsBackToText(): Promise<void> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "simplest-bot-tts-fallback-test-"));
  const config = createTestConfig({ outputDir });
  const fallbackMessages: string[] = [];
  const provider: TtsProvider = {
    synthesize: async () => {
      throw new Error("simulated Fish Audio outage");
    },
  };

  try {
    const plugin = createVoiceTtsPlugin({ provider });
    const context = {
      config,
      replyText: async (_message: BotMessage, text: string) => {
        fallbackMessages.push(text);
      },
    } as unknown as PluginContext;
    await plugin.onLoad?.(context);
    const tool = plugin.getToolRegistrations()[0];
    const speechText = "[empathetic] 我会继续跟进这项工作。";
    const result = (await tool.execute(
      { text: speechText, emotion: "empathetic" },
      { mode: "single", message: makeMessage(), environment: "restricted" },
    )) as { final?: boolean; deliveredText?: string };

    assert.equal(result.final, true);
    assert.equal(result.deliveredText, "我会继续跟进这项工作。");
    await Promise.all(plugin.inflight());
    assert.deepEqual(fallbackMessages, ["我会继续跟进这项工作。"]);
    assert.deepEqual(plugin.inflight(), [], "后台任务完成后应被清出 in-flight 列表");
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

function createTestConfig(overrides: { outputDir?: string } = {}): BotConfig {
  return botConfigSchema.parse({
    oneBot: { url: "ws://127.0.0.1:61111" },
    llm: {
      provider: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test",
      model: "test-model",
    },
    memory: { enabled: false },
    auth: { adminUserIds: [] },
    blacklist: {},
    plugins: { chat: true, tts: true },
    pluginSettings: {
      tts: {
        apiKey: "test-fish-key",
        outputDir: overrides.outputDir ?? "data/tts-test",
      },
    },
  });
}

function makeMessage(): BotMessage {
  return {
    id: "message-test",
    type: "group",
    groupId: "group-test",
    userId: "user-test",
    text: "测试语音",
    raw: {},
  };
}
