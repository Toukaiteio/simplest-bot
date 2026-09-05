import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BotMessage, BotConfig, NotifyTarget, Plugin, PluginContext, PromptBuildInput } from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";
import { getInputMessage } from "../../security/access-control.js";
import { registerVoiceMessageText } from "./voice-message-registry.js";

export type TtsAudioFormat = "mp3" | "wav" | "pcm" | "opus";

export type TtsSynthesisRequest = {
  text: string;
  model: string;
  referenceId: string;
  format: TtsAudioFormat;
};

export type TtsProvider = {
  synthesize: (request: TtsSynthesisRequest) => Promise<Uint8Array>;
};

export type PreparedSpeechText = {
  /** Text sent to Fish Audio, including any generated/explicit S2 tags. */
  speechText: string;
  /** Text to persist/use for a text fallback, without provider tags/noise. */
  fallbackText: string;
  /** The primary emotion selected for this utterance, if any. */
  emotion: string | null;
};

type VoiceTtsConfig = BotConfig["pluginSettings"]["tts"];
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type VoiceTtsPlugin = Plugin & {
  getToolRegistrations: () => BotToolRegistration[];
  /** 返回仍在后台合成/发送中的 TTS 任务，便于测试与优雅停机时等待。 */
  inflight: () => Promise<unknown>[];
};

type VoiceTtsPluginOptions = {
  provider?: TtsProvider;
};

/**
 * Fish Audio implementation behind the small provider boundary. The plugin
 * currently ships with Fish only, while the boundary leaves room for another
 * TTS provider without changing the Agent tool contract.
 */
export class FishAudioTtsProvider implements TtsProvider {
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly config: VoiceTtsConfig,
    fetchFn: FetchLike = fetch,
  ) {
    this.fetchFn = fetchFn;
  }

  async synthesize(request: TtsSynthesisRequest): Promise<Uint8Array> {
    const apiKey = this.config.apiKey.trim();
    if (!apiKey) throw new Error("Fish Audio TTS API key 未配置。");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(buildTtsEndpoint(this.config.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: audioMimeType(request.format),
          model: request.model,
        },
        body: JSON.stringify({
          text: request.text,
          reference_id: request.referenceId,
          format: request.format,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Fish Audio TTS 请求超时（${this.config.timeoutMs}ms）。`);
      }
      throw new Error(`Fish Audio TTS 请求失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const suffix = detail.trim() ? `：${detail.trim().slice(0, 500)}` : "";
      throw new Error(`Fish Audio TTS 请求失败（HTTP ${response.status}）${suffix}`);
    }

    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) throw new Error("Fish Audio TTS 返回了空音频。");
    return audio;
  }
}

const FISH_AUDIO_PROMPT = [
  "你可以调用 send_voice_message_tts 发送语音消息。对每一条语音，你必须显式指定一个合适的情绪（emotion），让听感自然有温度，而不能把无情绪的正文直接丢给它。用户明确要求语音、TTS、朗读或用声音回复时，必须调用它。每轮通常最多发送一条语音。",
  "语音工具成功发送后已经完成最终交付，立即结束本轮，不要再调用 send_current_reply；如果工具返回已自动回退文字，也已经完成交付，同样不要重复发送。工作结果、代码、命令、路径、表格、长文和工具原始输出不要转成语音。",
  "含链接的内容不要走语音：只要正文里有链接，就不应调用 send_voice_message_tts，改用 send_current_reply（宿主会按文本或图像输出并单独列出链接）。",
  "emotion 参数用于控制情绪：请根据本条消息的语义主动选择，例如 happy（开心）、sad（难过）、angry（生气）、excited（兴奋）、calm(平静)、nervous(紧张）、confident（自信）、surprised（惊讶）、satisfied（满足）、delighted（愉悦）、grateful（感激）、curious（好奇）、sarcastic（讽刺）、whispering（耳语）、long-break（长停顿）等等。选择要贴合内容，不要无脑套用 happy。",
  "如需在同一句内局部改变语气，也可在 text 里使用方括号标签，例如 [happy] 好消息完成了。[sad] 不过那边出了点问题。每个句子优先使用一个主情绪，最多组合三个标签；不要滥用或组合冲突情绪。",
  "工具 text 应以自然语言为主；其中的颜文字、emoji、波浪号（～/~）、装饰符号、Markdown、链接、CQ 码和代码标记会在朗读前自动清理。发音内容要简洁口语，适合朗读，避免过于书面化。断句直接使用标准标点（，。！？…），不要用 ～、~ 或装饰符号表达语气——它们会让合成的停顿变得不自然；语气交给语气词（呢、啦、哦、呀）和标点本身，多用短句、少用长从句。",
  "基础情绪标签：happy、sad、angry、excited、calm、nervous、confident、surprised、satisfied、delighted、scared、worried、upset、frustrated、depressed、empathetic、embarrassed、disgusted、moved、proud、relaxed、grateful、curious、sarcastic。",
  "高级情绪标签：disdainful、unhappy、anxious、hysterical、indifferent、uncertain、doubtful、confused、disappointed、regretful、guilty、ashamed、jealous、envious、hopeful、optimistic、pessimistic、nostalgic、lonely、bored、contemptuous、sympathetic、compassionate、determined、resigned。",
  "还可以使用语气/音效标签：[in a hurry tone]、[shouting]、[whispering]、[soft tone]、[emphasis]、[laughing]、[chuckling]、[sighing]、[gasping]、[yawning]、[break]、[long-break]。默认 S2 使用方括号，不要改用 S1 的圆括号格式。",
].join("\n");

const FISH_AUDIO_MARKERS = [
  "happy", "sad", "angry", "excited", "calm", "nervous", "confident", "surprised",
  "satisfied", "delighted", "scared", "worried", "upset", "frustrated", "depressed",
  "empathetic", "embarrassed", "disgusted", "moved", "proud", "relaxed", "grateful",
  "curious", "sarcastic", "disdainful", "unhappy", "anxious", "hysterical", "indifferent",
  "uncertain", "doubtful", "confused", "disappointed", "regretful", "guilty", "ashamed",
  "jealous", "envious", "hopeful", "optimistic", "pessimistic", "nostalgic", "lonely",
  "bored", "contemptuous", "sympathetic", "compassionate", "determined", "resigned",
  "in a hurry tone", "shouting", "screaming", "whispering", "soft tone", "emphasis",
  "laughing", "chuckling", "sobbing", "crying loudly", "sighing", "groaning", "panting",
  "gasping", "yawning", "snoring", "clear throat", "audience laughing", "background laughter",
  "crowd laughing", "break", "long-break",
];
const FISH_AUDIO_MARKER_PATTERN = new RegExp(
  `\\[(?:${FISH_AUDIO_MARKERS.map(escapeRegExp).join("|")})\\]\\s*`,
  "giu",
);
const FISH_AUDIO_EMOTIONS = [
  "happy", "sad", "angry", "excited", "calm", "nervous", "confident", "surprised",
  "satisfied", "delighted", "scared", "worried", "upset", "frustrated", "depressed",
  "empathetic", "embarrassed", "disgusted", "moved", "proud", "relaxed", "grateful",
  "curious", "sarcastic", "disdainful", "unhappy", "anxious", "hysterical", "indifferent",
  "uncertain", "doubtful", "confused", "disappointed", "regretful", "guilty", "ashamed",
  "jealous", "envious", "hopeful", "optimistic", "pessimistic", "nostalgic", "lonely",
  "bored", "contemptuous", "sympathetic", "compassionate", "determined", "resigned",
];
const FISH_AUDIO_EMOTION_MARKER_PATTERN = new RegExp(
  "\\[(" + FISH_AUDIO_EMOTIONS.map(escapeRegExp).join("|") + ")\\]",
  "iu",
);
const KAO_MOJI_PATTERN =
  /(?:\([^()\r\n]{1,48}\)|（[^（）\r\n]{1,48}）|[╰╭][^╰╭╯╮\r\n]{1,48}[╯╮]|[┌┐][^┌┐└┘\r\n]{1,48}[└┘])/gu;
const ASCII_EMOTICON_PATTERN =
  /(?:[:;=8][\-^']?[)(\/\\DPpOo*]|[xX]D|[oO]_[oO]|[uU]w[uU]|[oO]rz|>[_.<]|<3)/gu;
const STANDALONE_KAOMOJI_PATTERN = /(?:QAQ|Q_Q|T_T|T﹏T|OwO|O_O|o_O|UwU|uWu|orz)/gu;
const CQ_CODE_PATTERN = /\[CQ:[^\]\r\n]*\]/giu;
const MARKDOWN_LINK_PATTERN = /!?\[([^\]\r\n]*)\]\((?:[^()]|\([^)]*\))*\)/gu;
const URL_PATTERN = /https?:\/\/[^\s<>]+/giu;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/gu;
const EMOTION_SIGNAL_PATTERN = /(?:开心|高兴|太好了|棒|成功|完成|欢迎|你好|嗨|早上好|晚安|哈哈|笑死|庆祝|喜欢|爱你|谢谢|感谢|辛苦|抱歉|对不起|难过|伤心|遗憾|担心|害怕|生气|愤怒|烦|麻烦|失败|问题|为什么|怎么回事|好奇|疑惑|困惑|不确定|马上|紧急|加油|坚持)/iu;
/** 方括号内的中文朗读控制词：不适用于朗读(Audible)，出现时应整体剔除而非照读。 */
const SPEECH_CONTROL_MARKER = /重音|轻声|停顿|拖长|放慢|加快|换气|气声|轻读|缓读|渐快|渐慢/iu;

export function createVoiceTtsPlugin(options: VoiceTtsPluginOptions = {}): VoiceTtsPlugin {
  const ctxRef = { current: null as PluginContext | null };
  /** 后台合成/发送中的任务，便于测试与停机前等待。 */
  const inflightTts: Array<Promise<unknown>> = [];
  function trackInflight(promise: Promise<void>): void {
    inflightTts.push(promise);
    void promise.finally(() => {
      const index = inflightTts.indexOf(promise);
      if (index >= 0) inflightTts.splice(index, 1);
    });
  }

  const plugin: VoiceTtsPlugin = {
    name: "voice-tts",
    description: "Fish Audio TTS 语音消息工具",
    systemPromptAppend: FISH_AUDIO_PROMPT,

    async onLoad(ctx) {
      ctxRef.current = ctx;
      const outputDir = path.resolve(process.cwd(), ctx.config.pluginSettings.tts.outputDir);
      await fs.mkdir(outputDir, { recursive: true });
      console.log(`[TTS] Fish Audio 语音插件已加载，默认模型：${ctx.config.pluginSettings.tts.model}`);
    },

    getToolRegistrations() {
      return [
        {
          definition: {
            type: "function",
            function: {
              name: "send_voice_message_tts",
              description: "使用 Fish Audio 将适合朗读的普通聊天内容合成为语音，并发送到当前私聊或群聊。必须显式指定 emotion 以控制语气；成功发送或失败回退文字后都会结束当前交付，不要再调用 send_current_reply。",
              parameters: {
                type: "object",
                properties: {
                  text: {
                    type: "string",
                    description: "要朗读的内容，简洁口语、适合朗读。可以包含 Fish Audio S2 方括号情绪标签；不要放代码、长 Markdown、工具原始输出或 API 密钥。",
                  },
                  emotion: {
                    type: "string",
                    enum: FISH_AUDIO_EMOTIONS,
                    description: "本条语音的主情绪，需根据语义主动选择（如 happy、sad、angry、excited、calm、nervous、confident、surprised、grateful、curious、sarcastic、whispering 等）。不要无脑套用 happy。",
                  },
                },
                required: ["text", "emotion"],
                additionalProperties: false,
              },
            },
          },
          execute: async (args, input) => {
            const ctx = ctxRef.current;
            if (!ctx) throw new Error("TTS 插件尚未初始化。");
            const config = ctx.config.pluginSettings.tts;
            const explicitEmotion = typeof args.emotion === "string" && args.emotion.trim()
              ? args.emotion.trim().toLowerCase()
              : "";
            const prepared = prepareSpeechText(args.text, config.maxTextChars, explicitEmotion || undefined);
            const message = getInputMessage(input);

            // 所有含链接的回复一律不走语音：回退到文本/图像输出，避免语音吞掉链接。
            if (containsUrl(args.text)) {
              const linkText = prepared.fallbackText;
              console.log("[TTS] 文本含链接，自动回退为文本/图像输出，不发送语音。");
              await ctx.replyText(message, linkText);
              return {
                text: "内容含链接，已自动回退为文本/图像输出。",
                final: true,
                deliveredText: linkText,
              };
            }

            const text = prepared.speechText;
            const provider = options.provider ?? new FishAudioTtsProvider(config);
            // 语音合成与发送在后台异步执行，不阻塞 Agent 主流程：工具先返回“已排队”，
            // 拿到音频后再发送；失败则在后台自动回退文字。
            console.log(`[TTS] 语音已排队，后台合成中（${text.length} 字，${config.model}，情绪：${prepared.emotion ?? "auto"}）`);
            const background: Promise<void> = (async () => {
              let filePath: string | undefined;
              try {
                const audio = await provider.synthesize({
                  text,
                  model: config.model,
                  referenceId: config.referenceId,
                  format: config.format,
                });

                const outputDir = path.resolve(process.cwd(), config.outputDir);
                await fs.mkdir(outputDir, { recursive: true });
                filePath = path.join(outputDir, `tts-${Date.now()}-${randomUUID()}.${config.format}`);
                await fs.writeFile(filePath, audio);
                const sentMessageId = await ctx.sendVoice(getTarget(message), filePath);
                if (sentMessageId) {
                  registerVoiceMessageText(sentMessageId, prepared.fallbackText);
                }
              } catch (error) {
                console.warn("[TTS] 语音发送失败，自动回退文字：", error);
                const fallbackText = prepared.fallbackText;
                try {
                  await ctx.replyText(message, fallbackText);
                } catch (fallbackError) {
                  console.error("[TTS] 文字回退也发送失败：", fallbackError);
                }
              } finally {
                if (filePath) {
                  await fs.rm(filePath, { force: true }).catch((error) => {
                    console.warn(`[TTS] 清理临时音频失败：${filePath}`, error);
                  });
                }
              }
            })();
            trackInflight(background);
            return {
              text: `语音已排队，将在后台合成并发送（${text.length} 字，${config.model}）。`,
              final: true,
              deliveredText: prepared.fallbackText,
            };
          },
        },
      ];
    },

    inflight: () => inflightTts,
  };

  return plugin;
}

function buildTtsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/v1/tts")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/tts`;
  return `${normalized}/v1/tts`;
}

function audioMimeType(format: TtsAudioFormat): string {
  if (format === "wav") return "audio/wav";
  if (format === "opus") return "audio/ogg, audio/opus";
  if (format === "pcm") return "audio/pcm";
  return "audio/mpeg";
}

export function prepareSpeechText(value: unknown, maxChars: number, explicitEmotion?: string): PreparedSpeechText {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("text 必须是非空字符串。");
  }
  const rawText = value.trim();
  // Reject pathological input before cleanup, while allowing decorative
  // symbols to be removed when the actual spoken text is within the limit.
  if (rawText.length > Math.max(maxChars * 4, maxChars + 200)) {
    throw new Error(`语音内容不能超过 ${maxChars} 个字符。`);
  }

  const markers: string[] = [];
  const emotionSignals: string[] = [];
  let text = rawText.replace(FISH_AUDIO_MARKER_PATTERN, (marker) => {
    markers.push(marker.trim());
    return `\uE000${markers.length - 1}\uE001`;
  });

  text = text
    .replace(CQ_CODE_PATTERN, " ")
    .replace(MARKDOWN_LINK_PATTERN, "$1")
    .replace(URL_PATTERN, " ")
    .replace(/<[^>\r\n]{1,120}>/gu, " ")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`\r\n]*)`/gu, "$1")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gmu, "");

  text = text.replace(KAO_MOJI_PATTERN, (candidate) => {
    if (!looksLikeKaomoji(candidate)) return candidate;
    const emotion = inferKaomojiEmotion(candidate);
    if (emotion) emotionSignals.push(emotion);
    return " ";
  });
  text = text.replace(ASCII_EMOTICON_PATTERN, (candidate) => {
    const emotion = inferKaomojiEmotion(candidate);
    if (emotion) emotionSignals.push(emotion);
    return " ";
  });
  text = text.replace(STANDALONE_KAOMOJI_PATTERN, (candidate) => {
    const emotion = inferKaomojiEmotion(candidate);
    if (emotion) emotionSignals.push(emotion);
    return " ";
  });
  text = text.replace(EMOJI_PATTERN, (emoji) => {
    const emotion = inferEmojiEmotion(emoji);
    if (emotion) emotionSignals.push(emotion);
    return " ";
  });
  text = text.replace(/[*_`#|@#$%^&=+<>—–·•▪▫◦\\]/gu, " ");
  text = text
    .replace(/[\u200D\uFE0E\uFE0F]/gu, "");
  text = normalizeTildes(text);
  text = text
    .replace(/[★☆✦✧※◆◇■□●○◎△▽◁▷♢♧♤♠♥♡♦♣♪♫♬∞≈≠≤≥→←↑↓]/gu, (symbol) => {
      const emotion = inferEmojiEmotion(symbol);
      if (emotion) emotionSignals.push(emotion);
      return " ";
    })
    .replace(/\.{3,}/gu, "…")
    .replace(/([!?！？])\1{2,}/gu, "$1$1")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n");
  text = normalizeCjkSpacing(text).trim();

  text = text.replace(/\[([^\]\r\n]{1,80})\]/gu, (whole, inner: string) => {
    // Unknown bracket metadata is not useful to a speech engine. Known Fish
    // tags are represented by private-use placeholders and restored below.
    // 中文朗读控制词（重音/轻声/停顿…）整体剔除，避免被当成正文朗读。
    const trimmed = inner.trim();
    if (!trimmed) return " ";
    if (SPEECH_CONTROL_MARKER.test(trimmed)) return " ";
    return trimmed;
  });
  text = restoreFishAudioMarkers(text, markers)
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/ \n/g, "\n")
    .replace(/\n /g, "\n")
    .trim();

  const markerEmotion = text.match(FISH_AUDIO_EMOTION_MARKER_PATTERN)?.[1]?.toLowerCase() ?? null;
  const emotion = explicitEmotion && FISH_AUDIO_MARKERS.includes(explicitEmotion)
    ? explicitEmotion
    : (markerEmotion ?? inferEmotion(text, emotionSignals));
  const spokenBody = stripFishAudioMarkers(text);
  const generatedBody = fallbackForEmotion(markerEmotion ?? emotion ?? inferEmotion(rawText, emotionSignals));
  const speechText = markerEmotion
    ? (spokenBody ? text : `${text} ${generatedBody}`).trim()
    : `${emotion ? `[${emotion}] ` : ""}${spokenBody || generatedBody}`.trim();
  const fallbackText = spokenBody || generatedBody;
  if (!speechText || !fallbackText) {
    throw new Error("语音内容清理后为空。请提供可朗读的文字。");
  }
  if (speechText.length > maxChars) {
    throw new Error(`语音内容不能超过 ${maxChars} 个字符。`);
  }

  return { speechText, fallbackText, emotion };
}

function stripFishAudioMarkers(text: string): string {
  return text
    .replace(FISH_AUDIO_MARKER_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function restoreFishAudioMarkers(text: string, markers: string[]): string {
  return text.replace(/\uE000(\d+)\uE001/gu, (_whole, index: string) => {
    const marker = markers[Number(index)];
    return marker ? `${marker} ` : "";
  });
}

/**
 * 语气波浪号（～/~）归一化。Fish S2 对 ～ 的停顿处理不稳定，本地 A/B 试听
 * （data/tts-ab）确认归一为常规标点显著更自然：句尾收束为终止标点，句中转为逗号。
 */
function normalizeTildes(text: string): string {
  return text
    // “3~5”这类区间应读作“三到五”，不能当停顿处理。
    .replace(/([0-9A-Za-z])[ \t]*[~～]{1,}[ \t]*(?=[0-9A-Za-z])/gu, "$1到")
    .replace(/[~～]{1,}/gu, (_run: string, offset: number, source: string) => {
      const before = source.slice(0, offset);
      const rest = source.slice(offset + _run.length);
      if (/[!?！?。…][ \t]*$/u.test(before)) return "";
      if (rest.trim() === "" || /^[ \t]*\n/u.test(rest)) return "！";
      if (/^[ \t]*[!?！?。，、；;:：…]/u.test(rest)) return "";
      return "，";
    });
}

/** 中文标点与汉字旁的空格对朗读没有意义，只会带来意外停顿。 */
function normalizeCjkSpacing(text: string): string {
  return text
    .replace(/[ \t]+([，。！？；：、…])/gu, "$1")
    .replace(/([，。！？；：、…])[ \t]+(?=[\u4E00-\u9FFF])/gu, "$1")
    .replace(/([\u4E00-\u9FFF])[ \t]+(?=[\u4E00-\u9FFF])/gu, "$1");
}

function looksLikeKaomoji(candidate: string): boolean {
  const value = candidate.trim();
  if (value.length < 3 || value.length > 50 || /[\u3400-\u9FFF]/u.test(value)) return false;
  const inner = value.slice(1, -1);
  if (!/[ _^;；:：~～*´`'"•ω▽△◕◡≧≦ಥ╥ㅠㅜ﹏♡♥❤]/u.test(inner)) return false;
  const chars = [...value];
  const symbolCount = chars.filter((char) => /[^\p{L}\p{N}\s]/u.test(char)).length;
  return symbolCount / chars.length >= 0.35;
}

function inferKaomojiEmotion(value: string): string | null {
  if (/(?:╥|ಥ|ㅠ|ㅜ|﹏|哭|泣|QAQ|Q_Q|T_T|T﹏T|;_;)/iu.test(value)) return "sad";
  if (/(?:怒|气|生气|愤|╬|ಠ|ง|>_<)/iu.test(value)) return "angry";
  if (value.includes("/") || /(?:害羞|脸红|照れ)/iu.test(value)) return "embarrassed";
  if (/(?:亲|吻|么么|˘|³|<3|♡|♥|❤)/iu.test(value)) return "delighted";
  if (/(?:笑|开心|≧|▽|△|◕|ω|XD|UwU|uWu|O_O|o_O)/iu.test(value)) return "happy";
  return null;
}

function inferEmojiEmotion(value: string): string | null {
  if (/[😭😢😞😔😟😥😰😨😱]/u.test(value)) return "sad";
  if (/[😡😠🤬💢]/u.test(value)) return "angry";
  if (/[😂🤣😆😀😃😄😁😅😊🙂🙃😉😌]/u.test(value)) return "happy";
  if (/[😍🥰😘😗😙😚💖💕💗💓💞💝💘❤♥♡]/u.test(value)) return "delighted";
  if (/[🙏🤝]/u.test(value)) return "grateful";
  if (/[🤔🧐❓❔]/u.test(value)) return "curious";
  if (/[😳🫣]/u.test(value)) return "embarrassed";
  if (/[🎉🎊🔥]/u.test(value)) return "excited";
  return null;
}

function inferEmotion(text: string, signals: string[]): string {
  const signalPriority = [
    "sad", "empathetic", "angry", "frustrated", "scared", "worried", "embarrassed",
    "grateful", "curious", "excited", "delighted", "happy", "determined", "calm",
  ];
  for (const candidate of signalPriority) {
    if (signals.includes(candidate)) return candidate;
  }

  if (/(?:抱歉|对不起|理解你的感受|辛苦|难过|伤心|遗憾|担心)/iu.test(text)) return "empathetic";
  if (/(?:生气|愤怒|烦死|气死|糟糕|失败|报错|出问题|不爽)/iu.test(text)) return "frustrated";
  if (/(?:恭喜|太棒|太好了|成功|完成|搞定|好消息|庆祝)/iu.test(text)) return "delighted";
  if (/(?:谢谢|感谢|多谢)/iu.test(text)) return "grateful";
  if (/(?:你好|嗨|哈喽|欢迎|早上好|晚上好|晚安)/iu.test(text)) return "happy";
  if (/[?？]|(?:为什么|怎么|好奇|疑问)/iu.test(text)) return "curious";
  if (/[!！]{1,}|(?:加油|马上|立即|一定会)/iu.test(text)) return "excited";
  if (EMOTION_SIGNAL_PATTERN.test(text)) return "happy";
  return "calm";
}

function fallbackForEmotion(emotion: string): string {
  const fallback: Record<string, string> = {
    happy: "我很开心。",
    sad: "我有点难过。",
    angry: "我有点生气。",
    frustrated: "这件事让我有些烦恼。",
    embarrassed: "我有点不好意思。",
    delighted: "我很开心。",
    grateful: "谢谢你的心意。",
    curious: "我有点好奇。",
    excited: "太棒了！",
    empathetic: "我理解你的感受。",
    calm: "我在听。",
  };
  return fallback[emotion] ?? fallback.calm;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 判断文本是否包含可点击的链接（Markdown 链接或裸 URL）。 */
function containsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/i.test(value) || /(?:^|\s)https?:\/\/[^\s<>]+/i.test(value);
}

function getTarget(message: BotMessage): NotifyTarget {
  if (message.type === "group" && message.groupId) {
    return { type: "group", id: message.groupId };
  }
  if (message.type === "private" && message.userId) {
    return { type: "private", id: message.userId };
  }
  throw new Error("当前消息缺少可用的发送目标。");
}
