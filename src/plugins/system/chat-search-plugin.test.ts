import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageStore } from "../../message-store.js";
import type { BotMessage, BotConfig, MenuPlugin, PluginContext } from "../../types.js";
import { createChatSearchPlugin } from "./chat-search-plugin.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "simplest-bot-chat-search-"));
const store = new MessageStore(path.join(tempDir, "messages.db"));
const registeredCommands = new Map<string, (...args: any[]) => Promise<void>>();

const menu = {
  registerCommand(name: string, _description: string, handler: (...args: any[]) => Promise<void>) {
    registeredCommands.set(name, handler);
  },
} as unknown as MenuPlugin;

const config = {
  auth: { adminUserIds: ["admin"] },
} as BotConfig;

function message(
  userId: string,
  text: string,
  options: Partial<Pick<BotMessage, "type" | "groupId" | "id" | "selfId">> = {},
): BotMessage {
  return {
    type: options.type ?? "private",
    userId,
    groupId: options.groupId,
    id: options.id,
    selfId: options.selfId ?? "bot",
    text,
    raw: {},
  };
}

function resultText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

try {
  const groupOne = message("alice", "群一的记录", { type: "group", groupId: "g1", id: "g1-msg" });
  const groupTwo = message("alice", "群二的记录", { type: "group", groupId: "g2", id: "g2-msg" });
  const privateAlice = message("alice", "Alice 的私聊记录", { id: "private-alice" });
  const privateBob = message("bob", "Bob 的私聊记录", { id: "private-bob" });
  store.appendIncoming(groupOne);
  store.appendIncoming(groupTwo);
  store.appendIncoming(privateAlice);
  store.appendIncoming(privateBob);

  const plugin = createChatSearchPlugin(store, menu);
  plugin.onLoad?.({ config } as PluginContext);
  const tools = new Map(plugin.getToolRegistrations().map((tool) => {
    const definition = tool.definition as unknown as { function: { name: string } };
    return [definition.function.name, tool] as const;
  }));

  const groupInput = { mode: "single" as const, message: message("alice", "查一下", { type: "group", groupId: "g1" }) };
  const groupSearch = await tools.get("search_chat_keyword")!.execute({ keyword: "记录" }, groupInput);
  assert.match(resultText(groupSearch), /群一的记录/);
  assert.doesNotMatch(resultText(groupSearch), /群二的记录|Alice 的私聊记录|Bob 的私聊记录/);

  await assert.rejects(
    () => tools.get("search_group_messages")!.execute({ groupId: "g2" }, groupInput),
    /权限不足/,
  );

  const privateInput = { mode: "single" as const, message: message("alice", "查一下") };
  const privateSearch = await tools.get("search_chat_keyword")!.execute({ keyword: "记录" }, privateInput);
  assert.match(resultText(privateSearch), /Alice 的私聊记录/);
  assert.doesNotMatch(resultText(privateSearch), /Bob 的私聊记录|群一的记录|群二的记录/);

  await assert.rejects(
    () => tools.get("get_message_context")!.execute({ messageId: "g2-msg" }, groupInput),
    /权限不足/,
  );
} finally {
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("✅ chat-search-plugin scope tests passed");
