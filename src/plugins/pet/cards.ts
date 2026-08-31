import fs from "node:fs";
import path from "node:path";
import type { BotMessage, PluginContext } from "../../types.js";
import { screenshotHtml } from "../mmorpg/screenshot.js";
import { PetInstance, PetSpecies, ElementType } from "./types.js";
import { PET_SPECIES, getSpecies, STARTER_SPECIES } from "./species.js";
import { TYPE_CHART, RESIST_CHART, elementName } from "./elements.js";
import { calcBattlePower } from "./data.js";

// Shared CSS
const CARD_CSS = `*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#111214;color:#c8cad0;font-family:-apple-system,"SF Pro Text","PingFang SC","Noto Sans SC",sans-serif;font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}
.card{width:480px;margin:0 auto;padding:0;background:#17181c;border:1px solid #22252b}
.hd{padding:14px 18px;border-bottom:1px solid #22252b;display:flex;align-items:center;gap:12px}
.hd-title{font-size:13px;font-weight:600;color:#e8eaed;letter-spacing:.5px;text-transform:uppercase}
.ft{padding:10px 18px;font-size:10px;color:#555960;background:#13151a;display:flex;gap:12px;flex-wrap:wrap}
.ft span{color:#6a6e78}`;

// Element SVG icons (14x14)
const ELEM_SVG: Record<string, string> = {
  fire: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1C5 5 3 8 3 11a5 5 0 0010 0c0-2-.8-3.5-2-5-.5.8-1 1.5-1.5 1.5C9.5 5.5 9 3 8 1z"/></svg>',
  ice: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="1" x2="8" y2="15"/><line x1="2" y1="4.5" x2="14" y2="11.5"/><line x1="2" y1="11.5" x2="14" y2="4.5"/><line x1="5.5" y1="2" x2="8" y2="4.5"/><line x1="10.5" y1="2" x2="8" y2="4.5"/><line x1="5.5" y1="14" x2="8" y2="11.5"/><line x1="10.5" y1="14" x2="8" y2="11.5"/></svg>',
  electric: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 1L3 9h4l-1.5 6L13 7H9l.5-6z"/></svg>',
  earth: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1L1 14h14L8 1zM8 5l4 8H4l4-8z"/></svg>',
  water: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1C5 5.5 3 8.5 3 11a5 5 0 0010 0c0-2.5-2-5.5-5-10z"/></svg>',
  dark: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M12 8A6 6 0 016 2a6.5 6.5 0 00.5 2.5A4.5 4.5 0 0010 9a4.5 4.5 0 01-5.5 4A6 6 0 0012 8z"/></svg>',
  light: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="2.5"/><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="1" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="1" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="15" y2="8"/><line x1="3" y1="3" x2="4.5" y2="4.5"/><line x1="11.5" y1="11.5" x2="13" y2="13"/><line x1="3" y1="13" x2="4.5" y2="11.5"/><line x1="11.5" y1="4.5" x2="13" y2="3"/></g></svg>',
  wind: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 5h8a2 2 0 10-2-2"/><path d="M2 8h10a2 2 0 11-2 2"/><path d="M2 11h6a2 2 0 10-2-2"/></svg>',
};

// Utility SVG icons (12x12)
const ICONS = {
  coin: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 5.5h2a1.5 1.5 0 010 3h-1a1.5 1.5 0 000 3h2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="8" y1="4" x2="8" y2="12" stroke="currentColor" stroke-width="1"/></svg>',
  trophy: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4 2h8v5a4 4 0 01-8 0V2z"/><path d="M4 4H2.5a1.5 1.5 0 001.5 2.5"/><path d="M12 4h1.5a1.5 1.5 0 01-1.5 2.5"/><line x1="8" y1="11" x2="8" y2="13"/><line x1="5.5" y1="13.5" x2="10.5" y2="13.5"/></svg>',
  sword: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M11 1l4 4-7 7-4-4 7-7z"/><path d="M3 10l3 3"/><line x1="1" y1="15" x2="5" y2="11"/></svg>',
  shield: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M8 1L2 4v4c0 4 2.5 6 6 8 3.5-2 6-4 6-8V4L8 1z"/></svg>',
  heart: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 14S2 10 2 6a3 3 0 016 0 3 3 0 016 0c0 4-6 8-6 8z"/></svg>',
  list: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="2" cy="4" r="1.2"/><circle cx="2" cy="8" r="1.2"/><circle cx="2" cy="12" r="1.2"/><rect x="5" y="3" width="9" height="2" rx=".5"/><rect x="5" y="7" width="9" height="2" rx=".5"/><rect x="5" y="11" width="9" height="2" rx=".5"/></svg>',
  star: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l2 4.5 5 .5-3.5 3.5 1 5L8 12l-4.5 2.5 1-5L1 6l5-.5L8 1z"/></svg>',
  bolt: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 1L3 9h4l-1.5 6L13 7H9l.5-6z"/></svg>',
  egg: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="8" cy="9" rx="5" ry="6.5"/></svg>',
  paw: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><ellipse cx="8" cy="10" rx="3.5" ry="3"/><circle cx="4.5" cy="5" r="1.5"/><circle cx="8" cy="3.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/></svg>',
  book: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2 2h4.5c1 0 1.5.5 1.5 1v11c0-.5-.5-1-1.5-1H2V2z"/><path d="M14 2H9.5C8.5 2 8 2.5 8 3v11c0-.5.5-1 1.5-1H14V2z"/></svg>',
};

const ELEM_BAR: Record<string, string> = {
  fire: "#e85d3a", ice: "#4fc3f7", electric: "#ffd54f", earth: "#8d6e63",
  water: "#42a5f5", dark: "#7e57c2", light: "#ffcc02", wind: "#80cbc4",
};
const RARITY_C: Record<string, string> = { common: "#888c96", uncommon: "#6aab4a", rare: "#4a9eff", epic: "#b06ad9", legendary: "#ff9922" };

export async function renderCard(
  html: string, ctx: PluginContext, message: BotMessage,
  target: { type: "group" | "private"; id: string }, fallback: string,
): Promise<void> {
  try {
    const dir = path.resolve("data", "pets", "cards");
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, "pet-" + Date.now() + ".webp");
    await screenshotHtml(html, fp, { width: 480, format: "webp", quality: 88 });
    await ctx.sendImage(target, fp);
    fs.unlink(fp, () => {});
  } catch { await ctx.replyText(message, fallback); }
}

/* ─── $pet status card ─── */
export function buildPetCard(pet: PetInstance, species: PetSpecies | undefined, prefix: string): string {
  const elem = species?.element ?? "wind";
  const bp = calcBattlePower(pet);
  const hpPct = Math.round(pet.currentHp / pet.maxHp * 100);
  const skill = species?.skill;
  const moodBar = (l: string, v: number, c: string) =>
    `<div class="md"><span class="ml">${l}</span><div class="mt"><div class="mf" style="width:${v}%;background:${c}"></div></div><span class="mv">${v}</span></div>`;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CARD_CSS}
.hd-icon{width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:#1d2026;border:1px solid ${RARITY_C[species?.rarity ?? "common"]}40;color:${RARITY_C[species?.rarity ?? "common"]};flex-shrink:0;font-weight:700;font-size:18px}
.hd-info{flex:1;min-width:0}
.hd-name{font-size:15px;font-weight:600;color:#e8eaed}
.hd-sub{font-size:11px;color:#8a8e98;margin-top:2px;display:flex;align-items:center;gap:4px}
.hd-badge{font-size:11px;font-weight:600;padding:3px 8px;background:${RARITY_C[species?.rarity ?? "common"]}18;color:${RARITY_C[species?.rarity ?? "common"]};border:1px solid ${RARITY_C[species?.rarity ?? "common"]}30;flex-shrink:0}
.elem-bar{height:3px;background:${ELEM_BAR[elem]}}
.body{padding:14px 18px;display:flex;gap:16px;border-bottom:1px solid #22252b}
.body-left{flex:1;min-width:0}
.body-right{flex-shrink:0;text-align:right}
.bp{font-size:22px;font-weight:700;color:#e8eaed;line-height:1}
.bp-l{font-size:10px;color:#6a6e78;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
.rec{font-size:11px;color:#8a8e98;margin-top:6px}
.sb{margin-top:8px;padding-top:8px;border-top:1px solid #22252b}
.sn{font-size:12px;font-weight:600;color:#b0b4bc;display:flex;align-items:center;gap:5px}
.sm{font-size:10px;color:#6a6e78;margin-top:1px}
.grid{padding:14px 18px;display:grid;grid-template-columns:1fr 1fr;gap:10px;border-bottom:1px solid #22252b}
.st{display:flex;align-items:center;gap:6px}
.si{width:14px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.sl{font-size:11px;color:#6a6e78;min-width:24px}
.sl span{display:block;font-size:9px;color:#555960}
.sb2{flex:1;height:4px;background:#262a32;position:relative}
.sf{height:100%;position:absolute;top:0;left:0}
.sv{font-size:12px;color:#9a9ea8;min-width:28px;text-align:right;font-variant-numeric:tabular-nums}
.mds{padding:12px 18px;border-bottom:1px solid #22252b}
.md{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.md:last-child{margin-bottom:0}
.ml{font-size:10px;color:#6a6e78;text-transform:uppercase;min-width:44px}
.mt{flex:1;height:3px;background:#262a32}
.mf{height:100%}
.mv{font-size:10px;color:#8a8e98;min-width:18px;text-align:right}
</style></head><body><div class="card"><div class="elem-bar"></div>
<div class="hd"><div class="hd-icon">${pet.name[0] ?? ""}</div><div class="hd-info"><div class="hd-name">${pet.name}</div><div class="hd-sub"><span style="color:${ELEM_BAR[elem]}">${ELEM_SVG[elem]}</span>${species?.name ?? "?"} · ${elementName(elem)}</div></div><div class="hd-badge">Lv.${pet.level}</div></div>
<div class="body"><div class="body-left"><div class="sb"><div class="sn"><span style="color:${ELEM_BAR[elem]}">${ICONS.sword}</span>${skill?.name ?? "普通攻击"}</div><div class="sm">威力 ${skill?.power ?? 10} · 冷却 ${skill?.cooldown ?? 0}回合${species ? " · " + elementName(species.element) : ""}</div></div><div class="rec">PVE ${pet.pveWins}胜 · PVP ${pet.wins}胜${pet.losses}负</div></div><div class="body-right"><div class="bp">${bp}</div><div class="bp-l">BATTLE POWER</div></div></div>
<div class="grid"><div class="st"><span class="si" style="color:#e85d3a">${ICONS.sword}</span><span class="sl">力<span>POWER</span></span><div class="sb2"><div class="sf" style="width:${Math.min(100,pet.stats.power)}%;background:#e85d3a"></div></div><span class="sv">${pet.stats.power}</span></div>
<div class="st"><span class="si" style="color:#4fc3f7">${ICONS.shield}</span><span class="sl">防<span>DEF</span></span><div class="sb2"><div class="sf" style="width:${Math.min(100,pet.stats.defense)}%;background:#4fc3f7"></div></div><span class="sv">${pet.stats.defense}</span></div>
<div class="st"><span class="si" style="color:#ffd54f">${ICONS.bolt}</span><span class="sl">速<span>SPD</span></span><div class="sb2"><div class="sf" style="width:${Math.min(100,pet.stats.speed)}%;background:#ffd54f"></div></div><span class="sv">${pet.stats.speed}</span></div>
<div class="st"><span class="si" style="color:#4ade80">${ICONS.heart}</span><span class="sl">HP<span>${pet.currentHp}/${pet.maxHp}</span></span><div class="sb2"><div class="sf" style="width:${hpPct}%;background:#4ade80"></div></div><span class="sv">${hpPct}%</span></div></div>
<div class="mds">${moodBar("饱食", pet.mood.hunger, "#ffd54f")}${moodBar("心情", pet.mood.happiness, "#4fc3f7")}${moodBar("清洁", pet.mood.cleanliness, "#4ade80")}</div>
<div class="ft"><span>${prefix}pet-hunt</span><span>${prefix}pet-battle</span><span>${prefix}pet-feed</span><span>${prefix}pet-play</span></div>
</div></body></html>`;
}

/* ─── $pet-dex card ─── */
export function buildDexCard(data: { seenSpecies: Record<string, string[]>; caughtSpecies: Record<string, string[]> }, userId: string): string {
  const seen = data.seenSpecies[userId] ?? [];
  const caught = data.caughtSpecies[userId] ?? [];
  const total = PET_SPECIES.length;
  const uniqueCaught = new Set(caught.filter((id: string) => PET_SPECIES.some((s: any) => s.id === id))).size;
  const pct = Math.round(uniqueCaught / total * 100);
  const elements: ElementType[] = ["fire", "ice", "electric", "earth", "water", "dark", "wind", "light"];

  const groupsHtml = elements.map(elem => {
    const species = PET_SPECIES.filter((s: any) => s.element === elem);
    if (!species.length) return "";
    const groupCaught = species.filter((s: any) => caught.includes(s.id)).length;
    const anySeen = species.some((s: any) => seen.includes(s.id));
    const hidden = !anySeen && groupCaught === 0;
    const speciesCells = species.map((s: any) => {
      const isCaught = caught.includes(s.id), isSeen = seen.includes(s.id);
      const dot = isCaught ? "\u25C6" : isSeen ? "\u25C7" : "\u00B7";
      const dotColor = isCaught ? "#4ade80" : isSeen ? "#666" : "#333";
      return `<div class="cell" data-c="${isCaught}" data-s="${isSeen}"><span class="sdot" style="color:${dotColor}">${dot}</span><span class="sname ${s.rarity}">${s.name.length > 5 ? s.name.slice(0,5)+"\u2026": s.name}</span></div>`;
    }).join("");
    const elemIcon = `<span style="color:${ELEM_BAR[elem]};display:inline-flex">${ELEM_SVG[elem]}</span>`;
    const h = hidden
      ? `<div class="ghead">${elemIcon}<span class="glabel">${elementName(elem)}</span><span class="glock">--</span></div>`
      : `<div class="ghead">${elemIcon}<span class="glabel">${elementName(elem)}</span><span class="gcount">${groupCaught}/${species.length}</span></div>`;
    return `<div class="group${hidden?" locked":""}">${h}<div class="gcells">${speciesCells}</div></div>`;
  }).join("");

  const completed = elements.filter(e => {
    const sp = PET_SPECIES.filter((s: any) => s.element === e);
    return sp.length > 0 && sp.every((s: any) => caught.includes(s.id));
  }).length;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CARD_CSS}
.hd-bar-wrap{flex:1;height:4px;background:#262a32;position:relative}
.hd-bar{height:100%;width:${pct}%;background:#4ade80;position:absolute;top:0;left:0}
.hd-pct{font-size:12px;color:#888c96;min-width:60px;text-align:right;font-weight:500}
.group{border-bottom:1px solid #1d2026;padding:10px 18px}
.group.locked{opacity:.35}
.ghead{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.glabel{font-size:11px;font-weight:600;color:#9a9ea8;text-transform:uppercase;letter-spacing:.3px}
.gcount{font-size:11px;color:#555960;margin-left:auto}
.glock{font-size:11px;color:#33363e;margin-left:auto}
.gcells{display:grid;grid-template-columns:repeat(3,1fr);gap:1px}
.cell{display:flex;align-items:center;gap:6px;padding:4px 6px;min-width:0;height:24px}
.cell[data-c="false"][data-s="false"]{opacity:.3}
.sdot{font-size:8px;width:10px;text-align:center;flex-shrink:0;line-height:1}
.sname{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b0b4bc}
.sname.common{color:#888c96}.sname.uncommon{color:#6aab4a}.sname.rare{color:#4a9eff}.sname.epic{color:#b06ad9}.sname.legendary{color:#ff9922}
</style></head><body><div class="card"><div class="hd"><span class="hd-title" style="display:flex;align-items:center;gap:6px"><span style="color:#80cbc4">${ICONS.book}</span>COLLECTION</span><div class="hd-bar-wrap"><div class="hd-bar"></div></div><span class="hd-pct">${uniqueCaught}/${total}</span></div>
${groupsHtml}
<div class="ft"><span>${completed} CLASSES DONE</span><span>${pct}%</span></div></div></body></html>`;
}

/* ─── $pet-skills card ─── */
export function buildSkillsCard(pet: PetInstance, species: PetSpecies | undefined): string {
  const elem = species?.element ?? "wind";
  const skill = species?.skill;
  const adv = species ? (TYPE_CHART[species.element] ?? []) : [];
  const weak = species ? (RESIST_CHART[species.element] ?? []) : [];
  const pairs: [string, string][] = [["fire","ice"],["ice","earth"],["earth","electric"],["electric","water"],["water","fire"],["dark","light"]];
  const chartRows = pairs.map(([a,d]) =>
    `<div class="cl"><span style="color:${ELEM_BAR[a]};display:inline-flex">${ELEM_SVG[a]}</span><span class="cl-label">${elementName(a as ElementType)}</span><span class="cl-arrow">\u2192</span><span style="color:${ELEM_BAR[d]};display:inline-flex">${ELEM_SVG[d]}</span><span class="cl-label">${elementName(d as ElementType)}</span><span style="color:#4ade80;font-size:10px;margin-left:auto">\u00D72</span></div>`
  ).join("");
  const advTags = adv.length ? adv.map(e => `<span class="tag" style="color:${ELEM_BAR[e]}">${elementName(e)}</span>`).join(" ") : "<span class=\"dim\">--</span>";
  const weakTags = weak.length ? weak.map(e => `<span class="tag" style="color:${ELEM_BAR[e]}">${elementName(e)}</span>`).join(" ") : "<span class=\"dim\">--</span>";

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CARD_CSS}
.section{padding:12px 18px;border-bottom:1px solid #22252b}
.sec-hd{font-size:10px;font-weight:600;color:#6a6e78;letter-spacing:.5px;margin-bottom:8px;text-transform:uppercase;display:flex;align-items:center;gap:5px}
.si{display:flex;align-items:center;gap:10px;margin-bottom:2px}
.si-name{font-size:14px;font-weight:600;color:#e8eaed}
.si-meta{font-size:11px;color:#8a8e98}
.si-desc{font-size:11px;color:#8a8e98;margin-top:2px}
.chart{display:grid;grid-template-columns:1fr 1fr;gap:3px}
.cl{display:flex;align-items:center;gap:6px;padding:4px 6px;font-size:11px}
.cl-label{color:#b0b4bc}
.cl-arrow{color:#555960;font-size:10px}
.chart-note{font-size:10px;color:#555960;margin-top:6px}
.tp{font-size:11px;color:#9a9ea8;margin-bottom:4px;display:flex;align-items:center;gap:4px}
.tag{font-size:10px;font-weight:600;padding:1px 6px;border:1px solid currentColor}
.dim{color:#555960}
</style></head><body><div class="card"><div class="hd"><span class="hd-title">SKILLS &amp; TYPES</span><span style="font-size:11px;color:#8a8e98;margin-left:auto;display:flex;align-items:center;gap:4px">${ICONS.bolt} ${pet.name}</span></div>
<div class="section"><div class="sec-hd"><span style="color:${ELEM_BAR[elem]}">${ICONS.sword}</span>SKILL</div><div class="si"><span class="si-name">${skill?.name ?? "\u666E\u901A\u653B\u51FB"}</span><span class="si-meta">\u5A01\u529B ${skill?.power ?? 0} \u00B7 \u51B7\u5374 ${skill?.cooldown ?? 0}</span></div><div class="si-desc">${skill?.description ?? ""}${species ? " \u00B7 " + elementName(species.element) : ""}</div></div>
<div class="section"><div class="sec-hd"><span style="color:#80cbc4">${ICONS.book}</span>TYPE CHART</div><div class="chart">${chartRows}</div><div class="chart-note">克制 \u00D72 \u00B7 被抗 \u00D70.5 \u00B7 中立 \u00D71</div></div>
<div class="section"><div class="sec-hd"><span style="color:${ELEM_BAR[elem]}">${ELEM_SVG[elem]}</span>THIS PET</div><div class="tp">属性：<span class="tag" style="color:${ELEM_BAR[elem]}">${elementName(elem)}</span></div><div class="tp">克制：${advTags}</div><div class="tp">被克：${weakTags}</div></div>
<div class="ft"><span>火\u2192冰\u2192土\u2192电\u2192水\u2192火</span><span>暗\u2194光</span></div></div></body></html>`;
}

/* ─── $pet-list card ─── */
export function buildPetListCard(pets: PetInstance[], prefix: string): string {
  const rows = pets.map((p, i) => {
    const s = getSpecies(p.speciesId); const bp = calcBattlePower(p);
    const elem = s?.element ?? "wind";
    return `<div class="pr${i===0?" active":""}"><div class="pr-bar" style="background:${ELEM_BAR[elem]}"></div><div class="pr-inner"><div class="pr-top"><span class="pr-name" style="color:${RARITY_C[s?.rarity??"common"]}">${i===0?"\u25B6 ":""}${p.name}</span><span class="pr-lv">Lv.${p.level}</span><span class="pr-bp">${bp}</span></div><div class="pr-bot"><span class="pr-sub">${s?.name??"?"}</span><span class="pr-rec">${p.pveWins+p.wins}胜${p.losses}负</span></div></div></div>`;
  }).join("");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CARD_CSS}
.pr{display:flex;align-items:stretch;border-bottom:1px solid #1d2026;min-height:44px}.pr.active{background:rgba(255,255,255,.03)}
.pr-bar{width:3px;flex-shrink:0}.pr-inner{flex:1;padding:8px 14px;display:flex;flex-direction:column;justify-content:center;gap:4px;min-width:0}
.pr-top{display:flex;align-items:center;gap:8px}
.pr-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.pr-lv{font-size:10px;color:#6a6e78;padding:1px 5px;border:1px solid #2a2d34;flex-shrink:0}
.pr-bp{font-size:12px;font-weight:600;color:#e8eaed;flex-shrink:0;min-width:30px;text-align:right}
.pr-bot{display:flex;align-items:center;gap:8px}
.pr-sub{font-size:10px;color:#6a6e78}.pr-rec{font-size:10px;color:#555960;margin-left:auto}
</style></head><body><div class="card"><div class="hd"><span class="hd-title" style="display:flex;align-items:center;gap:6px"><span style="color:#80cbc4">${ICONS.list}</span>MY PETS</span><span style="font-size:11px;color:#8a8e98;margin-left:auto">${pets.length} total</span></div>${rows}<div class="ft"><span>\u25B6 active</span><span>${prefix}pet</span><span>${prefix}pet-hunt</span></div></div></body></html>`;
}

/* ─── $pet-rank card ─── */
export function buildRankCard(rankings: [string, PetInstance][], prefix: string): string {
  const rows = rankings.map(([id, p], i) => {
    const s = getSpecies(p.speciesId); const rate = Math.round((p.wins/Math.max(1,p.wins+p.losses))*100);
    const medal = i===0?"1st":i===1?"2nd":i===2?"3rd":`${i+1}th`;
    return `<div class="rr${i<3?" top":""}"><span class="r-rank" style="color:${i===0?"#ffd54f":i===1?"#80cbc4":i===2?"#ffab91":"#555960"}">${medal}</span><span class="r-bar" style="background:${ELEM_BAR[s?.element??"wind"]}"></span><span class="r-name" style="color:${RARITY_C[s?.rarity??"common"]}">${p.name}</span><span class="r-lv">Lv.${p.level}</span><span class="r-rec">${p.wins}W ${p.losses}L</span><span class="r-rate">${rate}%</span></div>`;
  }).join("");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CARD_CSS}
.rr{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid #1d2026;font-size:12px}
.rr.top{background:rgba(255,255,255,.015)}
.r-rank{font-size:10px;font-weight:600;min-width:28px;text-transform:uppercase;letter-spacing:.3px}
.r-bar{width:3px;height:12px;flex-shrink:0}
.r-name{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.r-lv{font-size:10px;color:#6a6e78;min-width:32px}
.r-rec{font-size:10px;color:#8a8e98;min-width:60px;text-align:right}
.r-rate{font-size:11px;font-weight:600;color:#4ade80;min-width:32px;text-align:right}
</style></head><body><div class="card"><div class="hd"><span class="hd-title" style="display:flex;align-items:center;gap:6px"><span style="color:#ffd54f">${ICONS.trophy}</span>RANKINGS</span><span style="font-size:11px;color:#8a8e98;margin-left:auto">win rate</span></div>${rows}<div class="ft"><span>${prefix}pet-battle</span><span>to climb</span></div></div></body></html>`;
}

/* ─── $pet-shop card ─── */
export function buildShopCard(userCoins: number, prefix: string): string {
  const items = [{n:"普通蛋",c:500,d:"普通~稀有"},{n:"高级蛋",c:2000,d:"普通~史诗"},{n:"稀有蛋",c:8000,d:"稀有~传说"},{n:"史诗蛋",c:30000,d:"史诗~传说"},{n:"传说蛋",c:100000,d:"必出传说"}];
  const rows = items.map((item,i) => `<div class="si"><span class="si-id">${i+1}</span><span class="si-icon" style="color:${["#888c96","#6aab4a","#4a9eff","#b06ad9","#ff9922"][i]}">${ICONS.egg}</span><span class="si-name">${item.n}</span><span class="si-desc">${item.d}</span><span class="si-price">${item.c.toLocaleString()}G</span></div>`).join("");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CARD_CSS}
.si{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid #1d2026;font-size:12px}
.si-id{font-size:10px;color:#555960;min-width:16px;text-align:center}
.si-icon{flex-shrink:0;display:flex;align-items:center}
.si-name{font-weight:600;color:#b0b4bc;min-width:48px}
.si-desc{font-size:10px;color:#6a6e78;flex:1}
.si-price{font-weight:600;color:#4ade80;display:flex;align-items:center;gap:3px}
.bal{padding:10px 18px;font-size:12px;color:#8a8e98;border-bottom:1px solid #22252b;display:flex;align-items:center;gap:4px}
.bal span{color:#4ade80;font-weight:600}
</style></head><body><div class="card"><div class="hd"><span class="hd-title" style="display:flex;align-items:center;gap:6px"><span style="color:#ff9922">${ICONS.egg}</span>PET SHOP</span><span style="font-size:11px;color:#8a8e98;margin-left:auto">${prefix}pet-buy N</span></div><div class="bal"><span style="color:#4ade80">${ICONS.coin}</span>BALANCE <span>${userCoins.toLocaleString()}</span> G</div>${rows}<div class="ft"><span>${prefix}pet-hatch</span></div></div></body></html>`;
}

/* ─── $pet-hunt report card ─── */
export function buildBattleReportCard(petName: string, logs: string[], result: "win"|"lose"|"draw", expGain: number, coinGain: number, remain: number, dropItem: string|null): string {
  const logHtml = logs.slice(0,10).map(l => `<div class="bl">${l}</div>`).join("");
  const sc = result==="win"?"#4ade80":result==="lose"?"#e85d3a":"#ffd54f";
  const st = result==="win"?"VICTORY":result==="lose"?"DEFEAT":"DRAW";
  const resultIcon = result==="win"
    ? `<span style="color:#4ade80">${ICONS.star}</span>`
    : result==="lose"
    ? `<span style="color:#e85d3a">${ICONS.shield}</span>`
    : `<span style="color:#ffd54f">${ICONS.sword}</span>`;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CARD_CSS}
.status{padding:16px 18px;text-align:center;border-bottom:1px solid #22252b}
.st-icon{margin-bottom:6px}
.st-l{font-size:20px;font-weight:700;color:${sc};letter-spacing:1px;display:flex;align-items:center;justify-content:center;gap:6px}
.st-s{font-size:11px;color:#6a6e78;margin-top:4px}
.rw{display:flex;border-bottom:1px solid #22252b}
.rw>div{flex:1;padding:10px;text-align:center;border-right:1px solid #22252b}
.rw>div:last-child{border-right:none}
.rv{font-size:16px;font-weight:700;color:#e8eaed;display:flex;align-items:center;justify-content:center;gap:3px}
.rl{font-size:9px;color:#6a6e78;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
.logs{padding:10px 18px}
.bl{font-size:10px;color:#8a8e98;padding:2px 0;line-height:1.6;border-bottom:1px solid #1a1c21}
.bl:last-child{border-bottom:none}
</style></head><body><div class="card"><div class="status"><div class="st-l">${resultIcon}${st}</div><div class="st-s">${petName}</div></div>
<div class="rw"><div><div class="rv">+${expGain}</div><div class="rl">EXP</div></div><div><div class="rv"><span style="color:#4ade80">${ICONS.coin}</span>+${coinGain}</div><div class="rl">GOLD</div></div><div><div class="rv">${remain}</div><div class="rl">HUNTS LEFT</div></div>${dropItem?`<div><div class="rv" style="font-size:12px">${dropItem}</div><div class="rl">ITEM</div></div>`:""}</div>
<div class="logs">${logHtml}</div><div class="ft"><span>${logs.length} turns</span></div></div></body></html>`;
}

/* ─── PVP report card ─── */
export function buildPvPCard(myName: string, targetName: string, logs: string[], winner: string, expGain: number, coinReward: string, myW: number, myL: number): string {
  const logHtml = logs.slice(0,12).map(l => `<div class="bl">${l}</div>`).join("");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CARD_CSS}
.status{padding:14px 18px;text-align:center;border-bottom:1px solid #22252b}
.vs{font-size:13px;color:#8a8e98;margin-bottom:6px}
.vs .a{color:#e8eaed;font-weight:600}
.vs .b{color:#8a8e98;font-weight:600}
.win{font-size:16px;font-weight:700;color:#4ade80;display:flex;align-items:center;justify-content:center;gap:6px}
.exp{font-size:11px;color:#6a6e78;margin-top:4px}
.logs{padding:10px 18px}
.bl{font-size:10px;color:#8a8e98;padding:2px 0;line-height:1.6;border-bottom:1px solid #1a1c21;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bl:last-child{border-bottom:none}
.meta{display:flex;border-top:1px solid #22252b}
.meta>div{flex:1;padding:8px;text-align:center;font-size:10px;color:#6a6e78;display:flex;align-items:center;justify-content:center;gap:3px}
.meta span{color:#9a9ea8;font-weight:600}
</style></head><body><div class="card"><div class="status"><div class="vs"><span class="a">${myName}</span> VS <span class="b">${targetName}</span></div><div class="win"><span style="color:#ffd54f">${ICONS.trophy}</span>${winner} WINS</div><div class="exp">+${expGain} EXP${coinReward?" \u00B7 "+coinReward:""}</div></div>
<div class="logs">${logHtml}</div><div class="meta"><div><span style="color:#80cbc4">${ICONS.sword}</span>RECORD <span>${myW}W ${myL}L</span></div><div><span>${logs.length}</span> turns</div></div></div></body></html>`;
}

/* ─── starter selection card ─── */
export function buildStarterCard(prefix: string): string {
  const starters = STARTER_SPECIES.map(id => getSpecies(id)!).filter(Boolean);
  const cards = starters.map((s, i) => {
    const ec = ELEM_BAR[s.element];
    const statRow = (label: string, val: number, color: string, icon: string) =>
      `<div class="cs-stat"><span class="cs-si" style="color:${color}">${icon}</span><span class="cs-sv">${val}</span><span class="cs-sl">${label}</span></div>`;
    return `<div class="cs">
      <div class="cs-accent" style="background:${ec}"></div>
      <div class="cs-inner">
        <div class="cs-hd"><span class="cs-num" style="background:${ec};color:#111214">${i+1}</span><span class="cs-elem" style="color:${ec}">${ELEM_SVG[s.element]}</span></div>
        <div class="cs-name">${s.name}</div>
        <div class="cs-sub" style="color:${ec}">${elementName(s.element)}系</div>
        <div class="cs-desc">${s.description}</div>
        <div class="cs-divider"></div>
        <div class="cs-skill-hd">${ICONS.sword} <span style="color:#9a9ea8">${s.skill.name}</span></div>
        <div class="cs-skill-m">威力 ${s.skill.power} · 冷却 ${s.skill.cooldown}</div>
        <div class="cs-divider"></div>
        <div class="cs-stats">${statRow("力", s.baseStats.power, "#e85d3a", ICONS.sword)}${statRow("防", s.baseStats.defense, "#4fc3f7", ICONS.shield)}${statRow("速", s.baseStats.speed, "#ffd54f", ICONS.bolt)}${statRow("HP", s.baseStats.hp, "#4ade80", ICONS.heart)}</div>
      </div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CARD_CSS}
.starter-intro{padding:16px 18px 12px;text-align:center}
.starter-title{font-size:18px;font-weight:700;color:#e8eaed;letter-spacing:1px}
.starter-sub{font-size:11px;color:#6a6e78;margin-top:4px}
.cs-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:0 12px 16px}
.cs{background:#1d2026;border:1px solid #2a2d34;overflow:hidden}
.cs-accent{height:3px}
.cs-inner{padding:14px 10px 12px;display:flex;flex-direction:column;align-items:center;gap:6px}
.cs-hd{display:flex;align-items:center;gap:8px;width:100%;justify-content:space-between}
.cs-num{width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700}
.cs-elem{display:flex}
.cs-name{font-size:15px;font-weight:700;color:#e8eaed;letter-spacing:.5px}
.cs-sub{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.cs-desc{font-size:10px;color:#6a6e78;text-align:center;line-height:1.5}
.cs-divider{width:16px;height:1px;background:#2a2d34;margin:2px 0}
.cs-skill-hd{font-size:11px;font-weight:600;color:#b0b4bc;display:flex;align-items:center;gap:4px}
.cs-skill-m{font-size:9px;color:#555960}
.cs-stats{display:grid;grid-template-columns:1fr 1fr;gap:6px;width:100%;margin-top:2px}
.cs-stat{display:flex;align-items:center;gap:4px;font-size:10px}
.cs-si{display:flex;flex-shrink:0}
.cs-sv{color:#e8eaed;font-weight:700;font-variant-numeric:tabular-nums}
.cs-sl{color:#555960;font-size:9px}
.prompt{padding:12px 18px;font-size:11px;color:#555960;text-align:center;border-top:1px solid #22252b}
.prompt b{color:#e8eaed;font-weight:600}
</style></head><body><div class="card">
<div class="starter-intro"><div class="starter-title">CHOOSE YOUR PARTNER</div><div class="starter-sub">选择你的初始伙伴，开始冒险之旅</div></div>
<div class="cs-grid">${cards}</div>
<div class="prompt">发送 <b>${prefix}pet 1</b> / <b>2</b> / <b>3</b> 选择</div>
</div></body></html>`;
}

/* ─── welcome / starter claimed card ─── */
export function buildWelcomeCard(species: PetSpecies, prefix: string): string {
  const ec = ELEM_BAR[species.element];
  const statRow = (label: string, val: number, color: string, icon: string) =>
    `<div class="ws"><span style="color:${color}">${icon}</span><span class="wv">${val}</span><span class="wl">${label}</span></div>`;
  const evoTarget = species.evolvesTo ? getSpecies(species.evolvesTo) : null;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CARD_CSS}
.wh{padding:28px 18px 20px;text-align:center;background:${ec}08;border-bottom:1px solid #22252b}
.wh-badge{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:600;color:#4ade80;padding:3px 10px;border:1px solid #4ade8030;background:#4ade8010;margin-bottom:14px;letter-spacing:.5px;text-transform:uppercase}
.wh-icon{color:${ec};margin-bottom:12px}
.wh-name{font-size:22px;font-weight:700;color:#e8eaed;letter-spacing:1px}
.wh-spec{font-size:12px;color:#8a8e98;margin-top:4px}
.wh-elem{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:${ec};margin-top:8px;padding:2px 10px;border:1px solid ${ec}40;background:${ec}10}
.wb{padding:16px 18px}
.wb-sec{font-size:10px;font-weight:600;color:#555960;letter-spacing:.5px;text-transform:uppercase;margin-bottom:10px}
.wb-skill{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#1d2026;border:1px solid #2a2d34;margin-bottom:12px}
.wb-sicon{color:${ec};flex-shrink:0;display:flex}
.wb-sname{font-size:14px;font-weight:600;color:#e8eaed}
.wb-smeta{font-size:10px;color:#6a6e78;margin-top:2px}
.wb-sdesc{font-size:10px;color:#8a8e98;margin-top:1px}
.wb-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.ws{display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 4px;background:#1d2026;border:1px solid #2a2d34}
.wv{font-size:16px;font-weight:700;color:#e8eaed;font-variant-numeric:tabular-nums}
.wl{font-size:9px;color:#555960}
.w-evo{padding:10px 18px;font-size:11px;color:#6a6e78;border-top:1px solid #22252b;display:flex;align-items:center;gap:6px}
.w-evo span{color:#9a9ea8}
.wf{padding:12px 18px;font-size:11px;color:#555960;text-align:center;border-top:1px solid #22252b;background:#13151a}
.wf b{color:#e8eaed;font-weight:600}
</style></head><body><div class="card">
<div class="wh"><div class="wh-badge">${ICONS.star} WELCOME</div><div class="wh-icon"><svg width="56" height="56" viewBox="0 0 14 14">${ELEM_SVG[species.element].match(/<svg[^>]*>(.*)<\/svg>/)?.[1] ?? ""}</svg></div><div class="wh-name">${species.name}</div><div class="wh-spec">${species.description}</div><div class="wh-elem">${ELEM_SVG[species.element]} ${elementName(species.element)}系</div></div>
<div class="wb"><div class="wb-sec">SKILL</div><div class="wb-skill"><span class="wb-sicon">${ICONS.sword}</span><div><div class="wb-sname">${species.skill.name}</div><div class="wb-smeta">威力 ${species.skill.power} · 冷却 ${species.skill.cooldown} · ${elementName(species.skill.element)}</div><div class="wb-sdesc">${species.skill.description}</div></div></div><div class="wb-sec">BASE STATS</div><div class="wb-stats">${statRow("力量", species.baseStats.power, "#e85d3a", ICONS.sword)}${statRow("防御", species.baseStats.defense, "#4fc3f7", ICONS.shield)}${statRow("速度", species.baseStats.speed, "#ffd54f", ICONS.bolt)}${statRow("HP", species.baseStats.hp, "#4ade80", ICONS.heart)}</div></div>${evoTarget ? `<div class="w-evo">${ICONS.star} <span>Lv.${species.evolvesAt} 进化为 ${evoTarget.name}</span></div>` : ""}<div class="wf">发送 <b>${prefix}pet-name &lt;新名字&gt;</b> 给它起名</div>
</div></body></html>`;
}
