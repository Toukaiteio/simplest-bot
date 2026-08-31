import fs from "node:fs";
import path from "node:path";
import { botConfigSchema, type BotConfig } from "./types.js";

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
  const config = botConfigSchema.parse(raw);

  // 自动补全已安装插件的启用状态（默认 true）
  const installedPlugins = ["blacklist", "groupTrigger", "reply", "atMention", "markdownImage", "fftImage", "split",
    "debounce", "webfetch", "dailyReport", "fileWorkspace", "adminAssist",
    "todo", "mmorpgFramework", "chatSearch", "music", "imgGen", "githubIssue", "farm", "uno", "sgsCard"];
  installedPlugins.forEach(name => {
    if (!(name in config.plugins)) {
      (config.plugins as Record<string, boolean>)[name] = true;
    }
  });

  // 将补全后的配置回写磁盘，确保新增插件的默认配置项自动出现
  const normalized = JSON.stringify(config, null, 2);
  if (normalized !== JSON.stringify(raw, null, 2)) {
    fs.writeFileSync(configPath, normalized + "\n", "utf8");
    console.log("[Config] 配置文件已自动更新（新增默认配置项已写入）");
  }

  return config;
}
