import assert from "node:assert/strict";
import type {
  BotConfig,
  BotMessage,
  CoreCommandHandler,
  MenuPlugin,
  PluginContext,
} from "../../types.js";
import { createAgentEnvironmentPlugin } from "./agent-environment-plugin.js";

const commandHandlers = new Map<string, CoreCommandHandler>();
const menu = {
  registerCommandGroup() {},
  registerCommand(name: string, _description: string, handler: CoreCommandHandler) {
    commandHandlers.set(name, handler);
  },
  getPrefix: () => "$",
} as unknown as MenuPlugin;

const config = { auth: { adminUserIds: ["admin"] } } as BotConfig;
const ctx = { config, replyText: async () => {} } as unknown as PluginContext;
const plugin = createAgentEnvironmentPlugin(menu);
await plugin.onLoad!(ctx);

const adminPrivate = message("admin", "工作");
const ordinaryPrivate = message("ordinary", "工作");
const adminGroup = message("admin", "工作", { type: "group", groupId: "g1" });
const ordinaryGroup = message("ordinary", "工作", { type: "group", groupId: "g1" });
const command = commandHandlers.get("agent-real");
assert.ok(command);

assert.equal(plugin.getEnvironment(adminPrivate), "restricted");
assert.equal(plugin.getEnvironment(ordinaryPrivate), "restricted");
assert.equal(plugin.getSessionKey(adminPrivate), plugin.getSessionKey(ordinaryPrivate).replace("ordinary", "admin"));

await command(adminPrivate, ["enter"], ctx);
assert.equal(plugin.getEnvironment(adminPrivate), "real");
assert.equal(plugin.getEnvironment(ordinaryPrivate), "restricted");
assert.match(plugin.getSessionKey(adminPrivate), /agent-real:.*user:admin:generation:1/);
assert.equal(plugin.getEnvironment(adminGroup), "restricted", "真实模式按会话隔离");

await command(adminGroup, ["enter"], ctx);
assert.equal(plugin.getEnvironment(adminGroup), "real");
assert.equal(plugin.getEnvironment(ordinaryGroup), "restricted", "群成员不能继承管理员真实模式");
assert.notEqual(plugin.getSessionKey(adminPrivate), plugin.getSessionKey(adminGroup));

await command(adminPrivate, ["exit"], ctx);
assert.equal(plugin.getEnvironment(adminPrivate), "restricted");
await command(adminPrivate, ["enter"], ctx);
assert.match(plugin.getSessionKey(adminPrivate), /generation:3/);

function message(userId: string, text: string, extras: Partial<BotMessage> = {}): BotMessage {
  return { type: "private", userId, text, raw: {}, ...extras };
}

console.log("✅ Agent 环境模式按管理员、会话和会话代次隔离正常");
