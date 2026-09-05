import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  registerSentImageText,
  lookupSentImageText,
  clearSentImageTexts,
  initSentImageTexts,
} from "./sent-image-texts.js";

clearSentImageTexts();

// 登记后可查回原文
registerSentImageText("img-1", {
  text: "# 工作结果\n\n- 项目已构建",
  userId: "123456",
  groupId: "g-1",
  type: "group",
  relTarget: { type: "group", id: "g-1" },
});

const hit = lookupSentImageText("img-1");
assert.ok(hit, "已登记的图片消息 id 应能查到");
assert.equal(hit.text, "# 工作结果\n\n- 项目已构建", "应返回生成该图片的原文文本");
assert.equal(hit.userId, "123456");

// 未登记 → null
assert.equal(lookupSentImageText("missing"), null, "未登记的消息返回 null");
assert.equal(lookupSentImageText(""), null, "空 id 返回 null");

// 覆盖更新
registerSentImageText("img-1", { text: "新原文", type: "private", relTarget: { type: "private", id: "u-1" } });
assert.equal(lookupSentImageText("img-1")?.text, "新原文", "同 id 重新登记应覆盖");

// 数字 id（NapCat send_group_msg 返回数字 message_id）应与字符串 id 等价 —— 回归测试：
// 发送侧拿到数字 id、引用侧拿到字符串 id，不归一化会导致注册表永远查不回。
registerSentImageText(123456789, { text: "数字 id 原文", type: "group", relTarget: { type: "group", id: "g" } });
assert.equal(lookupSentImageText("123456789")?.text, "数字 id 原文", "数字 id 登记后应能以字符串查回");

// 持久化：落盘后模拟重启（清空内存重新加载）仍可查回 —— 覆盖“很久之前的图片被引用”场景。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sent-image-texts-"));
const dataFile = path.join(tmpDir, "registry.json");
initSentImageTexts(dataFile);
registerSentImageText("persist-1", {
  text: "跨重启原文",
  userId: "bot-self",
  type: "group",
  relTarget: { type: "group", id: "g-1" },
});
registerSentImageText(987654321, {
  text: "跨重启数字 id 原文",
  type: "group",
  relTarget: { type: "group", id: "g-1" },
});
await new Promise((resolve) => setTimeout(resolve, 500)); // 等待防抖落盘
clearSentImageTexts();
initSentImageTexts(dataFile);
assert.equal(lookupSentImageText("persist-1")?.text, "跨重启原文", "重启后应能查回已登记的图片原文");
assert.equal(lookupSentImageText("987654321")?.text, "跨重启数字 id 原文", "数字 id 持久化后应能以字符串查回");

// 容量封顶不崩（MAX_ENTRIES = 5000）
for (let i = 0; i < 5100; i += 1) {
  registerSentImageText(`bulk-${i}`, { text: `t${i}`, type: "group", relTarget: { type: "group", id: "g" } });
}
assert.ok(lookupSentImageText("bulk-5099"), "批量登记后最近一条仍可查");
assert.equal(lookupSentImageText("persist-1"), null, "最早登记的被容量淘汰");

console.log("✅ sent-image-texts 注册表（登记/查询/覆盖/数字 id 归一/持久化重载/封顶）测试通过");
