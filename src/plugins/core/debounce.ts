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
  const locks = new Map<string, boolean>();

  function getKey(message: BotMessage): string {
    return message.type === "group" ? `group:${message.groupId}` : `private:${message.userId}`;
  }

  async function flush(key: string) {
    if (locks.get(key)) return;

    const entry = buffers.get(key);
    if (!entry || entry.messages.length === 0) return;

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    locks.set(key, true);

    const messages = entry.messages;
    entry.messages = [];

    if (!handler) {
      locks.delete(key);
      return;
    }

    try {
      const triggerIndexes: number[] = [];
      for (let index = 0; index < messages.length; index += 1) {
        const msg = messages[index];
        const shouldReply = await handler.shouldReplyCheck(msg);
        if (shouldReply) triggerIndexes.push(index);
      }

      if (triggerIndexes.length > 0) {
        // 触发判定只决定是否回复；同一 burst 的全部消息都交给上下文层。
        const triggerIndex = triggerIndexes[triggerIndexes.length - 1];
        const reply = await handler.chatBatch(messages, triggerIndex);

        const triggerMessage = messages[triggerIndex];
        const target = triggerMessage.type === "group"
          ? { type: "group" as const, id: triggerMessage.groupId! }
          : { type: "private" as const, id: triggerMessage.userId! };

        const context = target.type === "group" ? { groupId: target.id } : undefined;
        await handler.sendResponse(target, reply, context);
      }
    } catch (error) {
      console.error("[Debounce] 处理失败:", error);
    } finally {
      locks.delete(key);
      const remaining = buffers.get(key);
      if (remaining && remaining.messages.length > 0) {
        remaining.timer = setTimeout(() => {
          void flush(key);
        }, windowMs);
      } else if (remaining) {
        buffers.delete(key);
      }
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

      if (locks.get(key)) return true;

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
