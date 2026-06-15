# MMORPG Entity Creation Rules

## Goal

This document maps content-writing intent to the actual entity shapes already present in `src/plugins/mmorpg/schema.ts` and the current live content registry in `src/plugins/mmorpg/default-content.ts`.

## Hard Source Rules

- All new built-in content must be registered in `src/plugins/mmorpg/default-content.ts`.
- IDs must be lowercase `snake_case`.
- All references must point to existing IDs.
- If you need a new field that does not exist in `schema.ts`, do not fake it in prose. Extend schema first.

## Current Supported Entity Buckets

- races
- genders
- classes
- skills
- items
- professions
- factions
- areas
- resource nodes
- fish species
- NPCs
- monsters
- quests
- dungeons
- achievements

## Area Creation Rules

- Every area needs:
  - `id`
  - `name`
  - `description`
  - `recommendedLevel`
  - `connectedAreaIds`
  - `monsterIds`
  - `npcIds`
  - `questIds`
  - `resourceNodeIds`
- The area must have a playable reason to exist.
- New areas should usually connect bidirectionally.
- Avoid creating empty placeholder areas with no gameplay loop.
- Area descriptions should answer:
  - what this place is
  - why players go there
  - what pressure exists there

## NPC Creation Rules

- `areaId` must place the NPC somewhere currently reachable.
- `role` must match actual usage.
- `offeredQuestIds` should be sparse and purposeful.
- `shopItemIds` should fit the NPC role and local economy.
- Do not create quest NPCs who offer unrelated errands from completely different area pressures.

## Monster Creation Rules

- Monster descriptions should imply behavior or ecological role.
- `level` should match the target area range.
- `lootItemIds` should make sense materially.
- Avoid making every monster a humanoid faction substitute.
- Use monsters to reinforce the region loop:
  - slime for low-tier nuisance and materials
  - wolves for route pressure
  - crawlers for mine hazard
  - undead for ruin pressure

## Quest Creation Rules

- Supported objective types:
  - `kill`
  - `collect`
  - `talk`
  - `reach`
- Every quest should use only currently supported objective types.
- Do not write escort, defense, crafting, stealth, puzzle, or branching objectives unless runtime support exists.
- `requiredLevel` should align with the giver area and target area.
- `prerequisiteQuestIds` should create understandable progression, not arbitrary locks.
- Reward items must be explicit and already registered.

## Resource Node Creation Rules

- Nodes must support a current profession.
- Node output should be narrow and readable.
- Resource nodes should reinforce area identity.
- Do not place every profession in every area.

## Fish Species Creation Rules

- Fish species are area-bound through `habitatAreaIds`.
- Fish species should feel distinct by:
  - habitat
  - base value
  - size range
  - rarity distribution
- Fish names and descriptions should fit local ecology and tone.
- Do not create joke fish that break immersion unless a seasonal event system actually exists.

## Item Creation Rules

- Items should map to one of the currently supported categories:
  - `weapon`
  - `armor`
  - `consumable`
  - `material`
  - `quest`
  - `misc`
- If an item is a core quest or area reward, its fiction should match how it is obtained.
- Avoid adding items with no acquisition path and no gameplay use.

## Faction Creation Rules

- New factions should only be added if the region can materially show them.
- A faction should have:
  - local presence
  - local stakes
  - reputation meaning
- Do not add distant lore factions just to inflate setting size.

## Dungeon Creation Rules

- Dungeons should be tied to a real area.
- `partySize` must reflect current party system expectations.
- Bosses should already exist as monsters.
- A dungeon should represent escalation of an existing regional problem, not a disconnected challenge room.

## Writing-To-Data Translation Checklist

Before adding an entity, confirm:

1. The concept fits the world bible.
2. The text style matches chat-readable fantasy prose.
3. The entity maps cleanly to an existing schema type.
4. Every referenced ID already exists or is added in the same change.
5. The entity has a gameplay-facing role, not just lore value.
6. The content does not imply unsupported mechanics.

## Unsupported Or Restricted Content Patterns

- branching moral-state quest trees
- romance plotlines that require runtime relationship states beyond existing marriage rules
- permanent city destruction or large evolving world-state arcs
- cinematic-only bosses with no monster logic
- puzzle keys, locked doors, or scripted events without runtime support
- dialogue systems requiring memory per NPC beyond current generic player state

## Validation Reminder

After editing content:

1. Run the MMORPG validator.
2. Run project build.
3. Check that descriptions still fit current command outputs and chat surfaces.

