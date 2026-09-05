import type {
  BlacklistPlugin,
  BotMessage,
  GroupTriggerPlugin,
  MenuPlugin,
  Plugin,
  PluginContext,
} from "../../types.js";
import type { MemoryManager } from "../../memory.js";
import type { PluginManager } from "../../plugin.js";
import type { ContextManager } from "../../context/context-manager.js";

export function createSystemPlugin(
  memory: MemoryManager,
  pluginManager: PluginManager,
  blacklistPlugin: BlacklistPlugin,
  groupTriggerPlugin: GroupTriggerPlugin,
  menuPlugin: MenuPlugin,
  contextManager?: ContextManager,
  getChatAgentPlugin?: () => ({
    isBusy: (message: BotMessage) => boolean;
    stopCurrentTask: (message: BotMessage) => boolean;
  }) | null,
): Plugin {
  // ── 强制终止任务的投票状态（每个会话独立，60 秒窗口） ──
  const STOP_VOTE_WINDOW_MS = 60_000;
  const stopVotes = new Map<string, { voters: Set<string>; expiresAt: number }>();

  function conversationKey(message: BotMessage): string {
    return message.type === "private" ? `user:${message.userId}` : `group:${message.groupId}`;
  }

  function purgeStopVotes(key: string): void {
    stopVotes.delete(key);
  }

  function isAdmin(message: BotMessage, ctx: PluginContext): boolean {
    return Boolean(ctx.config.auth.adminUserIds.includes(message.userId || ""));
  }

  function doStop(message: BotMessage, ctx: PluginContext, key: string): void {
    purgeStopVotes(key);
    const agent = getChatAgentPlugin?.() ?? null;
    if (!agent) {
      void ctx.replyText(message, "聊天 Agent 未启用，无法终止任务。");
      return;
    }
    const stopped = agent.stopCurrentTask(message);
    void ctx.replyText(message, stopped ? "🛑 已强制终止当前任务。" : "当前没有正在执行的任务。");
  }

  return {
    name: "system",
    description: "系统管理命令与内置服务",

    onLoad(ctx: PluginContext) {
      menuPlugin.registerCommandGroup("system", "系统管理", "插件管理、黑名单、关键词过滤、任务终止");
      const prefix = menuPlugin.getPrefix();

      menuPlugin.registerCommand(
        "stop",
        "强制终止当前任务：管理员直接执行，普通用户需两人同意 [管理员/双人确认]",
        async (message: BotMessage) => {
          const key = conversationKey(message);
          const now = Date.now();

          // 管理员直接终止。
          if (isAdmin(message, ctx)) {
            doStop(message, ctx, key);
            return;
          }

          const userId = message.userId || "";
          if (!userId) {
            void ctx.replyText(message, "无法识别发送者，无法执行终止。");
            return;
          }

          // 普通用户：归票制，两个不同用户同意后终止。
          const existing = stopVotes.get(key);
          const voters = existing && existing.expiresAt > now
            ? existing.voters
            : new Set<string>();
          voters.add(userId);
          stopVotes.set(key, { voters, expiresAt: now + STOP_VOTE_WINDOW_MS });

          if (voters.size >= 2) {
            doStop(message, ctx, key);
            return;
          }

          const need = 2 - voters.size;
          void ctx.replyText(
            message,
            `🛑 收到终止任务请求（${voters.size}/2）。还需 ${need} 位不同用户发送 ${prefix}stop 同意，60 秒内有效。`,
          );
        },
      );

      menuPlugin.registerCommand("clear", "清除当前对话历史 [管理员]", async (message: BotMessage) => {
        memory.clearHistory(message);
        if (contextManager) {
          const key = message.type === "private" ? `user:${message.userId}` : `group:${message.groupId}`;
          contextManager.clearSession(key);
        }
        await ctx.replyText(message, "对话历史已清除。");
      }, { adminOnly: true });

      menuPlugin.registerCommand("compress", "手动触发上下文压缩 [管理员]", async (message: BotMessage) => {
        if (!contextManager) {
          await ctx.replyText(message, "上下文管理未启用。");
          return;
        }
        const key = message.type === "private" ? `private:${message.userId}` : `group:${message.groupId}`;
        const result = await contextManager.forceCompress(key);
        if (!result) {
          await ctx.replyText(message, "当前会话无上下文可压缩。");
          return;
        }
        if (!result.compressed) {
          await ctx.replyText(message, `当前上下文（实际 ${result.beforeTokens} tokens）已在预算内，无需压缩。`);
          return;
        }
        await ctx.replyText(message, `压缩完成：实际 ${result.beforeTokens} → 估算 ${result.afterTokens} tokens，丢弃 ${result.droppedCount} 个旧 chunks。`);
      }, { adminOnly: true });

      menuPlugin.registerCommand("plugins", "列出已加载的插件", async (message: BotMessage) => {
        const plugins = pluginManager.listPlugins();
        const text = "已加载的插件：\n" + plugins.map((plugin) => `- ${plugin.name}: ${plugin.description}`).join("\n");
        await ctx.replyText(message, text);
      });

      menuPlugin.registerCommand(
        "blacklist",
        `管理黑名单：${prefix}blacklist add/remove user/group <id>`,
        async (message: BotMessage, args: string[]) => {
          if (args.length < 3) {
            await ctx.replyText(message, `用法：${prefix}blacklist add/remove user/group <id>`);
            return;
          }

          const [action, type, id] = args;
          if (type !== "user" && type !== "group") {
            await ctx.replyText(message, "类型必须为 user 或 group");
            return;
          }

          if (action === "add") {
            if (type === "user") {
              blacklistPlugin.addUser(id);
            } else {
              blacklistPlugin.addGroup(id);
            }
            await ctx.replyText(message, `已将 ${type} ${id} 添加到黑名单`);
            return;
          }

          if (action === "remove") {
            if (type === "user") {
              blacklistPlugin.removeUser(id);
            } else {
              blacklistPlugin.removeGroup(id);
            }
            await ctx.replyText(message, `已将 ${type} ${id} 从黑名单移除`);
            return;
          }

          await ctx.replyText(message, "操作必须为 add 或 remove");
        },
        { adminOnly: true }
      );

      menuPlugin.registerCommand(
        "blacklist-list",
        "查看当前黑名单",
        async (message: BotMessage) => {
          const users = blacklistPlugin.getBlockedUsers();
          const groups = blacklistPlugin.getBlockedGroups();
          const text = [
            "当前黑名单：",
            `封禁用户：${users.length > 0 ? users.join(", ") : "无"}`,
            `封禁群组：${groups.length > 0 ? groups.join(", ") : "无"}`,
          ].join("\n");
          await ctx.replyText(message, text);
        },
        { adminOnly: true }
      );

      menuPlugin.registerCommand(
        "keyword",
        `管理群聊触发关键词：${prefix}keyword list|add|remove <word>`,
        async (message: BotMessage, args: string[]) => {
          const subCommand = args[0];
          if (subCommand === "list") {
            const keywords = groupTriggerPlugin.getKeywords(ctx);
            await ctx.replyText(message, `当前触发关键词：${keywords.length > 0 ? keywords.join(", ") : "无"}`);
            return;
          }

          if (subCommand === "add" && args[1]) {
            groupTriggerPlugin.addKeyword(args[1], ctx);
            await ctx.replyText(message, `已添加触发关键词：${args[1]}`);
            return;
          }

          if (subCommand === "remove" && args[1]) {
            groupTriggerPlugin.removeKeyword(args[1], ctx);
            await ctx.replyText(message, `已移除触发关键词：${args[1]}`);
            return;
          }

          await ctx.replyText(message, `用法：${prefix}keyword list | add <word> | remove <word>`);
        },
        { adminOnly: true }
      );
    },
  };
}
