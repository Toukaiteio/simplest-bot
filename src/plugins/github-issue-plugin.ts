import type { BotMessage, MenuPlugin, Plugin, PluginContext } from "../types.js";
import { MessageStore } from "../message-store.js";
import fs from "node:fs";
import path from "node:path";
import { buildGhHelpHtml, buildGhChannelListHtml, buildGhPendingHtml, buildGhIssuesHtml, buildGhResultHtml, buildGhCommitCardHtml, renderGhToImage } from "./github-card-renderer.js";

interface OneBotLike {
  sendSegments(
    target: { type: "group" | "private"; id: string },
    segments: Array<{ type: string; data: Record<string, unknown> }>,
  ): Promise<void>;
}

// ── Data types ──────────────────────────────────────────────────────────────

type GhChannel = {
  repo: string;
  owner: string;
  labels: string[];
  description: string;
  trackEnabled?: boolean;
  lastSha?: string;
};

type ChannelStore = {
  channels: Record<string, GhChannel>;
};

type GhPendingIssue = {
  id: number;
  channel: string;
  submitter: string;
  title: string;
  body: string;
  status: "pending" | "approved" | "rejected" | "closed";
  createdAt: number;
  githubIssueNumber?: number;
  githubUrl?: string;
};

type PendingStore = {
  nextId: number;
  issues: GhPendingIssue[];
};

// ── Factory ─────────────────────────────────────────────────────────────────

export function createGithubIssuePlugin(
  menuPlugin: MenuPlugin,
  messageStore: MessageStore,
  onebot: OneBotLike,
  githubToken: string,
): Plugin {
  // ── Persistence helpers ─────────────────────────────────────────────────

  function getChannels(groupId: string): ChannelStore {
    const data = messageStore.getContextState(`gh-ch:${groupId}`) as ChannelStore | null;
    return data ?? { channels: {} };
  }

  function saveChannels(groupId: string, store: ChannelStore): void {
    messageStore.saveContextState(`gh-ch:${groupId}`, store);
  }

  function getPending(groupId: string): PendingStore {
    const data = messageStore.getContextState(`gh-pending:${groupId}`) as PendingStore | null;
    return data ?? { nextId: 1, issues: [] };
  }

  function savePending(groupId: string, store: PendingStore): void {
    messageStore.saveContextState(`gh-pending:${groupId}`, store);
  }

  function displayName(userId: string, groupId?: string): string {
    return messageStore.getLatestKnownDisplayName(userId, groupId) ?? userId;
  }

  // ── GitHub API ──────────────────────────────────────────────────────────

  async function createGithubIssue(
    repo: string,
    title: string,
    body: string,
    labels: string[],
  ): Promise<{ html_url: string }> {
    if (!githubToken) throw new Error("GitHub token 未配置，请联系管理员。");

    const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ title, body, labels }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API 错误 (${response.status}): ${errorText.slice(0, 200)}`);
    }

    return response.json() as Promise<{ html_url: string }>;
  }

  async function closeGithubIssue(repo: string, issueNumber: number): Promise<{ html_url: string }> {
    if (!githubToken) throw new Error("GitHub token 未配置，请联系管理员。");

    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ state: "closed" }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API 错误 (${response.status}): ${errorText.slice(0, 200)}`);
    }

    return response.json() as Promise<{ html_url: string }>;
  }

  async function fetchGithubIssues(
    repo: string,
    state: "open" | "closed" | "all",
    perPage: number,
    page: number,
  ): Promise<{
    issues: Array<{
      number: number;
      title: string;
      state: string;
      html_url: string;
      user: { login: string } | null;
      labels: Array<{ name: string }>;
      created_at: string;
      comments: number;
    }>;
    totalPages: number;
  }> {
    if (!githubToken) throw new Error("GitHub token 未配置，请联系管理员。");

    const params = new URLSearchParams({
      state,
      per_page: String(perPage),
      page: String(page),
      sort: "created",
      direction: "desc",
    });
    const response = await fetch(`https://api.github.com/repos/${repo}/issues?${params}`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API 错误 (${response.status}): ${errorText.slice(0, 200)}`);
    }

    const issues = (await response.json()) as Array<{
      number: number;
      title: string;
      state: string;
      html_url: string;
      user: { login: string } | null;
      labels: Array<{ name: string }>;
      created_at: string;
      comments: number;
    }>;

    // Parse Link header for total pages: <url?page=N>; rel="last"
    let totalPages = page;
    const linkHeader = response.headers.get("link");
    if (linkHeader) {
      const lastMatch = linkHeader.match(/page=(\d+)>;\s*rel="last"/);
      if (lastMatch) totalPages = parseInt(lastMatch[1], 10);
    } else if (issues.length < perPage) {
      // No Link header and fewer results than perPage means this is the only page
      totalPages = page;
    }

    return { issues, totalPages };
  }

  async function fetchLatestCommits(
    repo: string,
    branch: string,
    since?: string,
    perPage = 10,
  ): Promise<Array<{
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
    author: { login: string; avatar_url: string } | null;
    html_url: string;
  }>> {
    if (!githubToken) throw new Error("GitHub token 未配置，请联系管理员。");

    const params = new URLSearchParams({ sha: branch, per_page: String(perPage) });
    if (since) params.set("since", since);
    const response = await fetch(`https://api.github.com/repos/${repo}/commits?${params}`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API 错误 (${response.status}): ${errorText.slice(0, 200)}`);
    }
    return response.json() as Promise<Array<{
      sha: string;
      commit: { message: string; author: { name: string; date: string } };
      author: { login: string; avatar_url: string } | null;
      html_url: string;
    }>>;
  }

  function isChannelOwner(userId: string, channel: GhChannel, ctx: PluginContext): boolean {
    return userId === channel.owner || isAdmin(userId, ctx);
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  // In-memory set of group IDs that have at least one tracked channel
  const trackedGroups = new Set<string>();

  function updateTrackedGroups() {
    trackedGroups.clear();
    for (const key of messageStore.getAllContextStateKeys().filter((k) => k.startsWith("gh-ch:"))) {
      const groupId = key.slice("gh-ch:".length);
      const store = messageStore.getContextState(key) as ChannelStore | null;
      if (store && Object.values(store.channels).some((ch) => ch.trackEnabled)) {
        trackedGroups.add(groupId);
      }
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function startPolling(ctx: PluginContext) {
    if (pollTimer) return;

    async function pollOnce() {
      for (const groupId of trackedGroups) {
        const store = messageStore.getContextState(`gh-ch:${groupId}`) as ChannelStore | null;
        if (!store) continue;

        let changed = false;
        for (const [name, ch] of Object.entries(store.channels)) {
          if (!ch.trackEnabled) continue;

          try {
            const commits = await fetchLatestCommits(ch.repo, "main", ch.lastSha, 5);
            if (commits.length === 0) continue;

            if (ch.lastSha) {
              const newCommits: typeof commits = [];
              for (const c of commits) {
                if (c.sha === ch.lastSha) break;
                newCommits.push(c);
              }
              if (newCommits.length > 0) {
                const html = buildGhCommitCardHtml(newCommits, ch.repo, name);
                const imagePath = await renderGhToImage(html, process.cwd());
                try {
                  await ctx.sendImage({ type: "group", id: groupId }, imagePath, `📦 ${ch.repo} 新提交`);
                } finally {
                  fs.unlink(imagePath, () => {});
                }
              }
            }
            ch.lastSha = commits[0].sha;
            changed = true;
          } catch {
            // Silently skip on error (network, rate limit, etc.)
          }
        }
        if (changed) {
          messageStore.saveContextState(`gh-ch:${groupId}`, store);
        }
      }
    }

    pollOnce();
    pollTimer = setInterval(pollOnce, 120_000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ── Plugin ──────────────────────────────────────────────────────────────

  const plugin: Plugin = {
    name: "github-issue",
    description: "GitHub Issue 管理：创建频道映射仓库，用户提交 issue 请求，负责人审批后自动创建。自动追踪 main 分支 commit 动态并在群组通知。",

    onLoad(ctx: PluginContext) {
      menuPlugin.registerCommandGroup("gh", "GitHub Issue", "频道管理、Issue 提交与审批");
      // ── $gh channel add|remove|list ───────────────────────────────────
      menuPlugin.registerCommand(
        "gh",
        `GitHub Issue 管理：${menuPlugin.getPrefix()}gh channel add/remove/list | ${menuPlugin.getPrefix()}gh issue <频道> <标题> | <正文> | ${menuPlugin.getPrefix()}gh issues <频道> [open|closed|all] | ${menuPlugin.getPrefix()}gh pending | ${menuPlugin.getPrefix()}gh approve/reject/close <id> | ${menuPlugin.getPrefix()}gh track <频道> on|off`,
        async (message, args) => {
          if (!message.groupId) {
            await ctx.replyText(message, "此命令仅支持群聊使用。");
            return;
          }
          const groupId = message.groupId;
          const sub = args[0]?.toLowerCase();

          // ── channel sub-command ─────────────────────────────────────
          if (sub === "channel") {
            const action = args[1]?.toLowerCase();
            const store = getChannels(groupId);

            if (action === "add") {
              if (!message.userId || !isAdmin(message.userId, ctx)) {
                await ctx.replyText(message, "仅管理员可以创建频道。");
                return;
              }
              const name = args[2];
              const repo = args[3];
              const owner = args[4];
              const labelsRaw = args[5] ?? "";
              if (!name || !repo || !owner) {
                await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}gh channel add <频道名> <owner/repo> <负责人QQ> [标签1,标签2]`);
                return;
              }
              if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
                await ctx.replyText(message, "仓库格式错误，请使用 owner/repo 格式。");
                return;
              }
              const labels = labelsRaw ? labelsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
              store.channels[name.toLowerCase()] = {
                repo,
                owner,
                labels,
                trackEnabled: true,
                description: `${repo} (${displayName(owner, groupId)} 负责)`,
              };
              saveChannels(groupId, store);
              updateTrackedGroups();
              await ctx.replyText(message, `频道 ${name} 已创建，映射到 ${repo}，负责人 ${displayName(owner, groupId)}。\ncommit 动态追踪已自动开启（${menuPlugin.getPrefix()}gh track ${name} off 可关闭）。`);
              return;
            }

            if (action === "remove") {
              if (!message.userId || !isAdmin(message.userId, ctx)) {
                await ctx.replyText(message, "仅管理员可以删除频道。");
                return;
              }
              const name = args[2]?.toLowerCase();
              if (!name || !store.channels[name]) {
                await ctx.replyText(message, "频道不存在。");
                return;
              }
              delete store.channels[name];
              saveChannels(groupId, store);
              updateTrackedGroups();
              await ctx.replyText(message, `频道 ${name} 已删除。`);
              return;
            }

            // list (default)
            const entries = Object.entries(store.channels);
            const target = message.type === "group" ? { type: "group" as const, id: message.groupId! } : { type: "private" as const, id: message.userId! };
            const channels = entries.map(([name, ch]) => ({
              name, repo: ch.repo, owner: ch.owner, labels: ch.labels,
              ownerName: displayName(ch.owner, groupId),
              trackEnabled: ch.trackEnabled ?? true,
            }));
            const html = buildGhChannelListHtml(channels, menuPlugin.getPrefix());
            const imagePath = await renderGhToImage(html, process.cwd());
            await ctx.sendImage(target, imagePath);
            fs.unlink(imagePath, () => {});
            return;
          }

          // ── track sub-command ────────────────────────────────────────
          if (sub === "track") {
            const channelName = args[1]?.toLowerCase();
            const action = args[2]?.toLowerCase();
            if (!channelName || !action || (action !== "on" && action !== "off")) {
              await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}gh track <频道名> on|off`);
              return;
            }
            const store = getChannels(groupId);
            const channel = store.channels[channelName];
            if (!channel) {
              await ctx.replyText(message, `频道 ${channelName} 不存在。`);
              return;
            }
            if (!message.userId || !isChannelOwner(message.userId, channel, ctx)) {
              await ctx.replyText(message, "只有频道负责人或管理员可以控制追踪。");
              return;
            }
            channel.trackEnabled = action === "on";
            saveChannels(groupId, store);
            updateTrackedGroups();
            await ctx.replyText(message, `频道 ${channelName} 的 commit 动态追踪已${action === "on" ? "开启" : "关闭"}。`);
            return;
          }

          // ── issue sub-command ───────────────────────────────────────
          if (sub === "issue") {
            if (!message.userId) return;
            const channelName = args[1]?.toLowerCase();
            const restText = args.slice(2).join(" ");

            if (!channelName || !restText) {
              await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}gh issue <频道名> <标题> | <正文>\n正文可选，用 | 分隔标题和正文。`);
              return;
            }

            const store = getChannels(groupId);
            const channel = store.channels[channelName];
            if (!channel) {
              await ctx.replyText(message, `频道 ${channelName} 不存在。使用 ${menuPlugin.getPrefix()}gh channel list 查看可用频道。`);
              return;
            }

            const [title, ...bodyParts] = restText.split("|");
            const trimmedTitle = title.trim();
            const body = bodyParts.join("|").trim();
            if (!trimmedTitle) {
              await ctx.replyText(message, "标题不能为空。");
              return;
            }

            const pending = getPending(groupId);
            const issue: GhPendingIssue = {
              id: pending.nextId++,
              channel: channelName,
              submitter: message.userId,
              title: trimmedTitle,
              body,
              status: "pending",
              createdAt: Date.now(),
            };
            pending.issues.push(issue);
            savePending(groupId, pending);

            const submitterName = displayName(message.userId, groupId);
            const reqId = formatLocalId(issue.id);
            const lines = [
              `[GitHub Issue] ${reqId} 待审批`,
              `频道: ${channelName} | 提交者: ${submitterName}`,
              `标题: ${trimmedTitle}`,
            ];
            if (body) lines.push(`正文: ${body}`);
            lines.push("", `回复 ${menuPlugin.getPrefix()}gh approve ${reqId} 批准 | ${menuPlugin.getPrefix()}gh reject ${reqId} 拒绝`);

            await onebot.sendSegments(
              { type: "group", id: groupId },
              [
                { type: "at", data: { qq: channel.owner } },
                { type: "text", data: { text: " " + lines.join("\n") } },
              ],
            );

            await ctx.replyText(message, `Issue 请求 ${reqId} 已提交，等待负责人审批。本地审批编号为 ${reqId}，与 GitHub issue 编号不同。`);
            return;
          }

          // ── pending sub-command ─────────────────────────────────────
          if (sub === "pending") {
            const pending = getPending(groupId);
            const target = message.type === "group" ? { type: "group" as const, id: message.groupId! } : { type: "private" as const, id: message.userId! };
            const issues = pending.issues.map((issue) => {
              const ch = getChannels(groupId).channels[issue.channel];
              return {
                id: issue.id,
                channel: issue.channel,
                repo: ch?.repo ?? "?",
                title: issue.title,
                submitterName: displayName(issue.submitter, groupId),
                status: issue.status,
                createdAt: issue.createdAt,
              };
            });
            const html = buildGhPendingHtml(issues, menuPlugin.getPrefix());
            const imagePath = await renderGhToImage(html, process.cwd());
            await ctx.sendImage(target, imagePath);
            fs.unlink(imagePath, () => {});
            return;
          }

          // ── approve sub-command ─────────────────────────────────────
          if (sub === "approve") {
            const id = parseLocalIssueId(args[1] ?? "");
            if (isNaN(id)) {
              await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}gh approve <REQ-N 或 N>`);
              return;
            }

            const pending = getPending(groupId);
            const issue = pending.issues.find((i) => i.id === id);
            if (!issue) {
              await ctx.replyText(message, "未找到该 issue。");
              return;
            }

            const store = getChannels(groupId);
            const channel = store.channels[issue.channel];
            if (!channel) {
              await ctx.replyText(message, "该 issue 对应的频道已不存在。");
              return;
            }
            if (!message.userId || !isChannelOwner(message.userId, channel, ctx)) {
              await ctx.replyText(message, "只有频道负责人才能审批。");
              return;
            }
            if (issue.status !== "pending") {
              await ctx.replyText(message, `该 issue 已被${issue.status === "approved" ? "批准" : "拒绝"}。`);
              return;
            }

            const target = message.type === "group" ? { type: "group" as const, id: message.groupId! } : { type: "private" as const, id: message.userId! };

            try {
              const result = await createGithubIssue(
                channel.repo,
                issue.title,
                issue.body,
                channel.labels,
              );
              issue.status = "approved";
              issue.githubUrl = result.html_url;
              // Parse GitHub issue number from URL (last segment of path)
              const ghNumMatch = result.html_url.match(/\/(\d+)(?:\?|$|#)/) ?? result.html_url.match(/\/(\d+)$/);
              issue.githubIssueNumber = ghNumMatch ? parseInt(ghNumMatch[1], 10) : undefined;
              savePending(groupId, pending);

              const html = buildGhResultHtml("success", {
                id: issue.id,
                title: issue.title,
                channel: issue.channel,
                repo: channel.repo,
                githubUrl: result.html_url,
                githubIssueNumber: issue.githubIssueNumber,
                submitterName: displayName(issue.submitter, groupId),
              });
              const imagePath = await renderGhToImage(html, process.cwd());
              await ctx.sendImage(target, imagePath);
              fs.unlink(imagePath, () => {});

              await onebot.sendSegments(
                { type: "group", id: groupId },
                [
                  { type: "at", data: { qq: issue.submitter } },
                  { type: "text", data: { text: ` 你的请求 ${formatLocalId(id)}「${issue.title}」已创建为 GitHub issue #${issue.githubIssueNumber}：${result.html_url}` } },
                ],
              );
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              issue.status = "pending";
              savePending(groupId, pending);

              const html = buildGhResultHtml("error", undefined, msg);
              const imagePath = await renderGhToImage(html, process.cwd());
              await ctx.sendImage(target, imagePath);
              fs.unlink(imagePath, () => {});
            }
            return;
          }

          // ── reject sub-command ──────────────────────────────────────
          if (sub === "reject") {
            const id = parseLocalIssueId(args[1] ?? "");
            if (isNaN(id)) {
              await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}gh reject <id> [原因]`);
              return;
            }

            const pending = getPending(groupId);
            const issue = pending.issues.find((i) => i.id === id);
            if (!issue) {
              await ctx.replyText(message, "未找到该 issue。");
              return;
            }

            const store = getChannels(groupId);
            const channel = store.channels[issue.channel];
            if (!channel) {
              await ctx.replyText(message, "该 issue 对应的频道已不存在。");
              return;
            }
            if (!message.userId || !isChannelOwner(message.userId, channel, ctx)) {
              await ctx.replyText(message, "只有频道负责人才能拒绝。");
              return;
            }
            if (issue.status !== "pending") {
              await ctx.replyText(message, `该 issue 已被${issue.status === "approved" ? "批准" : "拒绝"}。`);
              return;
            }

            issue.status = "rejected";
            savePending(groupId, pending);

            const reason = args.slice(2).join(" ");
            const reasonText = reason ? `\n原因：${reason}` : "";

            await onebot.sendSegments(
              { type: "group", id: groupId },
              [
                { type: "at", data: { qq: issue.submitter } },
                { type: "text", data: { text: ` 你的请求 ${formatLocalId(id)}「${issue.title}」被拒绝了。${reasonText}` } },
              ],
            );
            return;
          }

          // ── close sub-command ──────────────────────────────────────
          if (sub === "close") {
            const id = parseLocalIssueId(args[1] ?? "");
            if (isNaN(id)) {
              await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}gh close <REQ-N 或 N>`);
              return;
            }

            const pending = getPending(groupId);
            const issue = pending.issues.find((i) => i.id === id);
            if (!issue) {
              await ctx.replyText(message, "未找到该 issue。");
              return;
            }

            const store = getChannels(groupId);
            const channel = store.channels[issue.channel];
            if (!channel) {
              await ctx.replyText(message, "该 issue 对应的频道已不存在。");
              return;
            }
            // Permission: channel owner can close any; submitter can close their own
            const isOwner = message.userId ? isChannelOwner(message.userId, channel, ctx) : false;
            const isSubmitter = message.userId === issue.submitter;
            if (!isOwner && !isSubmitter) {
              await ctx.replyText(message, "只有频道负责人或 issue 提交者才能关闭该 issue。");
              return;
            }
            if (issue.status === "rejected") {
              await ctx.replyText(message, "该 issue 已被拒绝，无法关闭。");
              return;
            }
            if (issue.status === "closed") {
              await ctx.replyText(message, "该 issue 已经关闭。");
              return;
            }

            const target = message.type === "group" ? { type: "group" as const, id: message.groupId! } : { type: "private" as const, id: message.userId! };

            try {
              // If already approved → close on GitHub
              if (issue.status === "approved" && issue.githubIssueNumber) {
                await closeGithubIssue(channel.repo, issue.githubIssueNumber);
              }
              issue.status = "closed";
              savePending(groupId, pending);

              const html = buildGhResultHtml("rejected", {
                id: issue.id,
                title: issue.title,
                channel: issue.channel,
                repo: channel.repo,
                githubUrl: issue.githubUrl,
                submitterName: displayName(issue.submitter, groupId),
              });
              const imagePath = await renderGhToImage(html, process.cwd());
              await ctx.sendImage(target, imagePath);
              fs.unlink(imagePath, () => {});

              // Notify submitter if closer is owner (not self-close)
              if (isOwner && !isSubmitter) {
                await onebot.sendSegments(
                  { type: "group", id: groupId },
                  [
                    { type: "at", data: { qq: issue.submitter } },
                    { type: "text", data: { text: ` 你的请求 ${formatLocalId(id)}「${issue.title}」已被负责人关闭。` } },
                  ],
                );
              }
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              const html = buildGhResultHtml("error", undefined, `关闭 issue 失败：${msg}`);
              const imagePath = await renderGhToImage(html, process.cwd());
              await ctx.sendImage(target, imagePath);
              fs.unlink(imagePath, () => {});
            }
            return;
          }

          // ── issues sub-command (list from GitHub) ─────────────────────
          if (sub === "issues") {
            const channelName = args[1]?.toLowerCase();
            const stateRaw = (args[2] ?? "open").toLowerCase();
            const pageRaw = parseInt(args[3] ?? "1", 10);

            if (!channelName) {
              await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}gh issues <频道名> [open|closed|all] [页码]`);
              return;
            }

            const state = stateRaw === "closed" || stateRaw === "all" ? stateRaw : "open";
            const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
            const store = getChannels(groupId);
            const channel = store.channels[channelName];
            if (!channel) {
              await ctx.replyText(message, `频道 ${channelName} 不存在。使用 ${menuPlugin.getPrefix()}gh channel list 查看可用频道。`);
              return;
            }

            try {
              const { issues, totalPages } = await fetchGithubIssues(channel.repo, state as "open" | "closed" | "all", 10, page);
              const target = message.type === "group" ? { type: "group" as const, id: message.groupId! } : { type: "private" as const, id: message.userId! };
              const html = buildGhIssuesHtml(channel.repo, state, page, totalPages, issues, channelName, menuPlugin.getPrefix());
              const imagePath = await renderGhToImage(html, process.cwd());
              await ctx.sendImage(target, imagePath);
              fs.unlink(imagePath, () => {});
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              await ctx.replyText(message, `获取 issue 列表失败：${msg}`);
            }
            return;
          }

          // ── help ────────────────────────────────────────────────────
          const p = menuPlugin.getPrefix();
          const target = message.type === "group" ? { type: "group" as const, id: message.groupId! } : { type: "private" as const, id: message.userId! };
          const html = buildGhHelpHtml(p);
          const imagePath = await renderGhToImage(html, process.cwd());
          await ctx.sendImage(target, imagePath);
          fs.unlink(imagePath, () => {});
        },
      );
      updateTrackedGroups();
      startPolling(ctx);
    },
  };

  return plugin;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isAdmin(userId: string, ctx: PluginContext): boolean {
  return ctx.config.auth.adminUserIds.includes(userId);
}

function parseLocalIssueId(raw: string): number {
  // Accept both "REQ-3" and "3" (and "#3")
  const match = raw.match(/^(?:REQ-|#)?(\d+)$/i);
  if (!match) return NaN;
  return parseInt(match[1], 10);
}

function formatLocalId(id: number): string {
  return `REQ-${id}`;
}
