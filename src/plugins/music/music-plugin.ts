import fs from "node:fs";
import path from "node:path";
import type { Plugin, PluginContext, BotMessage, MenuPlugin } from "../../types.js";
import type { LLMClient } from "../../llm.js";
import { MusicAgent } from "./music-agent.js";
import { listLibraries } from "./audio-synth.js";
import { transcodeWavToOggOpus } from "./voice-transcoder.js";
import { evaluateStrudelCode, renderStrudelCode } from "./strudel-renderer.js";

type MusicRecord = {
  id: string;
  title: string;
  prompt: string;
  library: string;
  createdAt: number;
  strudelCode: string;
  filePath: string;
  voiceFilePath?: string;
  source?: "ai" | "render";
};

type QueueTarget = { type: "group" | "private"; id: string };

type GenerateQueueEntry = {
  mode: "generate";
  userId: string;
  goal: string;
  library: string;
  target: QueueTarget;
};

type RenderQueueEntry = {
  mode: "render";
  userId: string;
  code: string;
  library: string;
  cycles: number;
  target: QueueTarget;
};

type QueueEntry = GenerateQueueEntry | RenderQueueEntry;

const OUTPUT_DIR = path.resolve(process.cwd(), "data", "music");
const MAX_PER_USER = 50;
const VOICE_EXT = ".ogg";
const DEFAULT_RENDER_CYCLES = 8;
const MAX_RENDER_CYCLES = 32;
const MIN_RENDER_CYCLES = 1;
const MAX_RENDER_CODE_CHARS = 12000;

export function createMusicPlugin(
  llm: LLMClient,
  menu: MenuPlugin,
): Plugin {
  let ctx: PluginContext;

  const queue: QueueEntry[] = [];
  const activeUsers = new Set<string>();
  let processing = false;

  function getUserDir(userId: string): string {
    const dir = path.join(OUTPUT_DIR, userId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function getMetaPath(userId: string): string {
    return path.join(getUserDir(userId), "records.json");
  }

  function getVoicePath(userId: string, id: string): string {
    return path.join(getUserDir(userId), `${id}${VOICE_EXT}`);
  }

  function loadRecords(userId: string): MusicRecord[] {
    const p = getMetaPath(userId);
    if (!fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as MusicRecord[];
    } catch {
      return [];
    }
  }

  function saveRecords(userId: string, records: MusicRecord[]): void {
    fs.writeFileSync(getMetaPath(userId), JSON.stringify(records, null, 2), "utf-8");
  }

  function getLibName(library: string): string {
    const libs = listLibraries();
    return libs.find(l => l.name === library)?.label ?? library;
  }

  function getTarget(message: BotMessage, userId: string): QueueTarget {
    return message.type === "group" && message.groupId
      ? { type: "group", id: message.groupId }
      : { type: "private", id: userId };
  }

  async function persistAndSendResult(params: {
    userId: string;
    target: QueueTarget;
    goal: string;
    library: string;
    wav: Buffer;
    code: string;
    elapsedMs: number;
    roundsText: string;
    source: "ai" | "render";
  }) {
    const ts = Date.now();
    const id = `${ts}`;
    const filePath = path.join(getUserDir(params.userId), `${id}.wav`);
    const voiceFilePath = getVoicePath(params.userId, id);
    fs.writeFileSync(filePath, params.wav);

    let voiceReady = false;
    let voiceError: string | null = null;
    try {
      await transcodeWavToOggOpus(filePath, voiceFilePath);
      voiceReady = true;
    } catch (error) {
      voiceError = error instanceof Error ? error.message : String(error);
      console.error("[MusicPlugin] 语音转码失败:", error);
    }

    const records = loadRecords(params.userId);
    records.unshift({
      id,
      title: params.goal.length > 30 ? params.goal.slice(0, 30) + "…" : params.goal,
      prompt: params.goal,
      library: params.library,
      createdAt: ts,
      strudelCode: params.code,
      filePath,
      voiceFilePath: voiceReady ? voiceFilePath : undefined,
      source: params.source,
    });
    while (records.length > MAX_PER_USER) records.pop();
    saveRecords(params.userId, records);

    if (voiceReady) {
      try {
        await ctx.sendVoice(params.target, voiceFilePath);
      } catch (error) {
        voiceError = error instanceof Error ? error.message : String(error);
        console.error("[MusicPlugin] 发送语音失败:", error);
      }
    }

    const voiceNote = voiceReady
      ? `已自动发送语音，可用 ${menu.getPrefix()}music voice ${id} 重发语音，或用 ${menu.getPrefix()}music download ${id} 下载原始 WAV。`
      : `语音预览生成或发送失败：${voiceError ?? "未知错误"}。你仍可用 ${menu.getPrefix()}music download ${id} 下载原始 WAV。`;
    await ctx.sendMessage(
      params.target,
      `[音乐生成] "${params.goal}" 创作完成！耗时 ${Math.max(1, Math.round(params.elapsedMs / 1000))} 秒，${params.roundsText}\n${voiceNote}`
    );
  }

  async function renderUserCode(entry: RenderQueueEntry): Promise<{ ok: true; wav: Buffer } | { ok: false; reason: string }> {
    if (entry.code.length > MAX_RENDER_CODE_CHARS) {
      return { ok: false, reason: `Strudel 代码过长（>${MAX_RENDER_CODE_CHARS} 字符），请精简后再试。` };
    }

    const normalizedCycles = Math.max(MIN_RENDER_CYCLES, Math.min(MAX_RENDER_CYCLES, Math.round(entry.cycles)));
    const { haps, error } = await evaluateStrudelCode(entry.code, normalizedCycles);
    if (error) {
      return { ok: false, reason: `Strudel 执行失败：${error}` };
    }
    if (haps.length === 0) {
      return { ok: false, reason: "Strudel 代码没有产生任何音符事件。" };
    }

    const wav = await renderStrudelCode(entry.code, {
      library: entry.library,
      duration: normalizedCycles,
    });
    if (!wav) {
      return { ok: false, reason: "音频合成失败，请检查代码是否包含可执行且可发声的模式。" };
    }
    return { ok: true, wav };
  }

  function extractStrudelBody(messageText: string, prefix: string): string {
    const pattern = new RegExp(`^\\${prefix}music\\s+render(?:\\s+|\\n)?`, "i");
    const withoutCommand = messageText.replace(pattern, "").trim();
    const codeBlock = withoutCommand.match(/```(?:javascript|js|strudel)?\s*([\s\S]*?)```/i);
    if (codeBlock) {
      return codeBlock[1].trim();
    }

    const inlineCode = withoutCommand
      .replace(/(?:^|\s)--lib\s+\S+/gi, " ")
      .replace(/(?:^|\s)--cycles\s+\S+/gi, " ")
      .trim();
    return inlineCode;
  }

  function parseRenderRequest(args: string[], rawCode: string, libs: Array<{ name: string; label: string; desc: string }>): {
    ok: true;
    library: string;
    cycles: number;
    code: string;
  } | {
    ok: false;
    reason: string;
  } {
    let library = "official";
    let cycles = DEFAULT_RENDER_CYCLES;

    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--lib" && args[i + 1]) {
        const libName = args[i + 1];
        const found = libs.find((l) => l.name === libName);
        if (!found) {
          return { ok: false, reason: `未知采样库 "${libName}"。可用库：${libs.map((l) => l.name).join(", ")}` };
        }
        library = libName;
        i++;
        continue;
      }
      if (args[i] === "--cycles" && args[i + 1]) {
        const parsed = Number(args[i + 1]);
        if (!Number.isFinite(parsed)) {
          return { ok: false, reason: "参数 --cycles 需要是数字。" };
        }
        cycles = Math.max(MIN_RENDER_CYCLES, Math.min(MAX_RENDER_CYCLES, Math.round(parsed)));
        i++;
      }
    }

    const code = rawCode.trim();
    if (!code) {
      return { ok: false, reason: `用法：${menu.getPrefix()}music render [--lib <库名>] [--cycles <1-${MAX_RENDER_CYCLES}>] <Strudel代码>` };
    }

    return { ok: true, library, cycles, code };
  }

  async function processQueue() {
    if (processing || queue.length === 0) return;
    processing = true;
    console.log("[MusicPlugin] processQueue 开始处理队列");

    const entry = queue.shift()!;
    activeUsers.add(entry.userId);

    try {
      if (entry.mode === "generate") {
        const agent = new MusicAgent(llm);
        try {
          agent.startTask(entry.userId, entry.goal, entry.library);

          const libLabel = getLibName(entry.library);
          await ctx.sendMessage(entry.target, `[音乐生成] 正在用"${libLabel}"采样库创作"${entry.goal}"…`);
          console.log("[MusicPlugin] 调用 agent.synth");
          const startedAt = Date.now();
          const result = await agent.synth(entry.userId);
          const elapsedMs = Date.now() - startedAt;
          agent.clearContext(entry.userId);

          if (!result.ok) {
            console.warn(`[MusicPlugin] 任务失败，耗时 ${elapsedMs}ms，原因: ${result.reason}`);
            await ctx.sendMessage(
              entry.target,
              `[音乐生成] 抱歉，"${entry.goal}" 创作失败了。\n原因：${result.reason}\n已尝试 ${result.rounds} 轮。你可以试试换个更具体的描述，或切换采样库。`
            );
            return;
          }

          await persistAndSendResult({
            userId: entry.userId,
            target: entry.target,
            goal: entry.goal,
            library: entry.library,
            wav: result.wav,
            code: result.code,
            elapsedMs,
            roundsText: `共尝试 ${result.rounds} 轮。`,
            source: "ai",
          });
        } finally {
          agent.clearContext(entry.userId);
        }
        return;
      }

      const libLabel = getLibName(entry.library);
      await ctx.sendMessage(
        entry.target,
        `[音乐生成] 正在渲染你提供的 Strudel 代码（"${libLabel}"采样库，最多 ${entry.cycles} 个 cycle）…`
      );
      const startedAt = Date.now();
      const result = await renderUserCode(entry);
      const elapsedMs = Date.now() - startedAt;

      if (!result.ok) {
        console.warn(`[MusicPlugin] 代码渲染失败，耗时 ${elapsedMs}ms，原因: ${result.reason}`);
        await ctx.sendMessage(
          entry.target,
          `[音乐生成] 你提供的 Strudel 代码渲染失败了。\n原因：${result.reason}\n如果代码包含无限循环模式，当前只会截取前 ${entry.cycles} 个 cycle 进行渲染。`
        );
        return;
      }

      await persistAndSendResult({
        userId: entry.userId,
        target: entry.target,
        goal: `Strudel 渲染 ${entry.cycles} cycles`,
        library: entry.library,
        wav: result.wav,
        code: entry.code,
        elapsedMs,
        roundsText: `按最多 ${entry.cycles} 个 cycle 截断渲染。`,
        source: "render",
      });
    } catch (error) {
      console.error("[MusicPlugin] 处理失败:", error);
      await ctx.sendMessage(entry.target, "[音乐生成] 处理出错，请稍后重试。");
    } finally {
      activeUsers.delete(entry.userId);
      processing = false;
      processQueue();
    }
  }

  function enqueue(entry: QueueEntry): string | null {
    if (activeUsers.has(entry.userId) || queue.some(e => e.userId === entry.userId)) {
      return "你已有正在处理或排队中的音乐任务，请等待完成后再提交。";
    }
    queue.push(entry);
    void processQueue();
    return null;
  }

  return {
    name: "music",
    description: "AI 音乐生成（基于 Strudel + 采样库）",

    onLoad(pluginCtx: PluginContext) {
      ctx = pluginCtx;
      const prefix = menu.getPrefix();
      const libs = listLibraries();

      menu.registerCommand(
        "music",
        `AI 音乐生成：${prefix}music <描述> [--lib <采样库>] | render [--lib <采样库>] [--cycles <1-${MAX_RENDER_CYCLES}>] <Strudel代码> | list | download <id> | voice <id> | code <id> | libs`,
        async (message, args) => {
          const sub = args[0];

          if (!sub) {
            await ctx.replyText(message, `用法：\n  ${prefix}music <描述> [--lib <库名>] - 生成音乐\n  ${prefix}music render [--lib <库名>] [--cycles <1-${MAX_RENDER_CYCLES}>] <Strudel代码> - 直接渲染代码\n  ${prefix}music list - 查看已生成\n  ${prefix}music download <id> - 下载原始 WAV\n  ${prefix}music voice <id> - 发送语音版\n  ${prefix}music code <id> - 查看 Strudel 代码\n  ${prefix}music libs - 查看可用采样库`);
            return;
          }

          if (sub === "libs") {
            const lines = libs.map(l => `  ${l.name}: ${l.label} - ${l.desc}`);
            await ctx.replyText(message, `可用采样库：\n${lines.join("\n")}`);
            return;
          }

          if (sub === "list") {
            const userId = message.userId;
            if (!userId) {
              await ctx.replyText(message, "无法确定你的用户 ID。");
              return;
            }
            const records = loadRecords(userId);
            if (records.length === 0) {
              await ctx.replyText(message, "你还没有生成过音乐。使用 $music <描述> 来创作第一首。");
              return;
            }
            const lines = records.map((r, i) =>
              `${i + 1}. [${r.id}] ${r.title} · ${getLibName(r.library)} · ${new Date(r.createdAt).toLocaleString("zh-CN")}`
            );
            await ctx.replyText(message, `你的音乐列表（共 ${records.length} 首）：\n${lines.join("\n")}`);
            return;
          }

          if (sub === "download") {
            const userId = message.userId;
            if (!userId || !args[1]) {
              await ctx.replyText(message, `用法：${prefix}music download <id>`);
              return;
            }
            const records = loadRecords(userId);
            const record = records.find(r => r.id === args[1]);
            if (!record) {
              await ctx.replyText(message, `未找到 ID 为 "${args[1]}" 的音乐。使用 ${prefix}music list 查看。`);
              return;
            }
            if (!fs.existsSync(record.filePath)) {
              await ctx.replyText(message, "文件不存在，可能已被清理。");
              return;
            }
            const target = message.type === "group" && message.groupId
              ? { type: "group" as const, id: message.groupId }
              : { type: "private" as const, id: userId };
            await ctx.sendMessage(target, `[音乐] ${record.title}（${getLibName(record.library)}）`);
            await ctx.sendFile(target, record.filePath, `${record.id}.wav`);
            return;
          }

          if (sub === "voice") {
            const userId = message.userId;
            if (!userId || !args[1]) {
              await ctx.replyText(message, `用法：${prefix}music voice <id>`);
              return;
            }
            const records = loadRecords(userId);
            const record = records.find(r => r.id === args[1]);
            if (!record) {
              await ctx.replyText(message, `未找到 ID 为 "${args[1]}" 的音乐。使用 ${prefix}music list 查看。`);
              return;
            }
            if (!record.voiceFilePath || !fs.existsSync(record.voiceFilePath)) {
              await ctx.replyText(message, "这首音乐还没有可用的语音版。可以重新生成，或先使用 download 下载原始 WAV。");
              return;
            }
            const target = message.type === "group" && message.groupId
              ? { type: "group" as const, id: message.groupId }
              : { type: "private" as const, id: userId };
            await ctx.sendMessage(target, `[音乐语音] ${record.title}（${getLibName(record.library)}）`);
            await ctx.sendVoice(target, record.voiceFilePath);
            return;
          }

          if (sub === "code") {
            const userId = message.userId;
            if (!userId || !args[1]) {
              await ctx.replyText(message, `用法：${prefix}music code <id>`);
              return;
            }
            const records = loadRecords(userId);
            const record = records.find(r => r.id === args[1]);
            if (!record) {
              await ctx.replyText(message, `未找到 ID 为 "${args[1]}" 的音乐。使用 ${prefix}music list 查看。`);
              return;
            }
            await ctx.replyText(
              message,
              `[Strudel 代码] ${record.title}\nID: ${record.id}\n采样库: ${getLibName(record.library)}\n\n${record.strudelCode || "（没有保存代码）"}`
            );
            return;
          }

          if (sub === "render") {
            const userId = message.userId;
            if (!userId) {
              await ctx.replyText(message, "无法确定用户 ID。");
              return;
            }

            const parsed = parseRenderRequest(args, extractStrudelBody(message.text, prefix), libs);
            if (!parsed.ok) {
              await ctx.replyText(message, parsed.reason);
              return;
            }

            const target = getTarget(message, userId);
            const error = enqueue({
              mode: "render",
              userId,
              code: parsed.code,
              library: parsed.library,
              cycles: parsed.cycles,
              target,
            });
            if (error) {
              await ctx.replyText(message, error);
            }
            return;
          }

          // Generate music: parse --lib flag
          const allArgs = args;
          let library = "official";
          let goalArgs: string[] = [];

          for (let i = 0; i < allArgs.length; i++) {
            if (allArgs[i] === "--lib" && allArgs[i + 1]) {
              const libName = allArgs[i + 1];
              const found = libs.find(l => l.name === libName);
              if (found) {
                library = libName;
                i++; // skip value
              } else {
                await ctx.replyText(message, `未知采样库 "${libName}"。可用库：${libs.map(l => l.name).join(", ")}`);
                return;
              }
            } else {
              goalArgs.push(allArgs[i]);
            }
          }

          const goal = goalArgs.join(" ").trim();
          if (!goal) {
            await ctx.replyText(message, `用法：${prefix}music <描述> [--lib <库名>]\n示例：${prefix}music 欢快的钢琴曲 --lib ambient`);
            return;
          }

          const userId = message.userId;
          if (!userId) {
            await ctx.replyText(message, "无法确定用户 ID。");
            return;
          }

          const target = getTarget(message, userId);

          const error = enqueue({ mode: "generate", userId, goal, library, target });
          if (error) {
            await ctx.replyText(message, error);
          }
        }
      );
    },
  };
}
