# MMORPG Story And NPC Guide

## Story Writing Goal

Story content in this project should produce playable hooks for chat interaction: where to go, who to meet, what to fight, what to collect, and why it matters locally.

## Plot Structure Rules

- Keep quest arcs legible in 1-3 steps whenever possible.
- Every quest should answer:
  - who needs help
  - what the concrete task is
  - why the task matters now
  - what makes the target area risky or interesting
- Starter-region writing should focus on:
  - patrol and settlement safety
  - resource gathering and logistics
  - ruins and minor mysteries
  - faction trust and local stability

## Quest Escalation Ladder

- Tier 1: chores with pressure
  - supplies, scouting, cleanup, escorts, recovery
- Tier 2: local danger
  - monster nests, blocked routes, missing workers, tainted ruins
- Tier 3: regional anomaly
  - organized raiders, strange relic activity, faction strain, dungeon awakening

Do not jump to Tier 3 unless earlier area logic supports it.

## NPC Writing Rules

- Each named NPC must have:
  - one clear social role
  - one clear reason to exist in the area
  - one distinct speech tendency
  - one gameplay-facing function
- Do not create NPCs who are only lore containers.
- Do not create NPCs whose backstory is larger than their actual in-game role unless they are intended future anchors.

## NPC Role Templates

- `merchant`
  - concerns: stock, routes, margin, theft, deliveries
  - speech: direct, transactional, practical
- `trainer`
  - concerns: discipline, fundamentals, readiness
  - speech: corrective, firm, skill-focused
- `quest`
  - concerns: local obstacle, missing resource, urgent task
  - speech: task-driven, situational
- `healer`
  - concerns: wounds, exhaustion, herbs, restraint
  - speech: clinical but humane
- `guild`
  - concerns: coordination, contracts, reputation
  - speech: organized, selective, accountable
- `story`
  - concerns: place memory, transition, social atmosphere
  - speech: contextual, grounding, human

## Dialogue Constraints

- One line should usually carry one idea.
- Avoid speeches longer than what a player would tolerate in chat.
- NPCs can imply history, but should not narrate encyclopedia entries.
- Use concrete references:
  - roads
  - weather
  - patrols
  - stock
  - tools
  - ruins
  - local names

## Quest Text Constraints

- `description` should be concise and actionable.
- Do not hide core requirements behind metaphor.
- Reward logic should match the fiction:
  - materials or supplies for labor quests
  - reputation for faction-facing work
  - keys or special items for ruin or dungeon progress
- If a quest requires killing, explain why force is justified in the local context.

## Good Quest Hooks

- wolves cut off herb gatherers from a needed patch
- mine runoff attracts creatures to a supply lane
- a scout needs proof of crypt activity before patrol reassignment
- a quartermaster needs specific resources before the next caravan

## Weak Quest Hooks

- vague destiny calls with no local trigger
- “prove yourself” tasks with no social or material context
- random errands that do not connect to area pressure
- exposition-only conversations disguised as gameplay

## NPC Continuity Rules

- Reuse existing NPCs before inventing new ones.
- If a new NPC is added, define how they change the area loop.
- NPC personality should remain stable across quest chains.
- Do not retrofit an NPC into a secret mastermind unless the code-supported quest chain actually plans for it.

## Relationship To Existing Content

- `starter_village` should feel like a working settlement and staging point.
- `whisper_forest` should feel like an explored but unreliable frontier.
- `iron_mine` should feel industrial, tense, and labor-driven.
- `ruined_crypt` should feel old, dangerous, and slightly uncanny, not universe-breaking.
- `misty_marsh` should feel damp, pungent, and rewarding for herbalists, with hidden danger in the fog.
- `frontier_checkpoint` should feel military, practical, and busy with logistics and patrol turnover.
- `southern_hills` should feel exposed, rolling, and increasingly lawless the further from the checkpoint.
- `stoneheart_valley` should feel ancient, quiet, and heavy with forgotten purpose.
- `frostleaf_ridge` should feel cold, open, and commanding in its vantage over the entire frontier.

