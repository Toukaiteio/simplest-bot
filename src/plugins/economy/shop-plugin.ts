import type {
  PluginContext,
  BotMessage,
  ShopPlugin,
  DataStorePlugin,
  InventoryPlugin,
  CheckinPlugin,
  SocialPlugin,
  MenuPlugin,
  InventorySubMenu,
} from "../../types.js";
import { MMORPG_RULEBOOK } from "../mmorpg/rulebook.js";
import { normalizeOptionalUserId } from "../mmorpg/framework/utils.js";
import fs from "node:fs";
import path from "node:path";
import { screenshotHtml } from "../mmorpg/screenshot.js";

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
        const toUserId = normalizeOptionalUserId(args[0]) ?? args[0];
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

        // Economy items
        const inv = inventory.getInventory(userId);
        const ecoItems = Object.entries(inv)
          .map(([id, qty]) => {
            const def = inventory.getItemDef(id);
            return { name: def?.name ?? id, qty };
          })
          .sort((a, b) => b.qty - a.qty);

        // Sub-menu items
        const subMenus = inventory.getSubMenus();
        const sections: Array<{ title: string; items: Array<{ name: string; qty: number }> }> = [];

        if (ecoItems.length > 0) {
          sections.push({ title: "通用背包", items: ecoItems });
        }

        for (const sub of subMenus) {
          const items = sub.getItems(userId);
          if (items.length > 0) {
            sections.push({
              title: sub.name,
              items: items.map((i) => ({ name: i.name, qty: i.quantity })),
            });
          }
        }

        if (sections.length === 0) {
          await ctx.replyText(message, "🧳 物品栏为空。");
          return;
        }

        const html = buildInventoryHtml(sections);
        const dir = path.resolve("data/inventory-images");
        fs.mkdirSync(dir, { recursive: true });
        const fp = path.join(dir, "inv-" + Date.now() + ".webp");
        await screenshotHtml(html, fp, { width: 420, format: "webp", quality: 85 });

        const target = message.type === "group"
          ? { type: "group" as const, id: message.groupId! }
          : { type: "private" as const, id: message.userId! };
        await ctx.sendImage(target, fp);
        fs.unlink(fp, () => {});
      });
    },
  };
}

// ── Inventory HTML card renderer ───────────────────────────────────────────

function buildInventoryHtml(sections: Array<{ title: string; items: Array<{ name: string; qty: number }> }>): string {
  const sectionHtml = sections.map((sec, si) => {
    const isFirst = si === 0;
    const itemsHtml = sec.items.slice(0, 30).map((item) => {
      const name = escapeHtml(item.name);
      return '<div class="inv-row"><span class="inv-name">' + name + '</span><span class="inv-qty">x' + item.qty + '</span></div>';
    }).join("");
    const overflow = sec.items.length > 30 ? '<div class="inv-more">...还有 ' + (sec.items.length - 30) + ' 件</div>' : "";
    return (!isFirst ? '<div class="inv-div"></div>' : "") +
      '<div class="inv-sec-title">' + escapeHtml(sec.title) + '</div>' +
      '<div class="inv-items">' + itemsHtml + overflow + '</div>';
  }).join("");

  const bagIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8' +
    'a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/>' +
    '<line x1="12" y1="22.08" x2="12" y2="12"/></svg>';

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><style>' +
    '*{box-sizing:border-box}html,body{margin:0;padding:0;background:#0f1117}body{' +
    'padding:16px;font-family:"Inter","Microsoft YaHei","PingFang SC",sans-serif;' +
    'color:#e6e9f2;font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}' +
    '.sheet{width:388px;margin:0 auto;background:#161924;border:1px solid #2a3045;' +
    'border-radius:14px;padding:16px 14px 14px}' +
    '.hd{font-size:16px;font-weight:700;padding-bottom:10px;margin-bottom:10px;' +
    'border-bottom:1px solid #2a3045;display:flex;align-items:center;gap:8px}' +
    '.hd svg{width:16px;height:16px;color:#6ea8ff}' +
    '.inv-div{height:1px;background:#232838;margin:8px 0}' +
    '.inv-sec-title{font-size:12px;font-weight:600;color:#7a8095;margin-bottom:6px;letter-spacing:0.04em}' +
    '.inv-items{display:flex;flex-direction:column;gap:1px}' +
    '.inv-row{display:flex;justify-content:space-between;align-items:center;padding:5px 6px;border-radius:6px}' +
    '.inv-row:hover{background:#1c2030}' +
    '.inv-name{color:#e6e9f2;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.inv-qty{color:#b8bcc9;font-size:12px;font-weight:600;font-family:"JetBrains Mono","Consolas",monospace;flex-shrink:0;margin-left:8px}' +
    '.inv-more{color:#7a8095;font-size:11px;text-align:center;padding:4px 0}' +
    '</style></head><body><div class="sheet">' +
    '<div class="hd">' + bagIcon + '<span>物品栏</span></div>' +
    sectionHtml +
    '</div></body></html>';
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
