/**
 * 猜动漫人物 - HTML 渲染（暗黑手绘风）
 * 参考: anime_character_guesser_redesign.html
 */

import type { GuessRecord, Game, FeedbackLevel, GenderFeedback } from "./types.js";

// ===== 反馈 → CSS class =====

function tileClass(level: FeedbackLevel): string {
  switch (level) {
    case "=": return "tile-correct";
    case "+": case "-": return "tile-close";
    default: return "tile-wrong";
  }
}

function genderTileClass(g: GenderFeedback): string {
  if (g === "yes") return "tile-correct";
  if (g === "unknown") return "tile-close";
  return "tile-wrong";
}

function genderSymbol(gender: string | null): string {
  if (gender === "male") return "♂";
  if (gender === "female") return "♀";
  return "?";
}

function arrow(level: FeedbackLevel): string {
  if (level === "+" || level === "++") return " ↓";
  if (level === "-" || level === "--") return " ↑";
  return "";
}

// ===== 单行渲染 =====

function renderRow(record: GuessRecord, index: number): string {
  const { character: c, feedback: f } = record;

  // 作品名：取第一个出演作品，判断是否共享
  const primaryWork = c.appearances[0];
  const workName = primaryWork ? (primaryWork.nameCn || primaryWork.name) : "";
  const workShared = f.sharedWorks.length > 0 &&
    f.sharedWorks.some((w) => primaryWork && (w === primaryWork.nameCn || w === primaryWork.name));
  const workCls = workShared ? "work-tag-correct" : "work-tag-wrong";

  // 声优
  const vaDisplay = c.voiceActors[0] ?? "-";
  const vaCls = f.sharedVoiceActors.length > 0 ? "tile-correct" : "tile-wrong";

  // 制作公司
  const studioDisplay = primaryWork?.studio ?? "-";
  const studioCls = f.sharedStudios.length > 0 ? "tile-correct" : "tile-wrong";

  // 标签（作品标签优先，共享高亮）
  const WORK_TAGS = new Set(["TV", "剧场版", "OVA", "OAD", "WEB", "原创", "漫画改", "小说改", "游戏改", "动画改", "科幻", "奇幻", "校园", "恋爱", "日常", "冒险", "战斗", "悬疑", "推理", "运动", "音乐", "后宫", "穿越", "机战", "搞笑", "治愈", "致郁", "热血", "催泪"]);
  const sortedTags = [...(c.tags || [])].sort((a, b) => {
    const aw = WORK_TAGS.has(a) ? 0 : 1;
    const bw = WORK_TAGS.has(b) ? 0 : 1;
    return aw - bw;
  }).slice(0, 12);
  const tagsHtml = sortedTags.map((tag) => {
    const shared = f.sharedTags.includes(tag);
    return `<span class="hand-tag ${shared ? "hand-tag-correct" : "hand-tag-wrong"}"># ${tag}</span>`;
  }).join("");

  // 头像
  const avatarHtml = c.image
    ? `<img src="${c.image}" class="avatar" onerror="this.style.display='none'" />`
    : `<div class="avatar avatar-placeholder"></div>`;

  return `<div class="table-grid p-row hand-box paper-card">
    <div class="cell-seq">#${index + 1}</div>
    <div class="cell-char">
      ${avatarHtml}
      <div class="char-info">
        <div class="char-name">${c.nameCn ?? c.name}</div>
        <span class="work-tag ${workCls}">${workName}</span>
      </div>
    </div>
    <div class="grid-cell hand-box-sm ${genderTileClass(f.gender)}">${genderSymbol(c.gender)}</div>
    <div class="grid-cell hand-box-sm ${tileClass(f.popularity)}">${c.popularity}${arrow(f.popularity)}</div>
    <div class="grid-cell hand-box-sm ${tileClass(f.worksCount)}">${c.worksCount}${arrow(f.worksCount)}</div>
    <div class="grid-cell hand-box-sm ${tileClass(f.highestRating)}">${c.highestRating ?? "-"}${arrow(f.highestRating)}</div>
    <div class="grid-cell hand-box-sm ${tileClass(f.latestYear)}">${c.latestYear ?? "-"}${arrow(f.latestYear)}</div>
    <div class="grid-cell hand-box-sm ${tileClass(f.earliestYear)}">${c.earliestYear ?? "-"}${arrow(f.earliestYear)}</div>
    <div class="grid-cell hand-box-sm ${vaCls}">${vaDisplay}</div>
    <div class="grid-cell hand-box-sm ${studioCls}">${studioDisplay}</div>
    <div class="cell-tags">${tagsHtml}</div>
  </div>`;
}

// ===== 完整游戏画面（仅渲染当前用户） =====

export function renderGameHtml(game: Game, viewerUserId: string): string {
  const player = game.players.get(viewerUserId);
  if (!player) return "<html><body><p>未加入游戏</p></body></html>";

  const records = player.guesses; // 时间顺序，新猜测在底部
  const rowsHtml = records.map((r, i) => renderRow(r, i)).join("\n");

  const remaining = player.maxAttempts - records.length;
  const statusText = player.won
    ? "已猜中"
    : player.finished
      ? "次数耗尽"
      : `剩余 ${remaining} 次`;

  const roundText = game.state === "ended"
    ? `第 ${game.round} 局已结束`
    : `第 ${game.round} 局 · ${statusText}`;

  const answerReveal = game.state === "ended" && game.answer
    ? `<span class="answer-text">答案: ${game.answer.nameCn ?? game.answer.name}</span>`
    : "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background-color: #14161d;
  color: #e2e8f0;
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
  padding: 16px;
  width: fit-content;
}
.gc { margin: 0 auto; }
.hand-box {
  border: 2px solid #64748b;
  border-radius: 255px 15px 225px 15px/15px 225px 15px 255px;
}
.hand-box-sm {
  border: 1.5px solid #475569;
  border-radius: 16px 6px 14px 5px/6px 14px 5px 16px;
}
.tile-correct { background-color: #14532d; color: #86efac; border-color: #22c55e !important; }
.tile-close { background-color: #713f12; color: #fef08a; border-color: #eab308 !important; }
.tile-wrong { background-color: #1e293b; color: #64748b; border-color: #334155 !important; }
.table-grid {
  display: grid;
  grid-template-columns: 38px 175px 44px 72px 52px 56px 60px 60px 90px 100px auto;
  gap: 6px;
  align-items: center;
}
.p-row { padding: 8px 10px; margin-bottom: 8px; }
.paper-card { background: #1e212b; box-shadow: 3px 3px 0px #090a0f; }
.cell-seq { text-align: center; font-weight: 700; color: #94a3b8; font-size: 14px; }
.cell-char { display: flex; align-items: center; gap: 8px; overflow: hidden; }
.avatar {
  width: 38px; height: 38px; object-fit: cover; object-position: center top; flex-shrink: 0;
  border: 1.5px solid #475569; background: #334155;
  border-radius: 16px 6px 14px 5px/6px 14px 5px 16px;
}
.avatar-placeholder { display: block; }
.char-info { overflow: hidden; }
.char-name { font-weight: 800; font-size: 14px; color: #f1f5f9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.work-tag {
  display: inline-block; padding: 1px 6px; font-size: 11px; font-weight: 700; margin-top: 2px;
  border: 1px solid #475569; border-radius: 10px 3px 8px 4px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px;
}
.work-tag-correct { background-color: #14532d; color: #86efac; border-color: #22c55e; }
.work-tag-wrong { background-color: #1e293b; color: #94a3b8; border-color: #475569; }
.grid-cell {
  display: flex; align-items: center; justify-content: center;
  padding: 5px 3px; font-size: 13px; font-weight: 700; text-align: center;
  min-height: 36px; box-shadow: 2px 2px 0px #090a0f;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cell-tags { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding-left: 4px; max-width: 400px; }
.hand-tag {
  border: 1px solid #475569; padding: 2px 6px; font-size: 11px; font-weight: 700;
  border-radius: 10px 3px 8px 4px; background: #111319; color: #94a3b8;
  box-shadow: 1px 1px 0px #000;
}
.hand-tag-correct { background: #14532d; color: #86efac; border-color: #22c55e; }
.hand-tag-wrong { background: #1e293b; color: #64748b; border-color: #334155; }
.header-grid {
  display: grid;
  grid-template-columns: 38px 175px 44px 72px 52px 56px 60px 60px 90px 100px auto;
  gap: 6px; padding: 4px 10px 8px; font-size: 12px; font-weight: 700;
  color: #94a3b8; text-align: center; border-bottom: 1px dashed #334155; margin-bottom: 10px;
}
.header-grid div:nth-child(2) { text-align: left; padding-left: 46px; }
.header-grid div:last-child { text-align: left; padding-left: 4px; }
.legend {
  display: flex; align-items: center; gap: 16px; padding-top: 10px; margin-top: 6px;
  font-size: 11px; font-weight: 700; color: #94a3b8;
  border-top: 1px dashed #334155; flex-wrap: wrap;
}
.legend-swatch { width: 14px; height: 14px; display: inline-block; border: 1.5px solid #475569; border-radius: 4px 2px 3px 2px; vertical-align: middle; margin-right: 4px; }
.round-info { margin-left: auto; color: #64748b; }
.answer-text { color: #fbbf24; font-weight: 800; }
</style></head><body>
<div class="gc">
  <div class="header-grid">
    <div>序号</div><div>角色</div><div>性别</div><div>热度</div><div>作品</div>
    <div>评分</div><div>晚</div><div>早</div><div>声优</div><div>公司</div><div>标签</div>
  </div>
  ${rowsHtml}
  <div class="legend">
    <span><span class="legend-swatch tile-correct"></span>一致</span>
    <span><span class="legend-swatch tile-close"></span>接近</span>
    <span><span class="legend-swatch tile-wrong"></span>不匹配</span>
    <span>↑ 目标更大 / ↓ 目标更小</span>
    <span class="round-info">${roundText} ${answerReveal}</span>
  </div>
</div>
</body></html>`;
}

// ===== 等待大厅 =====

export function renderLobbyHtml(game: Game): string {
  const players = [...game.players.values()];
  const listHtml = players.map((p, i) =>
    `<div class="lobby-player">${i + 1}. ${p.name}</div>`
  ).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #14161d; color: #e2e8f0; font-family: "Microsoft YaHei", sans-serif; padding: 20px; }
.gc { background: #1e212b; border: 2px solid #64748b; border-radius: 255px 15px 225px 15px/15px 225px 15px 255px; padding: 24px; max-width: 380px; margin: 0 auto; text-align: center; box-shadow: 3px 3px 0px #090a0f; }
h2 { color: #e94560; margin-bottom: 14px; font-size: 16px; }
.lobby-player { color: #e0e0e0; padding: 5px 0; font-size: 13px; border-bottom: 1px dashed #334155; }
.info { color: #94a3b8; font-size: 12px; margin-top: 14px; line-height: 1.8; }
.cmd { color: #a0c4ff; font-family: monospace; font-weight: 700; }
</style></head><body>
<div class="gc">
  <h2>等待大厅</h2>
  ${listHtml}
  <div class="info">
    <p>${players.length} 人 · 每人 ${players[0]?.maxAttempts ?? 7} 次</p>
    <p>房主: <span class="cmd">$guessr start</span></p>
    <p>加入: <span class="cmd">$guessr join</span></p>
  </div>
</div>
</body></html>`;
}

// ===== 搜索结果 =====

export function renderSearchResults(query: string, results: { name: string; nameCn: string | null; matchedField: string; popularity: number }[], total: number): string {
  const rows = results.map((r, i) =>
    `<tr><td class="idx">${i + 1}</td><td class="nm">${r.nameCn ?? r.name}</td><td class="sub">${r.name}</td><td class="tag">${r.matchedField}</td><td class="pop">${r.popularity}</td></tr>`
  ).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #14161d; font-family: "Microsoft YaHei", sans-serif; padding: 14px; }
.gc { max-width: 520px; background: #1e212b; border: 2px solid #64748b; border-radius: 255px 15px 225px 15px/15px 225px 15px 255px; padding: 16px; box-shadow: 3px 3px 0px #090a0f; }
h3 { color: #fef08a; font-size: 13px; margin-bottom: 10px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; color: #e2e8f0; }
th { color: #94a3b8; font-size: 11px; padding: 4px 6px; text-align: left; border-bottom: 1px dashed #334155; }
td { padding: 5px 6px; border-bottom: 1px solid #1a1a2e; }
.idx { color: #fef08a; font-weight: 700; width: 24px; }
.nm { font-weight: 700; }
.sub { color: #94a3b8; font-size: 11px; }
.tag { color: #86efac; font-size: 10px; }
.pop { color: #64748b; text-align: right; }
.footer { margin-top: 8px; font-size: 11px; color: #64748b; }
</style></head><body>
<div class="gc">
  <h3>搜索「${query}」- ${total} 个结果</h3>
  <table><thead><tr><th>#</th><th>角色</th><th>原文</th><th>匹配</th><th>热度</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div class="footer">使用 $guessr guess &lt;角色名&gt; 进行猜测</div>
</div>
</body></html>`;
}

export function renderWorkCharacters(workName: string, characters: { name: string; nameCn: string | null; popularity: number }[]): string {
  const rows = characters
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 20)
    .map((c, i) =>
      `<tr><td class="idx">${i + 1}</td><td class="nm">${c.nameCn ?? c.name}</td><td class="sub">${c.name}</td><td class="pop">${c.popularity}</td></tr>`
    ).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #14161d; font-family: "Microsoft YaHei", sans-serif; padding: 14px; }
.gc { max-width: 460px; background: #1e212b; border: 2px solid #64748b; border-radius: 255px 15px 225px 15px/15px 225px 15px 255px; padding: 16px; box-shadow: 3px 3px 0px #090a0f; }
h3 { color: #fef08a; font-size: 13px; margin-bottom: 10px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; color: #e2e8f0; }
th { color: #94a3b8; font-size: 11px; padding: 4px 6px; text-align: left; border-bottom: 1px dashed #334155; }
td { padding: 5px 6px; border-bottom: 1px solid #1a1a2e; }
.idx { color: #fef08a; font-weight: 700; width: 24px; }
.nm { font-weight: 700; }
.sub { color: #94a3b8; font-size: 11px; }
.pop { color: #64748b; text-align: right; }
.footer { margin-top: 8px; font-size: 11px; color: #64748b; }
</style></head><body>
<div class="gc">
  <h3>${workName} - 角色列表 (${characters.length})</h3>
  <table><thead><tr><th>#</th><th>角色</th><th>原文</th><th>热度</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div class="footer">使用 $guessr guess &lt;角色名&gt; 进行猜测</div>
</div>
</body></html>`;
}

// ===== 通用信息卡片 =====

export function renderInfoCard(title: string, lines: string[]): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  const body = lines.map((line) => `<div class="line">${escape(line)}</div>`).join("");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #14161d; font-family: "Microsoft YaHei", sans-serif; padding: 14px; }
.gc { max-width: 420px; background: #1e212b; border: 2px solid #64748b; border-radius: 255px 15px 225px 15px/15px 225px 15px 255px; padding: 18px 20px; box-shadow: 3px 3px 0px #090a0f; }
h3 { color: #fef08a; font-size: 14px; margin-bottom: 10px; }
.line { color: #e2e8f0; font-size: 12px; padding: 3px 0; line-height: 1.6; }
</style></head><body>
<div class="gc"><h3>${escape(title)}</h3>${body}</div>
</body></html>`;
}

// ===== 选择菜单 =====

export function renderSelectMenu(query: string, options: { label: string; sub: string }[]): string {
  const rows = options.map((o, i) =>
    `<tr><td class="idx">${i + 1}</td><td class="nm">${o.label}</td><td class="sub">${o.sub}</td></tr>`
  ).join("");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #14161d; font-family: "Microsoft YaHei", sans-serif; padding: 14px; }
.gc { max-width: 400px; background: #1e212b; border: 2px solid #64748b; border-radius: 255px 15px 225px 15px/15px 225px 15px 255px; padding: 16px; box-shadow: 3px 3px 0px #090a0f; }
h3 { color: #fef08a; font-size: 13px; margin-bottom: 10px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; color: #e2e8f0; }
td { padding: 6px 8px; border-bottom: 1px solid #1a1a2e; }
.idx { color: #fef08a; font-weight: 900; width: 24px; }
.nm { font-weight: 700; }
.sub { color: #94a3b8; font-size: 11px; }
.footer { margin-top: 8px; font-size: 11px; color: #64748b; }
</style></head><body>
<div class="gc">
  <h3>「${query}」匹配到多个角色</h3>
  <table><tbody>${rows}</tbody></table>
  <div class="footer">发送 $guessr guess &lt;序号&gt; 选择</div>
</div>
</body></html>`;
}

// ===== 帮助卡片 =====

export function renderHelpCard(maxAttempts: number): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #14161d; font-family: "Microsoft YaHei", sans-serif; padding: 14px; }
.gc { max-width: 440px; background: #1e212b; border: 2px solid #64748b; border-radius: 255px 15px 225px 15px/15px 225px 15px 255px; padding: 18px 20px; box-shadow: 3px 3px 0px #090a0f; }
h3 { color: #fef08a; font-size: 14px; margin-bottom: 12px; }
.section { margin-bottom: 10px; }
.st { color: #86efac; font-size: 11px; font-weight: 700; margin-bottom: 4px; }
.cr { display: flex; gap: 8px; padding: 2px 0; font-size: 12px; }
.cmd { color: #a0c4ff; font-family: monospace; font-weight: 700; min-width: 150px; }
.desc { color: #94a3b8; }
.legend { margin-top: 12px; padding-top: 8px; border-top: 1px dashed #334155; font-size: 11px; color: #64748b; line-height: 1.8; }
.sw { display: inline-block; width: 12px; height: 12px; border: 1px solid #475569; vertical-align: middle; margin-right: 3px; }
.sw-g { background: #14532d; border-color: #22c55e; }
.sw-y { background: #713f12; border-color: #eab308; }
.sw-x { background: #1e293b; border-color: #334155; }
</style></head><body>
<div class="gc">
  <h3>猜动漫人物 - 帮助</h3>
  <div class="section"><div class="st">游戏</div>
    <div class="cr"><span class="cmd">$guessr</span><span class="desc">创建/加入</span></div>
    <div class="cr"><span class="cmd">$guessr start</span><span class="desc">房主开始</span></div>
    <div class="cr"><span class="cmd">$guessr guess &lt;名字&gt;</span><span class="desc">猜测（拼音/首字母/别名）</span></div>
    <div class="cr"><span class="cmd">$guessr board</span><span class="desc">查看面板</span></div>
    <div class="cr"><span class="cmd">$guessr end</span><span class="desc">房主结束</span></div>
  </div>
  <div class="section"><div class="st">查询</div>
    <div class="cr"><span class="cmd">$guessr search &lt;词&gt;</span><span class="desc">搜索角色/作品</span></div>
    <div class="cr"><span class="cmd">$guessr rank</span><span class="desc">全服排行</span></div>
    <div class="cr"><span class="cmd">$guessr rank group</span><span class="desc">群内排行</span></div>
    <div class="cr"><span class="cmd">$guessr me</span><span class="desc">个人数据卡片</span></div>
  </div>
  <div class="section"><div class="st">社区共建</div>
    <div class="cr"><span class="cmd">$guessr contribute quick &lt;作品名&gt;</span><span class="desc">一键从 Bangumi 投稿作品和角色</span></div>
    <div class="cr"><span class="cmd">$guessr contribute help</span><span class="desc">投稿角色或作品资料</span></div>
    <div class="cr"><span class="cmd">$guessr contribute mine</span><span class="desc">查看我的投稿进度</span></div>
  </div>
  <div class="legend">
    每人 ${maxAttempts} 次 · 3 局不猜自动移出<br/>
    <span class="sw sw-g"></span>一致 <span class="sw sw-y"></span>接近 <span class="sw sw-x"></span>不匹配 · ↑大 ↓小
  </div>
</div>
</body></html>`;
}
