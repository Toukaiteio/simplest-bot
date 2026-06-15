import type { PendingMenu, MenuGroup, MenuGroupCategory } from "./schema.js";
import type { BattleResult } from "./battle-simulator.js";

/* ── v3 compact CSS (360px, grouped sections, colored bar headers) ── */

const MENU_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #0f1117;
  font-family: "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif;
}
.m { background: #0f1117; color: #c9d1d9; padding: 8px 10px; width: fit-content; }
.hd {
  display: flex; align-items: baseline; gap: 6px;
  padding-bottom: 5px; border-bottom: 1px solid #22272e; margin-bottom: 5px;
}
.hd-t { font-size: 14px; font-weight: 700; color: #e3b341; }
.hd-s { font-size: 10px; color: #555d6b; margin-left: auto; }
.inf {
  font-size: 10px; color: #8b949e; line-height: 1.5;
  padding-bottom: 4px; margin-bottom: 3px;
  border-bottom: 1px solid #1a1f27;
}
.inf b { color: #8b949e; font-weight: 600; }
.gh {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 0 2px; margin-top: 2px;
}
.gh-d { width: 3px; height: 10px; border-radius: 1px; flex-shrink: 0; }
.gh-t { font-size: 10px; font-weight: 600; color: #8b949e; }
.c-mv { background: #3fb950; }
.c-cb { background: #f85149; }
.c-tk { background: #58a6ff; }
.c-ia { background: #bc8cff; }
.c-qu { background: #e3b341; }
.c-sy { background: #484f58; }
.r {
  display: flex; align-items: center; gap: 5px;
  padding: 3px 0 3px 7px;
  font-size: 12px; line-height: 1.3;
}
.n { color: #e3b341; font-weight: 700; font-size: 11px; min-width: 16px; text-align: right; }
.lb { flex: 1; min-width: 0; color: #c9d1d9; }
.ds { font-size: 10px; color: #8b949e; flex-shrink: 0; }
.ft {
  margin-top: 5px; padding-top: 4px;
  border-top: 1px solid #22272e;
  font-size: 10px; color: #6e7681; text-align: center;
}
.sub { font-size: 10px; color: #3d444d; margin-left: 2px; }
.pt { display: block; width: 180px; margin: 6px auto 4px; border-radius: 6px; border: 1px solid #22272e; }
`;

/* ── Profile card CSS (left-right layout, 360px) ── */

const PROFILE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0f1117; font-family: "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif; }
.m { background: #0f1117; color: #c9d1d9; padding: 8px 10px; width: fit-content; }
.pf { display: flex; gap: 10px; align-items: stretch; }
.pf-l { flex-shrink: 0; width: 140px; }
.pf-l img { display: block; width: 140px; border-radius: 6px; border: 1px solid #22272e; object-fit: cover; }
.pf-r { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.hd { display: flex; align-items: baseline; gap: 6px; padding-bottom: 5px; border-bottom: 1px solid #22272e; margin-bottom: 4px; }
.hd-t { font-size: 13px; font-weight: 700; color: #e3b341; }
.hd-s { font-size: 10px; color: #555d6b; margin-left: auto; }
.inf { font-size: 9.5px; color: #8b949e; line-height: 1.55; padding-bottom: 4px; }
.inf b { color: #8b949e; font-weight: 600; }
.st { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 2px 8px; margin-top: 4px; font-size: 9.5px; color: #8b949e; }
.st b { color: #8b949e; font-weight: 600; }
.st-v { color: #c9d1d9; font-weight: 600; }
.mg { display: flex; gap: 0; margin-top: 6px; border-top: 1px solid #1a1f27; padding-top: 4px; }
.mg-c { flex: 1; min-width: 0; }
.mg-c + .mg-c { border-left: 1px solid #1a1f27; padding-left: 8px; }
.gh { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
.gh-d { width: 3px; height: 10px; border-radius: 1px; flex-shrink: 0; }
.gh-t { font-size: 10px; font-weight: 600; color: #8b949e; }
.c-ia { background: #bc8cff; }
.c-qu { background: #e3b341; }
.c-sy { background: #484f58; }
.r { display: flex; align-items: center; gap: 4px; padding: 2.5px 0 2.5px 5px; font-size: 11px; line-height: 1.3; }
.n { color: #e3b341; font-weight: 700; font-size: 10px; min-width: 13px; text-align: right; }
.lb { flex: 1; min-width: 0; color: #c9d1d9; }
.sub { font-size: 10px; color: #3d444d; margin-left: 1px; }
.ft { margin-top: 5px; padding-top: 4px; border-top: 1px solid #22272e; font-size: 10px; color: #6e7681; text-align: center; }
`;

/* ── Category → CSS class mapping ── */

const CAT_CSS: Record<MenuGroupCategory, string> = {
  move: "c-mv", combat: "c-cb", talk: "c-tk",
  interact: "c-ia", quest: "c-qu", system: "c-sy",
};

/* ── Helpers ── */

function esc(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Action types that navigate into a sub-menu → show `›` */
const SUB_MENU_ACTIONS = new Set([
  "open_bag", "open_equip", "open_skills", "open_guild", "open_achievements",
]);

function isSubMenu(actionType: string): boolean {
  return SUB_MENU_ACTIONS.has(actionType);
}

function isBack(actionType: string): boolean {
  return actionType === "back";
}

/* ── Render groups to HTML rows ── */

function renderGroups(groups: MenuGroup[]): string {
  let idx = 0;
  const parts: string[] = [];

  for (const group of groups) {
    // group header
    parts.push(
      `<div class="gh"><span class="gh-d ${CAT_CSS[group.category] ?? "c-sy"}"></span><span class="gh-t">${esc(group.label)}</span></div>`,
    );
    // items
    for (const item of group.items) {
      idx++;
      const desc = item.description ? `<span class="ds">${esc(item.description)}</span>` : "";
      const sub = isSubMenu(item.action.type)
        ? `<span class="sub">\u203A</span>`
        : isBack(item.action.type)
          ? `<span class="sub">\u2039</span>`
          : "";
      parts.push(
        `<div class="r"><span class="n">${idx}</span><span class="lb">${esc(item.label)}</span>${desc}${sub}</div>`,
      );
    }
  }

  return parts.join("\n");
}

/* ── Public API ── */

/**
 * Build a simple grouped menu HTML (e.g. area menu, shop, guild list).
 */
export function buildMenuHtml(menu: PendingMenu): string {
  const rows = renderGroups(menu.groups);
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(menu.title)}</title><style>${MENU_CSS}</style></head>
<body>
<div class="m">
<div class="hd"><span class="hd-t">${esc(menu.title)}</span><span class="hd-s">${esc(menu.context)}</span></div>
${rows}
<div class="ft">$mmo-pick &lt;序号&gt; | $mmo-check &lt;序号&gt; 查看物品属性</div>
</div>
</body></html>`;
}

/**
 * Build a detail menu: header + info line + optional body HTML + grouped action options.
 * Used for area details, NPC dialogs, bag overview, quest journal, etc.
 */
export function buildDetailMenuHtml(opts: {
  title: string;
  context: string;
  details: Array<{ label: string; value: string }>;
  bodyHtml?: string;
  menu: PendingMenu;
}): string {
  const info = opts.details
    .map((d) => `<b>${esc(d.label)}</b> ${esc(d.value)}`)
    .join(" | ");
  const rows = renderGroups(opts.menu.groups);
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(opts.title)}</title><style>${MENU_CSS}</style></head>
<body>
<div class="m">
<div class="hd"><span class="hd-t">${esc(opts.title)}</span><span class="hd-s">${esc(opts.context)}</span></div>
${info ? `<div class="inf">${info}</div>` : ""}
${opts.bodyHtml ?? ""}
${rows}
<div class="ft">$mmo-pick &lt;序号&gt; | $mmo-check &lt;序号&gt; 查看物品属性</div>
</div>
</body></html>`;
}

/* ══════════════════════════════════════════════════════
   Text Card Rendering (generic text → image)
   ══════════════════════════════════════════════════════ */

/* ── SVG Icons for text cards ── */

const ICON_VICTORY = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#3fb950" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
const ICON_DEFEAT = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#f85149" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
const ICON_ITEM = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#e3b341" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;
const ICON_GOLD = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#e3b341" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>`;
const ICON_NAV = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#58a6ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`;
const ICON_INFO = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#58a6ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
const ICON_ACHIEVE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#e3b341" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15l-2 5 2-1 2 1-2-5z"/><circle cx="12" cy="8" r="6"/></svg>`;
const ICON_HP = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#f85149" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
const ICON_WARN = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#f0883e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const ICON_REWARD = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#bc8cff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>`;
const ICON_SKILL = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#3fb950" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
const ICON_QUEST = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#e3b341" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
const ICON_DEFAULT = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#8b949e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;

const TEXT_CARD_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0f1117; font-family: "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif; }
.tc { background: #0f1117; color: #c9d1d9; padding: 0; width: fit-content; min-width: 220px; max-width: 360px; }
.tc-hd {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px;
  background: linear-gradient(135deg, #1a1f27 0%, #161b22 100%);
  border-bottom: 2px solid #e3b341;
}
.tc-hd svg { flex-shrink: 0; }
.tc-t { font-size: 13px; font-weight: 700; color: #e3b341; }
.tc-bd { padding: 8px 12px; font-size: 11px; line-height: 1.7; color: #c9d1d9; }
.tc-line { padding: 2px 0; display: flex; align-items: flex-start; gap: 6px; }
.tc-line svg { flex-shrink: 0; margin-top: 2px; }
.tc-line-val { color: #c9d1d9; }
.tc-line-val b, .tc-line-val strong { color: #e3b341; font-weight: 700; }
.tc-sep { border: none; border-top: 1px solid #1a1f27; margin: 4px 0; }
.tc-section {
  display: flex; align-items: center; gap: 5px;
  padding: 4px 0 2px; margin-top: 4px;
  font-size: 10px; font-weight: 600; color: #8b949e;
  border-bottom: 1px solid #1a1f27;
}
.tc-section svg { flex-shrink: 0; }
.tc-highlight {
  display: flex; align-items: center; gap: 6px;
  background: rgba(227,179,65,0.08);
  border-left: 3px solid #e3b341;
  padding: 5px 8px;
  margin: 4px 0;
  border-radius: 0 4px 4px 0;
  font-size: 12px; font-weight: 600; color: #e3b341;
}
.tc-highlight svg { flex-shrink: 0; }
.tc-success {
  display: flex; align-items: center; gap: 6px;
  background: rgba(63,185,80,0.08);
  border-left: 3px solid #3fb950;
  padding: 5px 8px;
  margin: 4px 0;
  border-radius: 0 4px 4px 0;
  font-size: 12px; font-weight: 600; color: #3fb950;
}
.tc-success svg { flex-shrink: 0; }
.tc-danger {
  display: flex; align-items: center; gap: 6px;
  background: rgba(248,81,73,0.08);
  border-left: 3px solid #f85149;
  padding: 5px 8px;
  margin: 4px 0;
  border-radius: 0 4px 4px 0;
  font-size: 12px; font-weight: 600; color: #f85149;
}
.tc-danger svg { flex-shrink: 0; }
.tc-info {
  display: flex; align-items: center; gap: 6px;
  background: rgba(88,166,255,0.08);
  border-left: 3px solid #58a6ff;
  padding: 5px 8px;
  margin: 4px 0;
  border-radius: 0 4px 4px 0;
  font-size: 11px; color: #58a6ff;
}
.tc-info svg { flex-shrink: 0; }
.tc-reward {
  display: flex; align-items: center; gap: 6px;
  background: rgba(188,140,255,0.08);
  border-left: 3px solid #bc8cff;
  padding: 5px 8px;
  margin: 4px 0;
  border-radius: 0 4px 4px 0;
  font-size: 11px; color: #bc8cff;
}
.tc-reward svg { flex-shrink: 0; }
.tc-warn {
  display: flex; align-items: center; gap: 6px;
  background: rgba(240,136,62,0.08);
  border-left: 3px solid #f0883e;
  padding: 5px 8px;
  margin: 4px 0;
  border-radius: 0 4px 4px 0;
  font-size: 11px; color: #f0883e;
}
.tc-warn svg { flex-shrink: 0; }
.tc-tag {
  display: inline-block;
  font-size: 9px; padding: 1px 5px;
  border-radius: 3px; font-weight: 600; margin-right: 4px;
}
.tc-tag-gold { background: rgba(227,179,65,0.15); color: #e3b341; border: 1px solid rgba(227,179,65,0.3); }
.tc-tag-green { background: rgba(63,185,80,0.15); color: #3fb950; border: 1px solid rgba(63,185,80,0.3); }
.tc-tag-red { background: rgba(248,81,73,0.15); color: #f85149; border: 1px solid rgba(248,81,73,0.3); }
.tc-tag-blue { background: rgba(88,166,255,0.15); color: #58a6ff; border: 1px solid rgba(88,166,255,0.3); }
.tc-tag-purple { background: rgba(188,140,255,0.15); color: #bc8cff; border: 1px solid rgba(188,140,255,0.3); }
.tc-ft {
  padding: 5px 12px;
  border-top: 1px solid #1a1f27;
  font-size: 9px; color: #3d444d; text-align: center;
}
`;

/**
 * Classify a line by its prefix icon/keyword into a visual style with SVG icon.
 */
function classifyLine(line: string): { type: string; icon: string; text: string } {
  const trimmed = line.trim();
  // Victory / success
  if (/^🎉|^🎊|^✨|^💫|^🌟|^🏆/.test(trimmed)) return { type: "highlight", icon: ICON_VICTORY, text: trimmed.replace(/^[🎉🎊✨💫🌟🏆]\s*/, "") };
  if (/^✅|^✓/.test(trimmed)) return { type: "success", icon: ICON_VICTORY, text: trimmed.replace(/^[✅✓]\s*/, "") };
  // Defeat / danger
  if (/^💀|^❌|^⚠️|^❗/.test(trimmed)) return { type: "danger", icon: ICON_DEFEAT, text: trimmed.replace(/^[💀❌⚠️❗]\s*/, "") };
  // Warning
  if (/^⚠/.test(trimmed)) return { type: "warn", icon: ICON_WARN, text: trimmed.replace(/^⚠\s*/, "") };
  // Combat
  if (/^⚔️|^🗡️|^🛡️|^⚔/.test(trimmed)) return { type: "info", icon: ICON_SKILL, text: trimmed.replace(/^[⚔️🗡️🛡️⚔]\s*/, "") };
  // Items / loot
  if (/^📦|^🎁|^🎒/.test(trimmed)) return { type: "reward", icon: ICON_ITEM, text: trimmed.replace(/^[📦🎁🎒]\s*/, "") };
  // Gold
  if (/^💰|^🪙/.test(trimmed)) return { type: "highlight", icon: ICON_GOLD, text: trimmed.replace(/^[💰🪙]\s*/, "") };
  // Navigation / movement
  if (/^🚶|^🎯|^🧭/.test(trimmed)) return { type: "info", icon: ICON_NAV, text: trimmed.replace(/^[🚶🎯🧭]\s*/, "") };
  // HP
  if (/^❤️|^♥/.test(trimmed)) return { type: "danger", icon: ICON_HP, text: trimmed.replace(/^[❤️♥]\s*/, "") };
  // Achievement
  if (/^🏆|^🎖️/.test(trimmed)) return { type: "highlight", icon: ICON_ACHIEVE, text: trimmed.replace(/^[🏆🎖️]\s*/, "") };
  // Quest
  if (/^📜|^📋/.test(trimmed)) return { type: "info", icon: ICON_QUEST, text: trimmed.replace(/^[📜📋]\s*/, "") };
  // Hint / tip
  if (/^💡/.test(trimmed)) return { type: "info", icon: ICON_INFO, text: trimmed.replace(/^💡\s*/, "") };
  // Reward
  if (/^🧪|^📦/.test(trimmed)) return { type: "reward", icon: ICON_REWARD, text: trimmed.replace(/^[🧪📦]\s*/, "") };
  // Section divider
  if (/^──/.test(trimmed)) return { type: "section", icon: "", text: trimmed.replace(/^──\s*/, "").replace(/\s*──$/, "") };
  return { type: "normal", icon: "", text: trimmed };
}

/**
 * Colorize text content by detecting patterns:
 * - label：value  →  label in accent color, value in bright color
 * - (id)  →  dimmer color
 * - numbers → gold
 * - 无/有 → colored
 */
function colorizeText(text: string): string {
  let result = esc(text);
  // Bold markers
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // Parenthetical IDs: (something) → dimmer
  result = result.replace(/\(([^)]+)\)/g, '<span style="color:#484f58">($1)</span>');
  // Label: value pattern
  result = result.replace(/^([^\s：:]+)([：:]\s*)/, '<span style="color:#8b949e;font-weight:600">$1</span><span style="color:#484f58">$2</span>');
  // "无" keyword → muted
  result = result.replace(/\b无\b/g, '<span style="color:#484f58">无</span>');
  // Standalone numbers → gold
  result = result.replace(/(?<![a-zA-Z_\u4e00-\u9fff])(\d+(?:\.\d+)?(?:%|[gG金件回合级步]))/g, '<span style="color:#e3b341;font-weight:600">$1</span>');
  // HP references → red
  result = result.replace(/HP\s*[:：]?\s*/g, '<span style="color:#f85149;font-weight:600">HP</span> ');
  return result;
}

/**
 * Format a single line with appropriate styling and SVG icon.
 */
function formatLine(line: string): string {
  const cls = classifyLine(line);
  const colored = colorizeText(cls.text);
  const iconHtml = cls.icon ? `<span>${cls.icon}</span>` : "";
  switch (cls.type) {
    case "highlight": return `<div class="tc-highlight">${iconHtml}<span>${colored}</span></div>`;
    case "success": return `<div class="tc-success">${iconHtml}<span>${colored}</span></div>`;
    case "danger": return `<div class="tc-danger">${iconHtml}<span>${colored}</span></div>`;
    case "info": return `<div class="tc-info">${iconHtml}<span>${colored}</span></div>`;
    case "reward": return `<div class="tc-reward">${iconHtml}<span>${colored}</span></div>`;
    case "warn": return `<div class="tc-warn">${iconHtml}<span>${colored}</span></div>`;
    case "section": return `<div class="tc-section">${colored}</div>`;
    default: return `<div class="tc-line">${iconHtml ? iconHtml : ""}<span class="tc-line-val">${colored}</span></div>`;
  }
}

/**
 * Detect the appropriate header icon from the title.
 */
function detectTitleIcon(title: string): string {
  if (/胜利|击败|升级|完成/.test(title)) return ICON_VICTORY;
  if (/失败|死亡|落败/.test(title)) return ICON_DEFEAT;
  if (/商店|购买|出售/.test(title)) return ICON_GOLD;
  if (/任务|剧情/.test(title)) return ICON_QUEST;
  if (/属性|状态|信息/.test(title)) return ICON_INFO;
  if (/=/.test(title) || /背包|装备|物品/.test(title)) return ICON_ITEM;
  if (/战斗|伤害|技能/.test(title)) return ICON_SKILL;
  if (/掉落|奖励|获得/.test(title)) return ICON_REWARD;
  if (/移动|前往|路径/.test(title)) return ICON_NAV;
  return ICON_DEFAULT;
}

/**
 * Build a styled text card HTML with visual hierarchy using SVG icons.
 * Supports emoji-to-icon conversion and **bold** text.
 */
export function buildTextCardHtml(title: string, lines: string[]): string {
  const titleIcon = detectTitleIcon(title);
  const bodyHtml = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '<hr class="tc-sep">';
    return formatLine(trimmed);
  }).join("");

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(title)}</title><style>${TEXT_CARD_CSS}</style></head>
<body>
<div class="tc">
<div class="tc-hd"><span>${titleIcon}</span><span class="tc-t">${esc(title)}</span></div>
<div class="tc-bd">${bodyHtml}</div>
</div>
</body></html>`;
}

/* ══════════════════════════════════════════════════════
   Profile Card Rendering (left-right layout)
   ══════════════════════════════════════════════════════ */

/**
 * Build a profile card with left-right layout:
 * - Left: portrait image (optional, 140px)
 * - Right: title + character info + stat grid
 * - Bottom: three-column menu groups
 */
export function buildProfileCardHtml(opts: {
  title: string;
  level: string;
  charInfo: Array<{ label: string; value: string }>;
  stats: Array<{ label: string; value: string }>;
  portraitSrc?: string;
  groups: MenuGroup[];
}): string {
  // Character info lines
  const charLines = opts.charInfo
    .map((d) => `<b>${esc(d.label)}</b> ${esc(d.value)}`)
    .join("<br>");

  // Stat grid cells
  const statCells = opts.stats
    .map((s) => `<span><b>${esc(s.label)}</b> <span class="st-v">${esc(s.value)}</span></span>`)
    .join("");

  // Portrait column
  const portraitHtml = opts.portraitSrc
    ? `<div class="pf-l"><img src="${opts.portraitSrc}" /></div>`
    : "";

  // Three-column menu groups
  let idx = 0;
  const colParts: string[] = [];
  for (const group of opts.groups) {
    const headerHtml = `<div class="gh"><span class="gh-d ${CAT_CSS[group.category] ?? "c-sy"}"></span><span class="gh-t">${esc(group.label)}</span></div>`;
    const itemParts: string[] = [];
    for (const item of group.items) {
      idx++;
      const sub = isSubMenu(item.action.type)
        ? `<span class="sub">\u203A</span>`
        : isBack(item.action.type)
          ? `<span class="sub">\u2039</span>`
          : "";
      itemParts.push(
        `<div class="r"><span class="n">${idx}</span><span class="lb">${esc(item.label)}</span>${sub}</div>`,
      );
    }
    colParts.push(`<div class="mg-c">${headerHtml}${itemParts.join("\n")}</div>`);
  }

  const hasPortrait = !!opts.portraitSrc;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(opts.title)}</title><style>${PROFILE_CSS}</style></head>
<body>
<div class="m">
${hasPortrait ? `<div class="pf">
${portraitHtml}
<div class="pf-r">
<div class="hd"><span class="hd-t">${esc(opts.title)}</span><span class="hd-s">${esc(opts.level)}</span></div>
<div class="inf">${charLines}</div>
<div class="st">${statCells}</div>
</div>
</div>` : `<div class="hd"><span class="hd-t">${esc(opts.title)}</span><span class="hd-s">${esc(opts.level)}</span></div>
<div class="inf">${charLines}</div>
<div class="st">${statCells}</div>`}
<div class="mg">
${colParts.join("\n")}
</div>
<div class="ft">$mmo-pick &lt;序号&gt; | $mmo-check &lt;序号&gt; 查看物品属性</div>
</div>
</body></html>`;
}

/* ══════════════════════════════════════════════════════
   Battle Log Rendering (Victory / Defeat styles)
   ══════════════════════════════════════════════════════ */

const BATTLE_CSS_VICTORY = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0f1117; font-family: "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif; }
.bl { background: #0f1117; color: #c9d1d9; padding: 8px 10px; width: fit-content; }
.hd { display: flex; align-items: baseline; gap: 6px; padding-bottom: 5px; border-bottom: 2px solid #3fb950; margin-bottom: 5px; }
.hd-t { font-size: 14px; font-weight: 700; color: #3fb950; }
.hd-s { font-size: 10px; color: #555d6b; margin-left: auto; }
.inf { font-size: 10px; color: #6e7681; line-height: 1.5; padding-bottom: 4px; margin-bottom: 3px; border-bottom: 1px solid #1a1f27; }
.inf b { color: #8b949e; font-weight: 600; }
.th { display: flex; align-items: center; gap: 4px; padding: 4px 0 2px; margin-top: 3px; }
.th-d { width: 3px; height: 10px; border-radius: 1px; background: #3fb950; flex-shrink: 0; }
.th-t { font-size: 10px; font-weight: 600; color: #6e7681; }
.ev { padding: 2px 0 2px 7px; font-size: 11px; line-height: 1.4; }
.ev-a { color: #58a6ff; }
.ev-m { color: #f85149; }
.ev-d { color: #8b949e; font-size: 10px; margin-left: 4px; }
.ev-dmg { color: #f0883e; font-weight: 600; }
.ev-heal { color: #3fb950; font-weight: 600; }
.hp { font-size: 9px; color: #484f58; padding: 1px 0 0 7px; }
.rw { margin-top: 4px; padding-top: 3px; border-top: 1px solid #22272e; }
.rw-r { font-size: 11px; color: #e3b341; padding: 1px 0; }
.ft { margin-top: 5px; padding-top: 4px; border-top: 1px solid #22272e; font-size: 10px; color: #3d444d; text-align: center; }
`;

const BATTLE_CSS_DEFEAT = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0d0909; font-family: "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif; }
.bl { background: #0d0909; color: #a08080; padding: 8px 10px; width: fit-content; }
.hd { display: flex; align-items: baseline; gap: 6px; padding-bottom: 5px; border-bottom: 2px solid #f85149; margin-bottom: 5px; }
.hd-t { font-size: 14px; font-weight: 700; color: #f85149; }
.hd-s { font-size: 10px; color: #5a4040; margin-left: auto; }
.inf { font-size: 10px; color: #6e5050; line-height: 1.5; padding-bottom: 4px; margin-bottom: 3px; border-bottom: 1px solid #1f1212; }
.inf b { color: #8b6060; font-weight: 600; }
.th { display: flex; align-items: center; gap: 4px; padding: 4px 0 2px; margin-top: 3px; }
.th-d { width: 3px; height: 10px; border-radius: 1px; background: #f85149; flex-shrink: 0; }
.th-t { font-size: 10px; font-weight: 600; color: #6e5050; }
.ev { padding: 2px 0 2px 7px; font-size: 11px; line-height: 1.4; }
.ev-a { color: #8090a0; }
.ev-m { color: #f85149; }
.ev-d { color: #6e5050; font-size: 10px; margin-left: 4px; }
.ev-dmg { color: #d06050; font-weight: 600; }
.ev-heal { color: #60a060; font-weight: 600; }
.hp { font-size: 9px; color: #4a3030; padding: 1px 0 0 7px; }
.rw { margin-top: 4px; padding-top: 3px; border-top: 1px solid #1f1212; }
.rw-r { font-size: 11px; color: #6e5050; padding: 1px 0; }
.ft { margin-top: 5px; padding-top: 4px; border-top: 1px solid #1f1212; font-size: 10px; color: #3a2020; text-align: center; }
`;

function formatDur(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}分${s}秒` : `${m}分钟`;
}

export function buildBattleLogHtml(result: BattleResult): string {
  const css = result.victory ? BATTLE_CSS_VICTORY : BATTLE_CSS_DEFEAT;
  const titleText = result.victory ? "战斗胜利" : "战斗失败";
  const resultTag = result.victory ? "VICTORY" : "DEFEAT";

  // Info line
  const info = [
    `<b>对手</b> ${esc(result.monsterName)} Lv.${result.monsterLevel}`,
    `<b>回合</b> ${result.totalTurns}`,
    `<b>耗时</b> ${formatDur(result.estimatedSeconds)}`,
    `<b>受伤</b> ${result.hpLost}`,
    `<b>剩余HP</b> ${result.playerHpRemaining}`,
  ].join(" | ");

  // Turn sections
  const turnParts: string[] = [];
  for (const turn of result.turns) {
    turnParts.push(`<div class="th"><span class="th-d"></span><span class="th-t">回合 ${turn.turn}</span></div>`);
    for (const ev of turn.events) {
      const isPlayer = ev.actor === result.playerName;
      const actorClass = isPlayer ? "ev-a" : "ev-m";
      const actorLabel = isPlayer ? "你" : esc(result.monsterName);
      let valueHtml = "";
      if (ev.damage !== undefined) {
        valueHtml = `<span class="ev-dmg">-${ev.damage}</span>`;
      } else if (ev.heal !== undefined) {
        valueHtml = `<span class="ev-heal">+${ev.heal}</span>`;
      }
      turnParts.push(
        `<div class="ev"><span class="${actorClass}">${actorLabel}</span> ${esc(ev.label)} ${valueHtml}</div>`,
      );
    }
    turnParts.push(
      `<div class="hp">HP 你 ${turn.playerHpAfter} | ${esc(result.monsterName)} ${turn.monsterHpAfter}</div>`,
    );
  }

  // Rewards section (only victory)
  let rewardsHtml = "";
  if (result.victory) {
    const lines: string[] = [];
    if (result.rewards.exp > 0) lines.push(`<div class="rw-r">经验 +${result.rewards.exp}</div>`);
    if (result.rewards.coins > 0) lines.push(`<div class="rw-r">金币 +${result.rewards.coins}</div>`);
    if (result.lootItemIds.length > 0) lines.push(`<div class="rw-r">掉落 ${result.lootItemIds.length} 件物品</div>`);
    if (result.levelsGained > 0) lines.push(`<div class="rw-r">升级 +${result.levelsGained}</div>`);
    if (lines.length > 0) {
      rewardsHtml = `<div class="rw">${lines.join("")}</div>`;
    }
  }

  const footerText = result.victory
    ? "私聊 $mmo-battle-log 查看记录"
    : "使用 $mmo-recover 拾回掉落金币";

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(titleText)}</title><style>${css}</style></head>
<body>
<div class="bl">
<div class="hd"><span class="hd-t">${esc(titleText)}</span><span class="hd-s">${resultTag}</span></div>
<div class="inf">${info}</div>
${turnParts.join("\n")}
${rewardsHtml}
<div class="ft">${footerText}</div>
</div>
</body></html>`;
}
