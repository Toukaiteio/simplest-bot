/**
 * 猜动漫人物 - 统计渲染（暗黑手绘风）
 * 个人卡片：六维雷达图 + 进度条
 * 排行榜：表格形式
 */

import type { PlayerStats, RankEntry, RadarDimension } from "./stats.js";

// ===== 六维雷达 SVG 生成 =====

function buildRadarSvg(dimensions: RadarDimension[], size = 220): string {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.38;
  const n = 6;

  // 背景网格环
  let gridLines = "";
  for (let ring = 1; ring <= 4; ring++) {
    const r = (radius / 4) * ring;
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 / n) * i - Math.PI / 2;
      pts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
    }
    const opacity = ring === 4 ? 0.5 : 0.2;
    gridLines += `<polygon points="${pts.join(" ")}" fill="none" stroke="#64748b" stroke-opacity="${opacity}" stroke-width="1"/>`;
  }

  // 轴线
  let axes = "";
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 / n) * i - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    axes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#64748b" stroke-opacity="0.2" stroke-width="1"/>`;
  }

  // 数据多边形
  const dataPts: string[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 / n) * i - Math.PI / 2;
    const r = radius * Math.max(0.08, dimensions[i].value);
    dataPts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
  }
  const polygon = `<polygon points="${dataPts.join(" ")}" fill="#fef08a" fill-opacity="0.2" stroke="#86efac" stroke-width="2.5"/>`;

  // 顶点
  let dots = "";
  for (const pt of dataPts) {
    const [x, y] = pt.split(",");
    dots += `<rect x="${+x - 3}" y="${+y - 3}" width="6" height="6" fill="#fff"/>`;
  }

  // 标签
  let labels = "";
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 / n) * i - Math.PI / 2;
    const lr = radius + 28;
    const lx = cx + lr * Math.cos(angle);
    const ly = cy + lr * Math.sin(angle);
    const anchor = Math.abs(Math.cos(angle)) < 0.3 ? "middle" : Math.cos(angle) > 0 ? "start" : "end";
    labels += `<text x="${lx}" y="${ly - 4}" text-anchor="${anchor}" fill="#e2e8f0" font-size="11" font-weight="700">${dimensions[i].title} ${dimensions[i].display}</text>`;
    labels += `<text x="${lx}" y="${ly + 10}" text-anchor="${anchor}" fill="#94a3b8" font-size="9">${dimensions[i].sub}</text>`;
  }

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${gridLines}${axes}${polygon}${dots}${labels}</svg>`;
}

// ===== 进度条 =====

function buildProgressBar(label: string, valueStr: string, percent: number): string {
  const pct = Math.max(2, Math.min(100, percent));
  return `<div class="pb-row">
    <span class="pb-label">${label}</span>
    <span class="pb-value">${valueStr}</span>
  </div>
  <div class="pb-track"><div class="pb-fill" style="width:${pct}%"></div></div>`;
}

// ===== 个人卡片 =====

export function renderPlayerCard(
  stats: PlayerStats,
  radar: RadarDimension[],
  rank: { global: number; group: number | null },
  groupName?: string,
): string {
  const radarSvg = buildRadarSvg(radar);
  const winRate = stats.gamesPlayed > 0 ? (stats.gamesWon / stats.gamesPlayed * 100).toFixed(1) : "0.0";

  const rankText = rank.group !== null
    ? `全服 #${rank.global} · ${groupName ?? "群内"} #${rank.group}`
    : `全服 #${rank.global}`;

  const bars = [
    buildProgressBar("总场次", `${stats.gamesPlayed}`, Math.min(100, stats.gamesPlayed / 50 * 100)),
    buildProgressBar("胜场", `${stats.gamesWon}`, Math.min(100, stats.gamesWon / 30 * 100)),
    buildProgressBar("总猜测", `${stats.totalGuesses}`, Math.min(100, stats.totalGuesses / 100 * 100)),
    buildProgressBar("最高连胜", `${stats.bestStreak}`, Math.min(100, stats.bestStreak / 10 * 100)),
  ].join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #14161d; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; padding: 16px; }
.card {
  width: 680px; background: #1e212b; border: 2px solid #64748b;
  border-radius: 255px 15px 225px 15px/15px 225px 15px 255px;
  padding: 24px 28px; box-shadow: 3px 3px 0px #090a0f; position: relative; overflow: hidden;
}
.watermark {
  position: absolute; top: 20px; left: 20px; font-size: 72px; font-weight: 900;
  color: rgba(255,255,255,0.03); pointer-events: none; line-height: 1;
}
.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
.player-name { font-size: 22px; font-weight: 900; color: #86efac; }
.rank-badge {
  font-size: 12px; font-weight: 700; color: #fef08a; background: #713f12;
  border: 1px solid #eab308; padding: 3px 10px;
  border-radius: 16px 6px 14px 5px/6px 14px 5px 16px;
}
.body { display: flex; gap: 20px; }
.radar-col { flex-shrink: 0; }
.stats-col { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 10px; }
.pb-row { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; color: #e2e8f0; margin-bottom: 3px; }
.pb-value { color: #86efac; }
.pb-track {
  height: 8px; background: #111319; border: 1px solid #475569;
  border-radius: 16px 6px 14px 5px/6px 14px 5px 16px; margin-bottom: 8px;
}
.pb-fill { height: 100%; background: #fef08a; border-radius: 16px 6px 14px 5px/6px 14px 5px 16px; }
.footer { margin-top: 14px; padding-top: 10px; border-top: 1px dashed #334155; font-size: 11px; color: #64748b; display: flex; justify-content: space-between; }
</style></head><body>
<div class="card">
  <div class="watermark">GUESSR</div>
  <div class="header">
    <div class="player-name">${stats.name || stats.userId}</div>
    <div class="rank-badge">${rankText}</div>
  </div>
  <div class="body">
    <div class="radar-col">${radarSvg}</div>
    <div class="stats-col">${bars}</div>
  </div>
  <div class="footer">
    <span>胜率 ${winRate}% · 当前连胜 ${stats.currentStreak}</span>
    <span>最快 ${stats.fastestWinMs ? (stats.fastestWinMs / 1000).toFixed(1) + "s" : "-"}</span>
  </div>
</div>
</body></html>`;
}

// ===== 排行榜 =====

export function renderLeaderboard(entries: RankEntry[], title: string): string {
  const rows = entries.map((e, i) => {
    const medal = i === 0 ? "1st" : i === 1 ? "2nd" : i === 2 ? "3rd" : `#${i + 1}`;
    const wr = (e.winRate * 100).toFixed(1);
    return `<tr class="${i < 3 ? "top3" : ""}">
      <td class="cell-rank">${medal}</td>
      <td class="cell-name">${e.name}</td>
      <td>${e.gamesWon}</td>
      <td>${e.gamesPlayed}</td>
      <td>${wr}%</td>
      <td>${e.bestStreak}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #14161d; font-family: "Microsoft YaHei", sans-serif; padding: 16px; }
.gc { max-width: 560px; background: #1e212b; border: 2px solid #64748b; border-radius: 255px 15px 225px 15px/15px 225px 15px 255px; padding: 20px; box-shadow: 3px 3px 0px #090a0f; }
h2 { color: #fef08a; font-size: 15px; margin-bottom: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; color: #e2e8f0; }
th { color: #94a3b8; font-weight: 700; padding: 6px 8px; text-align: center; border-bottom: 1px dashed #334155; }
td { padding: 6px 8px; text-align: center; border-bottom: 1px solid #1a1a2e; }
.cell-rank { font-weight: 900; color: #fef08a; }
.cell-name { text-align: left; font-weight: 700; }
tr.top3 td { background: rgba(254,240,138,0.05); }
tr.top3 .cell-rank { color: #86efac; }
</style></head><body>
<div class="gc">
  <h2>${title}</h2>
  <table>
    <thead><tr><th>排名</th><th style="text-align:left">玩家</th><th>胜场</th><th>总场</th><th>胜率</th><th>连胜</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
</body></html>`;
}
