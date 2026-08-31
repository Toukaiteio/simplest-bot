// ==================== Types ====================

export type ElementType = "fire" | "ice" | "electric" | "earth" | "water" | "dark" | "light" | "wind";

export type PetSkill = {
  id: string;
  name: string;
  element: ElementType;
  power: number;
  cooldown: number;
  description: string;
  effect?: "none" | "heal" | "shield" | "stun";
};

export type PetSpecies = {
  id: string;
  name: string;
  description: string;
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  element: ElementType;
  baseStats: { power: number; defense: number; speed: number; hp: number };
  skill: PetSkill;
  evolvesAt: number;
  evolvesTo: string | null;
  evolveItem?: string;
  emoji: string;
};

export type PetInstance = {
  id: string;
  ownerId: string;
  speciesId: string;
  name: string;
  level: number;
  exp: number;
  stats: { power: number; defense: number; speed: number; hp: number };
  maxHp: number;
  currentHp: number;
  mood: { hunger: number; happiness: number; cleanliness: number };
  skillLevel: number;
  wins: number;
  losses: number;
  pveWins: number;
  createdAt: number;
  lastFedAt: number;
  lastPlayedAt: number;
  lastBattleAt: number;
  lastDailyAt: number;
  dailyFeedCount: number;
  dailyPlayCount: number;
  dailyHuntCount: number;
};

export type PetData = {
  nextId: number;
  ownedEggs: Record<string, PetEgg[]>;
  pets: Record<string, PetInstance>;
  userPets: Record<string, string[]>;
  rankings: Record<string, number>;
  hasClaimedStarter: Record<string, boolean>;
  seenSpecies: Record<string, string[]>;
  caughtSpecies: Record<string, string[]>;
};

export type PetEgg = {
  speciesId: string;
  obtainedAt: number;
};
