import fs from "node:fs";
import path from "node:path";
import type { PendingMenu } from "./schema.js";
import { buildMenuHtml, buildDetailMenuHtml, buildBattleLogHtml, buildProfileCardHtml, buildTextCardHtml } from "./menu-templates.js";
import { screenshotHtml } from "./screenshot.js";
import type { BattleResult } from "./battle-simulator.js";

/**
 * Render a PendingMenu to a WebP image and return the file path.
 * The image is written to a temporary location and can be sent via
 * the bot's image delivery system.
 */
export async function renderMenuToImage(
  menu: PendingMenu,
  baseDir: string,
): Promise<string> {
  const outputDir = path.resolve(baseDir, "mmorpg-menus");
  fs.mkdirSync(outputDir, { recursive: true });

  const fileName = `menu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
  const imagePath = path.join(outputDir, fileName);
  const html = buildMenuHtml(menu);

  await screenshotHtml(html, imagePath, { width: 360, format: "webp" });
  return imagePath;
}

/**
 * Render a detail card (area info, NPC dialog, etc.) with action options
 * to a WebP image.
 */
export async function renderDetailMenuToImage(
  opts: Parameters<typeof buildDetailMenuHtml>[0],
  baseDir: string,
): Promise<string> {
  const outputDir = path.resolve(baseDir, "mmorpg-menus");
  fs.mkdirSync(outputDir, { recursive: true });

  const fileName = `menu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
  const imagePath = path.join(outputDir, fileName);
  const html = buildDetailMenuHtml(opts);

  await screenshotHtml(html, imagePath, { width: 360, format: "webp" });
  return imagePath;
}

/**
 * Render a battle log to a WebP image (victory = green theme, defeat = red theme).
 */
export async function renderBattleLogToImage(
  result: BattleResult,
  baseDir: string,
): Promise<string> {
  const outputDir = path.resolve(baseDir, "mmorpg-menus");
  fs.mkdirSync(outputDir, { recursive: true });

  const fileName = `battle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
  const imagePath = path.join(outputDir, fileName);
  const html = buildBattleLogHtml(result);

  await screenshotHtml(html, imagePath, { width: 360, format: "webp" });
  return imagePath;
}

/**
 * Render a profile card (left-right layout with portrait) to a WebP image.
 */
export async function renderProfileCardToImage(
  opts: Parameters<typeof buildProfileCardHtml>[0],
  baseDir: string,
): Promise<string> {
  const outputDir = path.resolve(baseDir, "mmorpg-menus");
  fs.mkdirSync(outputDir, { recursive: true });

  const fileName = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
  const imagePath = path.join(outputDir, fileName);
  const html = buildProfileCardHtml(opts);

  await screenshotHtml(html, imagePath, { width: 360, format: "webp" });
  return imagePath;
}

/**
 * Render a generic text card (title + lines) to a WebP image.
 */
export async function renderTextCardToImage(
  title: string,
  lines: string[],
  baseDir: string,
): Promise<string> {
  const outputDir = path.resolve(baseDir, "mmorpg-menus");
  fs.mkdirSync(outputDir, { recursive: true });

  const fileName = `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
  const imagePath = path.join(outputDir, fileName);
  const html = buildTextCardHtml(title, lines);

  await screenshotHtml(html, imagePath, { width: 360, format: "webp" });
  return imagePath;
}
