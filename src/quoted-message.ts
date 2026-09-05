import { lookupSentImageText } from "./sent-image-texts.js";
import { getVoiceMessageText } from "./plugins/system/voice-message-registry.js";
import { findMediaPlaceholders } from "./media-ids.js";
import type { BotMessage } from "./types.js";

/**
 * 引用（回复）消息的统一还原器。
 *
 * 背景：bot 的长文本 / Markdown / 特殊格式回复会被渲染成图片消息发送（markdown-image 等）。
 * 用户随后引用这条图片消息时，从 QQ 拿回的只是 `[图片 file=...]` 占位符，原文已经丢失。
 *
 * 按以下优先级还原被引用消息的真实内容：
 *
 * 1. bot 自己发送的图片型消息 → sent-image-texts 注册表（发送时登记的原文，持久化）；
 * 2. bot 自己发送的语音消息   → voice-message-registry（TTS 发送时登记的朗读文本）；
 * 3. 本地消息库 messageStore  → 用户消息等入站记录（含完整 message_id + message_json）；
 * 4. OneBot get_msg 远端兜底。
 *
 * 若被引用的是图片且原文无法还原（超出注册表周期 / 重启前发送 / 未登记），则进入
 * "默认识图模式"：把图片本体下载为 base64 随 prompt 提供给模型直接看图读字
 * （Agent.prompt 原生支持 images 参数，relay 会把图片上传给多模态上游）。
 * 识图也不可用（模型不支持 / 下载失败）时，返回明确的"内容不可读"说明，
 * 让模型如实告知用户，而不是编造。
 */
export type ResolvedQuotedImage = {
  /** 图片字节（纯 base64，不含 data: 前缀）。 */
  data: string;
  mimeType: string;
};

export type ResolvedQuotedMessage = {
  /** 还原后的内容文本（含 sender 标注 / 识图提示 / 诚实降级说明），随用户消息正文注入。 */
  text: string;
  /** 去掉图片本体后仍应交给模型的文本（识图兜底时为识图提示，正常还原时与 text 相同）。 */
  textWithoutImage: string;
  /** 识图兜底：被引用图片本体。仅在原文无法还原且图片可下载时存在。 */
  image?: ResolvedQuotedImage;
};

export type QuotedMessageResolverDeps = {
  findMessageById: (messageId: string) => BotMessage | null;
  getMessage: (messageId: string) => Promise<BotMessage | null>;
  /** 获取图片可读文件路径（OneBot get_image），识图兜底用。 */
  getImageFile: (fileId: string) => Promise<string | null>;
  /** 读取本地/远端文件为 base64，识图兜底用。 */
  downloadFileToBase64: (filePath: string) => Promise<string | null>;
  /** 获取媒体文件的远端 url（QQ 服务器多级回退链），识图兜底用。 */
  getMediaFileUrl?: (action: string, fileId: string) => Promise<string | null>;
  /** 下载远端 url 为 base64，识图兜底用（本地文件被清理/过期时）。 */
  downloadUrlToBase64?: (url: string) => Promise<string | null>;
};

/** extractText 生成的媒体占位符（media-ids.ts mediaPlaceholder）。 */
export const IMAGE_PLACEHOLDER_RE = /^\[图片( file=[^\]]+)?\]$/;
export const VOICE_PLACEHOLDER_RE = /^\[语音( file=[^\]]+)?\]$/;
const MAX_CHARS = 500;

export type QuotedMessageResolver = (message: BotMessage) => Promise<ResolvedQuotedMessage | null>;

export function createQuotedMessageResolver(deps: QuotedMessageResolverDeps): QuotedMessageResolver {
  return async (message) => {
    const quotedId = message.replyToMessageId;
    if (!quotedId) return null;

    // 1) bot 自己发送的图片型消息（markdown-image 等把原文转图）：还原为生成它的原文。
    //    原文不截断（完整原文才是事实来源；长度由 prompt 上下文管理兜底），
    //    不附图片本体——文本已完备，避免多模态上游的额外开销。
    const registered = lookupSentImageText(quotedId);
    if (registered) {
      const text = `Bot（你自己）此前发送的一条图片消息的完整原文如下，请直接依据它回答（不要复述这段包装文字）：\n<<<\n${registered.text}\n>>>`;
      return { text, textWithoutImage: text };
    }

    // 2) bot 自己发送的语音消息：还原为实际朗读文本。
    const voiceText = getVoiceMessageText(quotedId);
    if (voiceText) {
      const text = `Bot（你自己）此前发送的一条语音消息的内容：${clip(voiceText)}`;
      return { text, textWithoutImage: text };
    }

    // 3) 本地消息库 → 4) OneBot get_msg。
    const referenced = deps.findMessageById(quotedId) ?? await deps.getMessage(quotedId);
    if (!referenced) return null;

    const text = referenced.text?.trim() ?? "";
    const isFromBot = Boolean(referenced.selfId && referenced.selfId === referenced.userId);
    const who = isFromBot ? "Bot（你自己）" : `${referenced.userId ?? "unknown"}`;

    // 图片占位符：先尝试"默认识图模式"（下载图片本体给模型直接看），失败才诚实降级。
    if (IMAGE_PLACEHOLDER_RE.test(text)) {
      const image = await tryLoadQuotedImage(text, deps);
      if (image) {
        return {
          text: `（${who}发送的一条图片消息，原文无法还原；图片本体已作为图像附加在本消息中，请直接读取图中的文字与内容。）`,
          textWithoutImage: `（${who}发送的一条图片消息，原文无法还原；图片本体已作为图像附加在本消息中。）`,
          image,
        };
      }
      return {
        text: isFromBot
          ? `${who}此前发送的一条图片消息：图片内的文字内容未登记、无法读取。请如实告知用户你无法查看图片内容，不要编造。`
          : `${who}: （这是一条图片消息，图片内的文字无法读取。）`,
        textWithoutImage: isFromBot
          ? `${who}此前发送的一条图片消息：图片内的文字内容未登记、无法读取。请如实告知用户你无法查看图片内容，不要编造。`
          : `${who}: （这是一条图片消息，图片内的文字无法读取。）`,
      };
    }

    if (VOICE_PLACEHOLDER_RE.test(text)) {
      const voiceNote = isFromBot
        ? `${who}此前发送的一条语音消息：朗读内容未登记、无法读取。请如实告知用户你无法回听语音内容，不要编造。`
        : `${who}: （这是一条语音消息，语音内容无法读取。）`;
      return { text: voiceNote, textWithoutImage: voiceNote };
    }

    const plain = `${who}: ${clip(text)}`;
    return { text: plain, textWithoutImage: plain };
  };
}

/** 识图兜底：从图片占位符文本提取 file id，多级下载为 base64（本地文件 → QQ 服务器 url 回退链）。 */
async function tryLoadQuotedImage(
  placeholderText: string,
  deps: QuotedMessageResolverDeps,
): Promise<ResolvedQuotedImage | undefined> {
  try {
    const media = findMediaPlaceholders(placeholderText)
      .find((entry) => entry.type === "图片" && entry.fileId);
    if (!media) return undefined;

    // 一级：NapCat 本地缓存文件（get_image 的 file/path 字段）。
    const filePath = await deps.getImageFile(media.fileId);
    if (filePath) {
      const base64 = await deps.downloadFileToBase64(filePath);
      if (base64) return { data: base64, mimeType: inferImageMime(filePath) };
    }

    // 二级：QQ 服务器多级回退 url（multimedia.nt.qq.com.cn → gchat.qpic.cn → rlogin.qpic.cn）。
    // bot 渲染的图片本地文件很快被清理（markdownImage.cleanupDelayMs 默认 2 分钟），
    // 引用"很久之前"的图片时本地文件几乎必然已删，只有 url 链路可用。
    if (deps.getMediaFileUrl && deps.downloadUrlToBase64) {
      const url = await deps.getMediaFileUrl("get_image", media.fileId);
      if (url) {
        const base64 = await deps.downloadUrlToBase64(url);
        if (base64) return { data: base64, mimeType: inferImageMime(url) };
      }
    }

    return undefined;
  } catch (error) {
    console.warn("[QuotedMessage] 识图兜底加载被引用图片失败：", error);
    return undefined;
  }
}

function inferImageMime(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    default: return "image/png";
  }
}

function clip(value: string): string {
  return value.length > MAX_CHARS ? value.slice(0, MAX_CHARS) + "..." : value;
}
