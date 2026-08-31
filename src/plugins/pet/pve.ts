import { PetSpecies, ElementType } from "./types.js";
import { ELEMENT_NAMES } from "./elements.js";

const WILD_NAMES = [
  "野火兽", "影狼", "岩石怪", "风暴鸦", "雪狐",
  "毒藤蛇", "熔岩虫", "冰晶蝶", "雷光鼠", "沙蝎",
  "木灵", "水蛇", "铁甲蚁", "幽魂", "光羽雀",
];

export function generateWildPet(level: number): { species: PetSpecies; name: string; hp: number; stats: { power: number; defense: number; speed: number; hp: number } } {
  const elements: ElementType[] = ["fire", "ice", "electric", "earth", "dark", "light", "wind"];
  const wildElement = elements[Math.floor(Math.random() * elements.length)];
  const wildName = WILD_NAMES[Math.floor(Math.random() * WILD_NAMES.length)];
  const statScale = 0.8 + Math.random() * 0.4;
  const wildPower = Math.floor((8 + level * 1.5 + Math.random() * 5) * statScale);
  const wildDef = Math.floor((7 + level * 1.2 + Math.random() * 4) * statScale);
  const wildSpeed = Math.floor((6 + level * 1.3 + Math.random() * 5) * statScale);
  const wildHp = Math.floor((60 + level * 8 + Math.random() * 20) * statScale);
  const wildSkill = {
    id: `wild_${wildElement}_${level}`,
    name: wildElement === "fire" ? "野火" : wildElement === "ice" ? "冰刺" :
          wildElement === "electric" ? "电击" : wildElement === "earth" ? "碎石" :
          wildElement === "dark" ? "暗影球" : wildElement === "light" ? "光弹" : "风刃",
    element: wildElement as ElementType,
    power: Math.floor(15 + level * 2.5 + Math.random() * 10),
    cooldown: Math.random() < 0.4 ? 1 : 0,
    description: `野生的${ELEMENT_NAMES[wildElement as ElementType]}系攻击`,
  };
  const species: PetSpecies = {
    id: `wild_${wildElement}_${level}`, name: wildName, description: "野生的宠物",
    rarity: "common", element: wildElement as ElementType, skill: wildSkill,
    baseStats: { power: wildPower, defense: wildDef, speed: wildSpeed, hp: wildHp },
    evolvesAt: 999, evolvesTo: null, emoji: "",
  };
  return { species, name: wildName, hp: wildHp, stats: { power: wildPower, defense: wildDef, speed: wildSpeed, hp: wildHp } };
}
