import type { PluginContext, BotMessage, MentionTrackerPlugin, MentionTrackerHandler } from "../../types.js";

const FIVE_MINUTES = 5 * 60 * 1000;
const COLLECTION_WINDOW = 15 * 1000;

type TrackerState = {
  targetUserId: string;
  groupId: string;
  botMessage: string;
  startedAt: number;
  collectionMessages: BotMessage[];
  collectionTimer: ReturnType<typeof setTimeout> | null;
  hasResponded: boolean;
  processed: boolean;
  mainTimer: ReturnType<typeof setTimeout> | null;
};

export function createMentionTrackerPlugin(): MentionTrackerPlugin {
  let handler: MentionTrackerHandler | null = null;
  let ctx: PluginContext | null = null;
  const trackers = new Map<string, TrackerState>();

  function getKey(groupId: string, targetUserId: string): string {
    return `${groupId}:${targetUserId}`;
  }

  function startCollectionTimer(state: TrackerState) {
    if (state.collectionTimer) clearTimeout(state.collectionTimer);
    state.collectionTimer = setTimeout(() => {
      state.collectionTimer = null;
      finalize(state);
    }, COLLECTION_WINDOW);
  }

  function finalize(state: TrackerState) {
    if (state.processed) return;
    state.processed = true;
    if (state.mainTimer) { clearTimeout(state.mainTimer); state.mainTimer = null; }
    if (state.collectionTimer) { clearTimeout(state.collectionTimer); state.collectionTimer = null; }
    trackers.delete(getKey(state.groupId, state.targetUserId));

    if (state.collectionMessages.length > 0 && handler) {
      handler.evaluateAndReply({
        targetUserId: state.targetUserId,
        groupId: state.groupId,
        botMessage: state.botMessage,
        collectedMessages: state.collectionMessages,
      }).catch(console.error);
    }
  }

  function onFiveMinuteTimeout(state: TrackerState) {
    if (state.processed) return;
    if (state.hasResponded) {
      finalize(state);
    } else {
      state.processed = true;
      trackers.delete(getKey(state.groupId, state.targetUserId));
      handler?.reduceAffinity(state.targetUserId);
      handler?.sendAutoPrompt(state.groupId, state.targetUserId).catch(console.error);
    }
  }

  return {
    name: "mention-tracker",
    description: "追踪 Bot @用户后的对话状态",

    setHandler(h: MentionTrackerHandler) {
      handler = h;
    },

    trackMention(targetUserId: string, groupId: string, botMessage: string) {
      const key = getKey(groupId, targetUserId);
      if (trackers.has(key)) return;
      const state: TrackerState = {
        targetUserId,
        groupId,
        botMessage,
        startedAt: Date.now(),
        collectionMessages: [],
        collectionTimer: null,
        hasResponded: false,
        processed: false,
        mainTimer: setTimeout(() => onFiveMinuteTimeout(state), FIVE_MINUTES),
      };
      trackers.set(key, state);
    },

    onLoad(c: PluginContext) {
      ctx = c;
    },

    async onMessage(message: BotMessage): Promise<boolean | void> {
      if (!message.userId || message.type !== "group" || !message.groupId) return false;
      for (const [key, state] of trackers) {
        if (state.processed) continue;
        const [, trackedUserId] = key.split(":");
        if (message.userId === trackedUserId) {
          state.hasResponded = true;
          state.collectionMessages.push(message);
          startCollectionTimer(state);
        } else if (state.hasResponded && state.collectionTimer) {
          state.collectionMessages.push(message);
        }
      }
      return false;
    },
  };
}
