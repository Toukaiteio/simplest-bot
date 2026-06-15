import type { MMORPGContent, PlayerState, StatBlock } from "./schema.js";

export const MMORPG_RULEBOOK = {
  version: "0.2.0",
  combat: {
    critRatePerAgility: 0.002,
    dodgeRatePerAgility: 0.0015,
    attackPowerPerStrength: 2,
    defensePowerPerDefense: 1.8,
    socialPowerPerCharm: 1.2,
    negotiationPowerPerEloquence: 1.4,
    hpPerLife: 16,
    focusPerEloquence: 8,
    staminaPerEndurance: 5,
    /** CTB (Charge Time Battle) speed-bar parameters. */
    ctSpeedBase: 100,
    ctSpeedPerAgility: 20,
    ctGaugeThreshold: 1000,
    ctDefaultTimeCost: 500,
    focusRegenPerTick: 0.02,
    staminaRegenPerTick: 0.025,
    ticksPerCooldownTurn: 6,
  },
  progression: {
    baseExpToLevel: 100,
    expGrowthFactor: 1.005,
    maxLevel: 5000,
    /* 经验系数 +250%（原×1 → ×3.5），减缓升级速度 */
    expCoefficient: 3.5,
  },
  social: {
    maxPartySize: 5,
    maxGuildMembers: 50,
    mailRetentionDays: 30,
    marriageRequiredLevel: 120,
    marriageRequiredAffinity: 5000,
    /** Maximum affinity value between two users. */
    maxAffinity: 10000,
    /** Minimum affinity value (floor). */
    minAffinity: 0,
  },
  affinity: {
    /** Affinity gained per gift sent. */
    perGift: 50,
    /** Affinity gained when mentioned (@). */
    perMention: 5,
    /** Affinity gained per reply. */
    perReply: 3,
    /** Affinity gained per chat interaction with AI. */
    perChat: 2,
    /** Affinity gained by party members after a battle (non-leader gets more). */
    partyBattleLeader: 5,
    partyBattleMember: 10,
    /** Daily decay rate applied to all user-to-user affinity values. */
    dailyDecayRate: 0.002,
    /** Maximum daily gifts a user can send. */
    dailyGiftLimit: 10,
  },
  behavior: {
    /** AI affinity threshold for daily group greeting. */
    greetingThreshold: 5000,
    /** AI affinity threshold for cute language style. */
    cuteLanguageThreshold: 2000,
    /** AI affinity threshold for max-intimacy language style. */
    maxCuteThreshold: 8000,

    /** Cooldown (conversation rounds) after using ±5 affinity tool. */
    cooldownTiny: 1,
    /** Cooldown (conversation rounds) after using ±100 affinity tool. */
    cooldownNormal: 5,
    /** Cooldown (conversation rounds) after using ±1000 affinity tool. */
    cooldownMajor: 30,

    /** Max absolute delta for tiny affinity tool. */
    toolTinyMax: 5,
    /** Max absolute delta for normal affinity tool. */
    toolNormalMax: 100,
    /** Max absolute delta for major affinity tool. */
    toolMajorMax: 1000,
  },
  monster: {
    poolBaseRefreshMinutes: 2,       // base minutes for one monster slot to regenerate
    poolMinRefreshMinutes: 0.5,      // floor: fastest refresh with max players nearby
    poolRefreshPerActivePlayer: 0.3, // each active player in area reduces refresh by this many minutes
    poolDefaultSize: 6,              // default monster pool size per area (if cannot be computed)
    deathGoldLossRate: 0.5,
    deathGoldRecoverRate: 0.3,
    combatDamagePerLevel: 3,
    combatDefenseReduction: 0.5,
  },
  economy: {
    coinsRewardSource: "bot_coins_bridged",
    marketFeeRate: 0.08,
    /** NPC shop buys items back at this fraction of sellPrice (fixes buy/sell parity arbitrage). */
    npcSellBackRate: 0.5,
    /** Base recycle rate applied before rarity/enhance multipliers (creates a gold sink). */
    recycleBaseRate: 0.6,
    /** Multiplier per enhancement level when recycling enhanced gear. Raised from 0.1 to 0.2 to
     *  better reflect the linearly-scaling enhance cost (1 + level × 0.5). */
    recycleEnhanceMultiplierPerLevel: 0.2,
    dailyQuestResetHour: 4,
    marriageRingItemId: "wedding_ring",
    raceChangeItemId: "race_rewrite_scroll",
    genderChangeItemId: "gender_mirror",
    appearanceChangeItemId: "makeover_ticket",
  },
  marriage: {
    baseBonusRate: 0.05,
    partyBonusRate: 0.3,
  },
  party: {
    baseExpPerExtraMember: 0.02,
    baseGoldPerExtraMember: 0.01,
    classDiversityExpBonus: 0.03,
    maxExpFromParty: 0.2,
    maxGoldFromParty: 0.1,
  },
  fishing: {
    minWaitSeconds: 20,
    maxWaitSeconds: 90,
    minFishPrice: 1,
    maxFishPrice: 120,
    rarityBonus: {
      common: 0,
      uncommon: 2,
      rare: 5,
      epic: 8,
      legendary: 11,
    },
  },
  skillSlots: {
    /** Initial number of skill slots for a new character. */
    baseSlots: 3,
    /** Every N levels grants one additional skill slot. */
    extraSlotEveryLevel: 50,
    /** Each rebirth grants this many additional slots. */
    extraSlotPerRebirth: 1,
    /** Hard cap on total skill slots. */
    maxSlots: 8,
  },
  welfare: {
    /** Seven-day welfare reward table (progressive, Day 7 is the jackpot).
     *  Items use existing MMO item IDs so they flow through the normal inventory system. */
    sevenDayRewards: [
      { day: 1, coins: 200, items: [{ itemId: "small_healing_potion", quantity: 10 }] },
      { day: 2, coins: 300, items: [{ itemId: "iron_ore", quantity: 15 }] },
      { day: 3, coins: 500, items: [{ itemId: "cloth_bandage", quantity: 10 }] },
      { day: 4, coins: 800, items: [{ itemId: "mid_healing_potion", quantity: 5 }] },
      { day: 5, coins: 1200, items: [{ itemId: "focus_tonic", quantity: 5 }, { itemId: "iron_ore", quantity: 20 }] },
      { day: 6, coins: 2000, items: [{ itemId: "high_healing_potion", quantity: 3 }, { itemId: "war_elixir", quantity: 2 }] },
      { day: 7, coins: 5000, items: [{ itemId: "dragon_tonic", quantity: 2 }, { itemId: "spirit_elixir", quantity: 2 }] },
    ],
    /** Monthly cumulative-checkin milestones (per calendar month, non-cumulative reset). */
    monthlyMilestones: [
      { days: 7, coins: 800, items: [{ itemId: "mid_healing_potion", quantity: 3 }] },
      { days: 14, coins: 2000, items: [{ itemId: "spirit_elixir", quantity: 2 }] },
      { days: 21, coins: 5000, items: [{ itemId: "high_healing_potion", quantity: 5 }] },
      { days: 28, coins: 12000, items: [{ itemId: "dragon_tonic", quantity: 2 }] },
    ],
    /** Return reward tiers, keyed by minimum days absent. Checked in descending order. */
    returnTiers: [
      { minDaysAbsent: 30, coins: 8000, items: [{ itemId: "dragon_tonic", quantity: 2 }] },
      { minDaysAbsent: 14, coins: 3000, items: [{ itemId: "high_healing_potion", quantity: 3 }, { itemId: "war_elixir", quantity: 2 }] },
      { minDaysAbsent: 7, coins: 1000, items: [{ itemId: "mid_healing_potion", quantity: 5 }] },
    ],
    /** Level milestone rewards, granted automatically when a player reaches the level. */
    levelMilestones: [
      { level: 10, coins: 500, items: [{ itemId: "iron_ore", quantity: 10 }] },
      { level: 30, coins: 1500, items: [{ itemId: "mid_healing_potion", quantity: 5 }] },
      { level: 50, coins: 3000, items: [{ itemId: "high_healing_potion", quantity: 3 }] },
      { level: 100, coins: 8000, items: [{ itemId: "war_elixir", quantity: 2 }, { itemId: "iron_ore", quantity: 30 }] },
      { level: 200, coins: 20000, items: [{ itemId: "spirit_elixir", quantity: 2 }] },
      { level: 500, coins: 50000, items: [{ itemId: "dragon_tonic", quantity: 3 }] },
      { level: 1000, coins: 150000, items: [{ itemId: "dragon_tonic", quantity: 5 }, { itemId: "spirit_elixir", quantity: 5 }] },
    ],
    /** Whether a break in the seven-day streak resets progress. */
    sevenDayResetOnBreak: true,
  },
  rebirth: {
    /** Flat stat bonus per rebirth for each stat. */
    statBonusPerRebirth: 3,
    /** HP bonus per rebirth. */
    hpBonusPerRebirth: 50,
    /** Maximum number of rebirths. */
    maxRebirths: 10,
  },
  mmoShop: {
    /** Items available in the MMO gold sink shop with their prices. */
    items: [
      { itemId: "small_healing_potion", price: 20 },
      { itemId: "mid_healing_potion", price: 60 },
      { itemId: "high_healing_potion", price: 150 },
      { itemId: "focus_tonic", price: 15 },
      { itemId: "spirit_elixir", price: 200 },
      { itemId: "war_elixir", price: 100 },
      { itemId: "flame_ward_potion", price: 80 },
      { itemId: "dragon_tonic", price: 400 },
      { itemId: "antidote", price: 15 },
      { itemId: "alchemy_kit", price: 25 },
      { itemId: "field_ration", price: 10 },
      { itemId: "kingdom_ration", price: 30 },
      { itemId: "cloth_bandage", price: 8 },
      { itemId: "wedding_ring", price: 888 },
      { itemId: "race_rewrite_scroll", price: 500 },
      { itemId: "gender_mirror", price: 500 },
      { itemId: "makeover_ticket", price: 300 },
    ],
  },
  gathering: {
    /** Base time in seconds for a single gather action. */
    baseSecondsPerGather: 5,
    /** Default number of available gather slots per area. */
    poolDefaultSize: 3,
    /** Base refresh interval in minutes for a gathered slot to recover. */
    poolBaseRefreshMinutes: 1,
    /** Minimum refresh interval in minutes (regardless of active player count). */
    poolMinRefreshMinutes: 0.3,
    /** Minutes subtracted from refresh interval per active player in the area. */
    poolRefreshPerActivePlayer: 0.15,
  },
  travel: {
    /** Base travel time in seconds per step for multi-step movement. */
    baseSecondsPerStep: 5,
    /** Maximum number of steps allowed in a single auto-travel path. */
    maxPathSteps: 20,
  },
  agentWorkflow: {
    singleSourceOfTruth: [
      "schema.ts 负责定义数据形状",
      "default-content.ts 负责内容登记",
      "rulebook.ts 负责数值公式",
      "validator.ts 负责引用关系与结构校验",
      "state-store.ts 负责玩家、公会、队伍、拍卖和世界状态持久化",
    ],
  },
} as const;

export function createBaseStats(classId: string): StatBlock {
  if (classId === "warrior") {
    return { strength: 8, defense: 7, charm: 3, agility: 4, eloquence: 2, endurance: 7, life: 8 };
  }
  if (classId === "mage") {
    return { strength: 2, defense: 3, charm: 5, agility: 3, eloquence: 8, endurance: 4, life: 5 };
  }
  if (classId === "ranger") {
    return { strength: 4, defense: 4, charm: 4, agility: 8, eloquence: 4, endurance: 5, life: 6 };
  }
  if (classId === "cleric") {
    return { strength: 3, defense: 4, charm: 7, agility: 3, eloquence: 8, endurance: 5, life: 6 };
  }
  if (classId === "rogue") {
    return { strength: 5, defense: 3, charm: 5, agility: 9, eloquence: 5, endurance: 4, life: 5 };
  }
  if (classId === "paladin") {
    return { strength: 6, defense: 9, charm: 5, agility: 3, eloquence: 4, endurance: 6, life: 7 };
  }
  if (classId === "warlock") {
    return { strength: 3, defense: 3, charm: 7, agility: 4, eloquence: 9, endurance: 5, life: 5 };
  }
  if (classId === "druid") {
    return { strength: 4, defense: 4, charm: 6, agility: 7, eloquence: 5, endurance: 6, life: 6 };
  }
  if (classId === "martial_god") {
    return { strength: 10, defense: 9, charm: 3, agility: 5, eloquence: 3, endurance: 8, life: 9 };
  }
  if (classId === "holy_spirit_mage") {
    return { strength: 3, defense: 4, charm: 9, agility: 4, eloquence: 10, endurance: 5, life: 7 };
  }
  if (classId === "dragon_knight") {
    return { strength: 8, defense: 7, charm: 6, agility: 5, eloquence: 4, endurance: 7, life: 8 };
  }
  if (classId === "magic_swordsman") {
    return { strength: 6, defense: 5, charm: 5, agility: 6, eloquence: 8, endurance: 5, life: 6 };
  }
  return { strength: 5, defense: 5, charm: 5, agility: 5, eloquence: 5, endurance: 5, life: 5 };
}

export function createBaseResources(stats: StatBlock) {
  return {
    hp: 100 + stats.life * MMORPG_RULEBOOK.combat.hpPerLife,
    focus: 40 + stats.eloquence * MMORPG_RULEBOOK.combat.focusPerEloquence,
    stamina: 60 + stats.endurance * MMORPG_RULEBOOK.combat.staminaPerEndurance,
  };
}

/**
 * Compute the maximum resource capacities for a given stat block.
 * Returns maxHp, maxFocus, maxStamina — the ceiling values.
 */
export function getMaxResources(stats: StatBlock) {
  return {
    maxHp: 100 + stats.life * MMORPG_RULEBOOK.combat.hpPerLife,
    maxFocus: 40 + stats.eloquence * MMORPG_RULEBOOK.combat.focusPerEloquence,
    maxStamina: 60 + stats.endurance * MMORPG_RULEBOOK.combat.staminaPerEndurance,
  };
}

export function getExpRequiredForLevel(level: number): number {
  // 多项式曲线：exp = max(50, level × 15 + level^1.6) × expCoefficient
  // 同等级怪物每只约提供 5~12% 的经验，杜绝单杀直升多级
  const base = Math.max(50, level * 15 + Math.pow(level, 1.6));
  return Math.round(base * MMORPG_RULEBOOK.progression.expCoefficient);
}

export function calculateCombatPower(player: PlayerState): number {
  const physical = player.stats.strength * MMORPG_RULEBOOK.combat.attackPowerPerStrength;
  const defense = player.stats.defense * MMORPG_RULEBOOK.combat.defensePowerPerDefense;
  const social = player.stats.charm * MMORPG_RULEBOOK.combat.socialPowerPerCharm;
  const utility = player.stats.eloquence * MMORPG_RULEBOOK.combat.negotiationPowerPerEloquence;
  const mobility = player.stats.agility * 1.5;
  const sustain = player.stats.endurance * 2 + player.stats.life * 2;
  return Math.round(player.level * 10 + physical + defense + social + utility + mobility + sustain);
}

export function summarizeFramework(content: MMORPGContent): string[] {
  return [
    `规则版本：${MMORPG_RULEBOOK.version}`,
    `职业数：${Object.keys(content.classes).length}`,
    `技能数：${Object.keys(content.skills).length}`,
    `地图区域：${Object.keys(content.areas).length}`,
    `任务数：${Object.keys(content.quests).length}`,
    `副本数：${Object.keys(content.dungeons).length}`,
    `副职业数：${Object.keys(content.professions).length}`,
    "账号态说明：玩家、公会、队伍、拍卖行与邮件数据全局共享，不按群隔离。",
  ];
}

/**
 * Convert raw affinity value (0-10000) to display percentage string.
 */
export function affinityToPercent(value: number): string {
  const pct = Math.max(0, Math.min(100, Math.round((value / MMORPG_RULEBOOK.social.maxAffinity) * 100)));
  return `${pct}%`;
}

/**
 * Clamp affinity value to the configured range.
 */
export function clampAffinity(value: number): number {
  return Math.max(MMORPG_RULEBOOK.social.minAffinity, Math.min(MMORPG_RULEBOOK.social.maxAffinity, value));
}

/**
 * Apply rebirth bonus to base stats (additive).
 */
export function applyRebirthBonus(stats: StatBlock, rebirthBonus: StatBlock): StatBlock {
  const result = {} as StatBlock;
  for (const key of Object.keys(stats) as Array<keyof StatBlock>) {
    result[key] = stats[key] + (rebirthBonus?.[key] ?? 0);
  }
  return result;
}
