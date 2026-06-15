import type {
  BotMessage,
  DataStorePlugin,
  MenuPlugin,
  PromptBuildInput,
  SocialPlugin,
} from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";
import { MessageStore } from "../../message-store.js";
import { MMORPG_RULEBOOK, affinityToPercent, clampAffinity } from "../mmorpg/rulebook.js";
import { makeTool } from "../mmorpg/framework/utils.js";

// Minimal type to avoid heavy circular import — only the methods we call.
interface OneBotLike {
  getGroupMemberList(groupId: string): Promise<Array<{ userId: string; nickname?: string; card?: string }>>;
}

const AT_USER_PATTERN = /@(\d+)/g;
const CQ_REPLY_PATTERN = /\[CQ:reply,id=([^,\]]+)/;
const MENTION_AFFINITY_DELTA = MMORPG_RULEBOOK.affinity.perMention;
const REPLY_AFFINITY_DELTA = MMORPG_RULEBOOK.affinity.perReply;
const CHAT_AFFINITY_DELTA = MMORPG_RULEBOOK.affinity.perChat;
const BEHAVIOR = MMORPG_RULEBOOK.behavior;

// ── Affinity tool parameter schema (shared by all three tiers) ──────────────
const affinityToolParams = {
  type: "object",
  properties: {
    delta: {
      type: "integer",
      description: "好感度变化值（正数提升，负数降低）",
    },
    reason: {
      type: "string",
      description: "调整原因（简短描述用户做了什么让你产生这个反应）",
    },
  },
  required: ["delta"],
};

export function createSocialPlugin(
  store: DataStorePlugin,
  menuPlugin: MenuPlugin,
  messageStore: MessageStore,
  onebot: OneBotLike,
): SocialPlugin {
  // ── Cooldown tracking (session-only, resets on bot restart) ───────────────
  let conversationRound = 0;
  const cooldownExpiry = new Map<string, number>(); // userId → round when cooldown ends

  // ── Daily greeting tracking (session-only) ────────────────────────────────
  const dailyGreetings = new Map<string, string>(); // "groupId:userId" → "YYYY-MM-DD"

  // ── Multiplier helper ─────────────────────────────────────────────────────
  function getAffinityMultiplier(userId: string): number {
    const affinity = store.getUserData(userId).affinity.ai;
    return 1 + affinity / MMORPG_RULEBOOK.social.maxAffinity;
  }

  // ── Cooldown helpers ──────────────────────────────────────────────────────
  function isOnCooldown(userId: string): boolean {
    const expiry = cooldownExpiry.get(userId);
    return expiry !== undefined && expiry > conversationRound;
  }

  function setCooldown(userId: string, rounds: number): void {
    cooldownExpiry.set(userId, conversationRound + rounds);
  }

  // ── Build the three affinity tools ────────────────────────────────────────
  function buildAffinityTool(
    name: string,
    description: string,
    maxAbs: number,
    cooldownRounds: number,
  ): BotToolRegistration {
    return makeTool(name, description, affinityToolParams, async (args, input) => {
      const msg = input.mode === "single" ? input.message : input.messages[input.messages.length - 1];
      const userId = msg?.userId;
      if (!userId) return "无法确定当前用户。";

      if (isOnCooldown(userId)) {
        return "好感度调整冷却中，暂时无法使用。";
      }

      const rawDelta = typeof args.delta === "number" ? Math.round(args.delta) : 0;
      const clamped = Math.max(-maxAbs, Math.min(maxAbs, rawDelta));
      if (clamped === 0) return "好感度变化为 0，无需调整。";

      const mult = getAffinityMultiplier(userId);
      const effective = clamped > 0
        ? Math.round(clamped * mult)
        : Math.round(clamped / mult);

      const reason = typeof args.reason === "string" ? args.reason : "";

      // Apply to user's AI affinity
      const data = store.getUserData(userId);
      data.affinity.ai = clampAffinity(data.affinity.ai + effective);
      store.saveUserData(userId, data);

      setCooldown(userId, cooldownRounds);

      const sign = effective > 0 ? "+" : "";
      return `好感度已调整 ${sign}${effective}（${reason || "无原因"}）。所有好感度工具进入 ${cooldownRounds} 轮冷却。`;
    });
  }

  const toolTiny = buildAffinityTool(
    "adjust_affinity_tiny",
    `微调与当前用户的好感度（范围 ±${BEHAVIOR.toolTinyMax}）。用于对用户的日常言行做出轻微情感反应。使用后会触发所有好感度工具 ${BEHAVIOR.cooldownTiny} 轮冷却。`,
    BEHAVIOR.toolTinyMax,
    BEHAVIOR.cooldownTiny,
  );

  const toolNormal = buildAffinityTool(
    "adjust_affinity_normal",
    `中等幅度调整与当前用户的好感度（范围 ±${BEHAVIOR.toolNormalMax}）。用于对用户的显著行为（如暖心举动或冒犯言行）做出情感反应。使用后会触发所有好感度工具 ${BEHAVIOR.cooldownNormal} 轮冷却。`,
    BEHAVIOR.toolNormalMax,
    BEHAVIOR.cooldownNormal,
  );

  const toolMajor = buildAffinityTool(
    "adjust_affinity_major",
    `大幅调整与当前用户的好感度（范围 ±${BEHAVIOR.toolMajorMax}）。仅在用户做出极其重大行为时使用（如深情告白或严重背叛）。使用后会触发所有好感度工具 ${BEHAVIOR.cooldownMajor} 轮冷却。`,
    BEHAVIOR.toolMajorMax,
    BEHAVIOR.cooldownMajor,
  );

  // ── Behavior style prompt helper ──────────────────────────────────────────
  function buildBehaviorHint(aiAffinity: number): string {
    if (aiAffinity >= BEHAVIOR.maxCuteThreshold) {
      return "[行为风格] 你与此用户的关系极为亲密（灵魂伴侣级别）。请使用非常亲昵的语气，频繁使用颜文字（如 (´,,•ω•,,)♡、( ˘ ³˘)♥、(///▽///)）表达情感，可以撒娇、表达思念和占有欲，用独特的昵称称呼对方。";
    }
    if (aiAffinity >= BEHAVIOR.greetingThreshold) {
      return "[行为风格] 你与此用户非常亲近。请自然地使用颜文字（如 ( ˘ ³˘)♥、(///▽///)、♡），可以偶尔撒娇或表达小情绪，语气中带有亲昵感。";
    }
    if (aiAffinity >= BEHAVIOR.cuteLanguageThreshold) {
      return "[行为风格] 你与此用户关系不错。请语气活泼一些，适当使用颜文字（如 (≧▽≦)、╰(*°▽°*)╯、(◕‿◕)）增添可爱感，可以主动关心对方的日常。";
    }
    if (aiAffinity >= 500) {
      return "[行为风格] 你与此用户比较熟悉。请用友善随和的语气交流，可以偶尔开个小玩笑。";
    }
    return "[行为风格] 你与此用户还不太熟悉。请保持礼貌，用语正式一些，保持适当的距离感。";
  }

  // ── Affinity label helper (enriched) ──────────────────────────────────────
  function affinityLabel(value: number): string {
    if (value >= 8000) return "灵魂伴侣";
    if (value >= 5000) return "挚友";
    if (value >= 2000) return "好友";
    if (value >= 500) return "熟悉";
    if (value >= 100) return "普通";
    if (value >= 30) return "疏远";
    return "陌生";
  }

  // ── Plugin definition ─────────────────────────────────────────────────────
  const plugin: SocialPlugin = {
    name: "social",
    description: "好感度系统：记录 AI 与用户、用户与用户之间的关系，并提供可视化命令与 AI 好感度工具",
    systemPromptAppend: [
      "[好感度系统]",
      "系统会为你提供当前对话用户的关系亲密度、行为风格建议和每日行为提示。",
      "请根据这些自然地调整你的语气、用词和互动方式，但不要直接报数字或提及'系统提示'。",
      "你有三个好感度调整工具（微小/普通/大幅），可以在对话中自然地使用它们来表达你对用户言行的好恶反应。",
      "使用任意好感度工具后，所有好感度工具会进入冷却。请在关键时刻谨慎使用。",
    ].join("\n"),

    async onMessage(message: BotMessage) {
      if (!message.userId || !message.text.trim()) {
        return false;
      }
      conversationRound += 1;

      const userId = message.userId;
      const mult = getAffinityMultiplier(userId);

      const talksToAi = message.type === "private" || (message.selfId ? message.text.includes(`@${message.selfId}`) : false);
      if (talksToAi) {
        this.addAIAffinity(userId, Math.round(CHAT_AFFINITY_DELTA * mult));
        this.recordInteraction(userId, "ai", "chat", 1);
      }

      const mentionedUsers = extractMentionedUsers(message)
        .filter((mentionedUserId) => mentionedUserId !== userId && mentionedUserId !== message.selfId);

      for (const mentionedUserId of mentionedUsers) {
        this.addUserAffinity(userId, mentionedUserId, Math.round(MENTION_AFFINITY_DELTA * mult));
        this.recordInteraction(userId, mentionedUserId, "mention", 1);
      }

      const repliedUserId = resolveReplyTargetUserId(message, messageStore);
      if (repliedUserId && repliedUserId !== userId && repliedUserId !== message.selfId) {
        this.addUserAffinity(userId, repliedUserId, Math.round(REPLY_AFFINITY_DELTA * mult));
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
      const lines: string[] = [];

      // Affinity info
      lines.push(
        `当前对话用户 ${userId} 与你的关系亲密度为 ${affinityToPercent(aiAffinity)}（${affinityLabel(aiAffinity)}）。请据此自然调整亲近度。`,
      );

      // Behavior style hint
      lines.push(buildBehaviorHint(aiAffinity));

      // Daily greeting check (group chats only, affinity >= 5000)
      if (aiAffinity >= BEHAVIOR.greetingThreshold && currentMessage.type === "group" && currentMessage.groupId) {
        const greetKey = `${currentMessage.groupId}:${userId}`;
        const today = new Date().toISOString().slice(0, 10);
        const lastGreet = dailyGreetings.get(greetKey);
        if (lastGreet !== today) {
          dailyGreetings.set(greetKey, today);
          lines.push("[每日行为] 这是今天在此群聊中第一次看到此用户发消息。请自然地打个招呼或寒暄一下，表达开心见到对方的感觉，但不要太刻意。");
        }
      }

      // Mentioned users' relationships
      const mentionedUsers = Array.from(new Set(messages.flatMap((m) => extractMentionedUsers(m))))
        .filter((mentionedUserId) => mentionedUserId !== userId && mentionedUserId !== currentMessage.selfId);

      if (mentionedUsers.length > 0) {
        const relationText = mentionedUsers
          .map((mentionedUserId) => {
            const value = this.getUserAffinity(userId, mentionedUserId);
            return `${mentionedUserId}: ${affinityToPercent(value)}（${affinityLabel(value)}）`;
          })
          .join("；");
        lines.push(`当前用户与消息中被提及对象的关系：${relationText}。`);
      }

      // Affinity tool status
      if (isOnCooldown(userId)) {
        const remaining = (cooldownExpiry.get(userId) ?? 0) - conversationRound;
        lines.push(`[adjust_affinity_tiny/adjust_affinity_normal/adjust_affinity_major] 好感度工具在${remaining}轮对话后可用。`);
      } else {
        lines.push(`[adjust_affinity_tiny/adjust_affinity_normal/adjust_affinity_major] 好感度工具可用，如果与当前用户实际情况不符，请自行加减好感值，当前好感值 ${affinityToPercent(aiAffinity)}（${affinityLabel(aiAffinity)}）。`);
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

    getAffinityMultiplier(userId: string): number {
      return getAffinityMultiplier(userId);
    },

    getToolRegistrations(): BotToolRegistration[] {
      return [toolTiny, toolNormal, toolMajor];
    },

    onLoad(ctx) {
      menuPlugin.registerCommand("me", "查看我的关系概览", async (message) => {
        if (!message.userId) return;

        const profile = store.getUserData(message.userId);
        const summary = this.getInteractionSummary(message.userId);
        const mult = getAffinityMultiplier(message.userId);
        const topRelations = Object.entries(profile.affinity.users)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([uid, score]) => `${resolveUserLabel(uid, messageStore, message.groupId)}（${affinityToPercent(score)} / ${affinityLabel(score)}）`);

        const lines = [
          "你的关系概览：",
          `- 与 AI 的亲密度：${affinityToPercent(profile.affinity.ai)}（${affinityLabel(profile.affinity.ai)}）`,
          `- 好感度加成：×${mult.toFixed(2)}`,
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
          const mult = getAffinityMultiplier(message.userId);
          await ctx.replyText(
            message,
            `你与 AI 的亲密度：${affinityToPercent(value)}（${affinityLabel(value)}）\n好感度加成：×${mult.toFixed(2)}\n来源：送礼 ${summary.gifts}，日常聊天 ${summary.chats}`,
          );
          return;
        }

        const value = this.getUserAffinity(message.userId, target);
        const summary = this.getInteractionSummary(message.userId, target);
        await ctx.replyText(
          message,
          `你与 ${resolveUserLabel(target, messageStore, message.groupId)} 的亲密度：${affinityToPercent(value)}（${affinityLabel(value)}）\n来源：送礼 ${summary.gifts}，@互动 ${summary.mentions}，回复互动 ${summary.replies}`,
        );
      });

      // ── $social-board — group-filtered leaderboard ─────────────────────
      menuPlugin.registerCommand("social-board", "查看好感度排行榜（群聊中仅显示群内成员）", async (message) => {
        const allEntries = store.getAllUserEntries();
        let memberIds: Set<string> | null = null;
        let scopeLabel = "全局";

        // In group chats, fetch member list and filter
        if (message.type === "group" && message.groupId) {
          try {
            const members = await onebot.getGroupMemberList(message.groupId);
            memberIds = new Set(members.map((m) => m.userId));
            scopeLabel = "群内";
          } catch {
            // Fallback to global if API fails
          }
        }

        const filteredEntries = memberIds
          ? allEntries.filter((e) => memberIds!.has(e.userId))
          : allEntries;

        // AI affinity ranking
        const aiRanking = filteredEntries
          .sort((a, b) => b.profile.affinity.ai - a.profile.affinity.ai)
          .slice(0, 10)
          .map((entry, index) => {
            const label = resolveUserLabel(entry.userId, messageStore, message.groupId);
            const pct = affinityToPercent(entry.profile.affinity.ai);
            const tag = affinityLabel(entry.profile.affinity.ai);
            return `  ${index + 1}. ${label} - ${pct}（${tag}）`;
          });

        // Player-to-player affinity ranking (pairs only within group)
        const pairMap = new Map<string, { a: string; b: string; total: number }>();
        for (const { userId: u1, profile } of filteredEntries) {
          for (const [u2, score] of Object.entries(profile.affinity.users)) {
            if (memberIds && !memberIds.has(u2)) continue;
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
          .slice(0, 10)
          .map((pair, index) => {
            const nameA = resolveUserLabel(pair.a, messageStore, message.groupId);
            const nameB = resolveUserLabel(pair.b, messageStore, message.groupId);
            const pct = affinityToPercent(pair.total);
            const tag = affinityLabel(pair.total);
            return `  ${index + 1}. ${nameA} ↔ ${nameB} - ${pct}（${tag}）`;
          });

        const lines: string[] = [];
        if (aiRanking.length > 0) {
          lines.push(`${scopeLabel} AI 好感度排行：`, ...aiRanking);
        }
        if (playerRanking.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(`${scopeLabel} 玩家间亲密度排行：`, ...playerRanking);
        }
        if (lines.length === 0) {
          lines.push("当前还没有可展示的关系排行。");
        }
        if (memberIds && message.groupId) {
          lines.push(`\n（仅显示本群 ${memberIds.size} 位成员的数据）`);
        }

        await ctx.replyText(message, lines.join("\n"));
      });

      // Keep old $social-top as alias
      menuPlugin.registerCommand("social-top", "好感度排行榜（已迁移至 $social-board）", async (message) => {
        await ctx.replyText(message, `此命令已更名为 ${menuPlugin.getPrefix()}social-board，请使用新命令。`);
      });
    },
  };

  return plugin;
}

// ── Helper functions ────────────────────────────────────────────────────────

function extractMentionedUsers(message: BotMessage): string[] {
  const result = new Set<string>();
  let match: RegExpExecArray | null;

  AT_USER_PATTERN.lastIndex = 0;
  while ((match = AT_USER_PATTERN.exec(message.text)) !== null) {
    result.add(match[1]);
  }

  return Array.from(result);
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
