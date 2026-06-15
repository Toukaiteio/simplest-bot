import { randomUUID } from "node:crypto";
import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import type {
  ItemInstance,
  MenuGroup,
  PendingMenu,
  PlayerState,
  StatBlock,
} from "../schema.js";

/**
 * 新手引导奖励包。
 * 引导完成时由 framework-plugin 调用并写入玩家存档。
 */
export type StarterRewardBundle = {
  weaponInstanceId: string;
  weaponInstance: ItemInstance;
  coins: number;
  items: Array<{ itemId: string; quantity: number }>;
  autoQuestId: string;
};

const GUIDE_STEP_COUNT = 4;

export function checkGuideCompleted(player: PlayerState): boolean {
  return player.guideCompleted === true;
}

export function checkGuideEnforcement(
  player: PlayerState,
  commandPrefix: string
): void {
  if (!player.guideCompleted) {
    throw new Error(
      `⚠️ 你必须先完成新手引导！请发送 ${commandPrefix}mmo 进入新手引导。`
    );
  }
}

export function buildGuideMenu(
  player: PlayerState,
  step: number
): PendingMenu {
  const groups: MenuGroup[] = [];
  if (step === 0) {
    groups.push({
      label: "第一步：属性与升级 ──",
      category: "system",
      items: [
        {
          label: "我已了解属性，进行下一步 ➔",
          description: "学习如何提升实力",
          action: { type: "guide_step", targetId: "1" },
        },
      ],
    });
    return {
      context: `新手引导 (1/${GUIDE_STEP_COUNT})`,
      title: "属性与升级",
      groups,
      createdAt: new Date().toISOString(),
    };
  } else if (step === 1) {
    groups.push({
      label: "第二步：战斗与生命值 ──",
      category: "system",
      items: [
        {
          label: "我已了解战斗，进行下一步 ➔",
          description: "学习装备强化机制",
          action: { type: "guide_step", targetId: "2" },
        },
      ],
    });
    return {
      context: `新手引导 (2/${GUIDE_STEP_COUNT})`,
      title: "战斗与生命",
      groups,
      createdAt: new Date().toISOString(),
    };
  } else if (step === 2) {
    groups.push({
      label: "第三步：装备与随机词条 ──",
      category: "system",
      items: [
        {
          label: "我已了解装备，进行下一步 ➔",
          description: "学习交易与回收机制",
          action: { type: "guide_step", targetId: "3" },
        },
      ],
    });
    return {
      context: `新手引导 (3/${GUIDE_STEP_COUNT})`,
      title: "装备与强化",
      groups,
      createdAt: new Date().toISOString(),
    };
  } else {
    groups.push({
      label: "第四步：回收与拍卖行 ──",
      category: "system",
      items: [
        {
          label: "完成引导，领取新手大礼包！ 🎁",
          description: "获得+3武器、金币与材料",
          action: { type: "guide_step", targetId: "complete" },
        },
      ],
    });
    return {
      context: `新手引导 (4/${GUIDE_STEP_COUNT})`,
      title: "回收与交易",
      groups,
      createdAt: new Date().toISOString(),
    };
  }
}

export function getGuideStepDetails(
  step: number
): Array<{ label: string; value: string }> {
  if (step === 0) {
    return [
      {
        label: "前言",
        value:
          "欢迎来到英雄幻想世界！在这里你将历经冒险成长为最强斗士。",
      },
      {
        label: "关于属性",
        value:
          "力量提升物攻；防御减少受击伤害；魅力影响社交战力与价格；敏捷提高出手速度；口才提升谈判效果；耐力提升体力；生命大幅提升 HP 上限。",
      },
      {
        label: "等级提升",
        value:
          "击败怪物或完成任务可获取经验，经验满后自动升级并重新根据成长曲线生成属性。",
      },
    ];
  } else if (step === 1) {
    return [
      {
        label: "关于战斗",
        value:
          "通过 $mmo-hunt 挑选怪物。战斗是全自动进行的回合制模拟，完成后会通知你。",
      },
      {
        label: "战斗资源",
        value:
          "HP（生命）：降为0会导致死亡并掉落金币；Focus（专注）：释放法术消耗；Stamina（体力）：采集、挂机等消耗。",
      },
      {
        label: "阵营与死亡",
        value:
          "在安全区休息会自动回满血。非安全区死亡会导致金币掉落，需要回原地使用 mmo-recover 拾取。",
      },
    ];
  } else if (step === 2) {
    return [
      {
        label: "装备品质",
        value:
          "新获得的装备会随机生成品质：普通(白色)、优秀(绿色)、精良(蓝色)、史诗(紫色)和传说(橙色)。",
      },
      {
        label: "额外词条",
        value:
          "品质越高，装备会随机获得越多的额外属性词条，甚至带有独特的专属后缀（例如“之蛮力”）。",
      },
      {
        label: "装备强化",
        value:
          "使用 $mmo-enhance <部位> 可消耗金币与材料强化装备（最高+20），极大提升装备基础属性！",
      },
    ];
  } else {
    return [
      {
        label: "回收商店",
        value:
          "使用 $mmo-recycle <背包编号> 即可将没用的物品快速低价卖给回收商（任务与结婚物品不可售）。",
      },
      {
        label: "拍卖大厅",
        value:
          "使用 $mmo-auction-list 查看挂售商品；$mmo-auction-sell <背包编号> <单价> 上架商品；$mmo-auction-buy <商品编号> 购买他人上架的珍稀装备！",
      },
      {
        label: "奖励礼包",
        value:
          "点击下方完成按钮，将获得 +3 精良级定制武器、1000 金币以及初始探险物资！",
      },
    ];
  }
}

function resolveStarterWeaponId(classId: string): string {
  switch (classId) {
    case "mage":
      return "novice_staff";
    case "ranger":
      return "training_bow";
    case "cleric":
      return "oak_focus";
    case "rogue":
      return "iron_dagger";
    case "warrior":
    default:
      return "rust_sword";
  }
}

function generateSuffixFromSubstats(
  substats: StatBlock
): string | undefined {
  const statOptions: Array<keyof StatBlock> = [
    "strength",
    "defense",
    "charm",
    "agility",
    "eloquence",
    "endurance",
    "life",
  ];

  let maxVal = 0;
  let maxKey: keyof StatBlock | null = null;
  for (const k of statOptions) {
    if (substats[k] > maxVal) {
      maxVal = substats[k];
      maxKey = k;
    }
  }
  if (!maxKey || maxVal <= 0) return undefined;

  switch (maxKey) {
    case "strength":
      return "之蛮力";
    case "defense":
      return "之坚韧";
    case "charm":
      return "之优雅";
    case "agility":
      return "之疾风";
    case "eloquence":
      return "之睿智";
    case "endurance":
      return "之不屈";
    case "life":
      return "之生命";
    default:
      return undefined;
  }
}

export function generateStarterRewards(
  player: PlayerState
): StarterRewardBundle {
  const weaponId = resolveStarterWeaponId(player.classId);
  const instId = "inst_" + randomUUID().slice(0, 8);
  const itemDef = DEFAULT_MMORPG_CONTENT.items[weaponId];
  const baseValue = Math.max(
    1,
    Math.floor((itemDef?.sellPrice ?? 10) / 10)
  );

  const substats: StatBlock = {
    strength: 0,
    defense: 0,
    charm: 0,
    agility: 0,
    eloquence: 0,
    endurance: 0,
    life: 0,
  };
  const statOptions: Array<keyof StatBlock> = [
    "strength",
    "defense",
    "charm",
    "agility",
    "eloquence",
    "endurance",
    "life",
  ];
  for (let i = 0; i < 2; i++) {
    const opt = statOptions[Math.floor(Math.random() * statOptions.length)];
    const val = Math.max(
      1,
      Math.round(baseValue * (0.8 + Math.random() * 0.4))
    );
    substats[opt] += val;
  }

  const suffix = generateSuffixFromSubstats(substats);

  const weaponInstance: ItemInstance = {
    id: instId,
    itemId: weaponId,
    enhancement: 3,
    rarity: "rare",
    substats,
    suffix,
  };

  return {
    weaponInstanceId: instId,
    weaponInstance,
    coins: 1000,
    items: [
      { itemId: "small_healing_potion", quantity: 5 },
      { itemId: "iron_ore", quantity: 5 },
      { itemId: "cloth_bandage", quantity: 5 },
    ],
    autoQuestId: "main_quest_1",
  };
}
