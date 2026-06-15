# MMORPG Content Authoring Index

This repository already contains a text MMORPG framework with fixed schema, registries, and persistence boundaries. This index is the root entry for anyone writing story text, NPCs, maps, quests, fish species, or related world content.

## Read First

1. `docs/MMORPG_AGENT_GUIDE.md`
   Collaboration contract for framework-safe changes.
2. `src/plugins/mmorpg/schema.ts`
   Canonical entity shapes and field boundaries.
3. `src/plugins/mmorpg/data/`
   Modular data directory containing all built-in content. Entry point is `data/content.ts`.

## Root-Level Writing Guides

- `MMORPG_WORLD_BIBLE.md`
  Worldview, tone, genre limits, and text style rules.
- `MMORPG_STORY_AND_NPC_GUIDE.md`
  Plot writing rules, NPC writing rules, dialogue constraints, and quest-writing guardrails.
- `MMORPG_ENTITY_CREATION_RULES.md`
  Map, area, faction, monster, item, fish, and quest creation constraints mapped to the live schema.

## Source Of Truth

- New narrative rules belong in the root docs above.
- New game data belongs in the appropriate module under `src/plugins/mmorpg/data/` (by type and tier).
- New shapes still belong in `src/plugins/mmorpg/schema.ts`.
- New formulas still belong in `src/plugins/mmorpg/rulebook.ts`.
- New validation constraints still belong in `src/plugins/mmorpg/validator.ts`.

## Non-Negotiable Boundaries

- Do not invent new registry types in prose and assume they exist in code.
- Do not write content that requires group-specific save data. Player/MMORPG progression is global by `userId`.
- Do not write lore that depends on modern real-world politics, brands, or explicit real geography.
- Do not write content that breaks the current framework scale: this is a multi-tier MMORPG spanning from frontier villages to the abyss, but each region should remain internally coherent.
- Do not add irreversible world-state assumptions unless the runtime actually tracks them.

## Current World Snapshot

- Level cap: 1500 (7 world tiers, 34 areas)
- Factions: `dawn_alliance`, `iron_oath`, `silver_covenant`, `ash_covenant`
- Playable races: `human`, `elf`, `dwarf`, `beastkin`
- Starter classes: `warrior`, `mage`, `ranger`, `cleric`, `rogue`
- Skills: 40 (10 starter, 11 advanced, 6 high-tier, 13 passive)
- Items: 82 | Fish species: 17 | Dungeons: 10 | Achievements: 24
- Region map by tier:
  - **Starter (Lv 1–15)**: `starter_village` (1-5), `whisper_forest` (3-8), `iron_mine` (4-10), `misty_marsh` (5-10), `frontier_checkpoint` (7-12), `ruined_crypt` (8-12), `southern_hills` (8-13), `stoneheart_valley` (10-15), `frostleaf_ridge` (10-15)
  - **Kingdom (Lv 12–45)**: `broken_bridge` (12-20), `oak_ridge_town` (15-30), `red_bandit_ridge` (20-35), `garrison_fort` (30-45)
  - **Frontier (Lv 40–120)**: `windwall_fortress` (40-60), `iron_wall_road` (50-80), `black_swamp` (60-100), `goblin_caves` (80-120)
  - **Highland (Lv 100–300)**: `mist_port_city` (100-150), `highland_plateau` (120-180), `flame_mountains` (150-250), `iron_oath_garrison` (150-200), `ruined_kingdom_throne` (200-300)
  - **Shadow (Lv 280–700)**: `dragon_spine_mountains` (280-400), `shadow_council_reach` (350-500), `frozen_lake` (350-500), `blacktide_coast` (400-600), `snowveil_pass` (500-700)
  - **Demon (Lv 650–1100)**: `fire_demon_caverns` (650-800), `corrupted_spirit_woods` (750-950), `demon_king_throne` (900-1100), `spirit_king_sanctuary` (950-1100)
  - **Abyss (Lv 1000–1500)**: `abyss_descent` (1000-1200), `nine_turn_labyrinth` (1100-1400), `void_boundary` (1300-1500)
- Supported side systems:
  - professions, faction reputation, marriage, parties, fishing

## Recommended Workflow

1. Read `MMORPG_WORLD_BIBLE.md` before writing any narrative text.
2. Read `MMORPG_ENTITY_CREATION_RULES.md` before adding structured content.
3. If writing an NPC or quest chain, also read `MMORPG_STORY_AND_NPC_GUIDE.md`.
4. Add or edit data in the appropriate module file under `src/plugins/mmorpg/data/`.
5. Register new data in `data/content.ts` and re-export from `data/index.ts` if needed.
6. Run validation and build after edits.

