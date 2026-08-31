import fs from "node:fs";
import path from "node:path";
import type { PersonaConfig } from "../types.js";
import type {
  GlobalStyle,
  GroupPersona,
  PersonaProfile,
  PersonaSnapshot,
  RapportField,
  RapportProfile,
  SoftCore,
  SoftCoreField,
} from "./types.js";
import { RAPPORT_FIELDS, SOFT_CORE_FIELDS } from "./types.js";

/**
 * 出厂基准：软核心字段的初始值。
 * 这里只定"程度"，性格本身的定性描述在 config.llm.systemPrompt（硬底线）。
 */
const DEFAULT_SOFT_CORE_VALUES: Record<SoftCoreField, number> = {
  warmth: 0.7, // 热心肠
  tsundere: 0.5, // 一点点傲娇
  taciturnity: 0.6, // 无口属性
  toxicity: 0.2, // 偶尔毒舌
  emotionality: 0.3, // 情感内敛
};

const DEFAULT_SOFT_CORE: SoftCore = {
  values: { ...DEFAULT_SOFT_CORE_VALUES },
  locked: {},
  pendingDirection: {},
  pendingStreak: {},
  cumulativeDrift: 0,
  version: 1,
};

const DEFAULT_GLOBAL_STYLE: GlobalStyle = {
  formality: 0.3, // 偏口语
  warmth: 0.6,
  avgLength: "short",
  fillerWords: ["嗯", "啦", "嘛", "...呢"],
  signatures: ["偶尔自称本女仆"],
  notes: "",
  version: 1,
};

const DEFAULT_PROFILE: PersonaProfile = {
  softCore: structuredClone(DEFAULT_SOFT_CORE),
  globalStyle: structuredClone(DEFAULT_GLOBAL_STYLE),
  rapports: {},
  groups: {},
  history: [],
};

/** 历史快照保留上限。 */
const MAX_HISTORY = 10;

export class PersonaStore {
  private profile: PersonaProfile;
  private filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  /** 完整的 persona 配置，用于去重、容量与老化参数。 */
  private config?: PersonaConfig;

  constructor(dataDir: string, config?: PersonaConfig) {
    const personaDir = path.resolve(dataDir, "persona");
    fs.mkdirSync(personaDir, { recursive: true });
    this.filePath = path.join(personaDir, "profile.json");
    this.config = config;
    this.profile = this.load();
  }

  private load(): PersonaProfile {
    try {
      if (!fs.existsSync(this.filePath)) {
        return structuredClone(DEFAULT_PROFILE);
      }
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<PersonaProfile>;
      return this.mergeWithDefaults(raw);
    } catch (error) {
      console.error("[Persona] 加载画像失败，使用默认值:", error);
      return structuredClone(DEFAULT_PROFILE);
    }
  }

  /** 用默认值兜底缺失字段，保证向前兼容旧画像文件。 */
  private mergeWithDefaults(raw: Partial<PersonaProfile>): PersonaProfile {
    const base = structuredClone(DEFAULT_PROFILE);
    if (raw.softCore) {
      base.softCore = {
        values: { ...base.softCore.values, ...raw.softCore.values },
        locked: { ...raw.softCore.locked },
        pendingDirection: { ...raw.softCore.pendingDirection },
        pendingStreak: { ...raw.softCore.pendingStreak },
        cumulativeDrift: raw.softCore.cumulativeDrift ?? 0,
        version: raw.softCore.version ?? 1,
      };
      // 校正非法字段值
      for (const f of SOFT_CORE_FIELDS) {
        const v = base.softCore.values[f];
        if (typeof v !== "number" || Number.isNaN(v)) {
          base.softCore.values[f] = DEFAULT_SOFT_CORE_VALUES[f];
        } else {
          base.softCore.values[f] = clamp01(v);
        }
      }
    }
    if (raw.globalStyle) {
      base.globalStyle = {
        ...base.globalStyle,
        ...raw.globalStyle,
        version: raw.globalStyle.version ?? 1,
      };
    }
    if (raw.rapports && typeof raw.rapports === "object") {
      base.rapports = raw.rapports;
    }
    if (raw.groups && typeof raw.groups === "object") {
      base.groups = raw.groups;
    }
    if (Array.isArray(raw.history)) {
      base.history = raw.history.slice(-MAX_HISTORY);
    }
    return base;
  }

  /** 节流落盘（合并 300ms 内的多次写）。 */
  private persistSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(this.profile, null, 2), "utf-8");
      } catch (error) {
        console.error("[Persona] 保存画像失败:", error);
      }
    }, 300);
  }

  // ── 读 ─────────────────────────────────────────────────────────────────────

  getProfile(): Readonly<PersonaProfile> {
    return this.profile;
  }

  getSoftCore(): SoftCore {
    return this.profile.softCore;
  }

  getGlobalStyle(): GlobalStyle {
    return this.profile.globalStyle;
  }

  getRapport(userId: string): RapportProfile | undefined {
    return this.profile.rapports[userId];
  }

  /** 返回所有有 rapport 的 userId（供引擎遍历）。 */
  getAllRapportUserIds(): string[] {
    return Object.keys(this.profile.rapports);
  }

  getGroupPersona(groupId: string): GroupPersona | undefined {
    return this.profile.groups[groupId];
  }

  // ── 写：软核心 ──────────────────────────────────────────────────────────────

  /**
   * 应用一次软核心微调。
   * 调用方已施加过四道约束，这里只负责夹紧 [0,1]、记账、版本++、落盘。
   * @returns 是否实际发生了变化。
   */
  applySoftCoreDelta(deltas: Partial<Record<SoftCoreField, number>>, maxAbsDelta: number): boolean {
    let changed = false;
    const values = this.profile.softCore.values;
    for (const field of SOFT_CORE_FIELDS) {
      if (this.profile.softCore.locked[field]) continue;
      const d = deltas[field];
      if (typeof d !== "number" || d === 0) continue;
      const clamped = clampAbs(d, maxAbsDelta);
      if (clamped === 0) continue;
      const prev = values[field];
      const next = clamp01(prev + clamped);
      if (next === prev) continue;
      values[field] = next;
      // 按实际变化量记账，避免边界钳制时虚增漂移预算
      this.profile.softCore.cumulativeDrift += Math.abs(next - prev);
      changed = true;
    }
    if (changed) {
      this.profile.softCore.version += 1;
      this.persistSoon();
    }
    return changed;
  }

  /** 更新累积确认状态机。返回更新后该字段的连续次数。 */
  updatePending(
    field: SoftCoreField,
    direction: "up" | "down" | "neutral"
  ): number {
    const prev = this.profile.softCore.pendingDirection[field];
    const streakMap = this.profile.softCore.pendingStreak;
    if (direction === "neutral") {
      this.profile.softCore.pendingDirection[field] = "neutral";
      streakMap[field] = 0;
      return 0;
    }
    if (prev === direction) {
      streakMap[field] = (streakMap[field] ?? 0) + 1;
    } else {
      this.profile.softCore.pendingDirection[field] = direction;
      streakMap[field] = 1;
    }
    return streakMap[field] ?? 0;
  }

  setSoftCoreLocked(field: SoftCoreField, locked: boolean): void {
    this.profile.softCore.locked[field] = locked;
    if (locked) {
      // 锁定时清空该字段的累积确认
      this.profile.softCore.pendingDirection[field] = "neutral";
      this.profile.softCore.pendingStreak[field] = 0;
    }
    this.persistSoon();
  }

  // ── 写：全局风格 ────────────────────────────────────────────────────────────

  /**
   * 应用一次全局风格微调。
   * 每个字段施加幅度上限（单字段最大 |Δ|）。notes 由 LLM 整段重写。
   */
  applyGlobalStyleChange(
    change: Partial<Omit<GlobalStyle, "version">>,
    maxAbsDelta: number
  ): boolean {
    const g = this.profile.globalStyle;
    let changed = false;

    if (typeof change.formality === "number") {
      const next = clamp01(g.formality + clampAbs(change.formality - g.formality, maxAbsDelta));
      if (next !== g.formality) { g.formality = next; changed = true; }
    }
    if (typeof change.warmth === "number") {
      const next = clamp01(g.warmth + clampAbs(change.warmth - g.warmth, maxAbsDelta));
      if (next !== g.warmth) { g.warmth = next; changed = true; }
    }
    if (change.avgLength === "short" || change.avgLength === "medium" || change.avgLength === "long") {
      if (g.avgLength !== change.avgLength) { g.avgLength = change.avgLength; changed = true; }
    }
    if (Array.isArray(change.fillerWords)) {
      g.fillerWords = dedupeWithNearMerge(
        change.fillerWords,
        this.config?.dedupeSimilarityThreshold ?? 0.85
      ).slice(0, 12);
      changed = true;
    }
    if (Array.isArray(change.signatures)) {
      g.signatures = dedupeWithNearMerge(
        change.signatures,
        this.config?.dedupeSimilarityThreshold ?? 0.85
      ).slice(0, 8);
      changed = true;
    }
    if (typeof change.notes === "string" && change.notes.trim().length > 0) {
      g.notes = change.notes.trim().slice(0, 500);
      changed = true;
    }

    if (changed) {
      g.version += 1;
      this.persistSoon();
    }
    return changed;
  }

  // ── 写：相处调音 ────────────────────────────────────────────────────────────

  /**
   * 应用一次 rapport 调整。
   * 每字段施加硬上限（去偏闸①：防止被任何用户带跑）。
   */
  applyRapportChange(
    userId: string,
    change: { offsets?: Partial<Record<RapportField, number>>; notes?: string }
  ): boolean {
    const existing: RapportProfile = this.profile.rapports[userId] ?? {
      offsets: {},
      notes: "",
      updatedAt: Date.now(),
    };
    const maxOffset = this.config?.rapportMaxAbsOffset ?? 0.15;
    let changed = false;
    if (change.offsets) {
      for (const [field, delta] of Object.entries(change.offsets)) {
        if (typeof delta !== "number" || delta === 0) continue;
        const f = field as RapportField;
        const cur = existing.offsets[f] ?? 0;
        const next = clamp(cur + delta, -maxOffset, maxOffset);
        if (next !== cur) { existing.offsets[f] = next; changed = true; }
      }
    }
    if (typeof change.notes === "string") {
      const trimmed = change.notes.trim().slice(0, 300);
      if (trimmed !== existing.notes) { existing.notes = trimmed; changed = true; }
    }
    if (changed || !this.profile.rapports[userId]) {
      existing.updatedAt = Date.now();
      this.profile.rapports[userId] = existing;
      this.pruneRapports();
      this.persistSoon();
    }
    return changed;
  }

  // ── 写：群画像 ──────────────────────────────────────────────────────────────

  applyGroupPersonaChange(
    groupId: string,
    change: Partial<Omit<GroupPersona, "groupId" | "updatedAt">>
  ): boolean {
    const existing: GroupPersona = this.profile.groups[groupId] ?? {
      groupId,
      vibe: "",
      myRole: "",
      topicHints: [],
      knownMembers: [],
      notes: "",
      updatedAt: Date.now(),
    };
    let changed = false;
    if (typeof change.vibe === "string" && change.vibe.trim()) { existing.vibe = change.vibe.trim().slice(0, 200); changed = true; }
    if (typeof change.myRole === "string" && change.myRole.trim()) { existing.myRole = change.myRole.trim().slice(0, 200); changed = true; }
    if (Array.isArray(change.topicHints)) {
      existing.topicHints = dedupeWithNearMerge(
        change.topicHints,
        this.config?.dedupeSimilarityThreshold ?? 0.85
      ).slice(0, 10);
      changed = true;
    }
    if (Array.isArray(change.knownMembers)) {
      // 群成员用精确去重即可，避免把不同人误判为同一人
      existing.knownMembers = dedupeStrings(change.knownMembers).slice(0, 20);
      changed = true;
    }
    if (typeof change.notes === "string" && change.notes.trim()) { existing.notes = change.notes.trim().slice(0, 500); changed = true; }

    if (changed) {
      existing.updatedAt = Date.now();
      this.profile.groups[groupId] = existing;
      this.pruneGroups();
      this.persistSoon();
    }
    return changed;
  }

  // ── 容量与老化 ──────────────────────────────────────────────────────────────

  /** 按 updatedAt 淘汰最旧的 rapport，控制画像文件大小。 */
  private pruneRapports(): void {
    const max = this.config?.maxRapports ?? 200;
    const entries = Object.entries(this.profile.rapports);
    if (entries.length <= max) return;
    entries.sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
    const removeCount = entries.length - max;
    for (let i = 0; i < removeCount; i++) {
      delete this.profile.rapports[entries[i][0]];
    }
    console.log(`[Persona] rapport 超过容量上限，已淘汰 ${removeCount} 个最旧项`);
  }

  /** 按 updatedAt 淘汰最旧的群画像。 */
  private pruneGroups(): void {
    const max = this.config?.maxGroups ?? 50;
    const entries = Object.entries(this.profile.groups);
    if (entries.length <= max) return;
    entries.sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
    const removeCount = entries.length - max;
    for (let i = 0; i < removeCount; i++) {
      delete this.profile.groups[entries[i][0]];
    }
    console.log(`[Persona] 群画像超过容量上限，已淘汰 ${removeCount} 个最旧项`);
  }

  /**
   * 老化衰减：长期未更新的 rapport 偏移向 0 收缩；长期未更新的群画像清空动态 hint。
   * 应在每次进化循环末尾调用一次。
   */
  decayRapportsAndGroups(now = Date.now()): void {
    const rapportStaleMs = (this.config?.rapportStaleDays ?? 90) * 24 * 60 * 60 * 1000;
    const groupStaleMs = (this.config?.groupStaleDays ?? 180) * 24 * 60 * 60 * 1000;
    if (rapportStaleMs <= 0 && groupStaleMs <= 0) return;

    let changed = false;

    if (rapportStaleMs > 0) {
      for (const rp of Object.values(this.profile.rapports)) {
        if (now - rp.updatedAt < rapportStaleMs) continue;
        let rapportChanged = false;
        for (const f of RAPPORT_FIELDS) {
          const cur = rp.offsets[f];
          if (typeof cur !== "number" || Math.abs(cur) <= 0.01) continue;
          const next = cur * 0.5; // 每过一个老化周期减半，向 0 收敛
          rp.offsets[f] = Math.abs(next) < 0.01 ? 0 : next;
          rapportChanged = true;
        }
        if (rapportChanged) {
          rp.updatedAt = now;
          changed = true;
        }
      }
    }

    if (groupStaleMs > 0) {
      for (const g of Object.values(this.profile.groups)) {
        if (now - g.updatedAt < groupStaleMs) continue;
        if (g.topicHints.length > 0 || g.knownMembers.length > 0) {
          g.topicHints = [];
          g.knownMembers = [];
          g.notes = g.notes ? `[群画像已老化] ${g.notes}` : "[群画像已老化]";
          g.updatedAt = now;
          changed = true;
        }
      }
    }

    if (changed) {
      this.persistSoon();
    }
  }

  // ── 版本管理：快照与回滚 ────────────────────────────────────────────────────

  /** 在写操作前调用，留存只读快照供 rollback。 */
  snapshotBeforeChange(): void {
    const snap: PersonaSnapshot = {
      version: this.profile.softCore.version,
      takenAt: Date.now(),
      softCore: structuredClone(this.profile.softCore),
      globalStyle: structuredClone(this.profile.globalStyle),
    };
    this.profile.history.push(snap);
    if (this.profile.history.length > MAX_HISTORY) {
      this.profile.history = this.profile.history.slice(-MAX_HISTORY);
    }
    this.persistSoon();
  }

  /** 回滚到上一个快照（软核心 + 全局风格）。rapport/群画像不动。 */
  rollback(): boolean {
    const last = this.profile.history.pop();
    if (!last) return false;
    this.profile.softCore = structuredClone(last.softCore);
    this.profile.globalStyle = structuredClone(last.globalStyle);
    this.persistSoon();
    return true;
  }

  getHistory(): PersonaSnapshot[] {
    return [...this.profile.history];
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function clampAbs(v: number, maxAbs: number): number {
  return clamp(v, -Math.abs(maxAbs), Math.abs(maxAbs));
}

function dedupeStrings(arr: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** 把字符串归一化，用于去重/近义比较（忽略大小写、空格、常见中文标点）。 */
function normalizeDedupeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\u3000，。？！、；：“”‘’（）【】\[\]"'()]+/g, "")
    .trim();
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/** 计算两个字符串的相似度（0-1）。包含关系直接视为 1。 */
function stringSimilarity(a: string, b: string): number {
  const na = normalizeDedupeKey(a);
  const nb = normalizeDedupeKey(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 1;
  const dist = levenshteinDistance(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return 1 - dist / maxLen;
}

/** 判断新字符串是否与已有列表中的任意一项“重复或近义”。 */
function isNearDuplicate(newStr: string, existingStrs: string[], threshold: number): boolean {
  const s = newStr.trim();
  if (!s) return true;
  for (const ex of existingStrs) {
    if (stringSimilarity(s, ex) >= threshold) return true;
  }
  return false;
}

/**
 * 对字符串数组做“防重复 + 防近义”去重。
 * 保留首次出现的项，后续与已保留项重复或近义的项会被丢弃。
 */
function dedupeWithNearMerge(arr: string[], threshold: number): string[] {
  const out: string[] = [];
  for (const raw of arr) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s) continue;
    if (isNearDuplicate(s, out, threshold)) continue;
    out.push(s);
  }
  return out;
}
