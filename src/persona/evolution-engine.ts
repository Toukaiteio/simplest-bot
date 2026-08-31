import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI, type ChatOpenAICallOptions } from "@langchain/openai";
import type { PersonaConfig, LLMConfig } from "../types.js";
import type { MessageStore } from "../message-store.js";
import type { SocialPlugin } from "../types.js";
import { PersonaStore } from "./profile-store.js";
import type {
  EvaluationMaterial,
  PersonaEvaluation,
  SoftCoreField,
} from "./types.js";
import { SOFT_CORE_FIELDS } from "./types.js";

/**
 * 进化引擎：后台定时运行，驱动软核心 / 全局风格 / rapport / 群画像 的进化。
 *
 * 安全模型（四道约束 + 三道去偏闸）：
 *   软核心：频率低（softCoreIntervalHours）× 单次幅度小（softCoreMaxAbsDelta）
 *           × 累积确认（requiredConsecutive）× 漂移预算（driftBudget）
 *   全局风格：单字段幅度限制（globalStyleMaxAbsDelta）
 *   rapport：单字段偏移硬上限（rapportMaxAbsOffset，去偏闸①）
 *   软核心进化：单用户贡献 cap（singleUserInfluenceCap，去偏闸②）
 *   rapport 融合：加权平均而非叠加（render.blendRapports，去偏闸③）
 */
export class EvolutionEngine {
  private store: PersonaStore;
  private messageStore: MessageStore;
  private social?: SocialPlugin;
  private config: PersonaConfig;
  private llmConfig: LLMConfig;
  private evalModel: ChatOpenAI;

  /** 软核心上次评估时间（ms）。全局风格用 evolutionIntervalHours。 */
  private lastSoftCoreEvalAt = 0;
  private lastGlobalStyleEvalAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** 上次进化评估时间（用于 runCycleIfDue 限频） */
  private lastRunTime = 0;

  /** 单用户对软核心的贡献记账：每个评估周期重置（当前未启用更细粒度归因，保留扩展）。 */
  private userContributionThisCycle = new Map<string, number>();

  /** 软核心/全局风格变化后触发的回调（用于刷新 ContextManager 的 immutable 层）。 */
  private onPersonaChanged?: () => void;

  /** maxAffinity，用于把 affinity 归一化为 rapport strength。 */
  private readonly maxAffinity = 10000;

  constructor(
    store: PersonaStore,
    messageStore: MessageStore,
    config: PersonaConfig,
    llmConfig: LLMConfig
  ) {
    this.store = store;
    this.messageStore = messageStore;
    this.config = config;
    this.llmConfig = llmConfig;

    const openaiConfig: Record<string, unknown> = {
      modelName: llmConfig.model,
      temperature: 0.3, // 评估用低温度，求稳定
      maxTokens: 1500,
    };
    if (llmConfig.baseUrl) openaiConfig.configuration = { baseURL: llmConfig.baseUrl };
    if (llmConfig.apiKey) openaiConfig.apiKey = llmConfig.apiKey;
    this.evalModel = new ChatOpenAI(openaiConfig);
  }

  /** 注入 social 插件以读取 affinity（可选，缺失时 rapport strength 退化为均值）。 */
  setSocialPlugin(social: SocialPlugin): void {
    this.social = social;
  }

  /** 注入软核心/全局风格变化回调（用于刷新 ContextManager 的 immutable 层）。 */
  setOnPersonaChanged(cb: () => void): void {
    this.onPersonaChanged = cb;
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────

  /** (不再使用独立定时器。进化由上下文压缩回调触发。保留此方法仅兼容，实质空转) */
  start(): void {
    console.log(`[Persona] 进化引擎已就绪（无独立定时器，由上下文压缩触发）`);
  }

  stop(): void {
    // 不再有定时器需要清理
  }

  /**
   * 检查是否到了进化时机，如果是则执行一轮进化。
   * 由 ContextManager 的压缩前回调调用。
   */
  async runCycleIfDue(): Promise<boolean> {
    if (!this.config.enabled) return false;
    const now = Date.now();
    // 避免过于频繁的评估
    if (now - this.lastRunTime < 10 * 60 * 1000) return false;
    await this.runCycle();
    return true;
  }

  /** 管理员手动触发一次完整评估（用于测试 / 调试）。 */
  async runCycleNow(): Promise<{ softCoreChanged: boolean; globalStyleChanged: boolean }> {
    return this.runCycle();
  }

  // ── 单次进化循环 ────────────────────────────────────────────────────────────

  private async runCycle(): Promise<{ softCoreChanged: boolean; globalStyleChanged: boolean }> {
    if (this.running) {
      console.log("[Persona] 上一轮进化仍在进行，跳过");
      return { softCoreChanged: false, globalStyleChanged: false };
    }
    this.running = true;
    this.lastRunTime = Date.now();
    try {
      const now = Date.now();
      const windowMs = this.config.evaluationWindowHours * 60 * 60 * 1000;
      const material = this.collectMaterial(now - windowMs, now);

      // 素材太少（几乎没人聊）则跳过，避免在冷启动期凭空进化
      if (material.botSamples.length < 3 && material.userSignals.length === 0) {
        console.log("[Persona] 评估素材不足，跳过本轮");
        return { softCoreChanged: false, globalStyleChanged: false };
      }

      // 重置本周期单用户贡献记账
      this.userContributionThisCycle.clear();

      const evaluation = await this.callLLMEvaluation(material);
      if (!evaluation) {
        return { softCoreChanged: false, globalStyleChanged: false };
      }

      console.log(`[Persona] LLM 评估理由: ${evaluation.reasoning ?? "(无)"}`);

      const softCoreChanged = await this.maybeEvolveSoftCore(evaluation, now);
      const globalStyleChanged = this.maybeEvolveGlobalStyle(evaluation);
      this.maybeEvolveRapports(evaluation);
      this.maybeEvolveGroups(evaluation);

      // 每轮进化末尾执行一次老化衰减与容量清理
      this.store.decayRapportsAndGroups(now);

      // 软核心/全局风格是 immutable 层，变化后需刷新 ContextManager
      if ((softCoreChanged || globalStyleChanged) && this.onPersonaChanged) {
        try {
          this.onPersonaChanged();
        } catch (err) {
          console.error("[Persona] onPersonaChanged 回调失败:", err);
        }
      }

      return { softCoreChanged, globalStyleChanged };
    } finally {
      this.running = false;
    }
  }

  // ── 素材收集（纯本地计算） ─────────────────────────────────────────────────

  private collectMaterial(windowStart: number, windowEnd: number): EvaluationMaterial {
    const records = this.messageStore.queryMessages({
      startTime: windowStart,
      endTime: windowEnd,
      includeReplies: true,
      order: "asc",
      limit: 500,
    });

    // AI 发言样本（去重、截断、限量）
    const botRaw = records.filter((r) => r.isBot).slice(-this.config.maxBotSamples);
    const botSamples = botRaw.map((r) => ({
      text: r.text.slice(0, this.config.maxBotSampleChars),
      timestamp: r.timestamp,
    }));

    // 各用户的行为信号
    const userMap = new Map<string, { count: number; timestamps: number[] }>();
    for (const r of records) {
      if (r.isBot || !r.userId) continue;
      const entry = userMap.get(r.userId) ?? { count: 0, timestamps: [] };
      entry.count += 1;
      entry.timestamps.push(r.timestamp);
      userMap.set(r.userId, entry);
    }

    const groupIds = Array.from(
      new Set(records.map((r) => r.groupId).filter((g): g is string => Boolean(g)))
    );

    let userSignals = Array.from(userMap.entries()).map(([userId, info]) => {
      // 平均消息间隔：用同一用户相邻消息间隔的均值近似活跃节奏
      let avgMessageIntervalMs: number | null = null;
      if (info.timestamps.length >= 2) {
        const gaps: number[] = [];
        for (let i = 1; i < info.timestamps.length; i++) {
          gaps.push(info.timestamps[i] - info.timestamps[i - 1]);
        }
        avgMessageIntervalMs = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
      }
      return {
        userId,
        // 当前好感度绝对值作为关系深度代理；精确 delta 需要历史快照，暂用当前值
        currentAffinity: this.social ? this.social.getAIAffinity(userId) : 0,
        interactionCount: info.count,
        avgMessageIntervalMs,
      };
    });

    // 去偏闸②：单个用户的互动信号不应主导全局软核心评估
    userSignals = this.capSingleUserInfluence(userSignals);

    return { windowStart, windowEnd, botSamples, userSignals, groupIds };
  }

  /**
   * 去偏闸②：限制单用户对软核心评估素材的贡献比例。
   * 任何用户的 interactionCount 不得超过 singleUserInfluenceCap * 总互动数。
   */
  private capSingleUserInfluence(
    userSignals: EvaluationMaterial["userSignals"]
  ): EvaluationMaterial["userSignals"] {
    const cap = this.config.singleUserInfluenceCap;
    if (cap >= 1 || userSignals.length === 0) return userSignals;

    const totalInteractions = userSignals.reduce((sum, s) => sum + s.interactionCount, 0);
    if (totalInteractions === 0) return userSignals;

    const maxAllowed = totalInteractions * cap;
    const effectiveMin = 1; // 至少保留 1 条，避免完全抹除该用户存在

    return userSignals.map((s) => {
      if (s.interactionCount <= maxAllowed) return s;
      return { ...s, interactionCount: Math.max(effectiveMin, Math.round(maxAllowed)) };
    });
  }

  // ── LLM 评估 ───────────────────────────────────────────────────────────────

  private async callLLMEvaluation(material: EvaluationMaterial): Promise<PersonaEvaluation | null> {
    const profile = this.store.getProfile();
    const prompt = this.buildEvaluationPrompt(profile, material);

    try {
      const response = await this.evalModel.invoke([new HumanMessage(prompt)]);
      const content = typeof response.content === "string" ? response.content : String(response.content);
      return this.parseEvaluationResponse(content);
    } catch (error) {
      console.error("[Persona] LLM 评估调用失败:", error);
      return null;
    }
  }

  private buildEvaluationPrompt(
    profile: ReturnType<PersonaStore["getProfile"]>,
    material: EvaluationMaterial
  ): string {
    const sc = profile.softCore;
    const gs = profile.globalStyle;

    const botSamplesText = material.botSamples
      .map((s, i) => `  ${i + 1}. ${s.text}`)
      .join("\n");

    const userSignalsText = material.userSignals
      .map(
        (s) =>
          `  - 用户 ${s.userId}：当前好感度 ${s.currentAffinity}，互动 ${s.interactionCount} 次，` +
          `平均消息间隔 ${s.avgMessageIntervalMs ?? "?"}ms`
      )
      .join("\n");

    // 现有 rapport 摘要（让 LLM 知道现状，决定是否微调）
    const rapportSummary = Object.entries(profile.rapports)
      .slice(0, 15)
      .map(([uid, rp]) => {
        const offsets = Object.entries(rp.offsets)
          .map(([k, v]) => `${k}:${v?.toFixed(2)}`)
          .join(",");
        return `  - ${uid}: { ${offsets} } notes:"${rp.notes}"`;
      })
      .join("\n");

    const groupSummary = Object.entries(profile.groups)
      .slice(0, 10)
      .map(([gid, g]) => `  - ${gid}: vibe:"${g.vibe}" role:"${g.myRole}"`)
      .join("\n");

    return [
      "你是一个人格自进化评估器。请基于客观行为数据，评估 AI 的性格与语言风格是否需要微调。",
      "你的输出会被严格约束（幅度受限、累积确认），所以请只给出方向性建议，幅度由系统决定。",
      "",
      "【当前软核心（性格程度 0-1）】",
      ...SOFT_CORE_FIELDS.map((f) => `  ${f}: ${sc.values[f].toFixed(2)}${sc.locked[f] ? " [已锁定]" : ""}`),
      `  累计漂移: ${sc.cumulativeDrift.toFixed(2)} / 预算 ${this.config.softCoreDriftBudget}`,
      "",
      "【当前全局风格】",
      `  formality: ${gs.formality.toFixed(2)}, warmth: ${gs.warmth.toFixed(2)}, avgLength: ${gs.avgLength}`,
      `  fillerWords: [${gs.fillerWords.join(", ")}], signatures: [${gs.signatures.join(", ")}]`,
      `  notes: "${gs.notes}"`,
      "",
      `【评估窗口内 AI 发言样本（共 ${material.botSamples.length} 条）】`,
      botSamplesText || "  (无)",
      "",
      `【用户行为信号（共 ${material.userSignals.length} 位用户）】`,
      "  好感度为当前绝对值（0-10000），正值越高表示关系越深。",
      userSignalsText || "  (无)",
      "",
      "【现有 rapport（相处调音，每字段偏移量上限 ±0.15）】",
      rapportSummary || "  (无)",
      "",
      "【现有群画像】",
      groupSummary || "  (无)",
      "",
      "【评估原则】",
      "1. 只在有明确、持续的信号时才建议调整；没有足够依据就什么都别改。",
      "2. 软核心只给方向（up/down/neutral），不给具体数值。",
      "3. 全局风格可以直接给新值，但要小幅调整（单字段变化不超过 0.15）。",
      "4. rapport 只在用户行为明显指向某方向时才建议微调，每次偏移不超过 ±0.1。",
      "5. 群画像只在氛围/角色有明确变化时才更新。",
      "6. 好感度高的用户 rapport 权重更大，但任何单用户都不应主导全局性格。",
      "",
      "【输出格式：只输出 JSON，不要任何解释文字、不要 markdown 代码块】",
      "{",
      '  "reasoning": "一句话说明评估依据",',
      '  "softCore": { "warmth": "up|down|neutral", "tsundere": "...", ... },',
      '  "globalStyle": { "formality": 0.3, "warmth": 0.6, "fillerWords": [...], "notes": "..." },',
      '  "rapports": { "用户ID": { "offsets": { "warmth": 0.05, "playfulness": -0.03 }, "notes": "..." } },',
      '  "groups": { "群ID": { "vibe": "...", "myRole": "...", "topicHints": [...] } }',
      "}",
      "",
      "现在请输出 JSON：",
    ].join("\n");
  }

  private parseEvaluationResponse(content: string): PersonaEvaluation | null {
    // 提取第一个 {...} 块，兼容模型偶尔包裹 markdown
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      console.error("[Persona] LLM 评估输出未找到 JSON");
      return null;
    }
    try {
      const parsed = JSON.parse(content.slice(start, end + 1)) as PersonaEvaluation;
      return parsed;
    } catch (error) {
      console.error("[Persona] LLM 评估输出 JSON 解析失败:", error);
      return null;
    }
  }

  // ── 软核心进化（四道约束） ───────────────────────────────────────────────────

  private async maybeEvolveSoftCore(
    evaluation: PersonaEvaluation,
    now: number
  ): Promise<boolean> {
    // 约束①：频率。软核心评估间隔更长
    const intervalMs = this.config.softCoreIntervalHours * 60 * 60 * 1000;
    if (now - this.lastSoftCoreEvalAt < intervalMs) {
      // 未到评估时间，但仍更新累积确认状态机（不影响实际写入）
      this.updatePendingStreaks(evaluation);
      return false;
    }
    this.lastSoftCoreEvalAt = now;

    // 约束②：漂移预算。接近预算时收紧单次幅度
    const softCore = this.store.getSoftCore();
    const driftRatio = softCore.cumulativeDrift / this.config.softCoreDriftBudget;
    let effectiveMaxDelta = this.config.softCoreMaxAbsDelta;
    if (driftRatio > 0.7) {
      // 接近预算 → 幅度减半（自然减速）
      effectiveMaxDelta = this.config.softCoreMaxAbsDelta * 0.5;
    }
    if (driftRatio >= 1) {
      console.log("[Persona] 软核心漂移已达预算上限，本周期不再进化");
      return false;
    }

    // 更新累积确认状态机，收集已达阈值的字段
    const readyFields = this.updatePendingStreaks(evaluation);

    if (readyFields.length === 0) {
      console.log("[Persona] 软核心无字段达到累积确认阈值，不进化");
      return false;
    }

    // 构造 delta（方向 → 正负），施加幅度上限
    const deltas: Partial<Record<SoftCoreField, number>> = {};
    for (const field of readyFields) {
      const dir = this.store.getSoftCore().pendingDirection[field];
      if (dir === "up") deltas[field] = effectiveMaxDelta;
      else if (dir === "down") deltas[field] = -effectiveMaxDelta;
    }

    if (Object.keys(deltas).length === 0) return false;

    // 写前快照（供 rollback）
    this.store.snapshotBeforeChange();
    const changed = this.store.applySoftCoreDelta(deltas, effectiveMaxDelta);
    if (changed) {
      console.log(
        `[Persona] 软核心已进化: ${Object.entries(deltas)
          .map(([k, v]) => `${k}=${v!.toFixed(3)}`)
          .join(", ")}，version=${this.store.getSoftCore().version}`
      );
      // 生效后重置该字段的累积计数
      for (const field of readyFields) {
        this.store.updatePending(field, "neutral");
      }
    }
    return changed;
  }

  /**
   * 更新累积确认状态机。
   * @returns 本轮达到 requiredConsecutive 阈值、且未被锁定的字段列表
   */
  private updatePendingStreaks(evaluation: PersonaEvaluation): SoftCoreField[] {
    const ready: SoftCoreField[] = [];
    const sc = this.store.getSoftCore();
    for (const field of SOFT_CORE_FIELDS) {
      if (sc.locked[field]) continue;
      const dir = evaluation.softCore?.[field];
      if (dir !== "up" && dir !== "down" && dir !== "neutral") continue;

      const streak = this.store.updatePending(field, dir);
      if (streak >= this.config.softCoreRequiredConsecutive) {
        ready.push(field);
      }
    }
    return ready;
  }

  // ── 全局风格进化 ───────────────────────────────────────────────────────────

  private maybeEvolveGlobalStyle(evaluation: PersonaEvaluation): boolean {
    if (!evaluation.globalStyle) return false;
    this.store.snapshotBeforeChange();
    const changed = this.store.applyGlobalStyleChange(
      evaluation.globalStyle,
      this.config.globalStyleMaxAbsDelta
    );
    if (changed) {
      console.log(`[Persona] 全局风格已更新，version=${this.store.getGlobalStyle().version}`);
    }
    return changed;
  }

  // ── Rapport 进化 ────────────────────────────────────────────────────────────

  private maybeEvolveRapports(evaluation: PersonaEvaluation): void {
    if (!evaluation.rapports) return;
    for (const [userId, change] of Object.entries(evaluation.rapports)) {
      if (!userId) continue;
      // 软核心去偏闸②：单用户贡献 cap 不直接限制 rapport（rapport 本就是 per-user），
      // 但对完全没有交互记录的用户不创建 rapport（避免噪声）
      const existing = this.store.getRapport(userId);
      if (!existing) {
        // 仅在有近期交互时才新建
        const recent = this.messageStore.queryInteraction(userId, { limit: 1 });
        if (recent.length === 0) continue;
      }
      this.store.applyRapportChange(userId, {
        offsets: change.offsets,
        notes: change.notes,
      });
    }
  }

  // ── 群画像进化 ─────────────────────────────────────────────────────────────

  private maybeEvolveGroups(evaluation: PersonaEvaluation): void {
    if (!evaluation.groups) return;
    for (const [groupId, change] of Object.entries(evaluation.groups)) {
      if (!groupId) continue;
      this.store.applyGroupPersonaChange(groupId, change);
    }
  }

  // ── 给插件用的查询：在场用户 strength ─────────────────────────────────────

  /** 把 affinity 归一化为 rapport strength（0-1）。 */
  rapportStrength(userId: string): number {
    if (!this.social) return 0.3; // 无 social 时给个温和默认
    const aff = this.social.getAIAffinity(userId);
    return Math.max(0, Math.min(1, aff / this.maxAffinity));
  }
}
