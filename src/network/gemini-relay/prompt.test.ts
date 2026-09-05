import assert from "node:assert/strict";
import { messagesToPrompt, googleContentsToPrompt } from "./prompt.js";

// OpenAI 消息角色展平（与 python tools.py 纯文本部分一致）
const { prompt } = messagesToPrompt([
  { role: "system", content: "你是助手。" },
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好！" },
  { role: "tool", name: "search", content: "没有结果" },
  { role: "user", content: "" },
]);
assert.equal(
  prompt,
  [
    "[System instruction]: 你是助手。",
    "你好",
    "[Assistant]: 你好！",
    "[Tool result for search]: 没有结果",
  ].join("\n\n"),
);

// 图片 part → [Image attached] 占位 + images 收集（上传由服务端完成）
const withImage = messagesToPrompt([
  {
    role: "user",
    content: [
      { type: "text", text: "看看这张图" },
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ],
  },
]);
assert.equal(withImage.prompt, "看看这张图 [Image attached]");
assert.deepEqual(withImage.images, [{ url: "https://example.com/a.png" }], "图片 URL 被收集供上传");

// 带 mime 的 image_url / data URL → dataUrl
const withMime = messagesToPrompt([
  {
    role: "user",
    content: [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA", mime_type: "image/jpeg" } },
    ],
  },
]);
assert.deepEqual(withMime.images, [{ dataUrl: "data:image/jpeg;base64,AAAA", mime: "image/jpeg" }]);

// generateContent 展平（新结构：{ prompt, images }）
const googlePrompt = googleContentsToPrompt(
  { parts: [{ text: "系统说明" }] },
  [
    { role: "user", parts: [{ text: "问题" }] },
    { role: "model", parts: [{ text: "答案" }] },
    { role: "user", parts: [{ inlineData: { data: "base64", mimeType: "image/png" } }] },
    {
      role: "model",
      parts: [{ functionCall: { name: "f", args: { a: 1 } } }],
    },
  ],
);
assert.ok(googlePrompt.prompt.includes("系统说明"));
assert.ok(googlePrompt.prompt.includes("[Assistant]: 答案"));
assert.ok(googlePrompt.prompt.includes("[Image attached]"));
assert.ok(googlePrompt.prompt.includes('{"name":"f","args":{"a":1}}'));
assert.deepEqual(googlePrompt.images, [{ data: "base64", mime: "image/png" }]);

console.log("✅ Gemini relay prompt 展平测试通过");