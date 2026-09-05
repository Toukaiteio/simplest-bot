/**
 * gemini-web2api 的 Node.js 移植：OpenAI/Google 消息 → Gemini Web prompt。
 * 角色展平与 python 版 tools.py 对齐；图片 part 不再占位为 `[Image attached]`，
 * 而是收进 images 描述列表，由服务端解析字节 → Scotty 上传 → 织入 payload。
 */
import type { ImagePart } from "./multimodal.js";

export type RelayChatMessage = {
  role: string;
  content?: unknown;
  name?: string;
};

export type FlattenedPrompt = {
  /** 发给上游的纯文本 prompt。 */
  prompt: string;
  /** 消息中携带的图片描述列表（url/data/dataUrl/base64），由服务端上传为 file refs。 */
  images: ImagePart[];
};

/**
 * OpenAI 聊天消息 → 文本。system→`[System instruction]: ...`；assistant→`[Assistant]: ...`；
 * tool→`[Tool result for <name>]: ...`；其它角色原文；空段过滤；图片 part 收进 images
 * 并仅在该处插入简短占位（供上传后由 refs 携带，正文不再出现二进制）。
 */
export function messagesToPrompt(messages: RelayChatMessage[]): FlattenedPrompt {
  const parts: string[] = [];
  const images: FlattenedPrompt["images"] = [];

  for (const message of messages) {
    const { text, collected } = flattenContent(message.content);
    images.push(...collected);
    const content = text;
    if (!content) continue;

    if (message.role === "system") {
      parts.push(`[System instruction]: ${content}`);
    } else if (message.role === "assistant") {
      parts.push(`[Assistant]: ${content}`);
    } else if (message.role === "tool") {
      parts.push(`[Tool result for ${message.name ?? ""}]: ${content}`);
    } else {
      parts.push(content);
    }
  }

  return { prompt: parts.filter(Boolean).join("\n\n"), images };
}

function flattenContent(content: unknown): { text: string; collected: ImagePart[] } {
  if (typeof content === "string") return { text: content, collected: [] };

  if (Array.isArray(content)) {
    const pieces: string[] = [];
    const collected: ImagePart[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const type = (part as { type?: unknown }).type;
      if (type === "text" || type === "input_text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") pieces.push(text);
      } else if (type === "image_url" || type === "input_image" || type === "image") {
        const image = parseImagePart(part);
        if (image) {
          collected.push(image);
          pieces.push("[Image attached]");
        }
      }
      // 其它 part 类型不投递。
    }
    return { text: pieces.filter(Boolean).join(" "), collected };
  }

  return { text: "", collected: [] };
}

/** 从 image_url / input_image / image 类型的 part 提取图片描述。 */
function parseImagePart(part: unknown): ImagePart | null {
  const record = (part ?? {}) as Record<string, unknown>;
  const type = record.type;
  let url: unknown;
  let mime: unknown;
  let data: unknown;

  if (type === "image_url") {
    const imageUrl = record.image_url;
    if (imageUrl && typeof imageUrl === "object") {
      const ur = imageUrl as Record<string, unknown>;
      url = ur.url;
      mime = ur.mime_type;
    } else {
      url = imageUrl;
    }
  } else {
    const imageUrl = record.image_url ?? record.url;
    if (imageUrl && typeof imageUrl === "object") {
      const ur = imageUrl as Record<string, unknown>;
      url = ur.url;
      mime = ur.mime_type;
    } else if (imageUrl) {
      url = imageUrl;
    }
    data = record.data ?? record.base64;
    if (!mime) mime = record.mime_type ?? (record as { media_type?: unknown }).media_type;
  }

  const urlStr = typeof url === "string" && url ? url : undefined;
  const dataStr = typeof data === "string" && data ? data : undefined;
  if (!urlStr && !dataStr) return null;
  // data: 前缀的 URL 归为 dataUrl（供服务端直接解码字节），而不是当远程 http 下载。
  if (urlStr?.startsWith("data:")) {
    return { dataUrl: urlStr, ...(typeof mime === "string" && mime ? { mime } : {}) };
  }
  return {
    ...(urlStr ? { url: urlStr } : {}),
    ...(dataStr ? { data: dataStr } : {}),
    ...(typeof mime === "string" && mime ? { mime } : {}),
  };
}

/** generateContent 请求的 contents 结构。 */
export type GoogleContent = {
  role?: string;
  parts?: Array<{
    text?: string;
    inlineData?: { data?: string; mimeType?: string };
    functionCall?: { name?: string; args?: unknown };
    functionResponse?: { name?: string; response?: unknown };
  }>;
};

export type GooglePrompt = {
  prompt: string;
  images: ImagePart[];
};

/**
 * Google 原生 generateContent → 文本与图片列表。text 原文；inlineData（图片 base64）
 * 收进 images 供上传；functionCall/functionResponse 渲染为文本（与 python 对齐）。
 */
export function googleContentsToPrompt(
  systemInstruction: { parts?: GoogleContent["parts"] } | undefined,
  contents: GoogleContent[] | undefined,
): GooglePrompt {
  const parts: string[] = [];
  const images: ImagePart[] = [];
  if (systemInstruction?.parts) {
    const systemText = systemInstruction.parts
      .filter((part): part is { text: string } => typeof part.text === "string")
      .map((part) => part.text)
      .join(" ");
    if (systemText) parts.push(systemText);
  }

  for (const content of contents ?? []) {
    const contentParts: string[] = [];
    for (const part of content.parts ?? []) {
      if (typeof part.text === "string") {
        contentParts.push(part.text);
      } else if (part.inlineData) {
        images.push({ data: part.inlineData.data, mime: part.inlineData.mimeType });
        contentParts.push("[Image attached]");
      } else if (part.functionCall) {
        contentParts.push(JSON.stringify(part.functionCall));
      } else if (part.functionResponse) {
        contentParts.push(JSON.stringify(part.functionResponse.response ?? {}));
      }
    }
    const joined = contentParts.join("\n");
    if (!joined) continue;
    if (content.role === "model") parts.push(`[Assistant]: ${joined}`);
    else parts.push(joined);
  }
  return { prompt: parts.filter(Boolean).join("\n\n"), images };
}
