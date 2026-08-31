import { PetSpecies } from "./types.js";

export const STARTER_SPECIES = ["flame_pup", "frost_cub", "thunder_chick"];

export const PET_SPECIES: PetSpecies[] = [
  { id: "flame_pup", name: "火焰犬", description: "热情的小狗，体内流淌着火焰", rarity: "common",
    element: "fire", skill: { id: "flame_bite", name: "火焰牙", element: "fire", power: 25, cooldown: 0, description: "咬住对手并注入火焰" },
    baseStats: { power: 10, defense: 8, speed: 12, hp: 80 }, evolvesAt: 10, evolvesTo: "blaze_hound", emoji: "\u{1F415}" },
  { id: "frost_cub", name: "冰霜崽", description: "雪地中出生的小熊，浑身散发寒气", rarity: "common",
    element: "ice", skill: { id: "ice_claw", name: "冰爪", element: "ice", power: 28, cooldown: 0, description: "挥出冰冻利爪" },
    baseStats: { power: 12, defense: 10, speed: 6, hp: 100 }, evolvesAt: 10, evolvesTo: "glacier_bear", emoji: "\u{1F43B}" },
  { id: "thunder_chick", name: "雷雀", description: "能召唤雷电的小鸟", rarity: "common",
    element: "electric", skill: { id: "spark", name: "电击", element: "electric", power: 22, cooldown: 1, description: "释放微弱电流攻击" },
    baseStats: { power: 8, defense: 6, speed: 16, hp: 60 }, evolvesAt: 10, evolvesTo: "storm_eagle", emoji: "\u{1F426}" },
  { id: "mud_turtle", name: "泥龟", description: "慢吞吞但超级耐打", rarity: "common",
    element: "earth", skill: { id: "mud_shot", name: "泥浆喷射", element: "earth", power: 20, cooldown: 0, description: "喷射泥浆糊住对手" },
    baseStats: { power: 6, defense: 16, speed: 4, hp: 120 }, evolvesAt: 12, evolvesTo: "iron_shell", emoji: "\u{1F422}" },
  { id: "blaze_hound", name: "烈焰猎犬", description: "火焰犬的进化形态，奔跑时带出火星", rarity: "uncommon",
    element: "fire", skill: { id: "fire_breath", name: "火焰吐息", element: "fire", power: 45, cooldown: 1, description: "喷出烈焰灼烧对手" },
    baseStats: { power: 22, defense: 16, speed: 18, hp: 160 }, evolvesAt: 20, evolvesTo: "hell_hound", emoji: "\u{1F415}" },
  { id: "glacier_bear", name: "冰川巨熊", description: "冰霜崽的进化形态，咆哮能冻结敌人", rarity: "uncommon",
    element: "ice", skill: { id: "freeze_roar", name: "冰封咆哮", element: "ice", power: 50, cooldown: 1, description: "咆哮释放寒气，有几率冰冻对手" },
    baseStats: { power: 25, defense: 22, speed: 10, hp: 200 }, evolvesAt: 20, evolvesTo: "frost_giant", emoji: "\u{1F43B}" },
  { id: "storm_eagle", name: "暴风鹰", description: "雷雀的进化形态，展翅能掀起风暴", rarity: "uncommon",
    element: "electric", skill: { id: "thunder_bolt", name: "雷霆一击", element: "electric", power: 48, cooldown: 1, description: "从高空释放雷电" },
    baseStats: { power: 18, defense: 12, speed: 28, hp: 130 }, evolvesAt: 20, evolvesTo: "thunder_king", emoji: "\u{1F985}" },
  { id: "iron_shell", name: "铁甲龟", description: "泥龟的进化形态，甲壳坚不可摧", rarity: "uncommon",
    element: "earth", skill: { id: "rock_shield", name: "岩石护盾", element: "earth", power: 30, cooldown: 2, description: "用岩石加固防御" },
    baseStats: { power: 14, defense: 30, speed: 6, hp: 240 }, evolvesAt: 22, evolvesTo: "diamond_turtle", emoji: "\u{1F422}" },
  { id: "hell_hound", name: "地狱犬", description: "烈焰猎犬的终极形态，三头喷吐地狱之火", rarity: "rare",
    element: "fire", skill: { id: "hell_fire", name: "地狱烈焰", element: "fire", power: 80, cooldown: 2, description: "释放地狱之火焚尽一切" },
    baseStats: { power: 40, defense: 28, speed: 22, hp: 280 }, evolvesAt: 35, evolvesTo: null, emoji: "\u{1F415}\u200D\u{1F525}" },
  { id: "frost_giant", name: "冰霜巨人", description: "冰川巨熊的终极形态，寒气能冻结海洋", rarity: "rare",
    element: "ice", skill: { id: "absolute_zero", name: "绝对零度", element: "ice", power: 85, cooldown: 2, description: "极寒之气冻结一切" },
    baseStats: { power: 42, defense: 35, speed: 14, hp: 360 }, evolvesAt: 35, evolvesTo: null, emoji: "\u{1F9CA}" },
  { id: "thunder_king", name: "雷鸣霸王", description: "暴风鹰的终极形态，掌控天雷", rarity: "rare",
    element: "electric", skill: { id: "thunderstorm", name: "万雷天降", element: "electric", power: 78, cooldown: 2, description: "召唤万雷轰击对手" },
    baseStats: { power: 35, defense: 22, speed: 38, hp: 240 }, evolvesAt: 35, evolvesTo: null, emoji: "\u{1F985}" },
  { id: "diamond_turtle", name: "钻石龟", description: "铁甲龟的终极形态，浑身覆盖钻石", rarity: "rare",
    element: "earth", skill: { id: "diamond_crash", name: "钻石冲撞", element: "earth", power: 65, cooldown: 1, description: "以钻石般坚硬的身躯冲撞" },
    baseStats: { power: 26, defense: 52, speed: 8, hp: 420 }, evolvesAt: 38, evolvesTo: null, emoji: "\u{1F422}\u{1F48E}" },
  { id: "shadow_lynx", name: "暗影灵猫", description: "从暗影中诞生的神秘灵猫，行踪诡秘", rarity: "epic",
    element: "dark", skill: { id: "shadow_ambush", name: "暗影伏击", element: "dark", power: 55, cooldown: 1, description: "从暗影中突然袭击" },
    baseStats: { power: 35, defense: 20, speed: 40, hp: 220 }, evolvesAt: 40, evolvesTo: "phantom_panther", emoji: "\u{1F408}\u200D\u2B1B" },
  { id: "phantom_panther", name: "幻影黑豹", description: "暗影灵猫的终极形态，穿梭于虚实之间", rarity: "epic",
    element: "dark", skill: { id: "void_slash", name: "虚空斩", element: "dark", power: 90, cooldown: 2, description: "撕裂虚空发动致命一击" },
    baseStats: { power: 55, defense: 32, speed: 50, hp: 340 }, evolvesAt: 50, evolvesTo: null, emoji: "\u{1F406}" },
  { id: "jade_dragon", name: "玉龙幼崽", description: "传说中的玉龙后代，鳞片闪耀翡翠光芒", rarity: "epic",
    element: "wind", skill: { id: "wind_blade", name: "风刃", element: "wind", power: 50, cooldown: 0, description: "挥出锋利的空气之刃" },
    baseStats: { power: 50, defense: 40, speed: 30, hp: 300 }, evolvesAt: 45, evolvesTo: "celestial_dragon", emoji: "\u{1F409}" },
  { id: "celestial_dragon", name: "天穹神龙", description: "玉龙幼崽的终极形态，腾云驾雾遨游九天", rarity: "epic",
    element: "wind", skill: { id: "tornado", name: "天穹风暴", element: "wind", power: 100, cooldown: 2, description: "召唤毁天灭地的风暴" },
    baseStats: { power: 75, defense: 55, speed: 45, hp: 450 }, evolvesAt: 55, evolvesTo: null, emoji: "\u{1F409}\u2728" },
  { id: "phoenix_hatchling", name: "凤凰雏鸟", description: "涅槃之火中诞生的雏凤，注定不凡", rarity: "legendary",
    element: "light", skill: { id: "holy_flame", name: "圣焰", element: "light", power: 60, cooldown: 0, description: "神圣的火焰净化一切" },
    baseStats: { power: 60, defense: 30, speed: 45, hp: 350 }, evolvesAt: 50, evolvesTo: "eternal_phoenix", emoji: "\u{1F426}" },
  { id: "eternal_phoenix", name: "永恒凤凰", description: "不死不灭的神鸟，浴火重生永世长存", rarity: "legendary",
    element: "light", skill: { id: "rebirth", name: "涅槃重生", element: "light", power: 130, cooldown: 3, description: "浴火重生，释放毁天灭地的力量" },
    baseStats: { power: 90, defense: 50, speed: 60, hp: 520 }, evolvesAt: 60, evolvesTo: null, emoji: "\u{1F985}" },
];

export function getSpecies(speciesId: string): PetSpecies | undefined {
  return PET_SPECIES.find(s => s.id === speciesId);
}

export function getRandomSpeciesByRarity(rarity: string): PetSpecies | undefined {
  const firstStage = PET_SPECIES.filter(s => {
    const isFirstStage = !PET_SPECIES.some(p => p.evolvesTo === s.id);
    return isFirstStage && s.rarity === rarity;
  });
  return firstStage[Math.floor(Math.random() * firstStage.length)];
}

export function getRandomEgg(): PetSpecies {
  const rand = Math.random();
  if (rand < 0.45) return getRandomSpeciesByRarity("common")!;
  if (rand < 0.70) return getRandomSpeciesByRarity("common")!;
  if (rand < 0.85) return getRandomSpeciesByRarity("uncommon")!;
  if (rand < 0.94) return getRandomSpeciesByRarity("uncommon")!;
  if (rand < 0.98) return getRandomSpeciesByRarity("rare")!;
  if (rand < 0.995) return getRandomSpeciesByRarity("epic")!;
  return getRandomSpeciesByRarity("legendary")!;
}

export const EGG_COST: Record<string, number> = {
  common: 500, uncommon: 2000, rare: 8000, epic: 30000, legendary: 100000,
};

export function buildEvoChain(speciesId: string): string {
  const parts: string[] = [];
  let current = getSpecies(speciesId);
  while (current) {
    parts.push(`${current.emoji}${current.name}`);
    if (!current.evolvesTo) break;
    current = getSpecies(current.evolvesTo);
  }
  return parts.join(" -> ");
}
