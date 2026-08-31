import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import type { LLMClient } from "../../llm.js";
import { extractPatternTokens, listLibraries } from "./audio-synth.js";
import { evaluateStrudelCode } from "./strudel-renderer.js";

export type AgentContext = {
  turns: { role: "user" | "assistant"; content: string }[];
  goal: string;
  library: string;
};

const MAX_TURNS = 3;
const MAX_ERROR_MESSAGE_LENGTH = 180;
const MUSIC_GENERATION_MAX_TOKENS = 4096;
const MUSIC_GENERATION_REASONING: "high" = "high";
const MIN_NOTE_TOKENS = 16;
const MIN_UNIQUE_TOKENS = 6;
const MIN_TOP_LEVEL_SECTIONS = 2;
const MIN_TRACK_ROLES = 3;

export type MusicSynthesisResult =
  | { ok: true; wav: Buffer; rounds: number; code: string }
  | { ok: false; reason: string; rounds: number };

type RetryFeedback =
  | { kind: "initial" }
  | { kind: "missing_code" }
  | { kind: "runtime_error"; error: string; previousCode: string }
  | { kind: "too_short"; noteCount: number; previousCode: string }
  | { kind: "render_failed"; previousCode: string };

export class MusicAgent {
  private contexts = new Map<string, AgentContext>();

  constructor(private llm: LLMClient) {}

  startTask(userId: string, goal: string, library: string): void {
    this.contexts.set(userId, { turns: [], goal, library });
  }

  clearContext(userId: string): void {
    this.contexts.delete(userId);
  }

  private buildSysPrompt(library: string): string {
    const libs = listLibraries();
    const libLines = libs.map(l => `  ${l.name}: ${l.desc}（${l.label}）`).join("\n");
    return `你是一个音乐创作助手。用户会告诉你想要什么样的音乐，你需要生成 Strudel 代码来创作它。

可用采样库：
${libLines}
当前采样库: ${library}

Strudel 代码语法（基于 TidalCycles 微型记号法）：
- note("c d e f g")  — 音符序列（c=Do, d=Re, e=Mi, f=Fa, g=Sol, a=La, b=Si）+ 八度数字如 c3
- n("0 2 4")  — MIDI 音符号（按半音，0=中间C）
- s("piano")  — 设置乐器名（ piano bass pad lead pluck kick snare hihat bell organ ）
- .slow(2)    — 慢放 2 倍
- .fast(2)    — 快放 2 倍
- .chop(4)    — 切片
- .delay(.2)  — 延迟效果
- .gain(.5)   — 音量
- .pan(0)     — 声场
- stack(      — 叠加多个轨道
  note("c d e").s("piano"),
  note("c2").s("bass")
)
- cat(pat1, pat2) — 拼接
- 和弦: note("[c e g] [c f a]")  — [] 内的同时发声
- 和弦注释: note("c4 e4 g4").s("piano")
- 休止: ~
- 重复: "c*4 e"  — c 重复 4 次

创作要求：
- 总体按 8-12 个循环来构思，必须用 cat(...) / slowcat(...) / fastcat(...) 组织至少 2 个不同段落，不接受单个 stack(...) 从头铺到尾
- 每个主要段落里至少要有 3 个明确角色：主旋律、和声/织体、低音；不要只写旋律加一层长和弦
- 至少出现一次旋律变化、低音走向变化、节奏变化或和声变化；不要把同一乐句原样复制两遍交差
- 钢琴/夜晚/抒情类目标优先使用更平滑的旋律线和分解和弦，而不是方块式重复
- 伴奏不要整段只用 .slow(4) 之类的超长拖拍和弦；低音不要机械重复同一根音或完全等时值地上下拍点名
- 除非用户明确要求独奏，否则优先写成 3-4 层的完整小编制编曲，可加入轻打击、对位副旋律或过门
- 使用当前采样库的工具名: ${libs.find(l => l.name === library)?.label ?? library}

请只输出 strudel 代码，不要解释。代码必须可在 strudel 环境中直接执行。`;
  }

  private buildPlannerPrompt(goal: string, library: string, feedback: RetryFeedback): string {
    const feedbackText = this.buildPlannerFeedback(feedback);
    return [
      `你是一名专业作曲家、配器师与编曲家。现在先不要写代码，先做编曲方案。`,
      `目标：${goal}`,
      `采样库：${library}`,
      feedbackText ? `上一轮问题：${feedbackText}` : "",
      `请输出一个简洁但专业的编曲方案，必须包含：`,
      `1. 曲式结构：至少 2 个不同段落，例如 A / A' / B / 尾声`,
      `2. 主旋律走向：开头、中段、高潮、收束分别怎么变化`,
      `3. 伴奏织体：不是只铺长和弦，要说明分解和弦、节奏型、反拍或对位方式`,
      `4. 低音设计：说明低音如何行进，避免机械重复同一个节奏型`,
      `5. 配器层次：不同段落分别由哪些乐器承担旋律、垫底、低音、过门或轻打击`,
      `要求：`,
      `- 不要输出 Strudel 代码`,
      `- 不要空话，要具体到段落与织体`,
      `- 明确说明每个段落至少 3 个角色，不能是“旋律 + 一层长和弦”`,
      `- 总长度控制在 10 行内`,
    ].filter(Boolean).join("\n");
  }

  async generateStrudelCode(userId: string, feedback: RetryFeedback = { kind: "initial" }): Promise<string | null> {
    const ctx = this.contexts.get(userId);
    if (!ctx) return null;

    const plan = await this.generateCompositionPlan(ctx.goal, ctx.library, feedback);

    const messages: (SystemMessage | HumanMessage | AIMessage)[] = [
      new SystemMessage(this.buildSysPrompt(ctx.library)),
    ];

    for (const turn of ctx.turns) {
      if (turn.role === "user") messages.push(new HumanMessage(turn.content));
      else messages.push(new AIMessage(turn.content));
    }

    const prompt = this.buildRoundPrompt(ctx.goal, feedback, plan);

    messages.push(new HumanMessage(prompt));
    ctx.turns.push({ role: "user", content: prompt });

    try {
      console.log("[MusicAgent] 正在调用 LLM 生成 strudel 代码…");
      const text = await this.llm.invokeWithCustomConfig(messages, {
        timeout: 300000,
        maxTokens: MUSIC_GENERATION_MAX_TOKENS,
        reasoningEffort: MUSIC_GENERATION_REASONING,
      });
      const code = extractCode(text);
      console.log("[MusicAgent] LLM 返回，提取代码:", code ? `成功 (${code.length} 字符)` : "失败");
      if (code) {
        ctx.turns.push({ role: "assistant", content: code });
        return code;
      }
      return null;
    } catch (error) {
      console.error("[MusicAgent] LLM 调用失败:", error);
      return null;
    }
  }

  async synth(userId: string): Promise<MusicSynthesisResult> {
    const ctx = this.contexts.get(userId);
    if (!ctx) {
      return { ok: false, reason: "任务上下文不存在。", rounds: 0 };
    }

    let lastFailureReason = "未知错误";

    let feedback: RetryFeedback = { kind: "initial" };

    for (let round = 0; round < MAX_TURNS; round++) {
      console.log(`[MusicAgent] 第 ${round + 1}/${MAX_TURNS} 轮生成开始`);
      const code = await this.generateStrudelCode(userId, feedback);
      if (!code) {
        lastFailureReason = "LLM 未返回可提取的 Strudel 代码。";
        ctx.turns.push({
          role: "user",
          content: "你上一轮没有输出可提取的 Strudel 代码。请只输出一段可直接执行的 Strudel 代码，不要解释，不要加说明文字。",
        });
        feedback = { kind: "missing_code" };
        continue;
      }

      const { haps, error } = await evaluateStrudelCode(code, 12);
      if (error) {
        lastFailureReason = `Strudel 执行失败：${limitErrorMessage(error)}`;
        ctx.turns.push({ role: "user", content: `代码执行出错: ${error}。请修正后重试。` });
        feedback = { kind: "runtime_error", error, previousCode: code };
        continue;
      }

      const complexity = analyzeComplexity(code, haps);
      if (!complexity.ok) {
        lastFailureReason = complexity.reason;
        ctx.turns.push({ role: "user", content: `${complexity.reason} 请生成更长、更有层次、不要整段简单重复的版本。` });
        feedback = { kind: "too_short", noteCount: haps.length, previousCode: code };
        continue;
      }

      const { renderStrudelCode } = await import("./strudel-renderer.js");
      const wav = await renderStrudelCode(code, { library: ctx.library, duration: 12 });
      if (wav) {
        console.log(`[MusicAgent] 第 ${round + 1} 轮成功生成 WAV，大小 ${wav.length} 字节`);
        return { ok: true, wav, rounds: round + 1, code };
      }

      lastFailureReason = "音频合成失败。";
      ctx.turns.push({ role: "user", content: "音频合成失败，请修正代码后重试。" });
      feedback = { kind: "render_failed", previousCode: code };
    }

    return { ok: false, reason: lastFailureReason, rounds: MAX_TURNS };
  }

  private async generateCompositionPlan(goal: string, library: string, feedback: RetryFeedback): Promise<string> {
    try {
      const plan = await this.llm.invokeWithCustomConfig(
        [
          new SystemMessage("你是一名专业作曲家与编曲家，擅长把抽象情绪转成清晰的曲式与配器方案。"),
          new HumanMessage(this.buildPlannerPrompt(goal, library, feedback)),
        ],
        {
          timeout: 180000,
          maxTokens: 1200,
          reasoningEffort: MUSIC_GENERATION_REASONING,
        },
      );
      return plan.trim();
    } catch (error) {
      console.error("[MusicAgent] 编曲方案生成失败:", error);
      return "";
    }
  }

  private buildRoundPrompt(goal: string, feedback: RetryFeedback, plan: string): string {
    const planBlock = plan
      ? `请严格按照下面这份编曲方案写代码，不要偏离它的段落与配器设计：\n${plan}\n`
      : "";
    switch (feedback.kind) {
      case "initial":
        return [
          `你是一名专业作曲家、配器师与编曲家，请先在脑中完成整体构思，再输出最终 Strudel 代码。`,
          `目标：${goal}`,
          planBlock,
          `先思考整体音乐走向：开头氛围、主旋律发展、中段变化、收束方式、低音与伴奏如何支撑旋律。`,
          `必须用 cat(...) / slowcat(...) / fastcat(...) 写出至少两个不同段落，不接受单个顶层 stack(...) 从头铺到尾。`,
          `每个主要段落至少 3 个角色：主旋律、和声/织体、低音。`,
          `伴奏不要只是长和弦堆叠，不要整段 .slow(4) 拖着走；低音不要只是机械重复根音。`,
          `旋律需要有动机发展或问答，不要只写上行/下行音阶练习。`,
          `然后再写代码。最终输出时只输出 Strudel 代码，不要把你的思考过程写出来。`,
        ].join("\n");
      case "missing_code":
        return [
          `你上一轮没有正确输出 Strudel 代码。`,
          `目标：${goal}`,
          planBlock,
          `请重新输出一段完整的 Strudel 代码。`,
          `要求：只输出代码，不要解释，不要 Markdown 代码块，不要自然语言说明。`,
        ].join("\n");
      case "runtime_error":
        return [
          `你上一轮的 Strudel 代码执行报错了，请基于错误信息修正，而不是重写成解释文本。`,
          `目标：${goal}`,
          planBlock,
          `报错：${feedback.error}`,
          `上一轮代码：`,
          feedback.previousCode,
          `请修复导致报错的语法或调用问题，并输出修正后的完整 Strudel 代码。只输出代码。`,
        ].join("\n");
      case "too_short":
        return [
          `你上一轮的 Strudel 代码可以执行，但内容太少，不够成曲。请在保持可执行的前提下扩展它。`,
          `目标：${goal}`,
          planBlock,
          `问题：只生成了 ${feedback.noteCount} 个音符事件，至少需要更完整的旋律、伴奏和低音层次。`,
          `上一轮代码：`,
          feedback.previousCode,
          `请输出更长、更丰富、更有层次变化的完整 Strudel 代码，必须包含至少两个不同段落和三个明确角色，不要简单复制同一段。只输出代码。`,
        ].join("\n");
      case "render_failed":
        return [
          `你上一轮的 Strudel 代码评估通过了，但音频合成失败。请输出更稳定、更简单一些的版本。`,
          `目标：${goal}`,
          planBlock,
          `上一轮代码：`,
          feedback.previousCode,
          `请避免过度复杂或异常的写法，输出一段可直接执行的完整 Strudel 代码。只输出代码。`,
        ].join("\n");
    }
  }

  private buildPlannerFeedback(feedback: RetryFeedback): string {
    switch (feedback.kind) {
      case "initial":
        return "";
      case "missing_code":
        return "上一轮没有正确输出代码。";
      case "runtime_error":
        return `上一轮执行报错：${feedback.error}`;
      case "too_short":
        return `上一轮内容太简单，只有 ${feedback.noteCount} 个事件或结构层次不足。`;
      case "render_failed":
        return "上一轮虽然能评估，但整体写法不稳定。";
    }
  }
}

function extractCode(text: string): string | null {
  const codeBlock = /```(?:javascript|js|strudel)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  if (codeBlock) return codeBlock[1].trim();

  const lines = text.split("\n").filter(l => l.trim() && !l.startsWith("//") && !l.startsWith("/*"));
  if (lines.some(l => l.includes("note(") || l.includes("stack(") || l.includes("s("))) {
    return lines.join("\n").trim();
  }

  return null;
}

function limitErrorMessage(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_LENGTH) return message;
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH) + "...";
}

function analyzeComplexity(code: string, haps: Array<{ note?: string; n?: number | string | null }>): { ok: true } | { ok: false; reason: string } {
  const tokenSet = new Set<string>();
  let tokenCount = 0;
  let maxRawDuration = 0;

  for (const hap of haps) {
    const begin = typeof (hap as { begin?: unknown }).begin === "number" ? (hap as { begin: number }).begin : 0;
    const end = typeof (hap as { end?: unknown }).end === "number" ? (hap as { end: number }).end : begin;
    maxRawDuration = Math.max(maxRawDuration, end - begin);
    for (const token of extractPatternTokens(hap.note)) {
      if (typeof token !== "string") continue;
      tokenSet.add(token);
      tokenCount++;
    }
    for (const token of extractPatternTokens(hap.n)) {
      if (token === null || token === undefined) continue;
      tokenSet.add(String(token));
      tokenCount++;
    }
  }

  if (tokenCount < MIN_NOTE_TOKENS) {
    return { ok: false, reason: `生成的有效音符事件太少（${tokenCount} 个）。` };
  }
  if (tokenSet.size < MIN_UNIQUE_TOKENS) {
    return { ok: false, reason: `旋律/和声变化太少（仅 ${tokenSet.size} 种音高内容）。` };
  }

  const normalized = code.replace(/\s+/g, " ").trim();
  const catDuplicatePattern = /cat\s*\(\s*(stack[\s\S]+?)\s*,\s*\1\s*\)/i;
  if (catDuplicatePattern.test(normalized)) {
    return { ok: false, reason: "代码把同一段内容直接复制拼接，结构过于简单。" };
  }

  const stackCount = (normalized.match(/\bstack\s*\(/g) ?? []).length;
  if (stackCount < 1) {
    return { ok: false, reason: "轨道结构不清晰，缺少有效的多轨组织。" };
  }
  const sectionCount = (normalized.match(/\b(?:cat|slowcat|fastcat)\s*\(/g) ?? []).length;
  if (sectionCount < 1) {
    return { ok: false, reason: "缺少段落结构，像是单个 stack 从头铺到尾。" };
  }

  const topLevelSegments = countTopLevelSectionItems(normalized);
  if (topLevelSegments < MIN_TOP_LEVEL_SECTIONS) {
    return { ok: false, reason: "段落数量不足，顶层结构没有形成至少两个明确部分。" };
  }

  const instruments = new Set(Array.from(normalized.matchAll(/\.s\("([^"]+)"\)/g)).map((m) => m[1]));
  if (instruments.size < 2) {
    return { ok: false, reason: "乐器层次过少，至少需要两种不同的轨道音色。" };
  }

  const roleMatches = [
    /\.s\("(?:piano|lead|bell)"\)/g,
    /\.s\("(?:pad|pluck|organ)"\)/g,
    /\.s\("bass"\)/g,
    /\.s\("(?:kick|snare|hihat)"\)/g,
  ].map((pattern) => pattern.test(normalized));
  const roleCount = roleMatches.filter(Boolean).length;
  if (roleCount < MIN_TRACK_ROLES) {
    return { ok: false, reason: "编曲角色不完整，至少要有主旋律、和声/织体、低音三类层次。" };
  }

  const bassTracks = Array.from(normalized.matchAll(/note\("([^"]+)"\)\.s\("bass"\)/g)).map((m) => m[1]);
  if (bassTracks.length > 0) {
    const bassTokens = bassTracks.flatMap((track) => extractPatternTokens(track).filter((token): token is string => typeof token === "string"));
    const bassUnique = new Set(bassTokens);
    if (bassTokens.length >= 8 && bassUnique.size < 4) {
      return { ok: false, reason: "低音线条变化太少，像是在机械重复根音。" };
    }
  }

  const largeSlowValues = Array.from(normalized.matchAll(/\.slow\(([\d.]+)\)/g))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 4);
  if (largeSlowValues.length > 0 && tokenCount < 32) {
    return { ok: false, reason: "存在过度拖长的声部写法，织体容易变成难听的长音铺底。" };
  }

  if (maxRawDuration >= 3 && tokenCount < 32) {
    return { ok: false, reason: "存在过长持续音而整体内容又偏少，听感会像在拖长和弦。" };
  }

  return { ok: true };
}

function countTopLevelSectionItems(code: string): number {
  const match = /\b(?:cat|slowcat|fastcat)\s*\(([\s\S]+)\)/i.exec(code);
  if (!match) return 0;

  const body = match[1];
  let depth = 0;
  let count = 1;

  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) count++;
  }

  return count;
}
