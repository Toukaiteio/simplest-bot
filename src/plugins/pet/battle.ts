import { ElementType } from "./types.js";
import { typeEffectiveness } from "./elements.js";
import { PetInstance, PetSpecies } from "./types.js";
import { getSpecies } from "./species.js";

/** PVP battle with skills, type advantage, and cooldowns */
export function simulateSkillBattle(
  attacker: PetInstance, defender: PetInstance,
  atkMood: number, defMood: number,
): { winner: "attacker" | "defender"; log: string[] } {
  const log: string[] = [];
  const atkSpecies = getSpecies(attacker.speciesId);
  const defSpecies = getSpecies(defender.speciesId);
  const atkSkill = atkSpecies?.skill;
  const defSkill = defSpecies?.skill;
  const atkEff = atkSpecies ? typeEffectiveness(atkSpecies.element, defSpecies?.element ?? "wind") : 1.0;
  const defEff = defSpecies ? typeEffectiveness(defSpecies.element, atkSpecies?.element ?? "wind") : 1.0;

  let atkHp = attacker.maxHp, defHp = defender.maxHp;
  const atkPow = Math.floor(attacker.stats.power * (0.8 + atkMood * 0.2));
  const atkDef = Math.floor(attacker.stats.defense * (0.8 + atkMood * 0.2));
  const atkSpd = Math.floor(attacker.stats.speed * (0.8 + atkMood * 0.2));
  const defPow = Math.floor(defender.stats.power * (0.8 + defMood * 0.2));
  const defDef = Math.floor(defender.stats.defense * (0.8 + defMood * 0.2));
  const defSpd = Math.floor(defender.stats.speed * (0.8 + defMood * 0.2));

  log.push(`${attacker.name} VS ${defender.name}`);
  if (atkEff > 1) log.push(`${attacker.name} 属性克制！`);
  if (defEff > 1) log.push(`${defender.name} 属性克制！`);

  let turn = 0, atkTimer = 0, defTimer = 0;
  let atkCD = 0, defCD = 0;
  const maxTurns = 20;

  while (turn < maxTurns && atkHp > 0 && defHp > 0) {
    turn++;
    atkTimer += atkSpd; defTimer += defSpd;

    if (atkTimer >= defTimer) {
      const useSkill = atkCD <= 0 && atkSkill !== undefined;
      const baseDmg = useSkill ? Math.floor(atkSkill.power * (0.8 + Math.random() * 0.4)) : Math.floor(atkPow * 1.5 * (0.8 + Math.random() * 0.4));
      const dmg = Math.max(1, Math.floor(baseDmg * atkEff - atkDef * 0.25));
      const isCrit = Math.random() < 0.1;
      const finalDmg = isCrit ? Math.floor(dmg * 1.8) : dmg;
      const skillName = useSkill ? atkSkill!.name : "普通攻击";
      defHp = Math.max(0, defHp - finalDmg);
      if (useSkill) atkCD = atkSkill!.cooldown; else atkCD = Math.max(0, atkCD - 1);
      if (defCD > 0) defCD--;
      log.push(`${isCrit ? "暴击！" : ""}${attacker.name} ${skillName} ${finalDmg}伤害（${defender.name} ${defHp}/${defender.maxHp}）`);
      atkTimer -= 100;
    } else {
      const useSkill = defCD <= 0 && defSkill !== undefined;
      const baseDmg = useSkill ? Math.floor(defSkill.power * (0.8 + Math.random() * 0.4)) : Math.floor(defPow * 1.5 * (0.8 + Math.random() * 0.4));
      const dmg = Math.max(1, Math.floor(baseDmg * defEff - atkDef * 0.25));
      const isCrit = Math.random() < 0.1;
      const finalDmg = isCrit ? Math.floor(dmg * 1.8) : dmg;
      const skillName = useSkill ? defSkill!.name : "普通攻击";
      atkHp = Math.max(0, atkHp - finalDmg);
      if (useSkill) defCD = defSkill!.cooldown; else defCD = Math.max(0, defCD - 1);
      if (atkCD > 0) atkCD--;
      log.push(`${isCrit ? "暴击！" : ""}${defender.name} ${skillName} ${finalDmg}伤害（${attacker.name} ${atkHp}/${attacker.maxHp}）`);
      defTimer -= 100;
    }
  }

  if (atkHp <= 0) { log.push(`${attacker.name} 倒下了！`); return { winner: "defender", log }; }
  if (defHp <= 0) { log.push(`${defender.name} 倒下了！`); return { winner: "attacker", log }; }
  log.push("时间到！");
  return atkHp / attacker.maxHp >= defHp / defender.maxHp
    ? { winner: "attacker", log } : { winner: "defender", log };
}
