import type {
  PluginContext,
  BotMessage,
  AuthConfig,
  CoreCommandHandler,
  CoreCommandPlugin,
  CoreCommandOptions,
} from "../../types.js";

export function createCoreCommandPlugin(authConfig: AuthConfig, prefix = "$"): CoreCommandPlugin {
  const commands = new Map<string, { handler: CoreCommandHandler; adminOnly: boolean }>();

  // ── Per-user command rate limiting (sliding window) ──
  const RATE_LIMIT_WINDOW_MS = 5_000;
  const RATE_LIMIT_MAX_COMMANDS = 6;
  const commandTimestamps = new Map<string, number[]>();

  function isRateLimited(userId: string): boolean {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    let timestamps = commandTimestamps.get(userId);
    if (!timestamps) {
      timestamps = [];
      commandTimestamps.set(userId, timestamps);
    }
    // Remove expired entries
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= RATE_LIMIT_MAX_COMMANDS) {
      return true;
    }
    timestamps.push(now);
    return false;
  }

  return {
    name: "core-command",
    description: `核心命令系统（前缀: ${prefix}）`,

    register(name: string, handler: CoreCommandHandler, options: CoreCommandOptions = {}) {
      commands.set(name.toLowerCase(), {
        handler,
        adminOnly: options.adminOnly === true,
      });
    },

    getPrefix() {
      return prefix;
    },

    async onMessage(message: BotMessage, ctx: PluginContext): Promise<boolean> {
      if (!message.text.startsWith(prefix)) return false;

      const parts = message.text.slice(prefix.length).split(/\s+/);
      const cmdName = parts[0].toLowerCase();
      const args = parts.slice(1);

      const command = commands.get(cmdName);
      if (!command) {
        return false;
      }

      if (command.adminOnly && !authConfig.adminUserIds.includes(message.userId || "")) {
        await ctx.replyText(message, "权限不足，仅管理员可执行此命令。");
        return true;
      }

      // Rate limit check (admins bypass)
      const userId = message.userId;
      if (userId && !authConfig.adminUserIds.includes(userId) && isRateLimited(userId)) {
        await ctx.replyText(message, `⏳ 操作过于频繁，请 ${RATE_LIMIT_WINDOW_MS / 1000} 秒内最多执行 ${RATE_LIMIT_MAX_COMMANDS} 条命令。`);
        return true;
      }

      try {
        await command.handler(message, args, ctx);
      } catch (error) {
        console.error(`[CoreCommand] ${cmdName} 执行失败:`, error);
        const errMsg = error instanceof Error ? error.message : String(error);
        await ctx.replyText(message, `❌ ${errMsg}`);
      }

      return true;
    },
  };
}
