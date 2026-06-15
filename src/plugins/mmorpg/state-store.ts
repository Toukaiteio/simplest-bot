import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBaseResources, createBaseStats, getExpRequiredForLevel } from "./rulebook.js";
import { DEFAULT_MMORPG_CONTENT } from "./default-content.js";
import type { ClassDef, GuildState, MailState, MarriageProposalState, MarketListing, MMORPGState, MonsterPoolEntry, PartyState, PlayerState, ResourcePoolEntry, StatBlock, WorldState } from "./schema.js";
import type { MessageStore } from "../../message-store.js";


const EMPTY_WORLD_STATE = {
  dailyBossDefeatedIds: [],
  eventFlags: [],
  monsterPools: {} as Record<string, MonsterPoolEntry>,
  resourcePools: {} as Record<string, ResourcePoolEntry>,
  updatedAt: new Date(0).toISOString(),
};

/** Entity category names used as the first column in mmorpg_entities table. */
const CATEGORIES = ["players", "guilds", "parties", "marriageProposals", "marketListings", "mails"] as const;

export class MMORPGStateStore {
  private state: MMORPGState;
  private saveTimer: NodeJS.Timeout | null = null;

  // Dirty tracking for debounced SQLite persistence
  private dirtyCategories = new Set<string>();
  private deletedEntities = new Set<string>(); // "category:id"
  private worldDirty = false;

  constructor(private readonly messageStore: MessageStore) {
    this.state = this.load();
  }

  getState(): MMORPGState {
    return this.state;
  }

  getPlayer(userId: string): PlayerState | null {
    const player = this.state.players[userId] ?? null;
    if (!player) return null;
    // Backward compatibility: ensure new fields exist
    if (player.rebirthCount === undefined) player.rebirthCount = 0;
    if (!player.rebirthBonus) player.rebirthBonus = { strength: 0, defense: 0, charm: 0, agility: 0, eloquence: 0, endurance: 0, life: 0 };
    if (!player.unlockedAchievementIds) player.unlockedAchievementIds = [];
    if (!player.claimedAchievementIds) player.claimedAchievementIds = [];
    if (!player.factionRewardClaimedIds) player.factionRewardClaimedIds = [];
    // Skill-slot backward compat: old saves have no equippedSkillIds.
    // Auto-fill from unlockedSkillIds so existing characters keep fighting.
    if (!player.equippedSkillIds) {
      player.equippedSkillIds = player.unlockedSkillIds ?? [];
    }
    return player;
  }

  createPlayer(input: {
    userId: string;
    raceId: string;
    classDef: ClassDef;
    genderId: string;
    appearance: string;
    personalDeclaration?: string;
    startingAreaId: string;
    stats?: StatBlock;
  }): PlayerState {
    const { userId, raceId, classDef, genderId, appearance, personalDeclaration, startingAreaId } = input;
    const existing = this.state.players[userId];
    if (existing) {
      return existing;
    }

    const stats = input.stats ?? createBaseStats(classDef.id);
    const zeroRebirthBonus: StatBlock = { strength: 0, defense: 0, charm: 0, agility: 0, eloquence: 0, endurance: 0, life: 0 };
    const player: PlayerState = {
      userId,
      raceId,
      classId: classDef.id,
      genderId,
      appearance,
      personalDeclaration,
      areaId: startingAreaId,
      level: 1,
      exp: 0,
      coinsEarnedFromMMO: 0,
      stats,
      resources: createBaseResources(stats),
      currencies: { gold: 0, honor: 0, guild_token: 0 },
      inventory: classDef.starterItemIds.map((itemId) => ({ itemId, quantity: 1 })),
      equipment: {},
      fashionEquipment: {},
      unlockedSkillIds: [...classDef.starterSkillIds],
      // Auto-equip starter skills (active/utility) into slots; passives stay in the unlocked pool.
      equippedSkillIds: [...classDef.starterSkillIds],
      professionLevels: {},
      factionReputation: {},
      questLog: [],
      dialogueFlags: [],
      fishBasket: [],
      rebirthCount: 0,
      rebirthBonus: zeroRebirthBonus,
      guideCompleted: false,
      unlockedAchievementIds: [],
      claimedAchievementIds: [],
      factionRewardClaimedIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.players[userId] = player;
    this.markDirty("players");
    this.persistSoon();
    return player;
  }

  savePlayer(player: PlayerState) {
    player.updatedAt = new Date().toISOString();
    this.state.players[player.userId] = player;
    this.markDirty("players");
    this.persistSoon();
  }

  syncPlayerGold(userId: string, gold: number) {
    const player = this.state.players[userId];
    if (!player) {
      return;
    }
    player.currencies.gold = gold;
    player.updatedAt = new Date().toISOString();
    this.markDirty("players");
    this.persistSoon();
  }

  recordMMOCoinsGranted(userId: string, amount: number, resultingGoldBalance: number) {
    const player = this.state.players[userId];
    if (!player) {
      return;
    }
    player.currencies.gold = resultingGoldBalance;
    player.coinsEarnedFromMMO += amount;
    player.updatedAt = new Date().toISOString();
    this.markDirty("players");
    this.persistSoon();
  }

  getWorld(): WorldState {
    return this.state.world;
  }

  saveWorld(world: WorldState) {
    world.updatedAt = new Date().toISOString();
    this.state.world = world;
    this.worldDirty = true;
    this.persistSoon();
  }

  getParty(partyId: string): PartyState | null {
    return this.state.parties[partyId] ?? null;
  }

  findPartyByMember(userId: string): PartyState | null {
    return Object.values(this.state.parties).find((party) => party.memberUserIds.includes(userId)) ?? null;
  }

  saveParty(party: PartyState) {
    this.state.parties[party.id] = party;
    this.markDirty("parties");
    this.persistSoon();
  }

  removeParty(partyId: string) {
    delete this.state.parties[partyId];
    this.markDeleted("parties", partyId);
    this.persistSoon();
  }

  createParty(input: Omit<PartyState, "id" | "createdAt">): PartyState {
    const party: PartyState = {
      id: randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.state.parties[party.id] = party;
    this.markDirty("parties");
    this.persistSoon();
    return party;
  }

  listMarriageProposals(): MarriageProposalState[] {
    return Object.values(this.state.marriageProposals);
  }

  findProposal(proposerUserId: string, targetUserId: string): MarriageProposalState | null {
    return Object.values(this.state.marriageProposals).find((proposal) => (
      proposal.proposerUserId === proposerUserId && proposal.targetUserId === targetUserId
    )) ?? null;
  }

  saveMarriageProposal(input: Omit<MarriageProposalState, "id" | "createdAt">): MarriageProposalState {
    const proposal: MarriageProposalState = {
      id: randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.state.marriageProposals[proposal.id] = proposal;
    this.markDirty("marriageProposals");
    this.persistSoon();
    return proposal;
  }

  removeMarriageProposal(proposalId: string) {
    delete this.state.marriageProposals[proposalId];
    this.markDeleted("marriageProposals", proposalId);
    this.persistSoon();
  }

  getGuild(guildId: string): GuildState | null {
    return this.state.guilds[guildId] ?? null;
  }

  findGuildByName(name: string): GuildState | null {
    return Object.values(this.state.guilds).find((g) => g.name === name) ?? null;
  }

  createGuild(input: { name: string; leaderUserId: string }): GuildState {
    const guild: GuildState = {
      id: randomUUID().slice(0, 8),
      name: input.name,
      leaderUserId: input.leaderUserId,
      memberUserIds: [input.leaderUserId],
      treasury: { gold: 0 },
      createdAt: new Date().toISOString(),
    };
    this.state.guilds[guild.id] = guild;
    this.markDirty("guilds");
    this.persistSoon();
    return guild;
  }

  saveGuild(guild: GuildState) {
    this.state.guilds[guild.id] = guild;
    this.markDirty("guilds");
    this.persistSoon();
  }

  removeGuild(guildId: string) {
    delete this.state.guilds[guildId];
    this.markDeleted("guilds", guildId);
    this.persistSoon();
  }

  saveMarketListing(listing: MarketListing) {
    this.state.marketListings[listing.id] = listing;
    this.markDirty("marketListings");
    this.persistSoon();
  }

  removeMarketListing(listingId: string) {
    delete this.state.marketListings[listingId];
    this.markDeleted("marketListings", listingId);
    this.persistSoon();
  }

  getMail(mailId: string): MailState | null {
    return this.state.mails[mailId] ?? null;
  }

  listMailsForUser(userId: string): MailState[] {
    return Object.values(this.state.mails)
      .filter((mail) => mail.toUserId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  listUnreadMailsForUser(userId: string): MailState[] {
    return this.listMailsForUser(userId).filter((mail) => !mail.claimedAt);
  }

  createMail(input: Omit<MailState, "id" | "createdAt">): MailState {
    const mail: MailState = {
      id: randomUUID().slice(0, 8),
      ...input,
      createdAt: new Date().toISOString(),
    };
    this.state.mails[mail.id] = mail;
    this.markDirty("mails");
    this.persistSoon();
    return mail;
  }

  saveMail(mail: MailState) {
    this.state.mails[mail.id] = mail;
    this.markDirty("mails");
    this.persistSoon();
  }

  removeMail(mailId: string) {
    delete this.state.mails[mailId];
    this.markDeleted("mails", mailId);
    this.persistSoon();
  }

  /**
   * Data migration: reset all player progress (preserve character identity),
   * record compensation exp (1/10 of pre-reset total) to be granted as exp bottles
   * after re-completing the guide.
   *
   * Idempotent - players with pendingCompensationExp already set are skipped.
   */
  migrateResetAllPlayers(): { reset: number; skipped: number } {
    const zeroRebirthBonus: StatBlock = {
      strength: 0, defense: 0, charm: 0, agility: 0, eloquence: 0, endurance: 0, life: 0,
    };
    let resetCount = 0;
    let skippedCount = 0;

    for (const player of Object.values(this.state.players)) {
      // Idempotent: skip if already migrated
      if (player.pendingCompensationExp !== undefined) {
        skippedCount++;
        continue;
      }

      // 1. Compute approximate total accumulated experience
      let totalExp = player.exp;
      for (let lvl = 1; lvl < player.level; lvl++) {
        totalExp += getExpRequiredForLevel(lvl);
      }
      const compensationExp = Math.min(25000, Math.floor(totalExp / 10));

      // 1b. Compute gold compensation (1% of current gold)
      const compensationGold = Math.floor((player.currencies.gold ?? 0) / 100);

      // 2. Preserve character identity
      const preserved = {
        userId: player.userId,
        raceId: player.raceId,
        classId: player.classId,
        genderId: player.genderId,
        appearance: player.appearance,
        personalDeclaration: player.personalDeclaration,
        createdAt: player.createdAt,
      };

      // 3. Reset to fresh state
      const stats = createBaseStats(player.classId);
      player.areaId = "starter_village";
      player.level = 1;
      player.exp = 0;
      player.coinsEarnedFromMMO = 0;
      player.stats = stats;
      player.resources = createBaseResources(stats);
      player.currencies = { gold: 0, honor: 0, guild_token: 0 };
      player.inventory = [];
      player.equipment = {};
      player.unlockedSkillIds = [];
      player.equippedSkillIds = [];
      player.professionLevels = {};
      player.factionReputation = {};
      player.questLog = [];
      player.dialogueFlags = [];
      player.fishBasket = [];
      player.fishingSession = undefined;
      player.pendingMenu = undefined;
      player.deathMarker = undefined;
      player.guildId = undefined;
      player.partyId = undefined;
      player.marriage = undefined;
      player.portraitPath = undefined;
      player.portraitGeneratedAt = undefined;
      player.rebirthCount = 0;
      player.rebirthBonus = { ...zeroRebirthBonus };
      player.guideCompleted = false;
      player.itemInstances = {};
      player.unlockedAchievementIds = [];
      player.claimedAchievementIds = [];
      player.factionRewardClaimedIds = [];
      player.dailyGifts = undefined;
      player.lastAffinityDecayAt = undefined;
      player.pendingCompensationExp = compensationExp;
      player.pendingCompensationGold = compensationGold;
      player.updatedAt = new Date().toISOString();

      resetCount++;
    }

    // Also clear shared state that references reset players
    this.state.parties = {};
    this.state.marriageProposals = {};
    this.state.marketListings = {};
    this.state.mails = {};

    // Mark all affected categories as dirty
    this.markDirty("players");
    this.markDirty("parties");
    this.markDirty("marriageProposals");
    this.markDirty("marketListings");
    this.markDirty("mails");

    this.persistSoon();
    return { reset: resetCount, skipped: skippedCount };
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.persistNow();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private markDirty(category: string) {
    this.dirtyCategories.add(category);
  }

  private markDeleted(category: string, entityId: string) {
    this.deletedEntities.add(`${category}:${entityId}`);
  }

  private load(): MMORPGState {
    // Auto-migrate from legacy JSON if it exists
    const jsonPath = path.resolve(process.cwd(), "data", "mmorpg-state.json");
    if (fs.existsSync(jsonPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Partial<MMORPGState>;
        const migrated = normalizeState(raw);
        console.log("[MMORPG] Detected legacy mmorpg-state.json, migrating to SQLite...");

        // Write all entities to SQLite
        for (const [userId, player] of Object.entries(migrated.players)) {
          this.messageStore.saveMMORPGEntity("players", userId, player);
        }
        for (const [id, guild] of Object.entries(migrated.guilds)) {
          this.messageStore.saveMMORPGEntity("guilds", id, guild);
        }
        for (const [id, party] of Object.entries(migrated.parties)) {
          this.messageStore.saveMMORPGEntity("parties", id, party);
        }
        for (const [id, proposal] of Object.entries(migrated.marriageProposals)) {
          this.messageStore.saveMMORPGEntity("marriageProposals", id, proposal);
        }
        for (const [id, listing] of Object.entries(migrated.marketListings)) {
          this.messageStore.saveMMORPGEntity("marketListings", id, listing);
        }
        for (const [id, mail] of Object.entries(migrated.mails)) {
          this.messageStore.saveMMORPGEntity("mails", id, mail);
        }
        this.messageStore.saveMMORPGWorld(migrated.world);

        fs.renameSync(jsonPath, jsonPath + ".archived");
        console.log("[MMORPG] mmorpg-state.json archived as .archived");

        return migrated;
      } catch (error) {
        console.error("[MMORPG] Failed to migrate mmorpg-state.json:", error);
      }
    }

    // Load from SQLite
    return this.loadFromSQLite();
  }

  private loadFromSQLite(): MMORPGState {
    try {
      const players = this.messageStore.getAllMMORPGEntities("players") as Record<string, PlayerState>;
      const guilds = this.messageStore.getAllMMORPGEntities("guilds") as Record<string, GuildState>;
      const parties = this.messageStore.getAllMMORPGEntities("parties") as Record<string, PartyState>;
      const marriageProposals = this.messageStore.getAllMMORPGEntities("marriageProposals") as Record<string, MarriageProposalState>;
      const marketListings = this.messageStore.getAllMMORPGEntities("marketListings") as Record<string, MarketListing>;
      const mails = this.messageStore.getAllMMORPGEntities("mails") as Record<string, MailState>;
      const worldRaw = this.messageStore.getMMORPGWorld() as WorldState | null;

      const hasData = Object.keys(players).length > 0
        || Object.keys(guilds).length > 0
        || Object.keys(parties).length > 0
        || Object.keys(marriageProposals).length > 0
        || Object.keys(marketListings).length > 0
        || Object.keys(mails).length > 0
        || worldRaw !== null;

      if (!hasData) {
        return this.createEmptyState();
      }

      return normalizeState({
        players,
        guilds,
        parties,
        marriageProposals,
        marketListings,
        mails,
        world: worldRaw ?? undefined,
      });
    } catch (error) {
      console.error("[MMORPG] Failed to load state from SQLite, using empty state:", error);
      return this.createEmptyState();
    }
  }

  private createEmptyState(): MMORPGState {
    return {
      players: {},
      guilds: {},
      parties: {},
      marriageProposals: {},
      marketListings: {},
      mails: {},
      world: { ...EMPTY_WORLD_STATE },
    };
  }

  private persistSoon() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.persistNow();
      this.saveTimer = null;
    }, 200);
  }

  private persistNow() {
    try {
      // Process deletions first
      for (const key of this.deletedEntities) {
        const colonIdx = key.indexOf(":");
        const category = key.slice(0, colonIdx);
        const entityId = key.slice(colonIdx + 1);
        this.messageStore.deleteMMORPGEntity(category, entityId);
      }
      this.deletedEntities.clear();

      // Save all entities in dirty categories
      for (const category of this.dirtyCategories) {
        const entities = this.getCategoryEntities(category);
        for (const [entityId, data] of Object.entries(entities)) {
          this.messageStore.saveMMORPGEntity(category, entityId, data);
        }
      }
      this.dirtyCategories.clear();

      // Save world if dirty
      if (this.worldDirty) {
        this.messageStore.saveMMORPGWorld(this.state.world);
        this.worldDirty = false;
      }
    } catch (error) {
      console.error("[MMORPG] Failed to persist state to SQLite:", error);
    }
  }

  private getCategoryEntities(category: string): Record<string, unknown> {
    switch (category) {
      case "players": return this.state.players;
      case "guilds": return this.state.guilds;
      case "parties": return this.state.parties;
      case "marriageProposals": return this.state.marriageProposals;
      case "marketListings": return this.state.marketListings;
      case "mails": return this.state.mails;
      default: return {};
    }
  }
}

function normalizeState(input: Partial<MMORPGState>): MMORPGState {
  return {
    players: Object.fromEntries(
      Object.entries(input.players ?? {}).map(([userId, player]) => [userId, normalizePlayerState(player)])
    ),
    guilds: input.guilds ?? {},
    parties: input.parties ?? {},
    marriageProposals: input.marriageProposals ?? {},
    marketListings: input.marketListings ?? {},
    mails: input.mails ?? {},
    world: {
      dailyBossDefeatedIds: input.world?.dailyBossDefeatedIds ?? [],
      eventFlags: input.world?.eventFlags ?? [],
      monsterPools: Object.fromEntries(
        Object.entries(input.world?.monsterPools ?? {}).map(([areaId, entry]) => [
          areaId,
          { killedTimestamps: entry?.killedTimestamps ?? [], poolSize: entry?.poolSize ?? 6 },
        ]),
      ),
      resourcePools: Object.fromEntries(
        Object.entries(input.world?.resourcePools ?? {}).map(([areaId, entry]) => [
          areaId,
          { gatheredTimestamps: entry?.gatheredTimestamps ?? [], poolSize: entry?.poolSize ?? 3 },
        ]),
      ),
      updatedAt: input.world?.updatedAt ?? EMPTY_WORLD_STATE.updatedAt,
    },
  };
}

function normalizePlayerState(player: PlayerState): PlayerState {
  const equipment = { ...(player.equipment ?? {}) };
  const fashionEquipment = { ...(player.fashionEquipment ?? {}) };

  for (const [slot, idOrInstanceId] of Object.entries(equipment)) {
    if (!idOrInstanceId) continue;
    let baseItemId = idOrInstanceId;
    if (player.itemInstances?.[idOrInstanceId]) {
      baseItemId = player.itemInstances[idOrInstanceId].itemId;
    }
    const item = DEFAULT_MMORPG_CONTENT.items[baseItemId];
    if (item?.category === "fashion") {
      fashionEquipment[slot as keyof typeof fashionEquipment] = idOrInstanceId;
      delete equipment[slot as keyof typeof equipment];
    }
  }

  return {
    ...player,
    currencies: player.currencies ?? { gold: 0, honor: 0, guild_token: 0 },
    inventory: player.inventory ?? [],
    equipment,
    fashionEquipment,
    unlockedSkillIds: player.unlockedSkillIds ?? [],
    equippedSkillIds: player.equippedSkillIds ?? [],
    professionLevels: player.professionLevels ?? {},
    factionReputation: player.factionReputation ?? {},
    questLog: player.questLog ?? [],
    dialogueFlags: player.dialogueFlags ?? [],
    fishBasket: player.fishBasket ?? [],
    fishingSession: player.fishingSession,
    pendingMenu: player.pendingMenu,
    itemInstances: player.itemInstances ?? {},
    unlockedAchievementIds: player.unlockedAchievementIds ?? [],
    claimedAchievementIds: player.claimedAchievementIds ?? [],
    factionRewardClaimedIds: player.factionRewardClaimedIds ?? [],
    pendingCompensationExp: player.pendingCompensationExp,
    pendingCompensationGold: player.pendingCompensationGold,
  };
}
