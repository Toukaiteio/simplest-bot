import type { PluginContext } from "../../../types.js";
import type { BotToolRegistration } from "../../../tooling.js";
import type { PromptBuildInput } from "../../../types.js";
import { getInputMessage } from "../../../security/access-control.js";

/**
 * Pure utility helpers shared across the MMORPG framework.
 * These functions have zero closure/state dependencies and can be safely imported anywhere.
 */

export function makeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: BotToolRegistration["execute"]
): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description,
        parameters,
      },
    },
    execute,
  };
}

export function ensureContext(ctx: PluginContext | null): PluginContext {
  if (!ctx) {
    throw new Error("插件上下文尚未初始化。");
  }
  return ctx;
}

export function resolveInputUserId(
  input: PromptBuildInput,
): string | undefined {
  return getInputMessage(input).userId;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 必须为非空字符串。`);
  }
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeOptionalUserId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const patterns = [/^\[AT:(\d+)]$/i, /^\[CQ:at,qq=(\d+)[^\]]*]$/i, /^@(\d+)$/, /^(\d+)$/];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return match[1];
  }
  return trimmed;
}

export function decodeTextToken(value: string): string {
  return value.replace(/_/g, " ").trim();
}

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function isFormation(value: string | undefined): value is "balanced" | "aggressive" | "guarded" {
  return value === "balanced" || value === "aggressive" || value === "guarded";
}

export function formatPercent(value: number): string {
  return String(Math.floor(value * 100));
}

export function getObjectiveKey(
  objective: { type: string; monsterId?: string; itemId?: string; npcId?: string; areaId?: string }
): string {
  if (objective.type === "kill") {
    return `kill:${objective.monsterId}`;
  }
  if (objective.type === "collect") {
    return `collect:${objective.itemId}`;
  }
  if (objective.type === "talk") {
    return `talk:${objective.npcId}`;
  }
  if (objective.type === "reach") {
    return `reach:${objective.areaId}`;
  }
  return `${objective.type}:unknown`;
}

export function getObjectiveTarget(
  objective: { type: string; count?: number }
): number {
  if (objective.type === "kill" || objective.type === "collect") {
    return objective.count ?? 1;
  }
  return 1;
}

export function formatValidationReport(report: {
  errors: string[];
  warnings: string[];
  stats: Record<string, number>;
}): string {
  const lines = [
    `校验错误：${report.errors.length}`,
    `校验警告：${report.warnings.length}`,
    ...Object.entries(report.stats).map(([key, value]) => `${key}: ${value}`),
  ];
  if (report.errors.length > 0) {
    lines.push("错误详情：");
    lines.push(...report.errors.slice(0, 10).map((error) => `- ${error}`));
  }
  if (report.warnings.length > 0) {
    lines.push("警告详情：");
    lines.push(...report.warnings.slice(0, 10).map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}
