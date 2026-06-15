import type { PluginContext, BotMessage, DebounceHandler, DebouncePlugin } from "../../types.js";

const DEFAULT_WINDOW_MS = 2000;
const DEFAULT_MAX_BATCH = 10;

type BufferEntry = {
  messages: BotMessage[];
  timer: NodeJS.Timeout | null;
};

export function createDebouncePlugin(
  commandPrefix = "$",
  windowMs = DEFAULT_WINDOW_MS,
  maxBatch = DEFAULT_MAX_BATCH
): DebouncePlugin {
  let handler: DebounceHandler | null = null;
  const buffers = new Map<string, BufferEntry>();

  function getKey(message: BotMessage): string {
    return message.type === "group" ? `group:${message.groupId}` : `private:${message.userId}`;
  }

  async function flush(key: string) {
    const entry = buffers.get(key);
    if (!entry || entry.messages.length === 0) return;

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    const messages = entry.messages;
    buffers.delete(key);

    if (!handler) return;

    try {
      const validMessages: BotMessage[] = [];
      for (const msg of messages) {
        const shouldReply = await handler.shouldReplyCheck(msg);
        if (shouldReply) {
          validMessages.push(msg);
        }
      }

      if (validMessages.length === 0) return;

      const reply = await handler.chatBatch(validMessages);
      const parts = await handler.splitResponse(reply);

      const target = validMessages[validMessages.length - 1].type === "group"
        ? { type: "group" as const, id: validMessages[validMessages.length - 1].groupId! }
        : { type: "private" as const, id: validMessages[validMessages.length - 1].userId! };

      if (parts) {
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          const segments = await handler.transformResponse(trimmed);
          if (segments) {
            await handler.sendSegments(target, segments);
          } else {
            await handler.sendSegments(target, [{ type: "text", data: { text: trimmed } }]);
          }
        }
      } else {
        const segments = await handler.transformResponse(reply);
        if (segments) {
          await handler.sendSegments(target, segments);
        } else {
          await handler.sendSegments(target, [{ type: "text", data: { text: reply } }]);
        }
      }
    } catch (error) {
      console.error("[Debounce] 处理失败:", error);
    }
  }

  return {
    name: "debounce",
    description: `防抖合并：${windowMs}ms 窗口内消息统一处理`,

    setHandler(h: DebounceHandler) {
      handler = h;
    },

    async onMessage(message: BotMessage): Promise<boolean> {
      if (message.text.startsWith(commandPrefix)) return false;

      const key = getKey(message);
      let entry = buffers.get(key);

      if (!entry) {
        entry = { messages: [], timer: null };
        buffers.set(key, entry);
      }

      entry.messages.push(message);

      if (entry.timer) clearTimeout(entry.timer);

      if (entry.messages.length >= maxBatch) {
        void flush(key);
      } else {
        entry.timer = setTimeout(() => {
          void flush(key);
        }, windowMs);
      }

      return true;
    },
  };
}
