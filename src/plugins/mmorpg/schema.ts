export type StatBlock = {
  strength: number;
  defense: number;
  charm: number;
  agility: number;
  eloquence: number;
  endurance: number;
  life: number;
};

export type ResourceBlock = {
  hp: number;
  focus: number;
  stamina: number;
};

export type CurrencyDef = {
  id: string;
  name: string;
  description: string;
};

export type RaceDef = {
  id: string;
  name: string;
  description: string;
  baseStats: StatBlock;
  traitSummary: string;
};

export type GenderDef = {
  id: string;
  name: string;
  description: string;
};

export type ClassDef = {
  id: string;
  name: string;
  description: string;
  primaryStats: Array<keyof StatBlock>;
  growthMultipliers: Partial<Record<keyof StatBlock, number>>;
  starterSkillIds: string[];
  starterItemIds: string[];
  /** Minimum rebirth count required to select this class. */
  requiredRebirths?: number;
  /** Quest ID that must be turned in before this class can be selected. */
  unlockQuestId?: string;
  /** Whether a player has unlocked this class (checked for shop filtering). */
  isUnlocked?: (player: PlayerState) => boolean;
};

export type SkillDef = {
  id: string;
  name: string;
  description: string;
  category: "active" | "passive" | "utility";
  scalingStat: keyof StatBlock;
  resourceCost: Partial<ResourceBlock>;
  /** Number of turns to wait before this skill can be used again (0 = no cooldown). */
  cooldownTurns: number;
  /** Optional buff/debuff definitions applied when this skill is used. */
  appliesBuffs?: SkillBuffDef[];
  /** Targeting mode: "single" (default) hits one enemy; "aoe" hits all enemies. */
  targeting?: "single" | "aoe";
  /** Action time cost in the CTB gauge system (overrides category-based default). */
  timeCost?: number;
};

/**
 * Declarative buff/debuff attached to a skill.
 * The battle engine resolves this into a full StatusEffect at runtime.
 */
export type SkillBuffDef = {
  /** Status effect id (used for stacking/dedup). */
  effectId: string;
  /** Human-readable label. */
  name: string;
  /** Effect category. */
  kind: StatusEffectKind;
  /** Duration in turns. */
  duration: number;
  /** Numeric magnitude. */
  value: number;
  /** For stat_mod: which stat to modify. */
  stat?: keyof StatBlock;
  /** For resource_drain: which resource to drain. */
  resource?: keyof ResourceBlock;
  /** "buff" or "debuff". */
  polarity: "buff" | "debuff";
  /** Who receives the effect: "target" (enemy) or "self" or "allies". */
  target: "self" | "target" | "allies";
};

export type ItemDef = {
  id: string;
  name: string;
  description: string;
  /** "fashion" items go in fashionEquipment slots, provide reduced stats + charm bonus. */
  category: "weapon" | "armor" | "consumable" | "material" | "quest" | "misc" | "fashion";
  equipSlot?: "weapon" | "offhand" | "head" | "body" | "legs" | "accessory";
  /** Which classes are allowed to equip this item. Empty = no restriction. */
  allowedClasses?: string[];
  /** Minimum player level required for this equipment's stats to take effect. */
  requiredLevel?: number;
  grantsSkillId?: string;
  sellPrice?: number;
  /** Overrides the automatically calculated base stat value (Math.floor(sellPrice / 4)).
   *  Use this to decouple price changes from stat power. */
  basePower?: number;
};

export type ProfessionDef = {
  id: string;
  name: string;
  description: string;
  specialtyItemIds: string[];
};

export type FactionDef = {
  id: string;
  name: string;
  description: string;
  reputationTracks: string[];
};

export type AreaDef = {
  id: string;
  name: string;
  description: string;
  recommendedLevel: [number, number];
  connectedAreaIds: string[];
  monsterIds: string[];
  npcIds: string[];
  questIds: string[];
  resourceNodeIds: string[];
  factionId?: string;
  isSafe?: boolean;
};

export type ResourceNodeDef = {
  id: string;
  name: string;
  professionId: string;
  itemIds: string[];
  areaIds: string[];
};

export type FishRarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export type FishSpeciesDef = {
  id: string;
  name: string;
  description: string;
  habitatAreaIds: string[];
  baseValue: number;
  lengthRangeCm: [number, number];
  rarityWeights: Partial<Record<FishRarity, number>>;
};

export type NpcDef = {
  id: string;
  name: string;
  description: string;
  areaId: string;
  role: "merchant" | "trainer" | "quest" | "healer" | "guild" | "story";
  offeredQuestIds: string[];
  shopItemIds: string[];
  /** Dialogue tree IDs this NPC can initiate (checked in order, first eligible is used). */
  dialogueTreeIds?: string[];
};

export type MonsterDef = {
  id: string;
  name: string;
  description: string;
  level: number;
  statGrowth: StatBlock;
  skillIds: string[];
  lootItemIds: string[];
  areaIds: string[];
  /** Chance (0-1) to drop a random equipment piece on victory. */
  dropChance?: number;
  /** Pool of equipment item IDs that can be dropped. If empty, no equipment drops. */
  dropPool?: string[];
};

export type QuestObjective =
  | { type: "kill"; monsterId: string; count: number }
  | { type: "collect"; itemId: string; count: number }
  | { type: "talk"; npcId: string }
  | { type: "reach"; areaId: string };

export type QuestReward = {
  exp: number;
  coins: number;
  itemIds: string[];
  /** Skill (usually passive) unlocked when this quest is turned in. */
  rewardSkillId?: string;
  reputation?: {
    factionId: string;
    amount: number;
  };
};

export type QuestDef = {
  id: string;
  name: string;
  description: string;
  giverNpcId: string;
  turnInNpcId: string;
  requiredLevel: number;
  /** Quest IDs that must be turned_in before this quest can be accepted (AND logic). */
  prerequisiteQuestIds: string[];
  objectives: QuestObjective[];
  reward: QuestReward;
  /** Allowed classes. Empty = all classes. */
  allowedClasses?: string[];
  /** Minimum rebirth count required. */
  requiredRebirths?: number;
  /** Faction reputation requirements. */
  requiredFactionRep?: Array<{ factionId: string; minRep: number }>;
  /** Required items in inventory (must have all). */
  requiredItems?: Array<{ itemId: string; quantity: number }>;
  /** Dialogue flags that must be set. */
  requiredDialogueFlags?: string[];
  /** Guild membership required. */
  requiresGuild?: boolean;
  /** Skills that must be unlocked. */
  requiredSkillIds?: string[];
  /** Cooldown in seconds after turning in before this quest can be accepted again. 0 = no cooldown. */
  cooldownSeconds?: number;
  /** Quest IDs that exclude this quest (OR logic: if any is active/turned_in, this quest is hidden). */
  excludedQuestIds?: string[];
};

export type DungeonDef = {
  id: string;
  name: string;
  description: string;
  areaId: string;
  bossMonsterIds: string[];
  requiredLevel: number;
  rewardItemIds: string[];
  partySize: number;
};

export type AchievementDef = {
  id: string;
  name: string;
  description: string;
  rewardCoins: number;
};

export type WikiEntry = {
  id: string;
  title: string;
  keywords: string[];
  category?: string;
  content: string;
};

export type Registry<T extends { id: string }> = Record<string, T>;

export type MMORPGContent = {
  currencies: Registry<CurrencyDef>;
  races: Registry<RaceDef>;
  genders: Registry<GenderDef>;
  classes: Registry<ClassDef>;
  skills: Registry<SkillDef>;
  items: Registry<ItemDef>;
  professions: Registry<ProfessionDef>;
  factions: Registry<FactionDef>;
  areas: Registry<AreaDef>;
  resourceNodes: Registry<ResourceNodeDef>;
  fishSpecies: Registry<FishSpeciesDef>;
  npcs: Registry<NpcDef>;
  monsters: Registry<MonsterDef>;
  quests: Registry<QuestDef>;
  dungeons: Registry<DungeonDef>;
  achievements: Registry<AchievementDef>;
  wikiEntries: Registry<WikiEntry>;
  dialogueTrees: Registry<DialogueTree>;
};

export type InventoryEntry = {
  itemId: string;
  quantity: number;
  instanceId?: string;
};

export type ItemInstance = {
  id: string;
  itemId: string;
  enhancement: number;
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  substats: StatBlock;
  suffix?: string;
  /** Custom experience amount carried by this instance (经验瓶 only). */
  expAmount?: number;
  /** Custom gold amount carried by this instance (钱袋 only). */
  goldAmount?: number;
};

export type QuestProgress = {
  questId: string;
  status: "available" | "active" | "completed" | "turned_in";
  counters: Record<string, number>;
  /** Timestamp when the quest was turned in (for cooldown tracking). */
  turnedInAt?: string;
};

export type FishCatch = {
  id: string;
  speciesId: string;
  speciesName: string;
  rarity: FishRarity;
  lengthCm: number;
  price: number;
  areaId: string;
  caughtAt: string;
};

export type FishingSession = {
  areaId: string;
  startedAt: string;
  resolveAt: string;
};

export type DeathMarker = {
  areaId: string;
  goldDropped: number;
  timestamp: string;
};

export type PlayerState = {
  userId: string;
  raceId: string;
  classId: string;
  genderId: string;
  appearance: string;
  personalDeclaration?: string;
  areaId: string;
  level: number;
  exp: number;
  coinsEarnedFromMMO: number;
  stats: StatBlock;
  resources: ResourceBlock;
  currencies: Record<string, number>;
  inventory: InventoryEntry[];
  equipment: Partial<Record<NonNullable<ItemDef["equipSlot"]>, string>>;
  /** Fashion/cosmetic items — independent from real equipment, provide reduced stats + charm. */
  fashionEquipment: Partial<Record<NonNullable<ItemDef["equipSlot"]>, string>>;
  unlockedSkillIds: string[];
  /** Active/utility skills equipped into limited skill slots — only these participate in battle.
   *  Passive skills are read from unlockedSkillIds directly (always-on, no slot needed). */
  equippedSkillIds: string[];
  professionLevels: Record<string, number>;
  factionReputation: Record<string, number>;
  questLog: QuestProgress[];
  /** World flags set by dialogue choices (per-player story progress). */
  dialogueFlags: string[];
  fishBasket: FishCatch[];
  fishingSession?: FishingSession;
  pendingMenu?: PendingMenu;
  deathMarker?: DeathMarker;
  guildId?: string;
  partyId?: string;
  marriage?: {
    spouseUserId: string;
    marriedAt: string;
    ringItemId: string;
  };
  /** Number of times the player has been reborn (轮回). Each rebirth grants permanent stat bonuses. */
  rebirthCount: number;
  /** Permanent flat stat bonus accumulated from rebirths. */
  rebirthBonus: StatBlock;
  /** Daily gift tracking: { date: "YYYY-MM-DD", count: number } */
  dailyGifts?: { date: string; count: number };
  /** Timestamp (ms) of last affinity decay tick. */
  lastAffinityDecayAt?: number;
  portraitPath?: string;
  portraitGeneratedAt?: string;
  createdAt: string;
  updatedAt: string;
  itemInstances?: Record<string, ItemInstance>;
  guideCompleted?: boolean;
  unlockedAchievementIds: string[];
  claimedAchievementIds: string[];
  factionRewardClaimedIds?: string[];
  /** Pending compensation exp to be granted as an exp_bottle after guide re-completion. */
  pendingCompensationExp?: number;
  /** Pending compensation gold to be granted as a gold_bag after guide re-completion. */
  pendingCompensationGold?: number;
};

export type GuildState = {
  id: string;
  name: string;
  leaderUserId: string;
  memberUserIds: string[];
  treasury: Record<string, number>;
  createdAt: string;
};

export type PartyState = {
  id: string;
  leaderUserId: string;
  memberUserIds: string[];
  currentAreaId: string;
  objective?: string;
  formation: "balanced" | "aggressive" | "guarded";
  recruiting: boolean;
  createdAt: string;
};

export type MarriageProposalState = {
  id: string;
  proposerUserId: string;
  targetUserId: string;
  ringItemId: string;
  createdAt: string;
};

export type MarketListing = {
  id: string;
  sellerUserId: string;
  itemId: string;
  quantity: number;
  pricePerUnit: number;
  createdAt: string;
  instanceId?: string;
};

export type MailState = {
  id: string;
  fromUserId: string;
  toUserId: string;
  title: string;
  body: string;
  attachments: InventoryEntry[];
  createdAt: string;
  claimedAt?: string;
};

/* ── Combat Status Effects (Buff / Debuff) ── */

/**
 * The kind of modifier a status effect applies.
 *
 * - stat_mod:      Percentage modifier to a stat (stacks additively).
 * - dot:           Damage-over-time (flat damage per turn).
 * - hot:           Heal-over-time (flat heal per turn).
 * - stun:          Target skips its next action.
 * - shield:        Absorbs incoming damage before HP.
 * - taunt:         Forces the monster to attack this target.
 * - resource_drain: Drains a resource (focus/stamina) each turn.
 */
export type StatusEffectKind =
  | "stat_mod"
  | "dot"
  | "hot"
  | "stun"
  | "shield"
  | "taunt"
  | "resource_drain";

export type StatusEffect = {
  /** Unique effect id (e.g. "atk_up", "poison", "stun"). */
  id: string;
  /** Human-readable label shown in battle log. */
  name: string;
  /** Effect category. */
  kind: StatusEffectKind;
  /** Remaining turns (decremented at end of each round). */
  duration: number;
  /** Numeric magnitude — interpretation depends on `kind`. */
  value: number;
  /** Which stat this modifier affects (stat_mod only). */
  stat?: keyof StatBlock;
  /** Which resource to drain (resource_drain only). */
  resource?: keyof ResourceBlock;
  /** "buff" = beneficial, "debuff" = harmful. */
  polarity: "buff" | "debuff";
  /** Who applied this effect (name for battle log). */
  sourceName?: string;
};

/* ── Menu system types ── */

export type MenuActionType =
  | "move" | "talk" | "hunt" | "gather" | "fish"
  | "buy" | "sell" | "equip" | "unequip" | "use_item"
  | "equip_skill" | "unequip_skill" | "open_skill_slots"
  | "accept_quest" | "turn_in_quest" | "abandon_quest"
  | "enter_dungeon" | "dungeon_fight"
  | "guild_create" | "guild_join" | "guild_leave" | "guild_donate"
  | "view_npc" | "view_item" | "view_skill" | "view_monster"
  | "view_faction" | "view_achievement"
  | "open_bag" | "open_equip" | "open_skills" | "open_guild" | "open_achievements"
  | "open_quest_log" | "view_fish_basket" | "sell_all_fish"
  | "claim_achievement" | "claim_faction_reward"
  | "dialogue_choice"
  | "back" | "noop" | "recover_gold" | "guide_step";

export type MenuAction = {
  type: MenuActionType;
  targetId?: string;
  extra?: Record<string, string>;
};

/* ── Dialogue / Story System ── */

/**
 * Side-effects triggered when a dialogue choice is selected or a node is shown.
 */
export type DialogueEffect = {
  type: "set_flag" | "require_flag" | "grant_item" | "accept_quest" | "heal" | "damage" | "add_gold";
  value: string;
};

/**
 * One selectable option within a dialogue node.
 */
export type DialogueChoice = {
  text: string;
  nextNodeId?: string;
  effects?: DialogueEffect[];
  /** Only show this choice if the player has this world flag set. */
  requireFlag?: string;
};

/**
 * A single node (screen) in a dialogue tree.
 */
export type DialogueNode = {
  speaker: string;
  text: string;
  choices: DialogueChoice[];
};

/**
 * A complete dialogue tree for an NPC, containing multiple branching nodes.
 */
export type DialogueTree = {
  id: string;
  entryNodeId: string;
  nodes: Record<string, DialogueNode>;
  /** Only start this dialogue if the player has this world flag set. */
  requireFlag?: string;
  /** Set this world flag when the dialogue has been played through at least once. */
  setFlagOnComplete?: string;
};

export type PendingMenuItem = {
  label: string;
  description?: string;
  action: MenuAction;
};

export type MenuGroupCategory = "move" | "combat" | "talk" | "interact" | "quest" | "system";

export type MenuGroup = {
  label: string;
  category: MenuGroupCategory;
  items: PendingMenuItem[];
};

export type PendingMenu = {
  context: string;
  title: string;
  groups: MenuGroup[];
  createdAt: string;
};

export type MonsterPoolEntry = {
  killedTimestamps: number[];
  /** Cached monster pool size for this area (set when pool is first created). */
  poolSize: number;
};

export type ResourcePoolEntry = {
  gatheredTimestamps: number[];
  /** Cached resource pool size for this area (set when pool is first created). */
  poolSize: number;
};

export type WorldState = {
  dailyBossDefeatedIds: string[];
  eventFlags: string[];
  monsterPools: Record<string, MonsterPoolEntry>;
  resourcePools: Record<string, ResourcePoolEntry>;
  updatedAt: string;
};

export type MMORPGState = {
  players: Record<string, PlayerState>;
  guilds: Record<string, GuildState>;
  parties: Record<string, PartyState>;
  marriageProposals: Record<string, MarriageProposalState>;
  marketListings: Record<string, MarketListing>;
  mails: Record<string, MailState>;
  world: WorldState;
};

export type ValidationReport = {
  errors: string[];
  warnings: string[];
  stats: Record<string, number>;
};
