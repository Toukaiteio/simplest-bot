import assert from "node:assert/strict";
import type { NotifyTarget, OneBotMessageSegment } from "./types.js";
import { ResponsePipeline } from "./response-pipeline.js";

const sent: OneBotMessageSegment[][] = [];
const mentions: string[] = [];
const contexts: Array<string | undefined> = [];
const target: NotifyTarget = { type: "group", id: "g1" };
const pipeline = new ResponsePipeline({
  splitResponse: async (text) => text.includes("[Split]") ? text.split("[Split]") : null,
  transformResponse: async (text, context) => {
    contexts.push(context?.groupId);
    const reply = text.match(/^\[REPLY:(\d+)\]/);
    const at = text.match(/\[AT:(\d+)\]/);
    const segments: OneBotMessageSegment[] = [];
    let remaining = text;
    if (reply) { segments.push({ type: "reply", data: { id: reply[1] } }); remaining = remaining.replace(reply[0], ""); }
    if (at) { segments.push({ type: "at", data: { qq: at[1] } }); remaining = remaining.replace(at[0], ""); }
    if (!segments.length) return null;
    if (remaining.trimStart()) segments.push({ type: "text", data: { text: remaining.trimStart() } });
    return segments;
  },
  parseTextSegments: (text) => [{ type: "text", data: { text } }],
  sendSegments: async (_target, segments) => { sent.push(segments); },
  onAtMention: (_target, userId) => { mentions.push(userId); },
  maxTextChars: 5,
});

await pipeline.send(target, "\n[ASSISTANT] 第一条[Split][REPLY:9] [ASSISTANT] [AT:8]123456", {
  context: { groupId: "g1" }, quoteMessageId: "original",
});

assert.equal(sent.length, 3, "第一段一条，第二段长文本应拆为两条物理消息");
assert.deepEqual(sent[0], [
  { type: "reply", data: { id: "original" } },
  { type: "text", data: { text: "第一条" } },
]);
assert.deepEqual(sent[1], [
  { type: "reply", data: { id: "9" } },
  { type: "at", data: { qq: "8" } },
  { type: "text", data: { text: "12345" } },
]);
assert.deepEqual(sent[2], [{ type: "text", data: { text: "6" } }]);
assert.deepEqual(mentions, ["8"], "AT 跟踪只执行一次");
assert.deepEqual(contexts, ["g1", "g1"], "每个逻辑分段都保留群上下文");
console.log("✅ ResponsePipeline 净化、拆分、路由、长文本和引用顺序正常");
