import type { Plugin } from "../../types.js";

const SPLIT_PATTERN = /\[Split\]/g;
const REPLY_PATTERN = /\[REPLY:\d+\]/g;

export function createSplitPlugin(): Plugin {
  return {
    name: "split",
    description: "让 AI 可以使用 [Split] 将回复拆分为多条消息依次发送",
    systemPromptAppend:
      "如需将回复分成多条消息发送，在每段之间使用 [Split] 分隔。每条消息会独立发送。每条消息最多引用一条回复。",

    onSplit(text: string): string[] | null {
      // 1. 如果显式使用了 [Split]，优先按此分割
      if (SPLIT_PATTERN.test(text)) {
        SPLIT_PATTERN.lastIndex = 0;
        const parts = text.split(SPLIT_PATTERN).map((p) => p.trim()).filter(Boolean);
        return parts.length > 1 ? parts : null;
      }

      // 2. 自动分割：多条 [REPLY:xxx] 强制按每条拆为独立消息
      const replyMatches = text.match(REPLY_PATTERN);
      if (replyMatches && replyMatches.length > 1) {
        REPLY_PATTERN.lastIndex = 0;
        const parts = text.split(/(?=\[REPLY:\d+\])/).map((p) => p.trim()).filter(Boolean);
        return parts.length > 1 ? parts : null;
      }

      return null;
    },
  };
}
