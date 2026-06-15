import type { Plugin } from "../../types.js";

const SPLIT_PATTERN = /\[Split\]/g;

export function createSplitPlugin(): Plugin {
  return {
    name: "split",
    description: "让 AI 可以使用 [Split] 将回复拆分为多条消息依次发送",
    systemPromptAppend:
      "如需将回复分成多条消息发送，在每段之间使用 [Split] 分隔。每条消息会独立发送。",

    onSplit(text: string): string[] | null {
      if (!SPLIT_PATTERN.test(text)) return null;

      SPLIT_PATTERN.lastIndex = 0;

      const parts = text.split(SPLIT_PATTERN).map((p) => p.trim()).filter(Boolean);
      return parts.length > 1 ? parts : null;
    },
  };
}
