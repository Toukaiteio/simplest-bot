import type {
  PluginContext,
  BotMessage,
  ShopPlugin,
  DataStorePlugin,
  InventoryPlugin,
  CheckinPlugin,
  SocialPlugin,
  MenuPlugin,
} from "../../types.js";
import { MMORPG_RULEBOOK } from "../mmorpg/rulebook.js";

function getTodayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function createShopPlugin(
  store: DataStorePlugin,
  inventory: InventoryPlugin,
  _checkin: CheckinPlugin,
  social: SocialPlugin,
  menuPlugin: MenuPlugin
): ShopPlugin {
  return {
    name: "shop",
    description: "商城系统：购买礼物赠送 AI 或好友",

    getShopText(): string {
      const items = store.getAllItems();
      const lines = items.map((item) => `${item.id} - ${item.name}: ${item.price} 金币（${item.description}）`);
      return "🛒 商城物品列表：\n" + lines.join("\n");
    },

    buyItem(userId: string, itemId: string, quantity = 1): boolean {
      const item = store.getItem(itemId);
      if (!item || quantity < 1) return false;

      const totalCost = item.price * quantity;
      const data = store.getUserData(userId);
      if (data.coins < totalCost) return false;

      data.coins -= totalCost;
      store.saveUserData(userId, data);
      inventory.addItem(userId, itemId, quantity);
      return true;
    },

    giftItem(fromUserId: string, toUserId: string, itemId: string, quantity = 1): boolean {
      if (!inventory.hasItem(fromUserId, itemId, quantity)) return false;

      // Daily gift limit check
      const data = store.getUserData(fromUserId);
      const today = getTodayDateStr();
      const dailyInfo = data.dailyGifts;
      const usedToday = dailyInfo?.date === today ? dailyInfo.count : 0;
      if (usedToday + quantity > MMORPG_RULEBOOK.affinity.dailyGiftLimit) return false;

      inventory.removeItem(fromUserId, itemId, quantity);
      inventory.addItem(toUserId, itemId, quantity);

      const affinityPerGift = MMORPG_RULEBOOK.affinity.perGift;
      social.addUserAffinity(fromUserId, toUserId, affinityPerGift * quantity);
      if (toUserId === "ai") {
        social.addAIAffinity(fromUserId, Math.round(affinityPerGift * 1.5) * quantity);
        social.recordInteraction(fromUserId, "ai", "gift", quantity);
      } else {
        social.addAIAffinity(fromUserId, Math.round(affinityPerGift * 0.3) * quantity);
        social.recordInteraction(fromUserId, toUserId, "gift", quantity);
        social.addUserAffinity(toUserId, fromUserId, Math.round(affinityPerGift * 0.6) * quantity);
      }

      // Update daily gift counter
      const freshData = store.getUserData(fromUserId);
      freshData.dailyGifts = { date: today, count: usedToday + quantity };
      store.saveUserData(fromUserId, freshData);

      return true;
    },

    /**
     * Returns how many gifts the user can still send today.
     */
    getRemainingDailyGifts(userId: string): number {
      const data = store.getUserData(userId);
      const today = getTodayDateStr();
      const dailyInfo = data.dailyGifts;
      const usedToday = dailyInfo?.date === today ? dailyInfo.count : 0;
      return Math.max(0, MMORPG_RULEBOOK.affinity.dailyGiftLimit - usedToday);
    },

    onLoad(ctx: PluginContext) {
      const prefix = menuPlugin.getPrefix();

      menuPlugin.registerCommand("shop", "查看商城物品列表", async (message: BotMessage) => {
        await ctx.replyText(message, this.getShopText());
      });

      menuPlugin.registerCommand("buy", `购买物品：${prefix}buy <物品ID> [数量]`, async (message: BotMessage, args: string[]) => {
        if (!args[0]) {
          await ctx.replyText(message, `用法：${prefix}buy <物品ID> [数量]`);
          return;
        }
        const userId = message.userId!;
        const itemId = args[0];
        const quantity = Math.max(1, parseInt(args[1], 10) || 1);
        const item = store.getItem(itemId);
        if (!item) {
          await ctx.replyText(message, `物品 ${itemId} 不存在。使用 ${prefix}shop 查看可购买物品。`);
          return;
        }
        const totalCost = item.price * quantity;
        if (!this.buyItem(userId, itemId, quantity)) {
          await ctx.replyText(message, `金币不足，无法购买 ${quantity} 个。需要 ${totalCost} 金币。`);
          return;
        }
        await ctx.replyText(message, `成功购买 ${quantity} 个 ${item.name}！花费 ${totalCost} 金币。`);
      });

      menuPlugin.registerCommand("gift", `赠送物品给好友或 AI：${prefix}gift <用户ID> <物品ID> [数量]`, async (message: BotMessage, args: string[]) => {
        if (args.length < 2) {
          await ctx.replyText(message, `用法：${prefix}gift <用户ID> <物品ID> [数量]`);
          return;
        }
        const fromUserId = message.userId!;
        const toUserId = args[0];
        const itemId = args[1];
        const quantity = Math.max(1, parseInt(args[2], 10) || 1);
        const item = store.getItem(itemId);
        if (!item) {
          await ctx.replyText(message, `物品 ${itemId} 不存在。`);
          return;
        }
        if (!this.giftItem(fromUserId, toUserId, itemId, quantity)) {
          const remaining = this.getRemainingDailyGifts(fromUserId);
          if (remaining <= 0) {
            await ctx.replyText(message, `今日赠送次数已用完（每日最多 ${MMORPG_RULEBOOK.affinity.dailyGiftLimit} 个）。明天再来吧。`);
          } else if (quantity > remaining) {
            await ctx.replyText(message, `今日剩余赠送次数不足。今日还可赠送 ${remaining} 个。`);
          } else {
            await ctx.replyText(message, `你没有 ${quantity} 个 ${item.name}。`);
          }
          return;
        }
        await ctx.replyText(message, `成功赠送 ${quantity} 个 ${item.name} 给 ${toUserId}！今日剩余赠送次数：${this.getRemainingDailyGifts(fromUserId)}`);
      });

      menuPlugin.registerCommand("coins", "查看我的金币数量", async (message: BotMessage) => {
        const data = store.getUserData(message.userId!);
        await ctx.replyText(message, `💰 当前金币：${data.coins}`);
      });

      menuPlugin.registerCommand("inventory", "查看我的物品栏", async (message: BotMessage) => {
        const userId = message.userId!;
        const inv = inventory.getInventory(userId);
        const items = Object.entries(inv)
          .map(([id, qty]) => {
            const def = inventory.getItemDef(id);
            return `${def ? def.name : id} x${qty}`;
          });
        const text = items.length > 0
          ? "🎒 你的物品栏：\n" + items.join("\n")
          : "🎒 物品栏为空。";
        await ctx.replyText(message, text);
      });
    },
  };
}
