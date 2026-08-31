import fs from "node:fs";
import path from "node:path";
import { screenshotHtml } from "../plugins/mmorpg/screenshot.js";

export type DailyReportUserStat = {
  userId: string;
  count: number;
};

export type DailyAffinityDeltaEntry = {
  userId: string;
  name: string;
  delta: number;
  current: number;
};

export type DailyAffinityEntry = {
  userId: string;
  name: string;
  value: number;
  percent: number;
};

export type DailyWealthEntry = {
  userId: string;
  name: string;
  coins: number;
};

export type DailyGroupReport = {
  dateKey: string;
  groupId: string;
  totalMessages: number;
  activeUsers: number;
  botReplies: number;
  commandCount: number;
  mentionCount: number;
  averageLength: number;
  busiestHour: number;
  busiestHourCount: number;
  topUsers: DailyReportUserStat[];
  insights: string[];
  affinityDeltaTop?: DailyAffinityDeltaEntry[];
  affinityTop?: DailyAffinityEntry[];
  wealthTop?: DailyWealthEntry[];
  hourBuckets?: number[];
  // Fun newspaper fields
  dailyQuote?: string;
  quoteAuthor?: string;
  weatherText?: string;
  tempText?: string;
  nightOwl?: string;
  memeKing?: string;
  commandMaster?: string;
  editorial?: string;
  ads?: Array<{ tag: string; text: string }>;
};

export class DailyReportRenderer {
  constructor(private readonly baseDir = path.resolve(process.cwd(), "data", "daily-reports")) {}

  async render(report: DailyGroupReport): Promise<{ htmlPath: string; imagePath: string }> {
    const outputDir = path.join(this.baseDir, report.dateKey);
    fs.mkdirSync(outputDir, { recursive: true });

    const htmlPath = path.join(outputDir, `group-${report.groupId}.html`);
    const imagePath = path.join(outputDir, `group-${report.groupId}.png`);
    const html = buildHtml(report);

    fs.writeFileSync(htmlPath, html, "utf-8");
    await screenshotHtml(html, imagePath, { width: 1200 });

    return { htmlPath, imagePath };
  }
}

const ICON: Record<string, string> = {
  messageSquare: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  users: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  cpu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>`,
  type: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
  trendingUp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
  heart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  award: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>`,
  dollarSign: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  activity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  atSign: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></svg>`,
  terminal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  fileText: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
  arrowUp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`,
  arrowDown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
};

type RankingRow = {
  rank: number;
  name: string;
  rightLabel: string;
  rightSub?: string;
};

function renderRankingRows(rows: RankingRow[] | null): string {
  if (!rows || rows.length === 0) {
    return `<div class="rank-empty">暂无数据</div>`;
  }
  return rows
    .map((r) => {
      const rankCls = r.rank <= 3 ? ` rank-top rank-top-${r.rank}` : "";
      const subHtml = r.rightSub ? `<span class="rank-sub">${escapeHtml(r.rightSub)}</span>` : "";
      return `
        <div class="rank-row">
          <span class="rank-no${rankCls}">${r.rank}</span>
          <span class="rank-name">${escapeHtml(r.name)}</span>
          <span class="rank-value">
            <span class="rank-main">${r.rightLabel}</span>
            ${subHtml}
          </span>
        </div>`;
    })
    .join("");
}

function formatCoins(coins: number): string {
  if (coins >= 1_000_000) return (coins / 1_000_000).toFixed(2) + "M";
  if (coins >= 10_000) return (coins / 1000).toFixed(1) + "k";
  return String(coins);
}

function renderHourChart(hourBuckets: number[], busiestHour: number): string {
  const maxHour = Math.max(1, ...hourBuckets);
  return hourBuckets
    .map((count, hour) => {
      const h = Math.max(2, (count / maxHour) * 100);
      const isPeak = hour === busiestHour && count > 0;
      const isMajorHour = hour % 6 === 0;
      return `<div class="bar-col${isPeak ? " peak" : ""}" title="${hour}:00 - ${count}">
        <div class="bar-wrap"><div class="bar" style="height:${h.toFixed(1)}%"></div></div>
        <div class="bar-label${isMajorHour ? " bar-label-major" : ""}">${hour}</div>
      </div>`;
    })
    .join("");
}

export function buildHtml(report: DailyGroupReport): string {
  const hourBuckets = report.hourBuckets ?? Array.from({ length: 24 }, () => 0);

  const activeUsersHtml = renderRankingRows(
    report.topUsers.length > 0
      ? report.topUsers.slice(0, 8).map((u, i) => ({
          rank: i + 1,
          name: u.userId,
          rightLabel: String(u.count),
          rightSub: "条",
        }))
      : null,
  );

  const affinityDeltaHtml = renderRankingRows(
    report.affinityDeltaTop && report.affinityDeltaTop.length > 0
      ? report.affinityDeltaTop.slice(0, 8).map((e, i) => {
          const sign = e.delta > 0 ? "+" : "";
          const trendIcon = e.delta > 0 ? ICON.arrowUp : e.delta < 0 ? ICON.arrowDown : ICON.minus;
          const cls = e.delta > 0 ? "delta-up" : e.delta < 0 ? "delta-down" : "delta-flat";
          const rightLabel =
            '<span class="trend ' + cls + '"><span class="trend-icon">' + trendIcon + '</span>' + sign + e.delta + '</span>';
          return {
            rank: i + 1,
            name: e.name,
            rightLabel,
            rightSub: "当前 " + e.current,
          };
        })
      : null,
  );

  const affinityTopHtml = renderRankingRows(
    report.affinityTop && report.affinityTop.length > 0
      ? report.affinityTop.slice(0, 8).map((e, i) => ({
          rank: i + 1,
          name: e.name,
          rightLabel: e.percent + "%",
          rightSub: String(e.value),
        }))
      : null,
  );

  const wealthHtml = renderRankingRows(
    report.wealthTop && report.wealthTop.length > 0
      ? report.wealthTop.slice(0, 8).map((e, i) => ({
          rank: i + 1,
          name: e.name,
          rightLabel: formatCoins(e.coins),
          rightSub: "金币",
        }))
      : null,
  );

  const hourChart = renderHourChart(hourBuckets, report.busiestHour);
  const insightsHtml = report.insights.map((line) => {
    return '<li><span class="bullet-icon">' + ICON.chevronRight + '</span><span class="bullet-text">' + escapeHtml(line) + '</span></li>';
  }).join("");

  return renderTemplate({
    report,
    activeUsersHtml,
    affinityDeltaHtml,
    affinityTopHtml,
    wealthHtml,
    hourChart,
    insightsHtml,
  });
}

type TemplateInput = {
  report: DailyGroupReport;
  activeUsersHtml: string;
  affinityDeltaHtml: string;
  affinityTopHtml: string;
  wealthHtml: string;
  hourChart: string;
  insightsHtml: string;
};

const STYLE_CSS = `@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@600;900&family=Noto+Sans+SC:wght@500;800&display=swap');

:root {
  --bg: #f5f2eb;       /* Newspaper warm cream */
  --border: #2d2d2d;
  --text: #2d2d2d;
  --text-soft: #555555;
  --text-mute: #888888;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); }
body {
  padding: 32px 24px;
  font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
/* ── sheet ── */
.sheet {
  width: 1160px;
  margin: 0 auto;
  background: #faf8f5;
  border: 2px solid var(--border);
  padding: 36px 40px;
  border-radius: 0;
  box-shadow: none;
}
/* ── masthead ── */
.masthead {
  display: flex;
  flex-direction: column;
  align-items: center;
  border-bottom: 4px double var(--border);
  padding-bottom: 16px;
  margin-bottom: 24px;
}
.masthead-top {
  display: flex;
  justify-content: space-between;
  width: 100%;
  font-size: 10px;
  font-weight: 800;
  border-bottom: 1.5px solid var(--border);
  padding-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-family: "Noto Sans SC", "PingFang SC", sans-serif;
}
.masthead-main {
  padding: 12px 0 6px;
  text-align: center;
  width: 100%;
}
.masthead-main h1 {
  margin: 0;
  font-size: 42px;
  font-weight: 900;
  letter-spacing: 0.18em;
  font-family: "Noto Serif SC", "Georgia", "Times New Roman", serif;
  text-transform: uppercase;
  color: var(--text);
}
.masthead-sub {
  text-align: center;
  font-size: 11px;
  font-style: italic;
  font-weight: 700;
  color: var(--text-soft);
  border-top: 1.5px solid var(--border);
  padding-top: 6px;
  width: 100%;
  letter-spacing: 0.05em;
  font-family: "Noto Sans SC", "PingFang SC", sans-serif;
}

/* ── metrics bar ── */
.metrics-bar {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  border: 2px solid var(--border);
  border-left: none; border-right: none;
  background: transparent;
  padding: 12px 0;
  margin-bottom: 24px;
}
.metric-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-right: 1.5px solid var(--border);
  padding: 0 4px;
}
.metric-item:last-child {
  border-right: none;
}
.metric-icon {
  width: auto; height: auto;
  border: none; background: transparent !important;
  display: flex; align-items: center; justify-content: center;
  color: var(--text) !important;
  box-shadow: none;
  margin-bottom: 4px;
}
.metric-icon svg { width: 15px; height: 15px; stroke: var(--text); stroke-width: 2.2px; }
.metric-content { display: flex; flex-direction: column; align-items: center; }
.metric-val { font-size: 18px; font-weight: 900; line-height: 1.1; color: var(--text); font-family: "Georgia", serif; }
.metric-lbl { font-size: 9px; font-weight: 800; color: var(--text-soft); margin-top: 3px; font-family: "Noto Sans SC", sans-serif; }

/* ── quote banner ── */
.quote-banner {
  border: 1.5px solid var(--border);
  padding: 18px 24px;
  margin-bottom: 24px;
  background: #fdfdfc;
  position: relative;
  text-align: center;
}
.quote-label {
  position: absolute;
  top: -10px;
  left: 20px;
  background: var(--text);
  color: #ffffff;
  font-size: 9px;
  font-weight: 800;
  padding: 2px 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-family: "Noto Sans SC", sans-serif;
}
.quote-text {
  margin: 0;
  font-size: 13.5px;
  font-weight: 800;
  font-family: "Noto Serif SC", "Georgia", serif;
  line-height: 1.6;
  color: var(--text);
}
.quote-author {
  display: block;
  font-size: 10px;
  font-weight: 800;
  color: var(--text-soft);
  margin-top: 8px;
  font-family: "Noto Sans SC", sans-serif;
}

/* ── layout sections ── */
.section-row {
  display: grid;
  gap: 28px;
  padding: 20px 0;
  border-bottom: 1.5px solid var(--border);
}
.column-2 { grid-template-columns: 1.55fr 1fr; }
.column-4 { grid-template-columns: repeat(4, 1fr); border-bottom: none; padding-bottom: 0; }

.sec-col-left {
  border-right: 1.5px solid var(--border);
  padding-right: 28px;
  display: flex;
  flex-direction: column;
}
.sec-col-left .card-section {
  flex: 1;
}
.sec-col-right {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.card-section {
  display: flex;
  flex-direction: column;
}
.sec-header { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; border-bottom: 1.5px solid var(--border); padding-bottom: 6px; }
.sec-title-icon { color: var(--text); display: flex; align-items: center; }
.sec-title-icon svg { width: 15px; height: 15px; stroke: var(--text); stroke-width: 2.5px; }
.sec-header h2 { margin: 0; font-size: 13.5px; font-weight: 900; letter-spacing: 0.05em; font-family: "Noto Serif SC", "Georgia", serif; text-transform: uppercase; color: var(--text); }
.sec-tag { font-size: 9px; font-weight: 800; border: 1px solid var(--border); padding: 1px 6px; margin-left: auto; letter-spacing: 0.05em; border-radius: 0; font-family: "Noto Sans SC", sans-serif; }
.sec-body { flex: 1; display: flex; flex-direction: column; }

/* activity chart with flex stretching */
.chart-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
.bar-grid {
  display: grid;
  grid-template-columns: repeat(24, 1fr);
  gap: 3.5px;
  flex: 1;
  min-height: 105px;
  align-items: end;
  border-bottom: 2px solid var(--border);
  padding-bottom: 2px;
}
.bar-col { display: flex; flex-direction: column; align-items: center; height: 100%; }
.bar-wrap { width: 100%; height: 100%; display: flex; align-items: end; }
.bar { width: 100%; background: #e6e2da; border: 1.5px solid var(--border); border-bottom: none; border-radius: 0; }
.bar-col.peak .bar { background: var(--text); }
.bar-label { font-size: 8px; color: var(--text-soft); margin-top: 5px; font-family: monospace; font-weight: 700; opacity: 0.5; }
.bar-label-major { opacity: 1; }
.bar-col.peak .bar-label { color: var(--text); font-weight: 900; opacity: 1; }

/* ── insights list ── */
.insights-list { margin: 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
.insights-list li {
  color: var(--text);
  font-size: 11.5px;
  padding: 6px 0 8px;
  background: transparent;
  border: none;
  border-bottom: 1.5px dashed var(--border);
  display: flex;
  align-items: flex-start;
  gap: 8px;
  line-height: 1.5;
  font-weight: 700;
  font-family: "Noto Sans SC", sans-serif;
}
.insights-list li:last-child { border-bottom: none; }
.bullet-icon { color: var(--text); display: flex; align-items: center; flex-shrink: 0; margin-top: 2px; }
.bullet-icon svg { width: 11px; height: 11px; stroke-width: 3px; }
.bullet-text { flex: 1; }

/* ── rankings column ── */
.rank-column { border-right: 1.5px solid var(--border); padding-right: 14px; }
.rank-column:last-child { border-right: none; padding-right: 0; }

.rank-list { display: flex; flex-direction: column; gap: 6px; }
.rank-row {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  align-items: center;
  gap: 6px;
  padding: 5px 0;
  border-bottom: 1px dashed #2d2d2d;
}
.rank-row:last-child { border-bottom: none; }
.rank-no {
  width: 18px; height: 18px;
  background: transparent;
  border: 1.5px solid var(--border);
  color: var(--text);
  font-size: 9px;
  font-weight: 800;
  display: flex; align-items: center; justify-content: center;
  border-radius: 0;
  font-family: monospace;
}
.rank-top-1 { background: var(--text) !important; color: #ffffff !important; }
.rank-top-2 { background: #666666 !important; color: #ffffff !important; }
.rank-top-3 { background: #999999 !important; color: #ffffff !important; }
.rank-name {
  color: var(--text);
  font-size: 11px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: "Noto Sans SC", sans-serif;
}
.rank-value { text-align: right; line-height: 1.1; }
.rank-main { font-size: 10.5px; font-weight: 800; }
.rank-sub { display: inline-block; color: var(--text-soft); font-size: 8.5px; margin-left: 2px; font-weight: 700; font-family: "Noto Sans SC", sans-serif; }
.rank-empty { color: var(--text-mute); font-size: 11px; padding: 16px 4px; text-align: center; font-weight: 700; font-family: "Noto Sans SC", sans-serif; }

/* ── trend icons ── */
.trend { display: inline-flex; align-items: center; gap: 2px; font-weight: 900; font-size: 10px; }
.trend-icon { display: flex; align-items: center; }
.trend-icon svg { width: 9px; height: 9px; stroke: currentColor; stroke-width: 3.5px; }
.delta-up { color: #2e7d32; }
.delta-down { color: #c62828; }
.delta-flat { color: #757575; }

/* ── superlatives bar ── */
.superlatives-bar {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}
.sup-item {
  border: 1.5px solid var(--border);
  padding: 10px 14px;
  background: #faf8f5;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  font-weight: 700;
  font-family: "Noto Sans SC", sans-serif;
}
.sup-label {
  background: var(--text);
  color: #ffffff;
  padding: 1px 6px;
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
}
.sup-val {
  color: var(--text);
  font-weight: 800;
}

/* ── editorial text ── */
.editorial-text {
  margin: 0;
  font-size: 11.5px;
  font-weight: 700;
  line-height: 1.6;
  font-family: "Noto Serif SC", "Georgia", serif;
  text-align: justify;
  text-indent: 2em;
  padding: 4px 0 12px;
  border-bottom: 1.5px dashed var(--border);
  margin-bottom: 14px;
}

/* ── classifieds bar ── */
.classifieds-bar {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border-top: 1.5px solid var(--border);
  border-bottom: 1.5px solid var(--border);
  padding: 10px 0;
  margin-top: 24px;
}
.ad-item {
  padding: 0 16px;
  border-right: 1.5px dashed var(--border);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.4;
  font-family: "Noto Sans SC", sans-serif;
}
.ad-item:last-child {
  border-right: none;
}
.ad-tag {
  background: var(--text);
  color: #ffffff;
  padding: 0 4px;
  margin-right: 6px;
  font-size: 9px;
  font-weight: 800;
}
.ad-text {
  color: var(--text-soft);
}

/* ── footer ── */
.footer {
  margin-top: 24px;
  padding: 12px 0 0;
  border-top: 2px solid var(--border);
  display: flex;
  justify-content: space-between;
  color: var(--text-soft);
  font-size: 8.5px;
  font-weight: 800;
  font-family: monospace;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
`;

function metric(icon: string, label: string, value: string, sub: string, index: number): string {
  return (
    '<div class="metric-item"><div class="metric-icon col-' + index + '">' + icon + '</div>' +
    '<div class="metric-content">' +
    '<div class="metric-val">' + escapeHtml(value) + '</div>' +
    '<div class="metric-lbl">' + escapeHtml(label) + ' (' + escapeHtml(sub) + ')</div>' +
    '</div></div>'
  );
}

function card(icon: string, title: string, tag: string, body: string): string {
  return (
    '<article class="card-section">' +
    '<div class="sec-header">' +
    '<span class="sec-title-icon">' + icon + '</span>' +
    '<h2>' + escapeHtml(title) + '</h2>' +
    (tag ? '<span class="sec-tag">' + escapeHtml(tag) + '</span>' : '') +
    '</div>' +
    '<div class="sec-body">' + body + '</div>' +
    '</article>'
  );
}

function renderTemplate(input: TemplateInput): string {
  const { report, activeUsersHtml, affinityDeltaHtml, affinityTopHtml, wealthHtml, hourChart, insightsHtml } = input;
  const parts: string[] = [];
  parts.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" />');
  parts.push('<title>' + escapeHtml(report.dateKey) + ' 群日报</title>');
  parts.push('<style>' + STYLE_CSS + '</style>');
  parts.push('</head><body><main class="sheet">');

  parts.push('<header class="masthead">');
  parts.push('<div class="masthead-top">');
  parts.push('<span>GROUP: ' + escapeHtml(report.groupId) + '</span>');
  parts.push('<span>' + (report.weatherText ? '天气: ' + escapeHtml(report.weatherText) + ' &middot; 气温: ' + escapeHtml(report.tempText || "") : 'SIMPLEST BOT DAILY') + '</span>');
  parts.push('<span>' + escapeHtml(report.dateKey) + '</span>');
  parts.push('</div>');
  parts.push('<div class="masthead-main"><h1>群聊日报</h1></div>');
  parts.push('<div class="masthead-sub">记录群内每日的点滴与快乐 &middot; 自动生成报告</div>');
  parts.push('</header>');

  parts.push('<section class="metrics-bar">');
  parts.push(metric(ICON.messageSquare, '群消息', String(report.totalMessages), '条', 1));
  parts.push(metric(ICON.users, '活跃成员', String(report.activeUsers), '人', 2));
  parts.push(metric(ICON.cpu, '智能回复', String(report.botReplies), '次', 3));
  parts.push(metric(ICON.terminal, '指令调用', String(report.commandCount), '次', 4));
  parts.push(metric(ICON.atSign, '@ 互动', String(report.mentionCount), '次', 5));
  parts.push(metric(ICON.type, '平均长度', String(report.averageLength), '字', 6));
  parts.push('</section>');

  // Quote banner
  if (report.dailyQuote) {
    parts.push('<section class="quote-banner">');
    parts.push('<span class="quote-label">每日金句</span>');
    parts.push('<p class="quote-text">“ ' + escapeHtml(report.dailyQuote) + ' ”</p>');
    parts.push('<span class="quote-author">— ' + escapeHtml(report.quoteAuthor || '编辑部') + '</span>');
    parts.push('</section>');
  }

  // Superlatives banner
  if (report.nightOwl || report.memeKing || report.commandMaster) {
    parts.push('<section class="superlatives-bar">');
    if (report.nightOwl) {
      parts.push('<div class="sup-item"><span class="sup-label">深夜猫头鹰</span><span class="sup-val">' + escapeHtml(report.nightOwl) + '</span></div>');
    }
    if (report.memeKing) {
      parts.push('<div class="sup-item"><span class="sup-label">表情包达人</span><span class="sup-val">' + escapeHtml(report.memeKing) + '</span></div>');
    }
    if (report.commandMaster) {
      parts.push('<div class="sup-item"><span class="sup-label">指令大师</span><span class="sup-val">' + escapeHtml(report.commandMaster) + '</span></div>');
    }
    parts.push('</section>');
  }

  parts.push('<section class="section-row column-2">');
  parts.push('<div class="sec-col-left">');
  parts.push(card(
    ICON.clock,
    '24h 活跃度趋势',
    '峰值 ' + formatHour(report.busiestHour) + ' · ' + report.busiestHourCount + ' 条',
    '<div class="chart-wrap"><div class="bar-grid">' + hourChart + '</div></div>',
  ));
  parts.push('</div>');
  parts.push('<div class="sec-col-right">');
  if (report.editorial) {
    parts.push(card(ICON.activity, '今日社论', 'Editorial', '<p class="editorial-text">' + escapeHtml(report.editorial) + '</p>'));
  }
  parts.push(card(ICON.fileText, '今日摘要', 'Insights', '<ul class="insights-list">' + insightsHtml + '</ul>'));
  parts.push('</div>');
  parts.push('</section>');

  parts.push('<section class="section-row column-4">');
  
  parts.push('<div class="rank-column">');
  parts.push(card(ICON.trendingUp, '活跃榜', 'Top 8', '<div class="rank-list">' + activeUsersHtml + '</div>'));
  parts.push('</div>');
  
  parts.push('<div class="rank-column">');
  parts.push(card(ICON.heart, '好感涨幅', 'Δ Top 8', '<div class="rank-list">' + affinityDeltaHtml + '</div>'));
  parts.push('</div>');
  
  parts.push('<div class="rank-column">');
  parts.push(card(ICON.award, '好感总榜', 'AI 累计', '<div class="rank-list">' + affinityTopHtml + '</div>'));
  parts.push('</div>');
  
  parts.push('<div class="rank-column">');
  parts.push(card(ICON.dollarSign, '富翁榜', 'Coins', '<div class="rank-list">' + wealthHtml + '</div>'));
  parts.push('</div>');
  
  parts.push('</section>');

  // Classified Ads
  parts.push('<section class="classifieds-bar">');
  if (report.ads && report.ads.length > 0) {
    for (const ad of report.ads) {
      parts.push('<div class="ad-item">');
      parts.push('<span class="ad-tag">' + escapeHtml(ad.tag) + '</span>');
      parts.push('<span class="ad-text">' + escapeHtml(ad.text) + '</span>');
      parts.push('</div>');
    }
  } else {
    parts.push('<div class="ad-item">');
    parts.push('<span class="ad-tag">广告租借</span>');
    parts.push('<span class="ad-text">发送 $rent-ad [标签] [内容] 即可花费 100 金币租借明日日报广告位！</span>');
    parts.push('</div>');
    parts.push('<div class="ad-item">');
    parts.push('<span class="ad-tag">如何自定义</span>');
    parts.push('<span class="ad-text">标签最多 4 字，内容最多 30 字。可写寻人启事、表白或特惠广告。</span>');
    parts.push('</div>');
    parts.push('<div class="ad-item">');
    parts.push('<span class="ad-tag">广告说明</span>');
    parts.push('<span class="ad-text">租借广告按日计价，展示与今日数据统计日报同步发布。</span>');
    parts.push('</div>');
  }
  parts.push('</section>');

  parts.push('<div class="footer">');
  parts.push('<span>SIMPLEST BOT DAILY REPORT &middot; ALL RIGHTS RESERVED</span>');
  parts.push('<span>VOL. ' + escapeHtml(report.groupId) + '</span>');
  parts.push('</div>');

  parts.push('</main></body></html>');
  return parts.join('');
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
