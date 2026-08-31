import fs from "node:fs";
import path from "node:path";
import { PetData, PetInstance } from "./types.js";

const DATA_FILE = path.resolve("data", "pets.json");

export { DATA_FILE };

export function defData(): PetData {
  return { nextId: 1, ownedEggs: {}, pets: {}, userPets: {}, rankings: {}, hasClaimedStarter: {}, seenSpecies: {}, caughtSpecies: {} };
}

export function loadData(): PetData {
  try {
    if (!fs.existsSync(DATA_FILE)) return defData();
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    return { ...defData(), ...raw, seenSpecies: raw.seenSpecies ?? {}, caughtSpecies: raw.caughtSpecies ?? {} };
  } catch { return defData(); }
}

export function saveData(data: PetData): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function markSeen(data: PetData, userId: string, speciesId: string): void {
  if (!data.seenSpecies[userId]) data.seenSpecies[userId] = [];
  if (!data.seenSpecies[userId].includes(speciesId)) data.seenSpecies[userId].push(speciesId);
}

export function markCaught(data: PetData, userId: string, speciesId: string): void {
  markSeen(data, userId, speciesId);
  if (!data.caughtSpecies[userId]) data.caughtSpecies[userId] = [];
  if (!data.caughtSpecies[userId].includes(speciesId)) data.caughtSpecies[userId].push(speciesId);
}

export function getDailyKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getDailyNum(): number {
  return parseInt(getDailyKey().replace(/-/g, ""), 10);
}

export function todayStr(): string {
  return getDailyKey();
}

export function moodDescription(pet: PetInstance): string {
  const { hunger, happiness, cleanliness } = pet.mood;
  const parts: string[] = [];
  if (hunger < 30) parts.push("很饿"); else if (hunger < 60) parts.push("有点饿"); else parts.push("吃饱了");
  if (happiness < 30) parts.push("不开心"); else if (happiness < 60) parts.push("还可以"); else parts.push("很开心");
  if (cleanliness < 30) parts.push("脏兮兮"); else if (cleanliness < 60) parts.push("该洗了"); else parts.push("干净");
  return parts.join(" | ");
}

export function applyMoodDecay(pet: PetInstance): void {
  const hoursSinceFeed = (Date.now() - pet.lastFedAt) / (1000 * 60 * 60);
  const hoursSincePlay = (Date.now() - pet.lastPlayedAt) / (1000 * 60 * 60);
  pet.mood.hunger = Math.max(0, pet.mood.hunger - Math.floor(hoursSinceFeed * 2));
  pet.mood.happiness = Math.max(0, pet.mood.happiness - Math.floor(hoursSincePlay * 1.5));
  pet.mood.cleanliness = Math.max(0, pet.mood.cleanliness - Math.floor(hoursSinceFeed * 1));
}

export function resetDailyCounts(pet: PetInstance): void {
  const today = getDailyNum();
  if (pet.lastDailyAt !== today) {
    pet.dailyFeedCount = 0;
    pet.dailyPlayCount = 0;
    pet.dailyHuntCount = 0;
    pet.lastDailyAt = today;
  }
}

export function calcBattlePower(pet: PetInstance): number {
  return Math.floor((pet.stats.power * 2 + pet.stats.defense * 1.5 + pet.stats.speed * 1.8 + pet.maxHp * 0.3) / 5);
}
