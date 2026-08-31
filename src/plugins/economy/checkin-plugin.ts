import type { PluginContext, BotMessage, CheckinPlugin, DataStorePlugin, SocialPlugin, MenuPlugin } from "../../types.js";

const BASE_REWARD = 10;
const STREAK_BONUS_PER_DAY = 5;
const MAX_STREAK_BONUS = 50;
const RANDOM_MAX = 5;

export function createCheckinPlugin(
  store: DataStorePlugin,
  social: SocialPlugin,
  menuPlugin: MenuPlugin
): CheckinPlugin {
  function today(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  return {
    name: "checkin",
    description: "每日签到系统",
    systemPromptAppend:
      "每天第一次与用户的有效对话会自动触发一次与 $checkin 完全相同的签到结算；若当天已签到，则不要再次发放奖励。",

    canCheckin(userId: string): boolean {
      return store.getUserData(userId).lastCheckin !== today();
    },

    shouldSendAutoCheckinNotice(userId: string): boolean {
      const data = store.getUserData(userId);
      return data.lastAutoCheckinNoticeDate !== today();
    },

    markAutoCheckinNoticeSent(userId: string) {
      const data = store.getUserData(userId);
      data.lastAutoCheckinNoticeDate = today();
      store.saveUserData(userId, data);
      store.flush();
    },

    checkin(userId: string) {
      const data = store.getUserData(userId);
      const isNewDay = data.lastCheckin !== today();

      if (!isNewDay) return { coins: 0, streak: data.checkinStreak, bonus: 0 };

      if (data.lastCheckin === yesterday()) {
        data.checkinStreak += 1;
      } else {
        data.checkinStreak = 1;
      }

      const streakBonus = Math.min((data.checkinStreak - 1) * STREAK_BONUS_PER_DAY, MAX_STREAK_BONUS);
      const randomBonus = Math.floor(Math.random() * (RANDOM_MAX + 1));
      const total = BASE_REWARD + streakBonus + randomBonus;

      data.coins += total;
      data.lastCheckin = today();
      data.lastAutoCheckinNoticeDate = today();
      store.saveUserData(userId, data);
      store.flush();
      social.addAIAffinity(userId, 1);

      return { coins: total, streak: data.checkinStreak, bonus: streakBonus + randomBonus };
    },

    tryAutoCheckin(userId: string) {
      const result = this.checkin(userId);
      return { didCheckin: result.coins > 0, ...result };
    },

    onLoad(ctx: PluginContext) {
      menuPlugin.registerCommandGroup("economy", "经济与社交", "签到、商城、礼物、亲密度、福利");
      menuPlugin.registerCommand("checkin", "每日签到领取金币", async (message: BotMessage) => {
        const userId = message.userId!;
        const result = this.checkin(userId);
        if (result.coins <= 0) {
          await ctx.replyText(message, "你今天已经签到过了，首次与 Bot 的对话或 $checkin 都共享同一次签到次数，明天再来吧～");
          return;
        }
        const streakText = result.streak > 1 ? `（连续签到 ${result.streak} 天）` : "";
        await ctx.replyText(
          message,
          `签到成功！获得 ${result.coins} 金币${streakText}（基础 ${BASE_REWARD} + 奖励 ${result.bonus}）。每日首次对话触发的自动签到与 $checkin 共享同一结算。`
        );
      });
    },
  };
}

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
