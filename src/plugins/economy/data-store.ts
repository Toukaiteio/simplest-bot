import fs from "node:fs";
import path from "node:path";
import type { UserProfile, ItemDef, DataStorePlugin } from "../../types.js";

const DATA_FILE = path.resolve(process.cwd(), "data", "plugins.json");

const DEFAULT_ITEMS: ItemDef[] = [
  { id: "rose", name: "玫瑰", description: "表达爱意的红玫瑰", price: 10 },
  { id: "chocolate", name: "巧克力", description: "甜蜜的巧克力", price: 15 },
  { id: "cake", name: "蛋糕", description: "美味的生日蛋糕", price: 30 },
  { id: "ring", name: "戒指", description: "闪亮的戒指", price: 100 },
  { id: "card", name: "贺卡", description: "写满祝福的贺卡", price: 5 },
];

type StoreData = {
  users: Record<string, UserProfile>;
  items: ItemDef[];
};

function defaultProfile(): UserProfile {
  return {
    coins: 0,
    lastCheckin: null,
    checkinStreak: 0,
    lastAutoCheckinNoticeDate: null,
    inventory: {},
    affinity: { ai: 0, users: {} },
    interactionStats: {
      ai: {
        gifts: 0,
        chats: 0,
      },
      users: {},
    },
  };
}

let saveTimer: NodeJS.Timeout | null = null;

export function createDataStorePlugin(): DataStorePlugin {
  let data: StoreData = loadData();

  function writeToDisk() {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
  }

  function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        writeToDisk();
      } catch (error) {
        console.error("[DataStore] 保存失败:", error);
      } finally {
        saveTimer = null;
      }
    }, 500);
  }

  return {
    name: "data-store",
    description: "经济与社交系统的数据持久化存储",

    getUserData(userId: string): UserProfile {
      if (!data.users[userId]) {
        data.users[userId] = defaultProfile();
        persist();
      }
      data.users[userId] = ensureProfileShape(data.users[userId]);
      return data.users[userId];
    },

    saveUserData(userId: string, profile: UserProfile) {
      data.users[userId] = ensureProfileShape(profile);
      persist();
    },

    flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      try {
        writeToDisk();
      } catch (error) {
        console.error("[DataStore] 立即保存失败:", error);
      }
    },

    getAllUserEntries() {
      return Object.entries(data.users).map(([userId, profile]) => ({ userId, profile }));
    },

    getItem(itemId: string): ItemDef | undefined {
      return data.items.find((item) => item.id === itemId);
    },

    getAllItems(): ItemDef[] {
      return [...data.items];
    },

    addItem(item: ItemDef) {
      data.items.push(item);
      persist();
    },
  };
}

function loadData(): StoreData {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      return JSON.parse(raw) as StoreData;
    }
  } catch (error) {
    console.error("[DataStore] 读取失败，使用默认数据:", error);
  }
  return { users: {}, items: [...DEFAULT_ITEMS] };
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
