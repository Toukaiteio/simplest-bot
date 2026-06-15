import type { BotMessage, GroupTriggerPlugin, PluginContext } from "../../types.js";

export function createGroupTriggerPlugin(): GroupTriggerPlugin {
  return {
    name: "group-trigger",
    description: "群聊触发插件 - 仅在被 @提及或命中关键词时允许 LLM 回复",

    onLoad: (ctx: PluginContext) => {
      const cfg = ctx.config.pluginSettings.groupTrigger;
      console.log(
        `[GroupTrigger] 已加载，提及触发=${cfg.requireMention}，关键词=${cfg.keywords.join(", ")}`
      );
    },

    onShouldReply: (message: BotMessage, ctx?: PluginContext): boolean => {
      if (!ctx) return true;

      const cfg = ctx.config.pluginSettings.groupTrigger;
      if (!cfg.enabled) return true;
      if (message.type === "private") return true;

      const text = message.text;

      if (message.selfId && text.includes(`@${message.selfId}`)) {
        return true;
      }

      if (!cfg.requireMention && cfg.keywords.length > 0) {
        const matched = cfg.keywords.some((kw) => text.includes(kw));
        if (matched) return true;
      }

      return false;
    },

    getKeywords: (ctx: PluginContext) => [...ctx.config.pluginSettings.groupTrigger.keywords],

    addKeyword: (keyword: string, ctx: PluginContext) => {
      const cfg = ctx.config.pluginSettings.groupTrigger;
      if (!cfg.keywords.includes(keyword)) {
        cfg.keywords.push(keyword);
        console.log(`[GroupTrigger] 已添加触发关键词: ${keyword}`);
      }
    },

    removeKeyword: (keyword: string, ctx: PluginContext) => {
      const cfg = ctx.config.pluginSettings.groupTrigger;
      cfg.keywords = cfg.keywords.filter((k) => k !== keyword);
      console.log(`[GroupTrigger] 已移除触发关键词: ${keyword}`);
    },
  };
}
