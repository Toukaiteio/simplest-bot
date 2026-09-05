import type { NotifyTarget, OneBotMessageSegment, TransformContext } from "./types.js";
import { sanitizeAssistantOutput } from "./response-sanitizer.js";

export type ResponsePipelineDependencies = {
  splitResponse(text: string): Promise<string[] | null>;
  transformResponse(text: string, context?: TransformContext): Promise<OneBotMessageSegment[] | null>;
  parseTextSegments(text: string): OneBotMessageSegment[];
  /**
   * 发送一段消息段。若发送的消息中含图片，应返回该图片消息的 message_id，
   * 以便上层把"图片消息 id ↔ 原文(sourceText)"登记起来（引用时还原为原文）。
   */
  sendSegments(target: NotifyTarget, segments: OneBotMessageSegment[], sourceText?: string): Promise<string | void>;
  onAtMention?(target: NotifyTarget, userId: string, sourceText: string): void;
  splitLongText?(text: string, maxChars: number): string[];
  maxTextChars?: number;
};

export type ResponseSendOptions = {
  context?: TransformContext;
  /** 仅在第一条实际发送的消息前附加引用。 */
  quoteMessageId?: string;
  /**
   * 每条物理消息发送成功后回调其真实 message_id（可能多条）。
   * 用于把 bot 回复与真实 message_id 关联（持久化 / 图片原文注册表回填）。
   */
  onSentMessageIds?: (messageIds: string[]) => void;
};

/**
 * 模型输出之后的统一响应管线。它不读取或修改 ContextManager，
 * 因此不会改变 system/memory/user/assistant 层级与 prompt cache 前缀。
 */
export class ResponsePipeline {
  private readonly maxTextChars: number;

  constructor(private readonly deps: ResponsePipelineDependencies) {
    this.maxTextChars = deps.maxTextChars ?? 3000;
  }

  async send(target: NotifyTarget, rawText: string, options: ResponseSendOptions = {}): Promise<void> {
    const normalized = sanitizeAssistantOutput(rawText);
    if (!normalized) return;

    const logicalParts = await this.deps.splitResponse(normalized) ?? [normalized];
    let quotePending = options.quoteMessageId;

    for (const rawPart of logicalParts) {
      const part = sanitizeAssistantOutput(rawPart).trim();
      if (!part) continue;

      const transformed = await this.deps.transformResponse(part, options.context);
      const semanticSegments = transformed ?? [{ type: "text", data: { text: part } }];
      const parsedSegments = this.parseTextSegments(semanticSegments);
      this.trackMentions(target, parsedSegments, part);

      // 该逻辑段渲染成了图片（如 markdown-image 把长文本转图）：把原文 sourceText 一并传下去，
      // 便于发送成功后在"图片消息 id ↔ 原文"注册表中登记，供后续引用时还原为文本。
      const imageSourceText = parsedSegments.some((s) => s.type === "image") ? part : undefined;

      for (const physicalMessage of splitSegmentsByTextLength(parsedSegments, this.maxTextChars, this.deps.splitLongText)) {
        if (physicalMessage.length === 0) continue;
        const outgoing = quotePending
          ? [{ type: "reply", data: { id: quotePending } }, ...physicalMessage]
          : physicalMessage;
        quotePending = undefined;
        const sentId = await this.deps.sendSegments(target, outgoing, imageSourceText);
        if (sentId) options.onSentMessageIds?.([sentId]);
      }
    }
  }

  private parseTextSegments(segments: OneBotMessageSegment[]): OneBotMessageSegment[] {
    const parsed: OneBotMessageSegment[] = [];
    for (const segment of segments) {
      if (segment.type === "text" && typeof segment.data.text === "string") {
        parsed.push(...this.deps.parseTextSegments(segment.data.text));
      } else {
        parsed.push(segment);
      }
    }
    return parsed;
  }

  private trackMentions(target: NotifyTarget, segments: OneBotMessageSegment[], sourceText: string): void {
    if (target.type !== "group" || !this.deps.onAtMention) return;
    for (const segment of segments) {
      if (segment.type === "at") {
        this.deps.onAtMention(target, String(segment.data.qq ?? ""), sourceText);
      }
    }
  }
}

/** 按文本长度拆成物理消息，同时保留 reply/at/image 等 segment 的原有顺序。 */
export function splitSegmentsByTextLength(
  segments: OneBotMessageSegment[],
  maxChars: number,
  splitText: (text: string, maxChars: number) => string[] = (text, limit) => [text.slice(0, limit), text.slice(limit)].filter(Boolean),
): OneBotMessageSegment[][] {
  const messages: OneBotMessageSegment[][] = [];
  let current: OneBotMessageSegment[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length > 0) messages.push(current);
    current = [];
    currentChars = 0;
  };

  for (const segment of segments) {
    if (segment.type !== "text" || typeof segment.data.text !== "string") {
      current.push(segment);
      continue;
    }

    let rest = segment.data.text;
    while (rest.length > 0) {
      const capacity = maxChars - currentChars;
      if (capacity <= 0) { flush(); continue; }
      const piece = splitText(rest, capacity)[0] ?? rest.slice(0, capacity);
      if (piece) current.push({ type: "text", data: { ...segment.data, text: piece } });
      currentChars += piece.length;
      rest = rest.slice(piece.length);
      if (currentChars >= maxChars) flush();
    }
  }
  flush();
  return messages;
}
