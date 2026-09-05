import assert from "node:assert/strict";
import { createQuotedMessageResolver } from "./quoted-message.js";
import { registerSentImageText, clearSentImageTexts } from "./sent-image-texts.js";
import { registerVoiceMessageText } from "./plugins/system/voice-message-registry.js";
import type { BotMessage } from "./types.js";

clearSentImageTexts();

function makeMessage(text: string, replyToMessageId?: string): BotMessage {
  return {
    id: "m-new",
    type: "group",
    groupId: "g-1",
    userId: "u-100",
    text,
    replyToMessageId,
    raw: {},
  };
}

// 本地消息库 / get_msg / 图片文件下载的桩
const localMessages = new Map<string, BotMessage>();
const remoteMessages = new Map<string, BotMessage>();
const imageFiles = new Map<string, string>();
let getMsgCalls = 0;

const resolve = createQuotedMessageResolver({
  findMessageById: (id) => localMessages.get(id) ?? null,
  getMessage: async (id) => {
    getMsgCalls += 1;
    return remoteMessages.get(id) ?? localMessages.get(id) ?? null;
  },
  getImageFile: async (fileId) => imageFiles.get(fileId) ?? null,
  downloadFileToBase64: async (filePath) => `base64(${filePath})`,
});

// 1) bot 发送的图片消息（sent-image-texts 注册表命中）→ 还原为原文（完整不截断）
registerSentImageText("m-img", {
  text: "# 工作结果\n- 步骤一\n- 步骤二",
  userId: "10001",
  type: "group",
  relTarget: { type: "group", id: "g-1" },
});
const r1 = await resolve(makeMessage("你刚发的那张图写的什么？", "m-img"));
assert.ok(r1?.text.includes("图片消息的完整原文"), "应标注为 bot 图片消息完整原文");
assert.ok(r1?.text.includes("# 工作结果"), "应包含注册表中的原文");
assert.equal(r1?.image, undefined, "注册表命中时不需要识图兜底");

// 2) bot 发送的语音消息（voice 注册表命中）→ 还原为朗读文本
registerVoiceMessageText("m-voice", "今天天气不错，适合出门散步。");
const r2 = await resolve(makeMessage("语音里说了什么？", "m-voice"));
assert.ok(r2?.text.includes("语音消息的内容"), "应标注为 bot 语音消息内容");
assert.ok(r2?.text.includes("今天天气不错"), "应包含朗读文本");

// 3) 本地消息库命中（普通用户消息）→ 还原为 发送者: 文本
localMessages.set("m-user", {
  id: "m-user",
  type: "group",
  groupId: "g-1",
  userId: "u-200",
  text: "明天下午三点开会",
  raw: {},
});
const r3 = await resolve(makeMessage("引用查看", "m-user"));
assert.equal(r3?.text, "u-200: 明天下午三点开会");
assert.equal(r3?.textWithoutImage, "u-200: 明天下午三点开会");

// 4) 本地命中图片占位符 + 图片文件可下载 → 识图兜底（默认识图模式）
imageFiles.set("abc", "E:/fake/abc.png");
localMessages.set("m-user-img", {
  id: "m-user-img",
  type: "group",
  groupId: "g-1",
  userId: "u-200",
  text: "[图片 file=abc]",
  raw: {},
});
const r4 = await resolve(makeMessage("看图", "m-user-img"));
assert.ok(r4?.image, "图片可下载时应提供识图兜底");
assert.equal(r4?.image.data, "base64(E:/fake/abc.png)");
assert.equal(r4?.image.mimeType, "image/png");
assert.ok(r4?.text.includes("已作为图像附加"), "识图提示应说明图片已附加");
assert.ok(r4?.textWithoutImage.includes("已作为图像附加"), "textWithoutImage 也应包含识图提示");

// 4b) 本地文件不可读 + NapCat 响应带 QQ 服务器 url → url 多级下载兜底
const resolverWithUrl = createQuotedMessageResolver({
  findMessageById: (id) => localMessages.get(id) ?? null,
  getMessage: async (id) => remoteMessages.get(id) ?? localMessages.get(id) ?? null,
  getImageFile: async (fileId) => imageFiles.get(fileId) ?? null,
  downloadFileToBase64: async () => null, // 本地文件读不出（已被清理）
  getMediaFileUrl: async () => "https://multimedia.nt.qq.com.cn/download?fid=old-img",
  downloadUrlToBase64: async (url) => (url.includes("multimedia.nt") ? "url-base64" : null),
});
const r4b = await resolverWithUrl(makeMessage("看老图", "m-user-img"));
assert.ok(r4b?.image, "本地文件不可读时应有 url 下载兜底");
assert.equal(r4b.image.data, "url-base64", "应通过 QQ 服务器 url 下载图片");
assert.equal(r4b.image.mimeType, "image/png");
assert.ok(r4b.text.includes("已作为图像附加"), "url 兜底也应说明图片已附加");

// 5) 本地命中图片占位符但文件不可下载 → 诚实降级，明确要求模型不要编造
localMessages.set("m-user-img2", {
  id: "m-user-img2",
  type: "group",
  groupId: "g-1",
  userId: "u-200",
  text: "[图片 file=no-file]",
  raw: {},
});
const r5 = await resolve(makeMessage("看图", "m-user-img2"));
assert.equal(r5?.image, undefined, "下载失败时不应有图片");
assert.ok(r5?.text.includes("无法读取"), "应诚实说明无法读取");

// 6) 本地命中 bot 自己发的图片占位符（注册表未登记，如重启前的旧消息）
//    → 走识图兜底；文件不可下载时诚实降级
localMessages.set("m-bot-img", {
  id: "m-bot-img",
  type: "group",
  groupId: "g-1",
  selfId: "10001",
  userId: "10001",
  text: "[图片 file=bot-no-file]",
  raw: {},
});
const r6 = await resolve(makeMessage("引用我的图片", "m-bot-img"));
assert.equal(r6?.image, undefined);
assert.ok(r6?.text.includes("Bot"), "应识别为 bot 消息");
assert.ok(r6?.text.includes("不要编造"), "应要求模型不要编造");

// 7) 注册表与本地库都未命中 → get_msg 兜底
remoteMessages.set("m-remote", {
  id: "m-remote",
  type: "group",
  groupId: "g-1",
  userId: "u-300",
  text: "来自远端的消息",
  raw: {},
});
const r7 = await resolve(makeMessage("引用远端", "m-remote"));
assert.equal(getMsgCalls, 1, "本地未命中时应调用 get_msg 兜底");
assert.equal(r7?.text, "u-300: 来自远端的消息");

// 8) 完全未命中 → null（上层会注入"无法读取，不要编造"提示）
const r8 = await resolve(makeMessage("引用不存在", "m-missing"));
assert.equal(r8, null);

// 9) 无引用 → null
assert.equal(await resolve(makeMessage("普通消息")), null);

console.log("✅ quoted-message 引用还原器（图片原文/语音内容/本地库/识图兜底/占位符降级/get_msg 兜底）测试通过");
