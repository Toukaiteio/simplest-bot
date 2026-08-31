import assert from "node:assert/strict";
import type { BotMessage } from "../../types.js";
import { createDebouncePlugin } from "./debounce.js";

const plugin = createDebouncePlugin("$", 5, 10);
const received = new Promise<{ texts: string[]; triggerIndex: number }>((resolve) => {
  plugin.setHandler({
    shouldReplyCheck: async (message) => message.text.includes("@bot"),
    chatBatch: async (messages, triggerIndex) => {
      resolve({ texts: messages.map((message) => message.text), triggerIndex });
      return "[ASSISTANT] 收到";
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
