import type {
  BotMessage,
  DataStorePlugin,
  InventoryPlugin,
  MenuPlugin,
  PluginContext,
  WelfareRewardSystemPlugin,
  WelfareClaimResult,
} from "../../types.js";
import { MMORPG_RULEBOOK } from "../mmorpg/rulebook.js";

/**
 * 福利奖励系统：连续签到 / 新人七日福利 / 月度签到大奖 / 回归奖励 / 等级里程碑。
 *
 * 设计要点：
 * - 所有奖励的金币产出都通过 DataStorePlugin.coins 流转，与 MMORPG 桥接金币一致。
 * - 道具发放复用 InventoryPlugin.addItem，使用 MMO 已有物品 ID。
 * - 七日福利采用递增式（Day7 大奖），中断重置（重福利型防小号刷）。
 * - 月度签到按日历月累计，跨月重置。
 * - 回归奖励按离开天数分级，需用户主动领取。
 * - 等级里程碑由外部（MMORPG 升级钩子）调用 checkLevelMilestones 自动发放。
 *
 * 经济对冲：见 MMORPG_ECONOMY_ANALYSIS.md。本系统增加金币产出，配套的消耗口修复
 * （NPC 折价、回收折损、拍卖行费率上调）已在 framework-plugin.ts / rulebook.ts 落地。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Days between two YYYY-MM-DD dates (b - a), ignoring time-of-day. Negative if b < a. */
function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00");
  const b = new Date(dateB + "T00:00:00");
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

function emptyResult(message: string): WelfareClaimResult {
  return { success: false, message, coinsGranted: 0, itemsGranted: [] };
}

export function createRewardSystemPlugin(
  store: DataStorePlugin,
  inventory: InventoryPlugin,
  menuPlugin: MenuPlugin
): WelfareRewardSystemPlugin {
  /** Grant coins + items and persist. Returns the aggregated result. */
  function grant(userId: string, coins: number, items: ReadonlyArray<{ itemId: string; quantity: number }>): WelfareClaimResult {
    const data = store.getUserData(userId);
    if (coins > 0) {
      data.coins += coins;
    }
    store.saveUserData(userId, data);
    store.flush();
    for (const it of items) {
      if (it.quantity > 0) {
        inventory.addItem(userId, it.itemId, it.quantity);
      }
    }
    return {
      success: true,
      message: buildGrantMessage(coins, items),
      coinsGranted: coins,
      itemsGranted: items.map((it) => ({ ...it })),
    };
  }

  function buildGrantMessage(coins: number, items: ReadonlyArray<{ itemId: string; quantity: number }>): string {
    const parts: string[] = [];
    if (coins > 0) parts.push(`💰 金币 +${coins}`);
    for (const it of items) {
      const def = inventory.getItemDef(it.itemId);
      const name = def?.name ?? it.itemId;
      parts.push(`🎒 ${name} x${it.quantity}`);
    }
    return parts.length > 0 ? parts.join("，") : "无奖励内容";
  }

  // ─────────────────────────────────────────────────────────
  // Seven-day welfare (progressive, reset on break)
  // ─────────────────────────────────────────────────────────
  function claimSevenDay(userId: string, requestedDay?: number): WelfareClaimResult {
    const data = store.getUserData(userId);
    const w = data.sevenDayWelfare ?? { startDate: null, claimedDays: [], lastClaimDate: null };
    const today = todayStr();

    // First-time activation: lock the start date to today.
    if (!w.startDate) {
      w.startDate = today;
      w.claimedDays = [];
      w.lastClaimDate = null;
    }

    // Determine the next eligible day (1-based).
    const maxClaimed = w.claimedDays.length > 0 ? Math.max(...w.claimedDays) : 0;
    let targetDay = requestedDay ?? maxClaimed + 1;

    // Streak continuity check: if more than one day was skipped, reset.
    if (MMORPG_RULEBOOK.welfare.sevenDayResetOnBreak && w.lastClaimDate) {
      const gap = daysBetween(w.lastClaimDate, today);
      if (gap > 1) {
        // Reset: start a fresh seven-day cycle from today.
        w.startDate = today;
        w.claimedDays = [];
        w.lastClaimDate = null;
        targetDay = 1;
      }
    }

    // Validate the requested day.
    const rewards = MMORPG_RULEBOOK.welfare.sevenDayRewards;
    if (targetDay < 1 || targetDay > rewards.length) {
      return emptyResult("七日福利已全部领取完毕，感谢你的支持！");
    }
    if (w.claimedDays.includes(targetDay)) {
      return emptyResult(`第 ${targetDay} 天的福利已经领取过了。`);
    }

    // Enforce sequential claiming: can only claim the next day, not skip ahead.
    if (targetDay > maxClaimed + 1) {
      targetDay = maxClaimed + 1;
    }

    const reward = rewards[targetDay - 1];
    const result = grant(userId, reward.coins, reward.items);

    w.claimedDays = [...w.claimedDays, targetDay].sort((a, b) => a - b);
    w.lastClaimDate = today;
    data.sevenDayWelfare = w;
    store.saveUserData(userId, data);
    store.flush();

    const dayLabel = targetDay === 7 ? "🎉 第七日大奖" : `第 ${targetDay} 日福利`;
    return {
      ...result,
      message: `🎁 ${dayLabel}领取成功！${result.message}`,
    };
  }

  // ─────────────────────────────────────────────────────────
  // Monthly cumulative-checkin milestones
  // ─────────────────────────────────────────────────────────
  function claimMonthlyMilestones(userId: string): WelfareClaimResult {
    const data = store.getUserData(userId);
    const today = todayStr();
    let m = data.monthlyCheckin;

    // Reset on month rollover.
    if (!m || m.month !== monthStr()) {
      m = { month: monthStr(), totalDays: 0, claimedMilestones: [] };
    }

    // Increment today's check-in count once per day.
    // We piggyback on lastCheckin to avoid double-counting.
    if (data.lastCheckin !== today) {
      // Hasn't checked in today via the checkin plugin yet; still allow welfare
      // accumulation but only count distinct active days (tracked via a marker).
      // We use lastActiveDate as the dedup key.
      if (data.lastActiveDate !== today) {
        m.totalDays += 1;
        data.lastActiveDate = today;
      }
    } else if (data.lastActiveDate !== today) {
      // Checked in today via checkin plugin but not yet counted for monthly.
      m.totalDays += 1;
      data.lastActiveDate = today;
    }

    // Find newly-eligible milestones.
    const newlyEligible = MMORPG_RULEBOOK.welfare.monthlyMilestones.filter(
      (ms) => m!.totalDays >= ms.days && !m!.claimedMilestones.includes(ms.days)
    );

    data.monthlyCheckin = m;
    store.saveUserData(userId, data);
    store.flush();

    if (newlyEligible.length === 0) {
      const next = MMORPG_RULEBOOK.welfare.monthlyMilestones.find(
        (ms) => !m.claimedMilestones.includes(ms.days)
      );
      const hint = next
        ? `本月已累计签到 ${m.totalDays} 天，距离下个奖励（${next.days} 天）还差 ${Math.max(0, next.days - m.totalDays)} 天。`
        : `本月已累计签到 ${m.totalDays} 天，所有月度奖励已领取完毕！`;
      return emptyResult(`暂无可领取的月度签到奖励。${hint}`);
    }

    let totalCoins = 0;
    const totalItems: Array<{ itemId: string; quantity: number }> = [];
    const claimedDays: number[] = [];
    for (const ms of newlyEligible) {
      totalCoins += ms.coins;
      for (const it of ms.items) {
        const existing = totalItems.find((x) => x.itemId === it.itemId);
        if (existing) existing.quantity += it.quantity;
        else totalItems.push({ ...it });
      }
      claimedDays.push(ms.days);
    }

    const result = grant(userId, totalCoins, totalItems);

    data.monthlyCheckin = {
      ...m,
      claimedMilestones: [...m.claimedMilestones, ...claimedDays].sort((a, b) => a - b),
    };
    store.saveUserData(userId, data);
    store.flush();

    const labels = claimedDays.map((d) => `累计${d}天`).join("、");
    return {
      ...result,
      message: `🎊 月度签到大奖领取成功（${labels}）！${result.message}`,
    };
  }

  // ─────────────────────────────────────────────────────────
  // Return reward (lapsed-player comeback)
  // ─────────────────────────────────────────────────────────
  function computeAbsenceDays(userId: string): number {
    const data = store.getUserData(userId);
    if (!data.lastActiveDate) return 0;
    return Math.max(0, daysBetween(data.lastActiveDate, todayStr()));
  }

  function hasPendingReturnReward(userId: string): boolean {
    const data = store.getUserData(userId);
    if (data.returnRewardClaimedForAbsence) return false;
    const absence = computeAbsenceDays(userId);
    return absence >= MMORPG_RULEBOOK.welfare.returnTiers[MMORPG_RULEBOOK.welfare.returnTiers.length - 1].minDaysAbsent;
  }

  function claimReturnReward(userId: string): WelfareClaimResult {
    const data = store.getUserData(userId);
    const absence = computeAbsenceDays(userId);

    // Find the highest tier the user qualifies for (tiers are sorted descending).
    const tier = MMORPG_RULEBOOK.welfare.returnTiers.find((t) => absence >= t.minDaysAbsent);
    if (!tier) {
      return emptyResult("你最近很活跃，暂无回归奖励可领取。继续探索世界吧！");
    }
    if (data.returnRewardClaimedForAbsence) {
      return emptyResult("本次回归奖励已领取。欢迎回来！");
    }

    const result = grant(userId, tier.coins, tier.items);

    data.returnRewardClaimedForAbsence = true;
    data.lastActiveDate = todayStr();
    store.saveUserData(userId, data);
    store.flush();

    return {
      ...result,
      message: `👋 欢迎回归！你离开了 ${absence} 天，回归奖励：${result.message}`,
    };
  }

  // ─────────────────────────────────────────────────────────
  // Level milestone (auto-grant on level-up)
  // ─────────────────────────────────────────────────────────
  function checkLevelMilestones(userId: string, currentLevel: number): WelfareClaimResult {
    const data = store.getUserData(userId);
    const claimed = data.claimedLevelMilestones ?? [];

    const newlyReached = MMORPG_RULEBOOK.welfare.levelMilestones.filter(
      (ms) => currentLevel >= ms.level && !claimed.includes(ms.level)
    );

    if (newlyReached.length === 0) {
      return emptyResult("");
    }

    let totalCoins = 0;
    const totalItems: Array<{ itemId: string; quantity: number }> = [];
    const claimedLevels: number[] = [];
    for (const ms of newlyReached) {
      totalCoins += ms.coins;
      for (const it of ms.items) {
        const existing = totalItems.find((x) => x.itemId === it.itemId);
        if (existing) existing.quantity += it.quantity;
        else totalItems.push({ ...it });
      }
      claimedLevels.push(ms.level);
    }

    const result = grant(userId, totalCoins, totalItems);

    data.claimedLevelMilestones = [...claimed, ...claimedLevels].sort((a, b) => a - b);
    store.saveUserData(userId, data);
    store.flush();

    const labels = claimedLevels.map((l) => `${l}级`).join("、");
    return {
      ...result,
      message: `🏆 等级里程碑达成（${labels}）！${result.message}`,
    };
  }

  // ─────────────────────────────────────────────────────────
  // Welfare center overview
  // ─────────────────────────────────────────────────────────
  function getWelfareCenterText(userId: string): string {
    const data = store.getUserData(userId);
    const w = data.sevenDayWelfare ?? { startDate: null, claimedDays: [], lastClaimDate: null };
    const m = data.monthlyCheckin && data.monthlyCheckin.month === monthStr()
      ? data.monthlyCheckin
      : { month: monthStr(), totalDays: 0, claimedMilestones: [] };
    const absence = computeAbsenceDays(userId);
    const pendingReturn = hasPendingReturnReward(userId);

    // Seven-day progress
    const claimedCount = w.claimedDays.length;
    const nextDay = claimedCount + 1;
    const sevenDayLine = nextDay <= 7
      ? `七日福利：${claimedCount}/7 天，今日可领第 ${nextDay} 天`
      : `七日福利：7/7 天（全部完成）`;

    // Monthly progress
    const nextMonthly = MMORPG_RULEBOOK.welfare.monthlyMilestones.find(
      (ms) => !m.claimedMilestones.includes(ms.days)
    );
    const monthlyLine = nextMonthly
      ? `月度签到：本月累计 ${m.totalDays} 天，下个奖励在 ${nextMonthly.days} 天`
      : `月度签到：本月累计 ${m.totalDays} 天（全部领取）`;

    // Return status
    const returnLine = pendingReturn
      ? `回归奖励：⭐ 可领取（你已离开 ${absence} 天）`
      : absence > 0
        ? `回归奖励：未触发（连续活跃 ${absence === 0 ? "今日" : ""}）`
        : `回归奖励：未触发`;

    return [
      "🎁 福利中心",
      "──────────────",
      sevenDayLine,
      monthlyLine,
      returnLine,
      "",
      `命令：${menuPlugin.getPrefix()}welfare-claim [天数]  领取七日福利`,
      `      ${menuPlugin.getPrefix()}welfare-monthly  领取月度签到大奖`,
      `      ${menuPlugin.getPrefix()}return-reward  领取回归奖励`,
    ].join("\n");
  }

  function markActiveToday(userId: string): void {
    const data = store.getUserData(userId);
    const today = todayStr();
    if (data.lastActiveDate === today) return;

    // If the user was absent long enough to qualify for a return reward, reset
    // the claimed flag so the reward becomes available again after this new lapse.
    if (data.lastActiveDate) {
      const gap = daysBetween(data.lastActiveDate, today);
      if (gap > 1) {
        data.returnRewardClaimedForAbsence = false;
      }
    }
    data.lastActiveDate = today;
    store.saveUserData(userId, data);
    store.flush();
  }

  return {
    name: "reward-system",
    description: "福利奖励系统：连续签到、七日福利、月度大奖、回归奖励、等级里程碑",
    systemPromptAppend: [
      "福利系统已启用：七日福利、月度签到大奖、回归奖励、等级里程碑。",
      "用户可用 $welfare 查看福利中心，$welfare-claim 领取七日福利，$welfare-monthly 领取月度奖励，$return-reward 领取回归奖励。",
      "每日首次对话会自动更新活跃状态并提示可领奖励。",
    ].join("\n"),

    getWelfareCenterText,
    claimSevenDay,
    claimMonthlyMilestones,
    claimReturnReward,
    checkLevelMilestones,
    hasPendingReturnReward,
    markActiveToday,

    onLoad(ctx: PluginContext) {
      const prefix = menuPlugin.getPrefix();

      menuPlugin.registerCommand("welfare", "🎁 查看福利中心", async (message: BotMessage) => {
        const userId = message.userId!;
        markActiveToday(userId);
        await ctx.replyText(message, getWelfareCenterText(userId));
      });

      menuPlugin.registerCommand(
        "welfare-claim",
        `领取七日福利：${prefix}welfare-claim [天数1-7]`,
        async (message: BotMessage, args: string[]) => {
          const userId = message.userId!;
          const day = args[0] ? parseInt(args[0], 10) : undefined;
          if (day !== undefined && (isNaN(day) || day < 1 || day > 7)) {
            await ctx.replyText(message, `用法：${prefix}welfare-claim [天数1-7]`);
            return;
          }
          markActiveToday(userId);
          const result = claimSevenDay(userId, day);
          await ctx.replyText(message, result.message);
        }
      );

      menuPlugin.registerCommand("welfare-monthly", "领取月度签到大奖", async (message: BotMessage) => {
        const userId = message.userId!;
        markActiveToday(userId);
        const result = claimMonthlyMilestones(userId);
        await ctx.replyText(message, result.message);
      });

      menuPlugin.registerCommand("return-reward", "领取回归奖励", async (message: BotMessage) => {
        const userId = message.userId!;
        markActiveToday(userId);
        const result = claimReturnReward(userId);
        await ctx.replyText(message, result.message);
      });
    },
  };
}
