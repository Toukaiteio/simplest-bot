# Text MMORPG Agent Guide

## Goal

This framework exists to let multiple AI agents extend the same text-adventure MMORPG without silently drifting on rules, data shape, or project structure.

## Shared Truth

- `src/plugins/mmorpg/schema.ts`
  Defines all canonical entity shapes: player, guild, party, market, mail, world state, classes, skills, items, quests, areas, dungeons, factions, professions.
- `src/plugins/mmorpg/data/`
  The modular data directory containing all built-in content, split into tier-based and type-based modules. Entry point is `data/content.ts`; public API is `data/index.ts`.
- `src/plugins/mmorpg/default-content.ts`
  Backward-compatibility re-export layer. All actual data lives in `data/`.
- `src/plugins/mmorpg/rulebook.ts`
  The only place for progression formulas, combat constants, and framework-wide numeric rules.
- `src/plugins/mmorpg/validator.ts`
  The only place for registry cross-reference validation.
- `src/plugins/mmorpg/state-store.ts`
  The only place for persistent MMORPG runtime state.
- `src/plugins/mmorpg/framework-plugin.ts`
  Bot-facing integration layer, commands, and tools.

## Global State Contract

- Player data is global by `userId`.
- Guild, party, mail, market, and world state are also global.
- No MMORPG progression data should be keyed by `groupId`.
- Chat context can affect narration, but not account ownership or persistence boundaries.

## Agent Change Rules

- If you add a new gameplay system, first add types in `schema.ts`.
- If you add built-in content, create or extend the appropriate module file under `src/plugins/mmorpg/data/`. Then register it in `data/content.ts` and re-export from `data/index.ts`.
- If you add new formulas or rebalance numbers, update `rulebook.ts`.
- If a new registry references existing IDs, extend `validator.ts`.
- If persistent state shape changes, update `state-store.ts` and keep backward-compatible defaults.
- Do not duplicate formulas inside commands, tools, or state store logic.
- Do not hardcode content IDs in multiple files when one registry can be the source of truth.
- Do not create a single excessively long file. Split content by data type (skills, items, etc.) and by tier (starter, kingdom, frontier, etc.).

## Content Extension Rules

- IDs must use lowercase snake_case.
- Every cross-reference must point to a registered ID.
- Starter classes must only reference starter skills and starter items that exist.
- Area graph links should be bidirectional unless one-way travel is intentional and documented.
- Quest rewards that touch economy should remain explicit and auditable.

## Data Module Architecture

All built-in game data lives under `src/plugins/mmorpg/data/` and is organized by data type and world tier:

- **Type-based modules**: `races.ts`, `classes.ts`, `basics.ts`, `skills.ts`, `items.ts`, `factions.ts`, `fish.ts`
- **World-tier modules**: `world-starter.ts`, `world-kingdom.ts`, `world-frontier.ts`, `world-high.ts`, `world-shadow.ts`, `world-demon.ts`, `world-abyss.ts` — each exports areas, NPCs, monsters, and resource nodes for that level bracket.
- **Quest-tier modules**: `quests-starter.ts`, `quests-kingdom.ts`, `quests-frontier.ts`, `quests-high.ts`, `quests-shadow.ts`, `quests-demon.ts`, `quests-abyss.ts`
- **Cross-cutting aggregators**: `all-npcs.ts`, `all-monsters.ts`, `all-resource-nodes.ts` — spread-merge all tier exports into unified registries.
- **Assembly**: `content.ts` composes the final `MMORPGContent` object; `index.ts` is the public API.

When adding a new world tier, create `world-<tier>.ts` and `quests-<tier>.ts`, then add them to `content.ts` and `all-*.ts` aggregators.

## Economy Bridge Rules

- Bot `coins` is now the single source of truth for shared gold balance.
- MMORPG `currencies.gold` is a synchronized mirror for framework read-model use.
- Any MMORPG reward that grants gold must update the Bot economy account and then sync the mirrored MMORPG gold view.
- Keep reward source labels stable so different agents do not invent conflicting bookkeeping.

## Safe Collaboration Workflow

1. Run framework validation before and after changing registries.
2. Prefer adding new files under `src/plugins/mmorpg/` instead of editing unrelated bot systems.
3. Keep framework decisions documented here when a new subsystem changes extension rules.
4. Preserve global shared-state semantics unless a deliberate migration is designed.
