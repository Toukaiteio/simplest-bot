import fs from "node:fs";
import path from "node:path";
import { screenshotHtml } from "../plugins/mmorpg/screenshot.js";

export type DailyReportUserStat = {
  userId: string;
  count: number;
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
    await screenshotHtml(html, imagePath, { width: 1040 });

    return { htmlPath, imagePath };
  }
}

function buildHtml(report: DailyGroupReport): string {
  const topUsersHtml = report.topUsers.length > 0
    ? report.topUsers.map((user, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(user.userId)}</td>
        <td>${user.count}</td>
      </tr>
    `).join("")
    : `
      <tr>
        <td colspan="3">今日暂无足够数据</td>
      </tr>
    `;

  const insightsHtml = report.insights
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(report.dateKey)} 群日报</title>
  <style>
    :root {
      --bg: #f5f2ea;
      --panel: #fffdf9;
      --ink: #1f2937;
      --subtle: #6b7280;
      --line: #e7ded0;
      --accent: #2f6f5e;
      --accent-soft: #dff0e7;
      --warn: #b45309;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px;
      background:
        radial-gradient(circle at top left, rgba(47, 111, 94, 0.12), transparent 30%),
        linear-gradient(180deg, #f8f5ee 0%, #f1ede3 100%);
      font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
      color: var(--ink);
    }
    .sheet {
      width: 960px;
      margin: 0 auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 24px;
      padding: 28px;
      box-shadow: 0 18px 40px rgba(31, 41, 55, 0.08);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
      margin-bottom: 24px;
    }
    .title {
      margin: 0;
      font-size: 34px;
      font-weight: 800;
      letter-spacing: 0.04em;
    }
    .subtitle {
      margin-top: 10px;
      color: var(--subtle);
      font-size: 15px;
      line-height: 1.7;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 10px 14px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 700;
      font-size: 14px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 22px;
    }
    .metric {
      padding: 18px;
      border-radius: 18px;
      border: 1px solid var(--line);
      background: #fffcf7;
    }
    .metric-label {
      color: var(--subtle);
      font-size: 13px;
      margin-bottom: 8px;
    }
    .metric-value {
      font-size: 28px;
      font-weight: 800;
      color: var(--accent);
    }
    .content {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 18px;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      background: #fffefa;
    }
    .panel h2 {
      margin: 0 0 14px 0;
      font-size: 20px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      text-align: left;
    }
    th {
      color: var(--subtle);
      font-weight: 700;
    }
    ul {
      margin: 0;
      padding-left: 20px;
    }
    li {
      margin-bottom: 10px;
      line-height: 1.7;
    }
    .footer {
      margin-top: 18px;
      color: var(--subtle);
      font-size: 12px;
      text-align: right;
    }
    .emphasis {
      color: var(--warn);
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main class="sheet">
    <section class="header">
      <div>
        <h1 class="title">群聊日报</h1>
        <div class="subtitle">
          日期：${escapeHtml(report.dateKey)}<br />
          群号：${escapeHtml(report.groupId)}<br />
          最忙时段：<span class="emphasis">${formatHour(report.busiestHour)}（${report.busiestHourCount} 条）</span>
        </div>
      </div>
      <div class="pill">自动生成</div>
    </section>

    <section class="metrics">
      <article class="metric">
        <div class="metric-label">群消息数</div>
        <div class="metric-value">${report.totalMessages}</div>
      </article>
      <article class="metric">
        <div class="metric-label">活跃人数</div>
        <div class="metric-value">${report.activeUsers}</div>
      </article>
      <article class="metric">
        <div class="metric-label">机器人回复</div>
        <div class="metric-value">${report.botReplies}</div>
      </article>
      <article class="metric">
        <div class="metric-label">平均长度</div>
        <div class="metric-value">${report.averageLength}</div>
      </article>
    </section>

    <section class="content">
      <article class="panel">
        <h2>活跃榜</h2>
        <table>
          <thead>
            <tr>
              <th>排名</th>
              <th>用户</th>
              <th>消息数</th>
            </tr>
          </thead>
          <tbody>${topUsersHtml}</tbody>
        </table>
      </article>

      <article class="panel">
        <h2>今日摘要</h2>
        <ul>${insightsHtml}</ul>
        <div class="subtitle">
          指令调用：${report.commandCount} 次<br />
          @ 互动：${report.mentionCount} 次
        </div>
      </article>
    </section>

    <div class="footer">Simplest Bot Daily Report</div>
  </main>
</body>
</html>`;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00 - ${String(hour).padStart(2, "0")}:59`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
