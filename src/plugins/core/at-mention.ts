import type { Plugin, OneBotMessageSegment, ResponseTransform, TransformContext } from "../../types.js";
import type { OneBotClient } from "../../onebot.js";

const AT_PATTERN = /\[AT:(\d+)\]/g;
const AT_NUMERIC_PATTERN = /@(\d+)/g;

export function createAtMentionPlugin(onebot: OneBotClient): Plugin {
  async function isGroupMember(groupId: string, userId: string): Promise<boolean> {
    try {
      await onebot.getGroupMemberInfo(groupId, userId);
      return true;
    } catch {
      return false;
    }
  }

  return {
    name: "at-mention",
    description: "让 AI 可以通过 [AT:QQ号] 或 @QQ号 格式 @ 指定对象",
    systemPromptAppend:
      "如需在回复中 @ 某人，请使用 [AT:QQ号] 格式（例如 [AT:123456]），或直接在消息中写 @QQ号（例如 @123456）。注意这些仅用于你回复时 @ 他人，不是你被提及的方式。",

    async onTransformResponse(text: string, context?: TransformContext): Promise<ResponseTransform | null> {
      if (!AT_PATTERN.test(text) && !AT_NUMERIC_PATTERN.test(text)) return null;

      // Reset lastIndex
      AT_PATTERN.lastIndex = 0;
      AT_NUMERIC_PATTERN.lastIndex = 0;

      // Collect all matches sorted by index
      type MatchEntry = {
        index: number;
        end: number;
        userId: string;
        kind: "at" | "numeric";
      };

      const matches: MatchEntry[] = [];

      let m: RegExpExecArray | null;
      while ((m = AT_PATTERN.exec(text)) !== null) {
        matches.push({ index: m.index, end: AT_PATTERN.lastIndex, userId: m[1], kind: "at" });
      }

      AT_NUMERIC_PATTERN.lastIndex = 0;
      while ((m = AT_NUMERIC_PATTERN.exec(text)) !== null) {
        // Skip if this position is already covered by an [AT:...] match
        const alreadyCovered = matches.some(
          (existing) => existing.index <= m!.index && existing.end >= m!.index + m![0].length
        );
        if (!alreadyCovered) {
          matches.push({ index: m.index, end: AT_NUMERIC_PATTERN.lastIndex, userId: m[1], kind: "numeric" });
        }
      }

      if (matches.length === 0) return null;

      // Sort by index
      matches.sort((a, b) => a.index - b.index);

      const groupId = context?.groupId;
      const segments: OneBotMessageSegment[] = [];
      let lastIndex = 0;

      for (const entry of matches) {
        if (entry.index > lastIndex) {
          segments.push({
            type: "text",
            data: { text: text.slice(lastIndex, entry.index) },
          });
        }

        if (entry.kind === "at") {
          segments.push({ type: "at", data: { qq: entry.userId } });
        } else {
          // Numeric @: verify existence if group context available
          const valid = groupId ? await isGroupMember(groupId, entry.userId) : true;
          if (valid) {
            segments.push({ type: "at", data: { qq: entry.userId } });
          } else {
            // Fallback: keep original text
            segments.push({
              type: "text",
              data: { text: text.slice(entry.index, entry.end) },
            });
          }
        }

        lastIndex = entry.end;
      }

      const remainingText = text.slice(lastIndex);

      return { segments, remainingText };
    },
  };
}
