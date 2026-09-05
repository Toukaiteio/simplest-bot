import fs from "node:fs";
import path from "node:path";
import { botConfigSchema, pluginsConfigSchema, type BotConfig } from "./types.js";

const CONFIG_CANDIDATES = [
  process.env.BOT_CONFIG,
  path.resolve(process.cwd(), "bot.config.json"),
  path.resolve(process.cwd(), "bot.config.example.json"),
].filter(Boolean) as string[];

export function loadConfig(): BotConfig {
  const configPath = CONFIG_CANDIDATES.find((p) => fs.existsSync(p));
  if (!configPath) {
    throw new Error("未找到配置文件。请创建 bot.config.json 或设置 BOT_CONFIG 环境变量。");
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  // Normalize missing plugin flags before Zod applies its defaults. If this
  // happens after parsing, `name in config.plugins` is always true and a new
  // plugin whose schema default is false can remain invisible in the user's
  // config file forever. The schema remains the single source of truth for
  // whether a newly introduced plugin is enabled by default.
  const normalizedInput = normalizeConfigInput(raw);
  const config = botConfigSchema.parse(normalizedInput);

  // The old search plugin used `default` to select an LLM proxy. That value
  // has no meaning for the real web-search providers, so migrate it to the
  // keyless DuckDuckGo provider instead of accidentally using a stale proxy.
  const searchProvider = config.pluginSettings.search.defaultProvider.trim().toLowerCase();
  if (!["tavily", "serper", "duckduckgo"].includes(searchProvider)) {
    config.pluginSettings.search.defaultProvider = "duckduckgo";
  }

  // 将补全后的配置回写磁盘，确保新增插件的默认配置项自动出现
  const normalized = JSON.stringify(config, null, 2);
  if (normalized !== JSON.stringify(raw, null, 2)) {
    fs.writeFileSync(configPath, normalized + "\n", "utf8");
    console.log("[Config] 配置文件已自动更新（新增默认配置项已写入）");
  }

  return config;
}

function normalizeConfigInput(raw: unknown): Record<string, unknown> {
  const input = isRecord(raw) ? { ...raw } : {};
  const plugins = isRecord(input.plugins) ? { ...input.plugins } : {};
  const pluginDefaults = pluginsConfigSchema.parse({});

  for (const [name, enabledByDefault] of Object.entries(pluginDefaults)) {
    if (!(name in plugins)) {
      plugins[name] = enabledByDefault;
    }
  }

  input.plugins = plugins;
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
