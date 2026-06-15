import fs from "node:fs";
import path from "node:path";
import type { UserProfile, ItemDef, DataStorePlugin } from "../../types.js";
import type { MessageStore } from "../../message-store.js";

const DEFAULT_ITEMS: ItemDef[] = [
  { id: "rose", name: "玫瑰", description: "表达爱意的红玫瑰", price: 10 },
  { id: "chocolate", name: "巧克力", description: "甜蜜的巧克力", price: 15 },
  { id: "cake", name: "蛋糕", description: "美味的生日蛋糕", price: 30 },
  { id: "ring", name: "戒指", description: "闪亮的戒指", price: 100 },
  { id: "card", name: "贺卡", description: "写满祝福的贺卡", price: 5 },
];

function defaultProfile(): UserProfile {
  return {
    coins: 0,
    lastCheckin: null,
    checkinStreak: 0,
    lastAutoCheckinNoticeDate: null,
    inventory: {},
    affinity: { ai: 0, users: {} },
    interactionStats: {
      ai: { gifts: 0, chats: 0 },
      users: {},
    },
  };
}

export function createDataStorePlugin(messageStore: MessageStore): DataStorePlugin {
  const users = new Map<string, UserProfile>();
  let items: ItemDef[] = [];
  let saveTimer: NodeJS.Timeout | null = null;
  const dirtyUsers = new Set<string>();

  // ── Load data (SQLite + JSON auto-migration) ────────────────────────
  function loadData() {
    // Auto-migrate from legacy JSON if it exists
    const jsonPath = path.resolve(process.cwd(), "data", "plugins.json");
    if (fs.existsSync(jsonPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as { users?: Record<string, UserProfile>; items?: ItemDef[] };
        const legacyUsers = raw.users ?? {};
        const userKeys = Object.keys(legacyUsers);
        if (userKeys.length > 0) {
          console.log(`[DataStore] 检测到旧版 plugins.json（${userKeys.length} 个用户），开始迁移至 SQLite…`);
          for (const [userId, profile] of Object.entries(legacyUsers)) {
            messageStore.saveUserProfile(userId, ensureProfileShape(profile));
          }
          console.log("[DataStore] plugins.json 用户数据迁移完成");
        }
        if (raw.items && raw.items.length > 0) {
          for (const item of raw.items) {
            messageStore.saveItemDef(item);
          }
          console.log(`[DataStore] plugins.json 物品定义迁移完成（${raw.items.length} 个）`);
        }
        fs.renameSync(jsonPath, jsonPath + ".archived");
        console.log("[DataStore] plugins.json 已归档为 .archived");
      } catch (error) {
        console.error("[DataStore] 迁移 plugins.json 失败:", error);
      }
    }

    // Load from SQLite
    const profiles = messageStore.getAllUserProfiles();
    for (const { userId, profile } of profiles) {
      users.set(userId, ensureProfileShape(profile));
    }

    const dbItems = messageStore.getAllItemDefs();
    items = dbItems.length > 0 ? dbItems : [...DEFAULT_ITEMS];

    // If SQLite had no items, persist defaults
    if (dbItems.length === 0) {
      for (const item of DEFAULT_ITEMS) {
        messageStore.saveItemDef(item);
      }
    }
  }

  loadData();

  // ── Debounced persist (only dirty profiles) ─────────────────────────
  function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        for (const userId of dirtyUsers) {
          const profile = users.get(userId);
          if (profile) {
            messageStore.saveUserProfile(userId, profile);
          }
        }
        dirtyUsers.clear();
      } catch (error) {
        console.error("[DataStore] 保存失败:", error);
      } finally {
        saveTimer = null;
      }
    }, 500);
  }

  return {
    name: "data-store",
    description: "经济与社交系统的数据持久化存储（SQLite）",

    getUserData(userId: string): UserProfile {
      if (!users.has(userId)) {
        users.set(userId, defaultProfile());
        dirtyUsers.add(userId);
        persist();
      }
      const profile = ensureProfileShape(users.get(userId)!);
      users.set(userId, profile);
      return profile;
    },

    saveUserData(userId: string, profile: UserProfile) {
      const shaped = ensureProfileShape(profile);
      users.set(userId, shaped);
      dirtyUsers.add(userId);
      persist();
    },

    flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      try {
        for (const userId of dirtyUsers) {
          const profile = users.get(userId);
          if (profile) {
            messageStore.saveUserProfile(userId, profile);
          }
        }
        dirtyUsers.clear();
      } catch (error) {
        console.error("[DataStore] 立即保存失败:", error);
      }
    },

    getAllUserEntries() {
      return Array.from(users.entries()).map(([userId, profile]) => ({ userId, profile }));
    },

    getItem(itemId: string): ItemDef | undefined {
      return items.find((item) => item.id === itemId);
    },

    getAllItems(): ItemDef[] {
      return [...items];
    },

    addItem(item: ItemDef) {
      items.push(item);
      messageStore.saveItemDef(item);
    },
  };
}

function ensureProfileShape(profile: UserProfile): UserProfile {
  const nextProfile = profile as UserProfile & {
    interactionStats?: UserProfile["interactionStats"];
  };

  nextProfile.inventory ??= {};
  nextProfile.lastAutoCheckinNoticeDate ??= null;
  nextProfile.affinity ??= { ai: 0, users: {} };
  nextProfile.affinity.users ??= {};
  nextProfile.interactionStats ??= {
    ai: { gifts: 0, chats: 0 },
    users: {},
  };
  nextProfile.interactionStats.ai ??= { gifts: 0, chats: 0 };
  nextProfile.interactionStats.ai.gifts ??= 0;
  nextProfile.interactionStats.ai.chats ??= 0;
  nextProfile.interactionStats.users ??= {};

  // Welfare system fields (all optional; defaulted lazily by the welfare plugin).
  nextProfile.sevenDayWelfare ??= { startDate: null, claimedDays: [], lastClaimDate: null };
  nextProfile.monthlyCheckin ??= { month: currentMonthStr(), totalDays: 0, claimedMilestones: [] };
  nextProfile.lastActiveDate ??= null;
  nextProfile.claimedLevelMilestones ??= [];
  nextProfile.returnRewardClaimedForAbsence ??= false;

  return nextProfile;
}

function currentMonthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
