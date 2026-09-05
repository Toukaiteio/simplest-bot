import assert from "node:assert/strict";
import type { BotMessage } from "../../types.js";
import { createDebouncePlugin } from "./debounce.js";

const plugin = createDebouncePlugin("$", 5, 10);
const received = new Promise<{ texts: string[]; triggerIndex: number }>((resolve) => {
  plugin.setHandler({
    shouldReplyCheck: async (message) => message.text.includes("@bot"),
    chatBatch: async (messages, triggerIndex) => {
      resolve({ texts: messages.map((message) => message.text), triggerIndex });
      return { text: "[ASSISTANT] 收到", delivered: false };
    },
    sendResponse: async () => {},
  });
});

const message = (text: string, time: number): BotMessage => ({
  type: "group", groupId: "group-1", userId: String(time), text, raw: { time },
});
await plugin.onMessage!(message("前因", 1), {} as never);
await plugin.onMessage!(message("@bot 你怎么看", 2), {} as never);
await plugin.onMessage!(message("补充背景", 3), {} as never);

const result = await received;
assert.deepEqual(result.texts, ["前因", "@bot 你怎么看", "补充背景"], "整个 burst 都应进入上下文");
assert.equal(result.triggerIndex, 1, "触发消息应单独标记，而不是强制取 burst 最后一条");
console.log("✅ debounce 保留完整 burst 并正确标记触发消息");

let releaseCurrentRun: () => void = () => {};
let resolveCurrentRunStarted: () => void = () => {};
const currentRunStarted = new Promise<void>((resolve) => {
  resolveCurrentRunStarted = resolve;
});
const pendingBatch = new Promise<string[]>((resolve) => {
  const pendingPlugin = createDebouncePlugin("$", 10, 10);
  let runCount = 0;
  pendingPlugin.setHandler({
    shouldReplyCheck: async () => true,
    chatBatch: async (messages) => {
      runCount += 1;
      if (runCount === 1) {
        resolveCurrentRunStarted();
        await new Promise<void>((resolve) => {
          releaseCurrentRun = resolve;
        });
      } else {
        resolve(messages.map((item) => item.text));
      }
      return { text: "", delivered: true };
    },
    sendResponse: async () => {},
  });

  void pendingPlugin.onMessage!(message("当前任务", 4), {} as never);
  void currentRunStarted.then(async () => {
    await pendingPlugin.onMessage!(message("排队消息一", 5), {} as never);
    await pendingPlugin.onMessage!(message("排队消息二", 6), {} as never);
    releaseCurrentRun();
  });
});

const pendingTexts = await pendingBatch;
assert.deepEqual(pendingTexts, ["排队消息一", "排队消息二"], "执行期间到达的多条消息应合并为一批 pending 输入");
console.log("✅ debounce 在 Agent 忙碌期间收集 pending 消息并在当前轮结束后立即合并插入");
