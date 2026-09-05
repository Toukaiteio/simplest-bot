import assert from "node:assert/strict";
import { MemoryManager } from "./memory.js";
import { botConfigSchema, type BotMessage } from "./types.js";

const config = botConfigSchema.parse({
  oneBot: { url: "ws://127.0.0.1:61111" },
  llm: {
    provider: "custom",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "test",
    model: "test-model",
  },
  memory: { enabled: false, maxHistoryLength: 10 },
  auth: { adminUserIds: [] },
  blacklist: {},
  plugins: { chat: true },
  pluginSettings: {},
});

function makeMessage(text: string): BotMessage {
  return {
    id: `m-${Date.now()}-${Math.random()}`,
    type: "group",
    groupId: "group-test",
    userId: "user-a",
    text,
    raw: {},
  };
}

const memory = new MemoryManager(config.memory);
await memory.init();

// 三条路径历史分键：standard 无后缀（兼容存档），voice/agent 带后缀。
await memory.addMessage(makeMessage("普通问题"), "普通回答", undefined);
await memory.addMessage(makeMessage("语音问题"), "语音回答", "voice");
await memory.addMessage(makeMessage("工作问题"), "工作回答", "agent");

const standardHistory = memory.getConversationHistory(makeMessage("x"), undefined);
assert.equal(standardHistory.some((m) => m.content === "普通回答"), true, "standard 应含自己的历史");
assert.equal(standardHistory.some((m) => m.content === "语音回答"), false, "standard 历史不应混入 voice");
assert.equal(standardHistory.some((m) => m.content === "工作回答"), false, "standard 历史不应混入 agent");

const voiceHistory = memory.getConversationHistory(makeMessage("x"), "voice");
assert.equal(voiceHistory.some((m) => m.content === "语音回答"), true, "voice 应含自己的历史");
assert.equal(voiceHistory.some((m) => m.content === "普通回答"), false, "voice 历史不应混入 standard");

const agentHistory = memory.getConversationHistory(makeMessage("x"), "agent");
assert.equal(agentHistory.some((m) => m.content === "工作回答"), true, "agent 应含自己的历史");
assert.equal(agentHistory.some((m) => m.content === "普通回答"), false, "agent 历史不应混入 standard");

// clearHistory 只清对应路径
memory.clearHistory(makeMessage("x"), "voice");
assert.equal(memory.getConversationHistory(makeMessage("x"), "voice").length, 0, "voice 历史应被清空");
assert.equal(
  memory.getConversationHistory(makeMessage("x"), undefined).some((m) => m.content === "普通回答"),
  true,
  "标准路径历史不应受 voice 清理影响",
);

console.log("✅ Memory 三路径历史分键测试通过");
