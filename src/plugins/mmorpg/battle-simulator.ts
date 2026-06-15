import type {
  PlayerState,
  MonsterDef,
  StatBlock,
  SkillDef,
  StatusEffect,
  SkillBuffDef,
  ResourceBlock,
} from "./schema.js";
import { MMORPG_RULEBOOK, getMaxResources } from "./rulebook.js";

/* CTB (Charge Time Battle) Simulator
   Speed-bar action ordering + utility-based AI + aggro/threat */

export type BattleLogEntry = {
  turn: number;
  actor: string;
  action: "attack" | "skill" | "effect";
  label: string;
  damage?: number;
  heal?: number;
  detail: string;
};

export type BattleTurnRecord = {
  turn: number;
  events: BattleLogEntry[];
  playerHpAfter: number;
  monsterHpAfter: number;
};

export type BattleResult = {
  victory: boolean;
  turns: BattleTurnRecord[];
  totalTurns: number;
  estimatedSeconds: number;
  hpLost: number;
  hpLostMap: Record<string, number>;
  rewards: { exp: number; coins: number };
  lootItemIds: string[];
  levelsGained: number;
  monsterName: string;
  monsterLevel: number;
  playerName: string;
  playerLevel: number;
  playerHpRemaining: number;
  /** Item ID of the equipment drop, if any. */
  equipmentDrop?: string;
};

type Combatant = {
  id?: string;
  name: string;
  level: number;
  classId?: string;
  stats: StatBlock;
  hp: number; maxHp: number;
  focus: number; maxFocus: number;
  stamina: number; maxStamina: number;
  skills: SkillDef[];
  isPlayer: boolean;
  buffs: StatusEffect[];
  actionGauge: number;
  aggro: number;
  cooldownUntilTick: Map<string, number>;
  shieldValue: number;
};

const MAX_TICKS = 600;
const TICKS_PER_TURN = 6;

type Strategy = { damage: number; healing: number; defense: number; control: number; aggro: number };

const STRATEGIES: Record<string, Strategy> = {
  warrior: { damage: 0.9, healing: 0.3, defense: 2.0, control: 1.2, aggro: 3.0 },
  paladin: { damage: 0.8, healing: 1.0, defense: 2.2, control: 1.0, aggro: 3.0 },
  martial_god: { damage: 1.0, healing: 0.3, defense: 2.5, control: 1.3, aggro: 3.5 },
  dragon_knight: { damage: 1.0, healing: 0.3, defense: 2.0, control: 1.2, aggro: 2.8 },
  mage: { damage: 1.3, healing: 0.3, defense: 0.8, control: 1.0, aggro: 0.5 },
  warlock: { damage: 1.3, healing: 0.4, defense: 0.7, control: 1.2, aggro: 0.5 },
  holy_spirit_mage: { damage: 1.4, healing: 0.8, defense: 0.9, control: 1.1, aggro: 0.5 },
  magic_swordsman: { damage: 1.25, healing: 0.3, defense: 0.9, control: 1.0, aggro: 0.7 },
  ranger: { damage: 1.3, healing: 0.3, defense: 0.8, control: 1.5, aggro: 0.6 },
  rogue: { damage: 1.35, healing: 0.2, defense: 0.7, control: 1.5, aggro: 0.5 },
  druid: { damage: 1.0, healing: 1.2, defense: 0.9, control: 1.6, aggro: 0.7 },
  cleric: { damage: 0.5, healing: 3.0, defense: 1.0, control: 0.8, aggro: 0.3 },
};
const DEFAULT_STRATEGY: Strategy = { damage: 1.0, healing: 1.0, defense: 1.0, control: 1.0, aggro: 1.0 };

function getStrategy(classId?: string): Strategy {
  return (classId && STRATEGIES[classId]) || DEFAULT_STRATEGY;
}

const HEAL_KEYWORDS = ["治疗", "回复", "恢复", "回春", "治愈", "heal", "renew", "light"];
const DEFENSE_KEYWORDS = ["防御", "护盾", "guard", "shield", "barrier", "守护", "姿态"];

function isHealingSkill(s: SkillDef): boolean {
  if (s.appliesBuffs?.some((b) => b.kind === "hot")) return true;
  return HEAL_KEYWORDS.some((kw) => s.name.includes(kw) || s.id.includes(kw));
}
function isDefenseBuffSkill(s: SkillDef): boolean {
  if (s.appliesBuffs?.some((b) => b.kind === "shield")) return true;
  if (s.appliesBuffs?.some((b) => b.kind === "stat_mod" && b.stat === "defense" && b.polarity === "buff")) return true;
  return DEFENSE_KEYWORDS.some((kw) => s.name.includes(kw) || s.id.includes(kw));
}
function isTauntSkill(s: SkillDef): boolean {
  if (s.appliesBuffs?.some((b) => b.kind === "taunt")) return true;
  return s.id === "guard_stance" || s.id === "war_cry" || s.id === "shield_bash";
}
function isControlSkill(s: SkillDef): boolean {
  return s.appliesBuffs?.some((b) => b.kind === "stun" || (b.kind === "stat_mod" && b.polarity === "debuff")) ?? false;
}
function hasDotDebuff(s: SkillDef): boolean {
  return s.appliesBuffs?.some((b) => b.kind === "dot" || b.kind === "resource_drain") ?? false;
}

function getSpeed(c: Combatant): number {
  const cb = MMORPG_RULEBOOK.combat;
  const agiMod = getStatModifier(c, "agility");
  const effAgi = c.stats.agility * (1 + agiMod);
  return Math.max(50, cb.ctSpeedBase + (effAgi * cb.ctSpeedPerAgility) / 10);
}
function getSkillTimeCost(s: SkillDef): number {
  if (s.timeCost) return s.timeCost;
  if (s.category === "utility") return 450;
  if (s.cooldownTurns >= 5) return 600;
  if (s.cooldownTurns <= 1) return 350;
  return MMORPG_RULEBOOK.combat.ctDefaultTimeCost;
}

function getStatModifier(c: Combatant, stat: keyof StatBlock): number {
  let mod = 0;
  for (const b of c.buffs) { if (b.kind === "stat_mod" && b.stat === stat) mod += b.value; }
  return mod;
}
function isStunned(c: Combatant): boolean {
  return c.buffs.some((b) => b.kind === "stun" && b.duration > 0);
}
function canAfford(c: Combatant, s: SkillDef): boolean {
  const cost = s.resourceCost;
  if (cost.hp && c.hp - cost.hp <= c.maxHp * 0.15) return false;
  if (cost.focus && c.focus < cost.focus) return false;
  if (cost.stamina && c.stamina < cost.stamina) return false;
  return true;
}
function isOnCooldown(c: Combatant, s: SkillDef, currentTick: number): boolean {
  const until = c.cooldownUntilTick.get(s.id);
  return until !== undefined && currentTick < until;
}
function consumeCost(c: Combatant, s: SkillDef): void {
  const cost = s.resourceCost;
  if (cost.hp) c.hp -= cost.hp;
  if (cost.focus) c.focus -= cost.focus;
  if (cost.stamina) c.stamina -= cost.stamina;
}

function absorbDamage(c: Combatant, rawDmg: number): number {
  let dmg = rawDmg;
  for (let i = c.buffs.length - 1; i >= 0; i--) {
    const b = c.buffs[i];
    if (b.kind === "shield" && b.duration > 0 && dmg > 0) {
      const absorbed = Math.min(dmg, b.value);
      dmg -= absorbed; b.value -= absorbed;
      if (b.value <= 0) c.buffs.splice(i, 1);
    }
  }
  return Math.max(0, dmg);
}
function dealDamage(target: Combatant, dmg: number): void {
  target.hp -= absorbDamage(target, dmg);
}

function computeAttackDamage(actor: Combatant, target: Combatant): number {
  const atkStat = actor.stats.strength * (1 + getStatModifier(actor, "strength"));
  const defStat = target.stats.defense * (1 + getStatModifier(target, "defense"));
  let dmg = Math.max(1, Math.floor(atkStat * 2 - defStat * 0.35));
  return Math.max(1, Math.floor(dmg * (0.85 + Math.random() * 0.3)));
}
function computeSkillDamage(actor: Combatant, skill: SkillDef, target: Combatant): number {
  const sv = actor.stats[skill.scalingStat] * (1 + getStatModifier(actor, skill.scalingStat));
  const tDef = target.stats.defense * (1 + getStatModifier(target, "defense"));
  let dmg = Math.max(1, Math.floor(sv * 3.0 + actor.level * 1.5 - tDef * 0.25));
  return Math.max(1, Math.floor(dmg * (0.88 + Math.random() * 0.24)));
}
function computeCritRate(actor: Combatant, isSkill: boolean): number {
  const effAgi = actor.stats.agility * (1 + getStatModifier(actor, "agility"));
  return Math.min(isSkill ? 0.5 : 0.4, effAgi * MMORPG_RULEBOOK.combat.critRatePerAgility * (isSkill ? 1.3 : 1.0));
}
function computeDodgeRate(target: Combatant, isSkill: boolean): number {
  const effAgi = target.stats.agility * (1 + getStatModifier(target, "agility"));
  return Math.min(isSkill ? 0.15 : 0.3, effAgi * MMORPG_RULEBOOK.combat.dodgeRatePerAgility * (isSkill ? 0.5 : 1.0));
}

function applySkillBuffs(caster: Combatant, recipients: Combatant[], skill: SkillDef, log: BattleLogEntry[], turn: number): void {
  if (!skill.appliesBuffs) return;
  for (const bd of skill.appliesBuffs) {
    const targets = bd.target === "self" ? [caster] : recipients;
    for (const r of targets) {
      const ex = r.buffs.findIndex((b) => b.id === bd.effectId);
      const eff: StatusEffect = { id: bd.effectId, name: bd.name, kind: bd.kind, duration: bd.duration, value: bd.value, stat: bd.stat, resource: bd.resource, polarity: bd.polarity, sourceName: caster.name };
      if (bd.kind === "shield") { if (ex >= 0) r.buffs[ex].value += bd.value; else r.buffs.push(eff); }
      else if (bd.kind === "taunt") { r.aggro += bd.value; }
      else { if (ex >= 0) r.buffs[ex] = eff; else r.buffs.push(eff); }
      log.push({ turn, actor: caster.name, action: "effect", label: bd.name, detail: `${bd.polarity === "buff" ? "增益" : "减益"} → ${r.name}` });
    }
  }
}
function tickBuffs(c: Combatant, log: BattleLogEntry[], turn: number): void {
  for (let i = c.buffs.length - 1; i >= 0; i--) {
    const b = c.buffs[i];
    if (b.duration <= 0) { c.buffs.splice(i, 1); continue; }
    if (b.kind === "dot") { c.hp -= b.value; log.push({ turn, actor: b.sourceName ?? "效果", action: "effect", label: b.name, damage: b.value, detail: `${c.name} 受到 ${b.value} 点${b.name}伤害` }); }
    else if (b.kind === "hot") { const h = Math.min(b.value, c.maxHp - c.hp); if (h > 0) { c.hp += h; log.push({ turn, actor: b.sourceName ?? "效果", action: "effect", label: b.name, heal: h, detail: `${c.name} 恢复 ${h} HP` }); } }
    else if (b.kind === "resource_drain") { if (b.resource === "focus") c.focus = Math.max(0, c.focus - b.value); else if (b.resource === "stamina") c.stamina = Math.max(0, c.stamina - b.value); else if (b.resource === "hp") c.hp -= b.value; log.push({ turn, actor: b.sourceName ?? "效果", action: "effect", label: b.name, detail: `${c.name} 的${b.resource ?? "资源"}被抽取 ${b.value}` }); }
    b.duration -= 1; if (b.duration <= 0) c.buffs.splice(i, 1);
  }
}
function regenResources(c: Combatant): void {
  const cb = MMORPG_RULEBOOK.combat;
  c.focus = Math.min(c.maxFocus, c.focus + Math.ceil(c.maxFocus * cb.focusRegenPerTick));
  c.stamina = Math.min(c.maxStamina, c.stamina + Math.ceil(c.maxStamina * cb.staminaRegenPerTick));
}

type Candidate = { kind: "attack" } | { kind: "skill"; skill: SkillDef };

function estimateDamage(c: Combatant, skill: SkillDef, target: Combatant): number {
  const sv = c.stats[skill.scalingStat] * (1 + getStatModifier(c, skill.scalingStat));
  const tDef = target.stats.defense * (1 + getStatModifier(target, "defense"));
  return Math.max(1, (sv * 3.0 + c.level * 1.5 - tDef * 0.25) * (1 + computeCritRate(c, true)));
}

function pickAction(actor: Combatant, allies: Combatant[], enemies: Combatant[], currentTick: number): Candidate {
  const strat = getStrategy(actor.classId);
  let best: { candidate: Candidate; utility: number } | null = null;
  const pt = enemies.find((e) => e.hp > 0);
  if (pt) best = { candidate: { kind: "attack" }, utility: actor.stats.strength * 2 * 0.9 * 0.6 * strat.damage };
  for (const skill of actor.skills) {
    if (skill.category === "passive") continue;
    if (isOnCooldown(actor, skill, currentTick) || !canAfford(actor, skill)) continue;
    let utility = 0;
    if (isHealingSkill(skill)) {
      const w = allies.filter((a) => a.hp > 0 && a.hp / a.maxHp < 0.85);
      if (w.length === 0) continue;
      const ad = w.reduce((s, a) => s + (1 - a.hp / a.maxHp), 0) / w.length;
      utility = (actor.stats[skill.scalingStat] * 2.5 + actor.level * 2) * (1 + ad * 2) * strat.healing;
    } else if (isTauntSkill(skill)) {
      const td = allies.filter((a) => a.hp > 0 && a.id !== actor.id).reduce((s, a) => s + (1 - a.hp / a.maxHp), 0);
      utility = (50 + td * 100) * strat.aggro;
    } else if (isDefenseBuffSkill(skill)) {
      utility = (actor.stats.defense * 1.5) * (actor.hp / actor.maxHp < 0.4 ? 3 : 1) * strat.defense;
    } else if (isControlSkill(skill) && enemies.length > 0) {
      utility = enemies.reduce((s, e) => s + e.stats.strength + e.level * 2, 0) * 0.5 * strat.control;
    } else if (pt) {
      let de = estimateDamage(actor, skill, pt);
      if (skill.targeting === "aoe") de *= Math.max(1, enemies.filter((e) => e.hp > 0).length);
      if (hasDotDebuff(skill)) de += skill.appliesBuffs?.filter((b) => b.kind === "dot").reduce((s, b) => s + b.value * b.duration, 0) ?? 0;
      utility = de * strat.damage;
    }
    if (utility > 0 && (!best || utility > best.utility)) best = { candidate: { kind: "skill", skill }, utility };
  }
  return best ? best.candidate : { kind: "attack" };
}

function selectTarget(actor: Combatant, enemies: Combatant[]): Combatant | null {
  const alive = enemies.filter((e) => e.hp > 0);
  if (alive.length === 0) return null;
  if (!actor.isPlayer) {
    const tot = alive.reduce((s, e) => s + Math.max(1, e.aggro), 0);
    let roll = Math.random() * tot;
    for (const e of alive) { roll -= Math.max(1, e.aggro); if (roll <= 0) return e; }
    return alive[0];
  }
  return alive.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
}
function selectMonsterTarget(players: Combatant[]): Combatant | null {
  const alive = players.filter((p) => p.hp > 0);
  if (alive.length === 0) return null;
  if (alive.length === 1) return alive[0];
  const tot = alive.reduce((s, p) => s + Math.max(1, p.aggro), 0);
  let roll = Math.random() * tot;
  for (const p of alive) { roll -= Math.max(1, p.aggro); if (roll <= 0) return p; }
  return alive[0];
}

function executeAction(actor: Combatant, allies: Combatant[], enemies: Combatant[], action: Candidate, log: BattleLogEntry[], turn: number, currentTick: number): number {
  if (action.kind === "attack") {
    const target = actor.isPlayer ? selectTarget(actor, enemies) : selectMonsterTarget(enemies);
    if (!target) return MMORPG_RULEBOOK.combat.ctDefaultTimeCost;
    if (Math.random() < computeDodgeRate(target, false)) { log.push({ turn, actor: actor.name, action: "attack", label: "普通攻击", detail: `${target.name} 闪避了攻击` }); actor.aggro += 5; return 400; }
    let dmg = computeAttackDamage(actor, target);
    const crit = Math.random() < computeCritRate(actor, false);
    if (crit) dmg = Math.floor(dmg * 1.8);
    dealDamage(target, dmg); actor.aggro += 5;
    log.push({ turn, actor: actor.name, action: "attack", label: crit ? "普通攻击（暴击！）" : "普通攻击", damage: dmg, detail: crit ? `对 ${target.name} 造成 ${dmg} 点暴击伤害` : `对 ${target.name} 造成 ${dmg} 点伤害` });
    return 400;
  }
  const skill = action.skill;
  consumeCost(actor, skill);
  if (skill.cooldownTurns > 0) actor.cooldownUntilTick.set(skill.id, currentTick + skill.cooldownTurns * TICKS_PER_TURN);
  if (isHealingSkill(skill)) {
    const target = allies.filter((a) => a.hp > 0).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
    if (target) { const sv = actor.stats[skill.scalingStat] * (1 + getStatModifier(actor, skill.scalingStat)); const heal = Math.min(Math.max(1, Math.floor(sv * 2.5 + actor.level * 2)), target.maxHp - target.hp); target.hp += heal; log.push({ turn, actor: actor.name, action: "skill", label: skill.name, heal, detail: `为 ${target.name} 恢复 ${heal} HP` }); }
    applySkillBuffs(actor, allies, skill, log, turn); return getSkillTimeCost(skill);
  }
  if (isTauntSkill(skill)) {
    actor.aggro += 200; applySkillBuffs(actor, allies, skill, log, turn);
    if (skill.appliesBuffs) for (const bd of skill.appliesBuffs) if (bd.target === "target" && bd.polarity === "debuff") for (const e of enemies.filter((e) => e.hp > 0)) e.buffs.push({ id: bd.effectId, name: bd.name, kind: bd.kind, duration: bd.duration, value: bd.value, stat: bd.stat, polarity: bd.polarity, sourceName: actor.name });
    log.push({ turn, actor: actor.name, action: "skill", label: skill.name, detail: `${actor.name} 发起嘲讽，大幅吸引仇恨` }); return getSkillTimeCost(skill);
  }
  const isAoe = skill.targeting === "aoe";
  const targets = isAoe ? enemies.filter((e) => e.hp > 0) : [selectTarget(actor, enemies)].filter((t): t is Combatant => !!t);
  if (targets.length === 0) return getSkillTimeCost(skill);
  for (const target of targets) {
    if (Math.random() < computeDodgeRate(target, true)) { log.push({ turn, actor: actor.name, action: "skill", label: skill.name, detail: `${target.name} 闪避了 ${skill.name}` }); continue; }
    let dmg = computeSkillDamage(actor, skill, target);
    const crit = Math.random() < computeCritRate(actor, true);
    if (crit) dmg = Math.floor(dmg * 2.0);
    dealDamage(target, dmg);
    log.push({ turn, actor: actor.name, action: "skill", label: crit ? `${skill.name}（暴击！）` : skill.name, damage: dmg, detail: isAoe ? `${skill.name} 命中 ${target.name}，造成 ${dmg} 点伤害` : `对 ${target.name} 使用 ${skill.name}，造成 ${dmg} 点伤害` });
    applySkillBuffs(actor, [target], skill, log, turn);
  }
  applySkillBuffs(actor, [actor], skill, log, turn); actor.aggro += 10; return getSkillTimeCost(skill);
}

function applyPassives(c: Combatant): void {
  for (const p of c.skills.filter((s) => s.category === "passive")) {
    const bonus = Math.floor((c.stats[p.scalingStat] ?? 0) * 0.1);
    switch (p.scalingStat) {
      case "defense": c.stats.defense += bonus; break;
      case "agility": c.stats.agility += bonus; break;
      case "life": c.maxHp += bonus * 8; c.hp += bonus * 8; break;
      case "strength": c.stats.strength += bonus; break;
      case "eloquence": c.stats.eloquence += bonus; c.maxFocus += bonus * 4; c.focus += bonus * 4; break;
      case "endurance": c.maxStamina += bonus * 3; c.stamina += bonus * 3; break;
      case "charm": c.stats.charm += bonus; break;
    }
  }
}

export function simulateBattle(
  playerOrPlayers: PlayerState | PlayerState[],
  monster: MonsterDef,
  allSkills: Record<string, SkillDef>,
  formation: "balanced" | "aggressive" | "guarded" = "balanced",
  ambushed = false,
): BattleResult {
  const players = Array.isArray(playerOrPlayers) ? playerOrPlayers : [playerOrPlayers];
  const mainPlayer = players[0];
  const cb = MMORPG_RULEBOOK.combat;
  const defMod = formation === "guarded" ? 1.10 : 1.0;

  const playerCombatants: Combatant[] = players.map((p) => {
    const mr = getMaxResources(p.stats);
    const ea = p.equippedSkillIds ?? p.unlockedSkillIds;
    const pi = p.unlockedSkillIds.filter((id) => allSkills[id]?.category === "passive");
    const skills = Array.from(new Set([...ea, ...pi])).map((id) => allSkills[id]).filter((s): s is SkillDef => !!s);
    return { id: p.userId, name: p.userId, level: p.level, classId: p.classId, stats: { ...p.stats, defense: Math.round(p.stats.defense * defMod) }, hp: p.resources.hp, maxHp: mr.maxHp, focus: p.resources.focus, maxFocus: mr.maxFocus, stamina: p.resources.stamina, maxStamina: mr.maxStamina, skills, isPlayer: true, buffs: [], actionGauge: 0, aggro: p.stats.defense * 2 + p.stats.life * 1.5, cooldownUntilTick: new Map<string, number>(), shieldValue: 0 };
  });
  for (const c of playerCombatants) applyPassives(c);

  const n = players.length;
  const sHp = 1 + (n - 1) * 0.8;
  const sSt = 1 + (n - 1) * 0.15;
  const mStats = { ...monster.statGrowth };
  for (const k of Object.keys(mStats) as Array<keyof StatBlock>) mStats[k] = Math.round(mStats[k] * sSt);
  const bHp = Math.round((50 + mStats.life * 10) * sHp);
  const mName = n > 1 ? `${monster.name} (精英)` : monster.name;
  const monsterCombatant: Combatant = { name: mName, level: monster.level, stats: mStats, hp: bHp, maxHp: bHp, focus: Math.round((30 + mStats.eloquence * 5) * sHp), maxFocus: Math.round((30 + mStats.eloquence * 5) * sHp), stamina: Math.round((40 + mStats.endurance * 4) * sHp), maxStamina: Math.round((40 + mStats.endurance * 4) * sHp), skills: monster.skillIds.map((id) => allSkills[id]).filter((s): s is SkillDef => !!s), isPlayer: false, buffs: [], actionGauge: 0, aggro: mStats.strength * 2 + mStats.defense * 1.5, cooldownUntilTick: new Map<string, number>(), shieldValue: 0 };

  if (ambushed) {
    monsterCombatant.actionGauge = Math.round(MMORPG_RULEBOOK.combat.ctGaugeThreshold * 0.6);
  }

  const initialHp: Record<string, number> = {};
  for (const c of playerCombatants) initialHp[c.id ?? c.name] = c.hp;
  const turns: BattleTurnRecord[] = [];
  let tick = 0;
  const tickLog: BattleLogEntry[] = [];

  while (tick < MAX_TICKS && monsterCombatant.hp > 0 && playerCombatants.some((p) => p.hp > 0)) {
    tick++;
    const turn = Math.floor((tick - 1) / TICKS_PER_TURN) + 1;
    const all = [...playerCombatants, monsterCombatant];
    for (const c of all) { if (c.hp > 0) { regenResources(c); c.actionGauge += getSpeed(c); } }
    const ready = all.filter((c) => c.hp > 0 && c.actionGauge >= cb.ctGaugeThreshold).sort((a, b) => b.actionGauge - a.actionGauge);
    for (const actor of ready) {
      if (actor.hp <= 0 || monsterCombatant.hp <= 0 || !playerCombatants.some((p) => p.hp > 0)) break;
      if (isStunned(actor)) { tickLog.push({ turn, actor: actor.name, action: "effect", label: "眩晕", detail: `${actor.name} 被眩晕，无法行动` }); actor.actionGauge -= cb.ctGaugeThreshold * 0.5; continue; }
      const allies = actor.isPlayer ? playerCombatants : [monsterCombatant];
      const enemies = actor.isPlayer ? [monsterCombatant] : playerCombatants;
      actor.actionGauge -= executeAction(actor, allies, enemies, pickAction(actor, allies, enemies, tick), tickLog, turn, tick);
    }
    for (const c of all) { if (c.hp > 0) tickBuffs(c, tickLog, turn); }
    if (tick % TICKS_PER_TURN === 0) { turns.push({ turn, events: [...tickLog], playerHpAfter: Math.max(0, playerCombatants[0]?.hp ?? 0), monsterHpAfter: Math.max(0, monsterCombatant.hp) }); tickLog.length = 0; }
  }
  if (tickLog.length > 0) turns.push({ turn: Math.floor(tick / TICKS_PER_TURN) + 1, events: [...tickLog], playerHpAfter: Math.max(0, playerCombatants[0]?.hp ?? 0), monsterHpAfter: Math.max(0, monsterCombatant.hp) });

  const victory = monsterCombatant.hp <= 0;
  const hpLostMap: Record<string, number> = {};
  for (const c of playerCombatants) { const id = c.id ?? c.name; hpLostMap[id] = Math.max(0, (initialHp[id] ?? 0) - c.hp); }
  const fid = playerCombatants[0]?.id ?? playerCombatants[0]?.name ?? "";

  return { victory, turns, totalTurns: turns.length, estimatedSeconds: Math.min(120, Math.max(15, Math.ceil(tick * 1.5) + 15)), hpLost: Math.max(0, (initialHp[fid] ?? 0) - (playerCombatants[0]?.hp ?? 0)), hpLostMap, rewards: { exp: 0, coins: 0 }, lootItemIds: victory ? [...monster.lootItemIds] : [], levelsGained: 0, monsterName: mName, monsterLevel: monster.level, playerName: mainPlayer.userId, playerLevel: mainPlayer.level, playerHpRemaining: Math.max(0, playerCombatants[0]?.hp ?? 0) };
}

function formatDuration(s: number): string { return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`; }

export function formatBattleSummary(result: BattleResult): string {
  const lines: string[] = [];
  lines.push(result.victory ? `战斗胜利！击败了 **${result.monsterName}**（Lv.${result.monsterLevel}）` : `战斗失败…被 **${result.monsterName}**（Lv.${result.monsterLevel}）击败`);
  lines.push(`持续 ${result.totalTurns} 回合，耗时约 ${formatDuration(result.estimatedSeconds)}`);
  lines.push(`── 队伍状态 ──`);
  const entries = Object.entries(result.hpLostMap);
  if (entries.length <= 1) lines.push(`你 → HP: ${result.playerHpRemaining}（-${result.hpLost}）`);
  else for (const [u, l] of entries) lines.push(`${u === result.playerName ? "你" : u}：受到 ${l} 伤害`);
  if (result.victory && result.lootItemIds.length > 0) lines.push(`掉落物品：${result.lootItemIds.length} 件`);
  lines.push(`私聊发送 $mmo-battle-log 查看详细战斗记录`);
  return lines.join("\n");
}

export function formatBattleLog(result: BattleResult): string {
  const lines: string[] = [];
  lines.push("═══ 战斗记录 ═══");
  lines.push(`${result.playerName} vs ${result.monsterName}（Lv.${result.monsterLevel}）`);
  lines.push(`结果：${result.victory ? "胜利" : "败北"} | ${result.totalTurns} 回合 | 约 ${formatDuration(result.estimatedSeconds)}`);
  for (const turn of result.turns) {
    lines.push(`── 回合 ${turn.turn} ──`);
    for (const ev of turn.events) {
      if (ev.action === "effect" && !ev.damage && !ev.heal) lines.push(`  ✦ ${ev.actor} → ${ev.label} ${ev.detail}`);
      else { const p = [`  ${ev.actor} → ${ev.label}`]; if (ev.damage) p.push(`-${ev.damage}`); if (ev.heal) p.push(`+${ev.heal}`); lines.push(p.join(" ")); }
    }
    lines.push(`  [HP] 你 ${turn.playerHpAfter} | ${result.monsterName} ${turn.monsterHpAfter}`);
  }
  if (result.victory && result.lootItemIds.length > 0) { lines.push(`── 战利品 ──`); lines.push(`掉落 ${result.lootItemIds.length} 件物品`); }
  return lines.join("\n");
}

export type { Combatant };
