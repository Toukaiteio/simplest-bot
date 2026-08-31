import type { SgsCardData, SgsSkill } from "./schema.js";

const CARD_FACTIONS = new Set(["魏", "蜀", "吴", "群", "晋", "神"]);

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function clip(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, Math.max(0, maxLen - 1)).trimEnd() + "…";
}

function normalizeSkillName(value: unknown, fallback = "未名"): string {
  const text = cleanText(value, fallback);
  const hanChars = [...text].filter((char) => /[\u3400-\u9fff\uf900-\ufaff]/u.test(char));
  if (hanChars.length >= 2) return hanChars.slice(0, 2).join("");
  if (hanChars.length === 1) return `${hanChars[0]}技`;
  return fallback;
}

function extractJsonBlock(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  return trimmed;
}

function normalizeSkills(value: unknown): SgsSkill[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const raw = entry as Record<string, unknown>;
      const name = normalizeSkillName(raw.name);
      const desc = clip(cleanText(raw.desc, ""), 112);
      if (!desc) return null;
      const type = clip(cleanText(raw.type, "普通技"), 8);
      return { name, type, desc };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .slice(0, 4);
  return normalized;
}

export function parseCardData(rawText: string): SgsCardData {
  const jsonText = extractJsonBlock(rawText);
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;

  const skills = normalizeSkills(parsed.skills);
  if (skills.length === 0) {
    throw new Error("未生成有效技能。");
  }

  const hp = clampInt(parsed.hp, 1, 6, 4);
  const maxHp = Math.max(hp, clampInt(parsed.maxHp, hp, 6, hp));
  const armor = clampInt(parsed.armor, 0, 3, 0);
  const factionText = cleanText(parsed.faction, "神");
  const faction = (CARD_FACTIONS.has(factionText) ? factionText : "神") as SgsCardData["faction"];

  const designNotes = Array.isArray(parsed.designNotes)
    ? parsed.designNotes
        .map((item) => clip(cleanText(item), 40))
        .filter(Boolean)
        .slice(0, 3)
    : [];

  const backstory = clip(cleanText(parsed.backstory, "一位来自远方的神秘角色，其身世如同三国乱世中的迷雾，令人捉摸不透。"), 150);

  return {
    name: clip(cleanText(parsed.name, "无名"), 5),
    title: clip(cleanText(parsed.title, "异界来客"), 6),
    faction,
    hp,
    maxHp,
    armor,
    flavor: clip(cleanText(parsed.flavor, "风云入局"), 14),
    skills,
    backstory,
    designNotes,
  };
}
