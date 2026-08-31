import assert from "node:assert/strict";
import { sanitizeAssistantOutput } from "./response-sanitizer.js";

assert.equal(sanitizeAssistantOutput("\n\n[ASSISTANT] 你好"), "你好");
assert.equal(sanitizeAssistantOutput("ASSISTANT]\n你好"), "你好");
assert.equal(sanitizeAssistantOutput("[REPLY:123]\n\n[ASSISTANT]\n你好"), "[REPLY:123]你好");
assert.equal(sanitizeAssistantOutput("[AT:456] [ASSISTANT] 你好"), "[AT:456]你好");
assert.equal(sanitizeAssistantOutput("[REPLY:123]正常回复"), "[REPLY:123]正常回复");
console.log("✅ 回复前缀、路由标记与随机开头空行清理正常");
