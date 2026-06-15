import type {
  BotMessage,
  DataStorePlugin,
  MenuPlugin,
  PromptBuildInput,
  SocialPlugin,
} from "../../types.js";
import { MessageStore } from "../../message-store.js";
import { MMORPG_RULEBOOK, affinityToPercent, clampAffinity } from "../mmorpg/rulebook.js";

const AT_USER_PATTERN = /@(\d+)/g;
const CQ_REPLY_PATTERN = /\[CQ:reply,id=([^,\]]+)/;
const MENTION_AFFINITY_DELTA = MMORPG_RULEBOOK.affinity.perMention;
const REPLY_AFFINITY_DELTA = MMORPG_RULEBOOK.affinity.perReply;
const CHAT_AFFINITY_DELTA = MMORPG_RULEBOOK.affinity.perChat;

export function createSocialPlugin(store: DataStorePlugin, menuPlugin: MenuPlugin, messageStore: MessageStore): SocialPlugin {
  return {
    name: "social",
    description: "好感度系统：记录 AI 与用户、用户与用户之间的关系，并提供可视化命令",
    systemPromptAppend:
      "系统会为你提供当前对话用户与被提及对象的关系信息。请自然体现亲疏变化，但不要直接报数字或自称在看系统提示。",

    async onMessage(message: BotMessage) {
      if (!message.userId || !message.text.trim()) {
        return false;
      }

      const userId = message.userId;
      const talksToAi = message.type === "private" || (message.selfId ? message.text.includes(`@${message.selfId}`) : false);
      if (talksToAi) {
        this.addAIAffinity(userId, CHAT_AFFINITY_DELTA);
        this.recordInteraction(userId, "ai", "chat", 1);
      }

      const mentionedUsers = extractMentionedUsers(message)
        .filter((mentionedUserId) => mentionedUserId !== userId && mentionedUserId !== message.selfId);

      for (const mentionedUserId of mentionedUsers) {
        this.addUserAffinity(userId, mentionedUserId, MENTION_AFFINITY_DELTA);
        this.recordInteraction(userId, mentionedUserId, "mention", 1);
      }

      const repliedUserId = resolveReplyTargetUserId(message, messageStore);
      if (repliedUserId && repliedUserId !== userId && repliedUserId !== message.selfId) {
        this.addUserAffinity(userId, repliedUserId, REPLY_AFFINITY_DELTA);
        this.recordInteraction(userId, repliedUserId, "reply", 1);
      }

      return false;
    },

    onBuildSystemPrompt(input: PromptBuildInput): string {
      const messages = input.mode === "single" ? [input.message] : input.messages;
      const currentMessage = messages[messages.length - 1];
      if (!currentMessage?.userId) {
        return "";
      }

      const userId = currentMessage.userId;
      const aiAffinity = this.getAIAffinity(userId);
      const lines = [
        `当前对话用户 ${userId} 与你的关系亲密度为 ${affinityToPercent(aiAffinity)}。请据此自然调整亲近度，但保持礼貌和分寸。`,
      ];

      const mentionedUsers = Array.from(new Set(messages.flatMap((message) => extractMentionedUsers(message))))
        .filter((mentionedUserId) => mentionedUserId !== userId && mentionedUserId !== currentMessage.selfId);

      if (mentionedUsers.length > 0) {
        const relationText = mentionedUsers
          .map((mentionedUserId) => {
            const value = this.getUserAffinity(userId, mentionedUserId);
            return `${mentionedUserId}: ${affinityToPercent(value)}（${formatAffinityLabel(value)}）`;
          })
          .join("；");
        lines.push(`当前用户与消息中被提及对象的关系：${relationText}。`);
      }

      return lines.join("\n");
    },

    addAIAffinity(userId: string, amount: number) {
      const data = store.getUserData(userId);
      data.affinity.ai = clampAffinity(data.affinity.ai + amount);
      store.saveUserData(userId, data);
    },

    getAIAffinity(userId: string): number {
      return store.getUserData(userId).affinity.ai;
    },

    addUserAffinity(userId1: string, userId2: string, amount: number) {
      const data = store.getUserData(userId1);
      const current = data.affinity.users[userId2] || 0;
      data.affinity.users[userId2] = clampAffinity(current + amount);
      store.saveUserData(userId1, data);
    },

    getUserAffinity(userId1: string, userId2: string): number {
      return store.getUserData(userId1).affinity.users[userId2] || 0;
    },

    /**
     * Apply daily affinity decay to all user-to-user relationships.
     * Should be called periodically (e.g. on login or interaction).
     */
    applyAffinityDecay(userId: string) {
      const data = store.getUserData(userId);
      const now = Date.now();
      const lastDecay = data.lastAffinityDecayAt ?? 0;
      const oneDayMs = 24 * 60 * 60 * 1000;
      if (now - lastDecay < oneDayMs) return;
      const daysSinceLastDecay = Math.floor((now - lastDecay) / oneDayMs);
      const decayFactor = Math.pow(1 - MMORPG_RULEBOOK.affinity.dailyDecayRate, daysSinceLastDecay);
      for (const targetId of Object.keys(data.affinity.users)) {
        const current = data.affinity.users[targetId];
        if (current > 0) {
          data.affinity.users[targetId] = Math.max(0, Math.floor(current * decayFactor));
        }
      }
      data.lastAffinityDecayAt = now;
      store.saveUserData(userId, data);
    },

    recordInteraction(userId: string, targetId: string, kind: "gift" | "mention" | "reply" | "chat", amount = 1) {
      const data = store.getUserData(userId);

      if (targetId === "ai") {
        if (kind === "gift") {
          data.interactionStats.ai.gifts += amount;
        } else if (kind === "chat") {
          data.interactionStats.ai.chats += amount;
        }
        store.saveUserData(userId, data);
        return;
      }

      const current = data.interactionStats.users[targetId] || {
        gifts: 0,
        mentions: 0,
        replies: 0,
      };

      if (kind === "gift") {
        current.gifts += amount;
      } else if (kind === "mention") {
        current.mentions += amount;
      } else if (kind === "reply") {
        current.replies += amount;
      }

      data.interactionStats.users[targetId] = current;
      store.saveUserData(userId, data);
    },

    getInteractionSummary(userId: string, targetId?: string) {
      const data = store.getUserData(userId);

      if (targetId === "ai") {
        return {
          gifts: data.interactionStats.ai.gifts,
          mentions: 0,
          replies: 0,
          chats: data.interactionStats.ai.chats,
        };
      }

      if (targetId) {
        const stats = data.interactionStats.users[targetId] || { gifts: 0, mentions: 0, replies: 0 };
        return {
          gifts: stats.gifts,
          mentions: stats.mentions,
          replies: stats.replies,
          chats: 0,
        };
      }

      let gifts = data.interactionStats.ai.gifts;
      let mentions = 0;
      let replies = 0;

      for (const stats of Object.values(data.interactionStats.users)) {
        gifts += stats.gifts;
        mentions += stats.mentions;
        replies += stats.replies;
      }

      return {
        gifts,
        mentions,
        replies,
        chats: data.interactionStats.ai.chats,
      };
    },

    onLoad(ctx) {
      menuPlugin.registerCommand("me", "查看我的关系概览", async (message) => {
        if (!message.userId) return;

        const profile = store.getUserData(message.userId);
        const summary = this.getInteractionSummary(message.userId);
        const topRelations = Object.entries(profile.affinity.users)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([userId, score]) => `${resolveUserLabel(userId, messageStore, message.groupId)}（${affinityToPercent(score)} / ${formatAffinityLabel(score)}）`);

        const lines = [
          "你的关系概览：",
          `- 与 AI 的亲密度：${affinityToPercent(profile.affinity.ai)}（${formatAffinityLabel(profile.affinity.ai)}）`,
          `- 当前金币：${profile.coins}`,
          `- 连续签到：${profile.checkinStreak} 天`,
          `- 最常互动对象：${topRelations.length > 0 ? topRelations.join("、") : "暂无"}`,
          `- 近期关系提升来源：送礼 ${summary.gifts}，@互动 ${summary.mentions}，回复互动 ${summary.replies}，日常聊天 ${summary.chats}`,
        ];
        await ctx.replyText(message, lines.join("\n"));
      });

      menuPlugin.registerCommand("affinity", `查看与 AI 或指定用户的关系：${menuPlugin.getPrefix()}affinity [ai|用户ID]`, async (message, args) => {
        if (!message.userId) return;

        const target = (args[0] || "ai").toLowerCase();
        if (target === "ai") {
          const value = this.getAIAffinity(message.userId);
          const summary = this.getInteractionSummary(message.userId, "ai");
          await ctx.replyText(
            message,
            `你与 AI 的亲密度：${affinityToPercent(value)}（${formatAffinityLabel(value)}）\n来源：送礼 ${summary.gifts}，日常聊天 ${summary.chats}`
          );
          return;
        }

        const value = this.getUserAffinity(message.userId, target);
        const summary = this.getInteractionSummary(message.userId, target);
        await ctx.replyText(
          message,
          `你与 ${resolveUserLabel(target, messageStore, message.groupId)} 的亲密度：${affinityToPercent(value)}（${formatAffinityLabel(value)}）\n来源：送礼 ${summary.gifts}，@互动 ${summary.mentions}，回复互动 ${summary.replies}`
        );
      });

      menuPlugin.registerCommand("social-top", "查看好感度排行榜（AI + 玩家间亲密度）", async (message) => {
        const allEntries = store.getAllUserEntries();

        const aiRanking = allEntries
          .sort((a, b) => b.profile.affinity.ai - a.profile.affinity.ai)
          .slice(0, 5)
          .map((entry, index) => `${index + 1}. ${resolveUserLabel(entry.userId, messageStore, message.groupId)} - ${affinityToPercent(entry.profile.affinity.ai)}（${formatAffinityLabel(entry.profile.affinity.ai)}）`);

        const pairMap = new Map<string, { a: string; b: string; total: number }>();
        for (const { userId: u1, profile } of allEntries) {
          for (const [u2, score] of Object.entries(profile.affinity.users)) {
            const pairKey = u1 < u2 ? `${u1}|${u2}` : `${u2}|${u1}`;
            const existing = pairMap.get(pairKey);
            if (existing) {
              existing.total += score;
            } else {
              pairMap.set(pairKey, { a: u1 < u2 ? u1 : u2, b: u1 < u2 ? u2 : u1, total: score });
            }
          }
        }
        const playerRanking = Array.from(pairMap.values())
          .sort((a, b) => b.total - a.total)
          .slice(0, 5)
          .map((pair, index) => `${index + 1}. ${resolveUserLabel(pair.a, messageStore, message.groupId)} ↔ ${resolveUserLabel(pair.b, messageStore, message.groupId)} - ${affinityToPercent(pair.total)}（${formatAffinityLabel(pair.total)}）`);

        const lines: string[] = [];
        if (aiRanking.length > 0) {
          lines.push("AI 好感度排行榜：", ...aiRanking.map(l => `  ${l}`));
        }
        if (playerRanking.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push("玩家间亲密度排行榜：", ...playerRanking.map(l => `  ${l}`));
        }
        if (lines.length === 0) {
          lines.push("当前还没有可展示的关系排行。");
        }
        await ctx.replyText(message, lines.join("\n"));
      });
    },
  };
}

function extractMentionedUsers(message: BotMessage): string[] {
  const result = new Set<string>();
  let match: RegExpExecArray | null;

  AT_USER_PATTERN.lastIndex = 0;
  while ((match = AT_USER_PATTERN.exec(message.text)) !== null) {
    result.add(match[1]);
  }

  return Array.from(result);
}

function formatAffinityLabel(value: number): string {
  if (value >= 8000) return "灵魂拍档";
  if (value >= 5000) return "非常亲近";
  if (value >= 2000) return "关系不错";
  if (value >= 500) return "有点熟悉";
  if (value >= 100) return "普通";
  if (value >= 30) return "有些疏远";
  return "保持距离";
}

function resolveUserLabel(userId: string, messageStore: MessageStore, groupId?: string): string {
  return messageStore.getLatestKnownDisplayName(userId, groupId) ?? userId;
}

function resolveReplyTargetUserId(message: BotMessage, messageStore: MessageStore): string | null {
  const replyMessageId = extractReplyMessageId(message);
  if (!replyMessageId) {
    return null;
  }

  const repliedMessage = messageStore.findMessageById(replyMessageId);
  return repliedMessage?.userId ?? null;
}

function extractReplyMessageId(message: BotMessage): string | null {
  const rawMessage = message.raw.message;
  if (Array.isArray(rawMessage)) {
    const replySegment = rawMessage.find((segment) => segment.type === "reply");
    const replyId = replySegment?.data.id;
    if (typeof replyId === "string" || typeof replyId === "number") {
      return String(replyId);
    }
  }

  if (typeof message.raw.raw_message === "string") {
    const match = message.raw.raw_message.match(CQ_REPLY_PATTERN);
    if (match?.[1]) {
      return match[1];
    }
  }

  if (typeof rawMessage === "string") {
    const match = rawMessage.match(CQ_REPLY_PATTERN);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}
