import { PetSpecies, PetInstance } from "./types.js";
import { getSpecies } from "./species.js";
import type { PluginContext, BotMessage } from "../../types.js";

export function calcStats(species: PetSpecies, level: number): { power: number; defense: number; speed: number; hp: number } {
  const growth = level / 10;
  return {
    power: Math.floor(species.baseStats.power * (1 + growth * 0.5)),
    defense: Math.floor(species.baseStats.defense * (1 + growth * 0.5)),
    speed: Math.floor(species.baseStats.speed * (1 + growth * 0.5)),
    hp: Math.floor(species.baseStats.hp * (1 + growth * 0.6)),
  };
}

export function calcExpForLevel(level: number): number {
  return Math.floor(50 * Math.pow(level, 1.6));
}

export async function grantExp(
  pet: PetInstance, amount: number, data: any,
  ctx: PluginContext, message: BotMessage, userId: string,
): Promise<PetInstance> {
  pet.exp += amount;
  let leveledUp = false;
  let species = getSpecies(pet.speciesId);

  while (pet.level < 100 && pet.exp >= calcExpForLevel(pet.level)) {
    pet.exp -= calcExpForLevel(pet.level);
    pet.level++;
    leveledUp = true;
    if (species) {
      pet.stats = calcStats(species, pet.level);
      const hpDiff = (pet.stats.hp - pet.maxHp);
      pet.maxHp = pet.stats.hp;
      pet.currentHp = Math.min(pet.maxHp, pet.currentHp + Math.floor(hpDiff * 0.5));
    }
    if (pet.level % 5 === 0) {
      pet.stats.power += 2; pet.stats.defense += 2; pet.stats.speed += 1; pet.stats.hp += 10;
      pet.maxHp = pet.stats.hp; pet.currentHp = pet.maxHp;
      if (species?.evolvesTo && pet.level >= species.evolvesAt) {
        const target = message.type === "group"
          ? { type: "group" as const, id: message.groupId! }
          : { type: "private" as const, id: userId };
        const next = getSpecies(species.evolvesTo);
        await ctx.sendMessage(target, `${pet.name} Lv.${pet.level}！可进化-> ${next?.name ?? species.evolvesTo}！`);
      }
    }
  }
  if (leveledUp) {
    const target = message.type === "group"
      ? { type: "group" as const, id: message.groupId! }
      : { type: "private" as const, id: userId };
    await ctx.sendMessage(target, `${pet.name} 升级到 Lv.${pet.level}！属性全面提升！`);
  }
  return pet;
}
