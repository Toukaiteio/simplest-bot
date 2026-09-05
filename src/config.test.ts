import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previousConfigPath = process.env.BOT_CONFIG;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "simplest-bot-config-"));
const configPath = path.join(tempDir, "bot.config.json");

fs.writeFileSync(configPath, JSON.stringify({
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
  plugins: { chat: true },
  pluginSettings: {},
}, null, 2) + "\n", "utf8");

try {
  process.env.BOT_CONFIG = configPath;
  const { loadConfig } = await import("./config.js");
  const config = loadConfig();

  assert.equal(config.plugins.chat, true, "用户显式设置应保持不变");
  assert.equal(config.plugins.codingTools, false, "默认关闭的新插件也应显式写入配置");
  assert.equal(config.plugins.todo, true, "默认开启的新插件应显式写入配置");
  assert.equal(config.pluginSettings.markdownImage.longTextThreshold, 450);
  assert.equal(config.proxy.mode, "system");
  assert.equal(config.proxy.url, "http://127.0.0.1:55268");
  assert.equal("autoUseVoice" in config.pluginSettings.tts, false, "语音自动触发配置已从 TTS 剥离");
  assert.equal("autoMaxChars" in config.pluginSettings.tts, false, "语音自动触发配置已从 TTS 剥离");

  const persisted = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    plugins?: Record<string, unknown>;
    pluginSettings?: { markdownImage?: Record<string, unknown> };
    proxy?: { mode?: string; url?: string };
  };
  assert.equal(persisted.plugins?.codingTools, false);
  assert.equal(persisted.plugins?.todo, true);
  assert.equal(persisted.pluginSettings?.markdownImage?.longTextThreshold, 450);
  assert.equal(persisted.proxy?.mode, "system");
  assert.equal(persisted.proxy?.url, "http://127.0.0.1:55268");

  console.log("✅ 缺失插件开关与插件配置默认值会被统一写入配置");
} finally {
  if (previousConfigPath === undefined) delete process.env.BOT_CONFIG;
  else process.env.BOT_CONFIG = previousConfigPath;
  fs.rmSync(tempDir, { recursive: true, force: true });
}
