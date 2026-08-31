import { screenshotHtml } from "./mmorpg/screenshot.js";

const GH_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0d1117; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; }
.gc {
  background: #0d1117; color: #e6edf3; width: fit-content;
  padding: 0; overflow: hidden;
}

/* ── Header ── */
.gc-hd {
  background: linear-gradient(180deg, #151c24 0%, #0d1117 100%);
  padding: 20px 20px 16px;
  border-bottom: 1px solid #21262d;
  display: flex; align-items: center; gap: 12px;
}
.gc-hd-icon { flex-shrink: 0; }
.gc-hd-text { flex: 1; min-width: 0; }
.gc-hd-title { font-size: 16px; font-weight: 600; color: #e6edf3; }
.gc-hd-sub { font-size: 11px; color: #8b949e; margin-top: 2px; }

/* ── Section ── */
.gc-sec { padding: 12px 20px 8px; }
.gc-sec-hd {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 8px;
}
.gc-sec-hd svg { flex-shrink: 0; }
.gc-sec-title { font-size: 12px; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
.gc-sec-line { flex: 1; height: 1px; background: #21262d; }

/* ── Command items (help) ── */
.gc-cmd { display: flex; align-items: baseline; gap: 8px; padding: 5px 0; font-size: 12px; line-height: 1.4; }
.gc-cmd-code {
  font-family: "SF Mono", "Cascadia Code", "Consolas", monospace;
  font-size: 11px; color: #58a6ff; white-space: nowrap;
  background: rgba(88,166,255,0.08); padding: 1px 6px; border-radius: 4px;
}
.gc-cmd-desc { color: #8b949e; flex: 1; min-width: 0; }
.gc-cmd-tag {
  font-size: 10px; padding: 1px 5px; border-radius: 8px;
  font-weight: 500; flex-shrink: 0;
}
.gc-tag-admin { background: rgba(210,153,34,0.15); color: #d29922; }
.gc-tag-user { background: rgba(63,185,80,0.12); color: #3fb950; }

/* ── Channel items ── */
.gc-ch {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; margin-bottom: 6px;
  background: #151b23; border: 1px solid #21262d; border-radius: 6px;
}
.gc-ch-icon { flex-shrink: 0; width: 32px; height: 32px; background: #1c2128; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
.gc-ch-body { flex: 1; min-width: 0; }
.gc-ch-name { font-size: 12px; font-weight: 600; color: #58a6ff; }
.gc-ch-repo { font-size: 11px; color: #8b949e; margin-top: 1px; }
.gc-ch-owner { font-size: 10px; color: #6e7681; margin-top: 1px; }
.gc-ch-labels { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
.gc-ch-label {
  font-size: 9px; padding: 1px 6px; border-radius: 8px;
  background: rgba(88,166,255,0.12); color: #58a6ff;
  border: 1px solid rgba(88,166,255,0.2);
}

/* ── Issue items ── */
.gc-issue { padding: 8px 12px; border-bottom: 1px solid #21262d; }
.gc-issue:last-child { border-bottom: none; }
.gc-issue-top { display: flex; align-items: flex-start; gap: 6px; }
.gc-issue-icon { flex-shrink: 0; margin-top: 2px; }
.gc-issue-body { flex: 1; min-width: 0; }
.gc-issue-title { font-size: 13px; font-weight: 600; color: #e6edf3; }
.gc-issue-title a { color: inherit; text-decoration: none; }
.gc-issue-title a:hover { color: #58a6ff; }
.gc-issue-meta { font-size: 11px; color: #8b949e; margin-top: 2px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.gc-issue-labels { display: flex; gap: 3px; flex-wrap: wrap; margin-top: 3px; }
.gc-issue-label {
  font-size: 9px; padding: 1px 6px; border-radius: 8px; font-weight: 500;
}

/* ── Pending items ── */
.gc-pending { padding: 8px 12px; border-left: 3px solid; margin-bottom: 6px; background: #151b23; border-radius: 0 6px 6px 0; }
.gc-pending-pending { border-color: #d29922; }
.gc-pending-approved { border-color: #3fb950; }
.gc-pending-rejected { border-color: #f85149; }
.gc-pending-hd { display: flex; align-items: center; gap: 6px; }
.gc-pending-id { font-family: "SF Mono", monospace; font-size: 11px; color: #58a6ff; font-weight: 600; }
.gc-pending-status {
  font-size: 10px; padding: 1px 6px; border-radius: 8px; font-weight: 500;
}
.gc-pending-status-pending { background: rgba(210,153,34,0.15); color: #d29922; }
.gc-pending-status-approved { background: rgba(63,185,80,0.12); color: #3fb950; }
.gc-pending-status-rejected { background: rgba(248,81,73,0.12); color: #f85149; }
.gc-pending-title { font-size: 12px; color: #e6edf3; margin-top: 3px; }
.gc-pending-meta { font-size: 10px; color: #8b949e; margin-top: 2px; }

/* ── Empty state ── */
.gc-empty {
  text-align: center; padding: 24px 20px; color: #8b949e;
}
.gc-empty-icon { margin-bottom: 8px; opacity: 0.4; }
.gc-empty-text { font-size: 13px; }
.gc-empty-hint { font-size: 11px; margin-top: 4px; color: #6e7681; }

/* ── Page nav ── */
.gc-page {
  display: flex; align-items: center; justify-content: center; gap: 4px;
  padding: 10px 20px; border-top: 1px solid #21262d;
}
.gc-page-btn {
  font-size: 11px; padding: 3px 10px; border-radius: 4px;
  background: #21262d; color: #8b949e;
  border: 1px solid #30363d; text-decoration: none;
}
.gc-page-active { background: #1f6feb; color: #fff; border-color: #1f6feb; }
.gc-page-hint { font-size: 11px; color: #6e7681; }

/* ── Footer ── */
.gc-ft {
  padding: 10px 20px; border-top: 1px solid #21262d;
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; color: #6e7681;
}
`;

/* ── SVG helpers ── */

function octocat(): string {
  return `<svg width="32" height="32" viewBox="0 0 16 16" fill="#e6edf3"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
}

function repoIcon(): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="#8b949e"><path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0l1.45 1.087A.25.25 0 009 15.5v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/></svg>`;
}

function issueOpenIcon(): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="#3fb950"><path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/><path fill-rule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/></svg>`;
}

function issueClosedIcon(): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="#8250df"><path d="M11.28 6.78a.75.75 0 00-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l3.5-3.5z"/><path fill-rule="evenodd" d="M16 8A8 8 0 110 8a8 8 0 0116 0zm-1.5 0a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"/></svg>`;
}

function pendingIcon(): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="#d29922"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/><circle cx="8" cy="8" r="3"/></svg>`;
}

function checkIcon(): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="#3fb950"><path fill-rule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>`;
}

function commentIcon(count: number): string {
  if (count === 0) return "";
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="#8b949e"><path fill-rule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z"/></svg> <span style="font-size:11px;color:#8b949e">${count}</span>`;
}

/* ── Build functions ── */

export function wrapHtml(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><style>${GH_CSS}</style></head><body><div class="gc">${bodyHtml}</div></body></html>`;
}

export function buildGhHelpHtml(prefix: string): string {
  return wrapHtml(`
    <div class="gc-hd">
      <div class="gc-hd-icon">${octocat()}</div>
      <div class="gc-hd-text">
        <div class="gc-hd-title">GitHub Issue Manager</div>
        <div class="gc-hd-sub">使用 ${prefix}gh 管理仓库 Issue · 自动从群聊直达 GitHub</div>
      </div>
    </div>

    <div class="gc-sec">
      <div class="gc-sec-hd">
        <div class="gc-sec-title">提交与管理</div>
        <div class="gc-sec-line"></div>
      </div>
      <div class="gc-cmd">
        <span class="gc-cmd-code">${prefix}gh issue &lt;频道&gt; &lt;标题&gt; | &lt;正文&gt;</span>
        <span class="gc-cmd-desc">提交 Issue 请求，等待负责人审批</span>
        <span class="gc-cmd-tag gc-tag-user">ALL</span>
      </div>
      <div class="gc-cmd">
        <span class="gc-cmd-code">${prefix}gh issues &lt;频道&gt; [open|closed|all] [页码]</span>
        <span class="gc-cmd-desc">远程查看仓库的 Issue 列表</span>
        <span class="gc-cmd-tag gc-tag-user">ALL</span>
      </div>
      <div class="gc-cmd">
        <span class="gc-cmd-code">${prefix}gh pending</span>
        <span class="gc-cmd-desc">查看当前群待审批的所有 Issue</span>
        <span class="gc-cmd-tag gc-tag-user">ALL</span>
      </div>
      <div class="gc-cmd">
        <span class="gc-cmd-code">${prefix}gh approve &lt;id&gt;</span>
        <span class="gc-cmd-desc">批准 Issue → 自动创建到 GitHub</span>
        <span class="gc-cmd-tag gc-tag-admin">OWNER</span>
      </div>
      <div class="gc-cmd">
        <span class="gc-cmd-code">${prefix}gh reject &lt;id&gt; [原因]</span>
        <span class="gc-cmd-desc">拒绝 Issue 并通知提交者</span>
        <span class="gc-cmd-tag gc-tag-admin">OWNER</span>
      </div>
      <div class="gc-cmd">
        <span class="gc-cmd-code">${prefix}gh close &lt;id&gt;</span>
        <span class="gc-cmd-desc">关闭 Issue（负责人可关闭任意，提交者可关闭自己）</span>
        <span class="gc-cmd-tag gc-tag-user">OWNER/SELF</span>
      </div>
    </div>

    <div class="gc-sec">
      <div class="gc-sec-hd">
        <div class="gc-sec-title">频道管理</div>
        <div class="gc-sec-line"></div>
      </div>
      <div class="gc-cmd">
        <span class="gc-cmd-code">${prefix}gh channel list</span>
        <span class="gc-cmd-desc">列出群内所有注册频道</span>
        <span class="gc-cmd-tag gc-tag-user">ALL</span>
      </div>
      <div class="gc-cmd">
        <span class="gc-cmd-code">${prefix}gh channel add &lt;名称&gt; &lt;owner/repo&gt; &lt;负责人QQ&gt; [标签]</span>
        <span class="gc-cmd-desc">创建频道→仓库映射</span>
        <span class="gc-cmd-tag gc-tag-admin">ADMIN</span>
      </div>
      <div class="gc-cmd">
        <span class="gc-cmd-code">${prefix}gh channel remove &lt;名称&gt;</span>
        <span class="gc-cmd-desc">删除频道映射</span>
        <span class="gc-cmd-tag gc-tag-admin">ADMIN</span>
      </div>
      <div class="gc-cmd">
        <span class="gc-cmd-code">${prefix}gh track &lt;频道&gt; on|off</span>
        <span class="gc-cmd-desc">开启/关闭 main 分支 commit 动态追踪</span>
        <span class="gc-cmd-tag gc-tag-admin">OWNER/ADMIN</span>
      </div>
    </div>

    <div class="gc-ft">
      ${repoIcon()}
      <span>Issues · Labels · Milestones · <span style="color:#58a6ff">Automate your workflow</span></span>
    </div>
  `);
}

export function buildGhChannelListHtml(
  channels: Array<{ name: string; repo: string; owner: string; labels: string[]; ownerName: string; trackEnabled?: boolean }>,
  prefix: string,
): string {
  let bodyHtml: string;
  if (channels.length === 0) {
    bodyHtml = `
      <div class="gc-hd">
        <div class="gc-hd-icon">${octocat()}</div>
        <div class="gc-hd-text">
          <div class="gc-hd-title">Repository Channels</div>
          <div class="gc-hd-sub">暂无频道 · 管理员可使用 ${prefix}gh channel add 创建</div>
        </div>
      </div>
      <div class="gc-empty">
        <div class="gc-empty-icon">${repoIcon()}</div>
        <div class="gc-empty-text">还没有频道</div>
        <div class="gc-empty-hint">管理员：${prefix}gh channel add &lt;名称&gt; &lt;owner/repo&gt; &lt;负责人QQ&gt; [标签]</div>
      </div>
    `;
  } else {
    const channelItems = channels.map((ch) => {
      const trackBadge = ch.trackEnabled !== false
        ? `<span style="font-size:9px;padding:1px 5px;border-radius:6px;background:rgba(63,185,80,0.12);color:#3fb950;border:1px solid rgba(63,185,80,0.2);margin-top:3px;display:inline-block">track on</span>`
        : `<span style="font-size:9px;padding:1px 5px;border-radius:6px;background:rgba(139,148,158,0.08);color:#6e7681;border:1px solid #30363d;margin-top:3px;display:inline-block">track off</span>`;
      return `
      <div class="gc-ch">
        <div class="gc-ch-icon">${repoIcon()}</div>
        <div class="gc-ch-body">
          <div class="gc-ch-name">${escapeHtml(ch.name)}</div>
          <div class="gc-ch-repo">${escapeHtml(ch.repo)}</div>
          <div class="gc-ch-owner">👤 ${escapeHtml(ch.ownerName)}  ${trackBadge}</div>
          ${ch.labels.length > 0 ? `<div class="gc-ch-labels">${ch.labels.map((l) => `<span class="gc-ch-label">${escapeHtml(l)}</span>`).join("")}</div>` : ""}
        </div>
      </div>
    `;
  }).join("");
    bodyHtml = `
      <div class="gc-hd">
        <div class="gc-hd-icon">${octocat()}</div>
        <div class="gc-hd-text">
          <div class="gc-hd-title">Repository Channels</div>
          <div class="gc-hd-sub">${channels.length} 个频道 · ${prefix}gh issue &lt;频道&gt; &lt;标题&gt; 提交 Issue</div>
        </div>
      </div>
      <div class="gc-sec">
        ${channelItems}
      </div>
    `;
  }
  return wrapHtml(bodyHtml);
}

export function buildGhPendingHtml(
  issues: Array<{ id: number; channel: string; repo: string; title: string; submitterName: string; status: string; createdAt: number }>,
  prefix: string,
): string {
  let bodyHtml: string;
  if (issues.length === 0) {
    bodyHtml = `
      <div class="gc-hd">
        <div class="gc-hd-icon">${checkIcon()}</div>
        <div class="gc-hd-text">
          <div class="gc-hd-title">Pending Reviews</div>
          <div class="gc-hd-sub">没有待审批的 Issue · 一切就绪 ✨</div>
        </div>
      </div>
    `;
  } else {
    const pendingItems = issues.map((issue) => {
      const statusLabel = issue.status === "pending" ? "Pending"
        : issue.status === "approved" ? "Approved"
        : issue.status === "rejected" ? "Rejected"
        : "Closed";
      // closed uses red styling like rejected
      const statusClass = issue.status === "closed" ? "rejected" : issue.status;
      const date = new Date(issue.createdAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
      // Local request ID uses REQ- prefix to avoid confusion with GitHub issue #
      const reqId = `REQ-${issue.id}`;
      // If approved and has a GitHub issue number, show both
      const ghLabel = issue.status === "approved" && (issue as any).githubIssueNumber
        ? `<span style="font-size:10px;color:#3fb950;margin-left:4px">→ GitHub #${(issue as any).githubIssueNumber}</span>`
        : "";
      return `
        <div class="gc-pending gc-pending-${statusClass}">
          <div class="gc-pending-hd">
            <span class="gc-pending-id" style="color:#d29922">${reqId}</span>
            <span class="gc-pending-status gc-pending-status-${statusClass}">${statusLabel}</span>
            ${ghLabel}
            <span style="font-size:10px;color:#6e7681;margin-left:auto">${escapeHtml(issue.repo)}</span>
          </div>
          <div class="gc-pending-title">${escapeHtml(issue.title)}</div>
          <div class="gc-pending-meta">${issue.submitterName === "" ? "" : "by "}${escapeHtml(issue.submitterName)} · ${date}</div>
        </div>
      `;
    }).join("");
    bodyHtml = `
      <div class="gc-hd">
        <div class="gc-hd-icon">${pendingIcon()}</div>
        <div class="gc-hd-text">
          <div class="gc-hd-title">Issue Requests</div>
          <div class="gc-hd-sub">${issues.filter((i) => i.status === "pending").length} 个待审批 · REQ-N = 本地审批编号，GitHub #N = 远端 Issue 编号</div>
        </div>
      </div>
      <div class="gc-sec">
        ${pendingItems}
      </div>
    `;
  }
  return wrapHtml(bodyHtml);
}

export function buildGhIssuesHtml(
  repo: string,
  state: string,
  page: number,
  totalPages: number,
  issues: Array<{
    number: number;
    title: string;
    state: string;
    html_url: string;
    user: { login: string } | null;
    labels: Array<{ name: string; color?: string }>;
    created_at: string;
    comments: number;
  }>,
  channelName: string,
  prefix: string,
): string {
  const stateLabel = state === "open" ? "Open" : state === "closed" ? "Closed" : "All";
  const stateCount = issues.length;

  const tabHtml = `
    <div style="display:flex;gap:2px;margin-top:8px">
      <span style="font-size:11px;padding:3px 10px;border-radius:6px;background:${state === "open" ? "#1f6feb" : "#21262d"};color:${state === "open" ? "#fff" : "#8b949e"};font-weight:500;border:1px solid ${state === "open" ? "#1f6feb" : "#30363d"};display:inline-flex;align-items:center;gap:3px">${issueOpenIcon()} Open</span>
      <span style="font-size:11px;padding:3px 10px;border-radius:6px;background:${state === "closed" ? "#1f6feb" : "#21262d"};color:${state === "closed" ? "#fff" : "#8b949e"};font-weight:500;border:1px solid ${state === "closed" ? "#1f6feb" : "#30363d"};display:flex;align-items:center;gap:3px">${issueClosedIcon()} Closed</span>
    </div>
  `;

  const issueItems = issues.map((issue) => {
    const icon = issue.state === "open" ? issueOpenIcon() : issueClosedIcon();
    const date = new Date(issue.created_at).toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
    const author = issue.user?.login ?? "?";
    const labelHtml = issue.labels.length > 0
      ? `<div class="gc-issue-labels">${issue.labels.map((l) => {
          const bgColor = l.color ? `#${l.color}` : "#30363d";
          const textColor = "e6edf3"; // should ideally be contrasting, but GitHub uses white text
          return `<span class="gc-issue-label" style="background:${bgColor}33;color:${bgColor};border:1px solid ${bgColor}44">${escapeHtml(l.name)}</span>`;
        }).join("")}</div>`
      : "";
    return `
      <div class="gc-issue">
        <div class="gc-issue-top">
          <div class="gc-issue-icon">${icon}</div>
          <div class="gc-issue-body">
            <div class="gc-issue-title"><a href="${escapeHtml(issue.html_url)}">${escapeHtml(issue.title)}</a></div>
            <div class="gc-issue-meta">
              <span>#${issue.number}</span>
              <span>·</span>
              <span>${escapeHtml(author)}</span>
              <span>·</span>
              <span>${date}</span>
              ${issue.comments > 0 ? `<span>·</span>${commentIcon(issue.comments)}` : ""}
            </div>
            ${labelHtml}
          </div>
        </div>
      </div>
    `;
  }).join("");

  const pageNav = totalPages > 1
    ? `<div class="gc-page">
        ${page > 1 ? `<span class="gc-page-btn">← Prev</span>` : ""}
        <span class="gc-page-hint">Page ${page} of ${totalPages}</span>
        ${page < totalPages ? `<span class="gc-page-btn">Next →</span>` : ""}
      </div>`
    : "";

  return wrapHtml(`
    <div class="gc-hd" style="padding-bottom:10px">
      <div class="gc-hd-icon" style="padding-top:2px">${repoIcon()}</div>
      <div class="gc-hd-text">
        <div class="gc-hd-title">${escapeHtml(repo)}</div>
        <div class="gc-hd-sub">${stateLabel} Issues</div>
        ${tabHtml}
      </div>
    </div>
    <div style="border-top:1px solid #21262d">
      ${issueItems}
    </div>
    ${pageNav}
    <div class="gc-ft">
      <span>${prefix}gh issues ${escapeHtml(channelName)} [open|closed|all] [page]</span>
    </div>
  `);
}

/* ── Commit notification card ── */

export function buildGhCommitCardHtml(
  commits: Array<{
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
    author: { login: string; avatar_url: string } | null;
    html_url: string;
  }>,
  repo: string,
  channelName: string,
): string {
  const items = commits.map((c, i) => {
    const shortSha = c.sha.slice(0, 7);
    const date = new Date(c.commit.author.date).toLocaleDateString("zh-CN", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const firstLine = c.commit.message.split("\n")[0];
    const authorName = c.author?.login ?? c.commit.author.name;
    const isLast = i === commits.length - 1;
    return `
      <div style="display:flex;gap:10px;padding:8px 0 ${isLast ? "0" : "0"};${isLast ? "" : "border-bottom:1px solid #21262d"}">
        <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="#8b949e"><path fill-rule="evenodd" d="M1.643 3.143L.427 1.927A.25.25 0 000 2.104V5.75c0 .138.112.25.25.25h3.646a.25.25 0 00.177-.427L2.715 4.215a6.5 6.5 0 11-.683 5.047.75.75 0 00-1.472-.292 8 8 0 10.857-5.822l-.774-.774z"/><path fill-rule="evenodd" d="M7.75 4.5a.75.75 0 01.75.75v2.19l1.78 1.78a.75.75 0 11-1.06 1.06L7.25 8.25A.75.75 0 017 7.5V5.25a.75.75 0 01.75-.75z"/></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;color:#e6edf3;line-height:1.35">${escapeHtml(firstLine)}</div>
          <div style="font-size:10px;color:#8b949e;margin-top:2px">
            <a href="${escapeHtml(c.html_url)}" style="color:#58a6ff;text-decoration:none;font-family:monospace">${shortSha}</a>
            <span> · ${escapeHtml(authorName)}</span>
            <span> · ${date}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");

  return wrapHtml(`
    <div class="gc-hd" style="padding:14px 20px">
      <div class="gc-hd-icon">${octocat()}</div>
      <div class="gc-hd-text">
        <div class="gc-hd-title">New Commits</div>
        <div class="gc-hd-sub">${escapeHtml(repo)} · 频道 ${escapeHtml(channelName)}</div>
      </div>
    </div>
    <div style="padding:4px 20px 12px">
      ${items}
    </div>
    <div class="gc-ft">
      <span>${commits.length} 个新提交推送到 main 分支</span>
    </div>
  `);
}

/* ── Result card ── */

export function buildGhResultHtml(
  type: "success" | "error" | "rejected",
  issue?: { id: number; title: string; channel: string; repo: string; githubUrl?: string; githubIssueNumber?: number; submitterName: string },
  errorMsg?: string,
): string {
  let icon: string;
  let titleText: string;
  let accentColor: string;

  if (type === "success") {
    icon = `<svg width="48" height="48" viewBox="0 0 16 16" fill="#3fb950"><path fill-rule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>`;
    titleText = "Issue 已创建";
    accentColor = "#3fb950";
  } else if (type === "rejected") {
    icon = `<svg width="48" height="48" viewBox="0 0 16 16" fill="#f85149"><path fill-rule="evenodd" d="M4.22 4.22a.75.75 0 011.06 0L8 6.94l2.72-2.72a.75.75 0 111.06 1.06L9.06 8l2.72 2.72a.75.75 0 11-1.06 1.06L8 9.06l-2.72 2.72a.75.75 0 01-1.06-1.06L6.94 8 4.22 5.28a.75.75 0 010-1.06z"/></svg>`;
    titleText = "Issue 已拒绝";
    accentColor = "#f85149";
  } else {
    icon = `<svg width="48" height="48" viewBox="0 0 16 16" fill="#f85149"><path fill-rule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/><circle cx="8" cy="8" r="3"/></svg>`;
    titleText = "操作失败";
    accentColor = "#f85149";
  }

  let bodyHtml: string;

  if (type === "success" && issue) {
    const reqId = `REQ-${issue.id}`;
    bodyHtml = `
      <div style="text-align:center;padding:24px 20px 8px">
        <div style="margin-bottom:12px">${icon}</div>
        <div style="font-size:16px;font-weight:600;color:#e6edf3">${titleText}</div>
        <div style="font-size:11px;color:#8b949e;margin-top:4px">Issue 已自动创建到 GitHub</div>
      </div>
      <div style="padding:0 20px 16px">
        <div style="background:#151b23;border:1px solid #21262d;border-radius:6px;padding:12px">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">
            <span style="font-family:monospace;font-size:11px;color:#d29922;font-weight:600">${reqId}</span>
            ${issue.githubIssueNumber ? `<span style="font-family:monospace;font-size:11px;color:#3fb950;font-weight:600">→ GitHub #${issue.githubIssueNumber}</span>` : ""}
            <span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(63,185,80,0.12);color:#3fb950;font-weight:500">Approved</span>
            <span style="margin-left:auto;font-size:10px;color:#6e7681">${escapeHtml(issue.repo)}</span>
          </div>
          <div style="font-size:13px;font-weight:500;color:#e6edf3">${escapeHtml(issue.title)}</div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid #21262d">
            <div style="font-size:10px;color:#8b949e">由 ${escapeHtml(issue.submitterName)} 提交 · 频道 ${escapeHtml(issue.channel)}</div>
            ${issue.githubUrl ? `<div style="margin-top:4px;font-size:10px;color:#58a6ff;word-break:break-all">${escapeHtml(issue.githubUrl)}</div>` : ""}
          </div>
        </div>
      </div>
    `;
  } else {
    bodyHtml = `
      <div style="text-align:center;padding:32px 20px">
        <div style="margin-bottom:12px">${icon}</div>
        <div style="font-size:16px;font-weight:600;color:#e6edf3">${titleText}</div>
        ${errorMsg ? `<div style="font-size:12px;color:#f85149;margin-top:6px;background:#151b23;border:1px solid #21262d;border-radius:6px;padding:8px 12px;word-break:break-all">${escapeHtml(errorMsg)}</div>` : ""}
      </div>
    `;
  }

  return wrapHtml(bodyHtml);
}

/* ── Image render helpers ── */

export async function renderGhToImage(
  html: string,
  baseDir: string,
): Promise<string> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const outputDir = path.resolve(baseDir, "gh-menus");
  fs.mkdirSync(outputDir, { recursive: true });
  const fileName = `gh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.webp`;
  const imagePath = path.join(outputDir, fileName);
  await screenshotHtml(html, imagePath, { width: 360, format: "webp", quality: 85 });
  return imagePath;
}

/* ── Utilities ── */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}