import type { PendingMenu, PlayerState } from "../schema.js";
import {
  renderMenuToImage,
  renderDetailMenuToImage,
  renderTextCardToImage,
} from "../menu-renderer.js";
import { rt } from "./runtime.js";
import { savePlayer } from "./player-access.js";

/**
 * 消息发送辅助：目标解析、菜单图片渲染、文本卡片回复、待定菜单持久化。
 * 这些函数依赖运行时容器中的 ctxRef 与渲染器。
 */

export type MessageLike = { type: string; groupId?: string; userId?: string };

export function resolveMessageTarget(message: MessageLike): { type: "group" | "private"; id: string } {
  return message.type === "group"
    ? { type: "group", id: message.groupId! }
    : { type: "private", id: message.userId! };
}

export async function sendMenuImage(message: MessageLike, menu: PendingMenu, caption?: string): Promise<void> {
  const target = resolveMessageTarget(message);
  const imagePath = await renderMenuToImage(menu, process.cwd());
  await rt.ctxRef!.sendImage(target, imagePath, caption);
}

export async function sendDetailMenuImage(
  message: MessageLike,
  opts: Parameters<typeof renderDetailMenuToImage>[0],
): Promise<void> {
  const target = resolveMessageTarget(message);
  const imagePath = await renderDetailMenuToImage(opts, process.cwd());
  await rt.ctxRef!.sendImage(target, imagePath);
}

/**
 * Render a text result as an image card.
 * Falls back to plain text reply if rendering fails.
 */
export async function replyCard(
  message: MessageLike,
  title: string,
  text: string,
): Promise<void> {
  try {
    const target = resolveMessageTarget(message);
    const lines = text.split("\n");
    const imagePath = await renderTextCardToImage(title, lines, process.cwd());
    await rt.ctxRef!.sendImage(target, imagePath);
  } catch {
    await rt.ctxRef!.replyText(message as never, text);
  }
}

export function setAndSavePendingMenu(player: PlayerState, menu: PendingMenu): void {
  player.pendingMenu = menu;
  savePlayer(player);
}
