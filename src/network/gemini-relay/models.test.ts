import assert from "node:assert/strict";
import { resolveModel, GEMINI_MODELS, DEFAULT_GEMINI_MODEL } from "./models.js";

// 与 python 版 resolve_model 语义 1:1
assert.equal(GEMINI_MODELS["gemini-3.7-flash"]?.mode, 1);
assert.equal(GEMINI_MODELS["gemini-3.7-flash"]?.think, 4);
assert.equal(GEMINI_MODELS["gemini-3.5-flash-thinking"]?.mode, 2);
assert.equal(GEMINI_MODELS["gemini-3.5-flash-thinking"]?.think, 0);

const enhanced = resolveModel("gemini-3.1-pro-enhanced");
assert.equal(enhanced.name, "gemini-3.1-pro-enhanced");
assert.equal(enhanced.modeId, 3);
assert.deepEqual(enhanced.extra, { 31: 2, 80: 3 });

const thinkOverride = resolveModel("gemini-3.6-flash@think=0");
assert.equal(thinkOverride.name, "gemini-3.6-flash");
assert.equal(thinkOverride.thinkMode, 0);

const invalidThink = resolveModel("gemini-3.6-flash@think=abc");
assert.equal(invalidThink.error, "Invalid think level: abc");

const unknown = resolveModel("gemini-unknowable-model");
assert.equal(unknown.name, DEFAULT_GEMINI_MODEL, "未知模型应静默回退默认");
assert.equal(unknown.modeId, GEMINI_MODELS[DEFAULT_GEMINI_MODEL]!.mode);

const customDefault = resolveModel("something-new", "gemini-3.7-flash");
assert.equal(customDefault.name, "gemini-3.7-flash");

console.log("✅ Gemini relay models 解析测试通过");
