import type {
  GlobalStyle,
  RapportField,
  RapportProfile,
  SoftCore,
  SoftCoreField,
} from "./types.js";

/**
 * 渲染层：把结构化的画像数值翻译成 LLM 可读的自然语言。
 *
 * 两个职责：
 *   1. renderPersonaBlock  ─ 把软核心 + 全局风格渲染成一段 system 文本，
 *      启动时拼进 ContextManager.personaContent（immutable）。
 *   2. renderRapportBlock  ─ 把"在场用户"的 rapport 加权融合后，渲染成
 *      动态注入文本（按当前发言者计算，用户不在即不生效）。
 */

// ── 软核心字段 → 自然语言描述 ──────────────────────────────────────────────────

const SOFT_CORE_LABELS: Record<SoftCoreField, { low: string; mid: string; high: string }> = {
  warmth: { low: "偏冷淡", mid: "热心肠", high: "非常热心" },
  tsundere: { low: "直率坦诚", mid: "带一点点傲娇", high: "明显傲娇" },
  taciturnity: { low: "话多", mid: "话不多", high: "无口属性" },
  toxicity: { low: "温和", mid: "偶尔毒舌", high: "毒舌" },
  emotionality: { low: "情感内敛", mid: "情感适度外露", high: "情感外露" },
};

function describeSoftCoreField(field: SoftCoreField, v: number): string {
  const label = SOFT_CORE_LABELS[field];
  if (v < 0.33) return label.low;
  if (v < 0.66) return label.mid;
  return label.high;
}

/** 把软核心渲染成一句性格描述，拼在硬底线之后。 */
export function renderSoftCore(softCore: SoftCore): string {
  const parts: string[] = [];
  for (const field of Object.keys(softCore.values) as SoftCoreField[]) {
    parts.push(describeSoftCoreField(field, softCore.values[field]));
  }
  // 去重相邻重复词
  return parts.filter((p, i, arr) => p !== arr[i - 1]).join("、");
}

/** 全局风格画像渲染为完整的 [SYSTEM] 文本块。 */
export function renderGlobalStyle(style: GlobalStyle): string {
  const lines: string[] = [];
  lines.push("[你的语言风格规范]");
  lines.push(
    `正式度：${style.formality < 0.4 ? "偏口语，可用网络用语但不用过时梗" : style.formality < 0.7 ? "半口语半书面" : "偏正式"}。`
  );
  lines.push(
    `热情度：${style.warmth < 0.4 ? "克制" : style.warmth < 0.7 ? "适中" : "热情"}。`
  );
  const lenDesc = style.avgLength === "short" ? "短句为主，一般一两句话，很少超过三行" : style.avgLength === "medium" ? "中等长度" : "可以长一些";
  lines.push(`句长：${lenDesc}。`);
  if (style.fillerWords.length > 0) {
    lines.push(`习惯语气词：${style.fillerWords.map((w) => `「${w}」`).join("、")}。`);
  }
  if (style.signatures.length > 0) {
    lines.push(`口头习惯：${style.signatures.join("；")}。`);
  }
  lines.push("称呼用户用名字或「你」，不用「您」（除非对方明确要求）。");
  if (style.notes.trim()) {
    lines.push(`风格补充：${style.notes.trim()}`);
  }
  lines.push("以上语言风格规范在所有群聊和私聊中保持一致，是跨场景的人格连续性锚点。");
  return lines.join("\n");
}

// ── Rapport 加权融合 ──────────────────────────────────────────────────────────

/**
 * 相处调音的"在场用户"。
 * strength 来自 affinity（已归一化到 [0,1]），决定该用户的调音影响权重。
 */
export type PresentUser = {
  userId: string;
  /** affinity 归一化后的强度，[0,1]。 */
  strength: number;
  rapport?: RapportProfile;
};

const RAPPORT_FIELD_LABELS: Record<RapportField, string> = {
  warmth: "热络",
  playfulness: "活泼",
  verbosity: "话量",
  respectfulness: "客套",
};

/**
 * 加权融合在场用户的 rapport。
 *
 * 公式（去偏闸③：融合而非叠加）：
 *   blendedOffset[f] = Σᵢ (offsetᵢ[f] × strengthᵢ) / Σᵢ strengthᵢ
 *
 * 即多人在场时取加权平均，而非相加 → 两个话痨在群里 ≠ 超级话痨。
 * strength 越高（越熟）影响越大，符合"越熟越放得开"。
 */
export function blendRapports(users: PresentUser[]): Partial<Record<RapportField, number>> {
  const totalWeight = users.reduce((sum, u) => sum + Math.max(0, u.strength), 0);
  if (totalWeight === 0) return {};

  const fields: RapportField[] = ["warmth", "playfulness", "verbosity", "respectfulness"];
  const blended: Partial<Record<RapportField, number>> = {};

  for (const f of fields) {
    let acc = 0;
    let weightUsed = 0;
    for (const u of users) {
      const offset = u.rapport?.offsets[f];
      if (typeof offset !== "number") continue;
      const w = Math.max(0, u.strength);
      acc += offset * w;
      weightUsed += w;
    }
    if (weightUsed > 0) {
      blended[f] = acc / weightUsed;
    }
  }
  return blended;
}

/**
 * 把融合后的 rapport offset 渲染成动态注入文本。
 * offset 接近 0 时省略，避免冗余。
 */
export function renderRapportBlock(
  blended: Partial<Record<RapportField, number>>,
  notes: string[]
): string {
  const lines: string[] = [];
  const significant: string[] = [];
  const THRESHOLD = 0.05;

  for (const f of Object.keys(blended) as RapportField[]) {
    const v = blended[f];
    if (typeof v !== "number" || Math.abs(v) < THRESHOLD) continue;
    const label = RAPPORT_FIELD_LABELS[f];
    if (v > 0) {
      significant.push(`对在场的人稍微更${label}一点`);
    } else {
      significant.push(`对在场的人稍微收敛一点${label}`);
    }
  }

  if (significant.length === 0 && notes.every((n) => !n.trim())) {
    return ""; // 没有有效调音，不注入
  }

  lines.push("[与在场用户的相处方式]");
  if (significant.length > 0) {
    lines.push(significant.join("、") + "。这是针对当前在场用户的微调，不改变你的核心性格。");
  }
  for (const n of notes) {
    if (n.trim()) lines.push(n.trim());
  }
  return lines.join("\n");
}

/** 群画像渲染为动态注入文本。 */
export function renderGroupBlock(group: {
  vibe: string;
  myRole: string;
  topicHints: string[];
  notes: string;
}): string {
  const lines: string[] = [];
  lines.push("[当前群的相处氛围]");
  if (group.vibe) lines.push(`氛围：${group.vibe}。`);
  if (group.myRole) lines.push(`你在这里的角色：${group.myRole}。`);
  if (group.topicHints.length > 0) lines.push(`常见话题：${group.topicHints.join("、")}。`);
  if (group.notes) lines.push(group.notes);
  lines.push("以上是对当前群的适配，不改变你的核心性格和语言风格规范。");
  return lines.join("\n");
}
