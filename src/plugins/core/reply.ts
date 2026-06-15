import type { Plugin, ResponseTransform } from "../../types.js";

const REPLY_PATTERN = /\[REPLY:(\d+)\]/;

export function createReplyPlugin(): Plugin {
  return {
    name: "reply",
    description: "让 AI 可以通过 [REPLY:消息ID] 格式回复指定消息",
    systemPromptAppend:
      "每条消息前会标注 [ID:数字]，这就是该消息的消息 ID。如果你想回复某条消息，使用 [REPLY:消息ID] 格式（例如 [REPLY:123456]），该标记必须放在回复内容最前面。每条消息最多引用一条消息；如需引用多条消息，请用 [Split] 分段后每段独立引用。",

    onTransformResponse(text: string): ResponseTransform | null {
      const match = REPLY_PATTERN.exec(text);
      if (!match) return null;

      const remainingText = text.slice(0, match.index) + text.slice(match.index + match[0].length);
      const trimmed = remainingText.trimStart();

      return { segments: [{ type: "reply", data: { id: match[1] } }], remainingText: trimmed };
    },
  };
}
