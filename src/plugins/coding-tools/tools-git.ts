import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ToolError, Workspace } from "./workspace.js";
import { truncateTextHead, parseGitBlame } from "./utils.js";

export function createGitToolRegistrations(workspace: Workspace): any[] {
  const ws = workspace;

  function isRepo(dir: string): boolean {
    try {
      runGitAt(dir, ["rev-parse", "--is-inside-work-tree"], 5000);
      return true;
    } catch {
      return false;
    }
  }
  function git(...args: string[]): string {
    return runGitAt(ws.root, args, 10000);
  }

  return [
    {
      definition: { type: "function", function: { name: "workspace_git_status", description: "显示工作区的 Git 状态。", parameters: { type: "object", properties: { includeUntracked: { type: "boolean" } } } } },
      execute: async (args: any) => {
        if (!isRepo(ws.root)) return JSON.stringify({ is_repo: false, clean: true, entries: [] });
        const includeUntracked = args.includeUntracked !== false;
        const statusArgs = ["status", "--porcelain=v1", "-b"];
        statusArgs.push(includeUntracked ? "--untracked-files=all" : "--untracked-files=no");
        const output = git(...statusArgs);
        const lines = output.split("\n").filter(Boolean);
        let branch = "", upstream = "", ahead = 0, behind = 0;
        const entries: any[] = [];
        for (const line of lines) {
          if (line.startsWith("## ")) {
            const rest = line.slice(3); let br = rest;
            const abMatch = rest.match(/\[([^\]]+)\]/);
            if (abMatch) {
              br = rest.replace(` ${abMatch[0]}`, "");
              const pi = abMatch[1].split(" ");
              if (pi.length >= 2) upstream = pi[0];
              const a = abMatch[1].match(/ahead\s+(\d+)/); if (a) ahead = parseInt(a[1], 10);
              const b = abMatch[1].match(/behind\s+(\d+)/); if (b) behind = parseInt(b[1], 10);
            }
            branch = br; continue;
          }
          let p = line.slice(3), o: string | undefined;
          if (p.includes(" -> ")) { const sp = p.split(" -> "); o = sp[0]; p = sp[1]; }
          entries.push({ path: p, original_path: o, index_status: line[0], worktree_status: line[1] });
        }
        return JSON.stringify({ is_repo: true, branch, head: git("rev-parse", "--short", "HEAD").trim(), upstream, ahead, behind, clean: !entries.length, entries });
      },
    },
    {
      definition: { type: "function", function: { name: "workspace_git_diff", description: "显示工作区的 Git Diff。", parameters: { type: "object", properties: { staged: { type: "boolean" }, unstaged: { type: "boolean" }, contextLines: { type: "number" }, maxBytes: { type: "number" }, path: { type: "string" } } } } },
      execute: async (args: any) => {
        if (!isRepo(ws.root)) return JSON.stringify({ diff: "", files: [], truncated: false });
        const staged = Boolean(args.staged); const unstaged = args.unstaged !== false;
        const context = Math.max(0, Number(args.contextLines) || 3); const maxBytes = Number(args.maxBytes) || 262144;
        const pathFilter = args.path ? String(args.path) : "";
        let combined = "";
        const safePath = pathFilter ? ws.resolveForWrite(pathFilter).display : "";
        if (unstaged) {
          const args = ["diff", "--no-ext-diff", "--no-textconv", `--unified=${context}`];
          if (safePath) args.push("--", safePath);
          combined += git(...args);
        }
        if (staged) {
          const args = ["diff", "--cached", "--no-ext-diff", "--no-textconv", `--unified=${context}`];
          if (safePath) args.push("--", safePath);
          combined += git(...args);
        }
        const trunc = truncateTextHead(combined, 2000, maxBytes);
        return JSON.stringify({ diff: trunc.content, files: combined.match(/^diff --git a\/(.+?) b\//gm)?.map(m => ({ path: m.replace(/^diff --git a\//, "").replace(/ b\/.*$/, ""), status: "modified" })) ?? [], truncated: trunc.truncated, truncated_by: trunc.truncatedBy });
      },
    },
    {
      definition: { type: "function", function: { name: "workspace_git_log", description: "显示工作区的 Git 提交历史。", parameters: { type: "object", properties: { path: { type: "string" }, ref: { type: "string" }, maxCount: { type: "number" }, skip: { type: "number" } } } } },
      execute: async (args: any) => {
        const pathArg = String(args.path ?? "."); const resolved = ws.resolveExisting(pathArg);
        if (!isRepo(resolved.resolved)) return JSON.stringify({ is_repo: false, commits: [] });
        const ref = sanitizeGitRevision(args.ref ?? "HEAD");
        const maxCount = Math.min(100, Math.max(1, Number(args.maxCount) || 20)); const skip = Math.max(0, Number(args.skip) || 0);
        const logArgs = ["log", `--max-count=${maxCount + 1}`, `--skip=${skip}`, "--date=iso-strict", "--pretty=format:%H|%h|%an|%ae|%ad|%s", ref];
        if (resolved.display !== ".") logArgs.push("--", resolved.display);
        const output = git(...logArgs);
        const records = output.split("\n").filter(Boolean);
        const commits = records.slice(0, maxCount).map(r => { const p = r.split("|"); return p.length >= 6 ? { hash: p[0], short_hash: p[1], author_name: p[2], author_email: p[3], author_date: p[4], subject: p.slice(5).join("|") } : null; }).filter(Boolean);
        return JSON.stringify({ is_repo: true, ref, path: resolved.display, commits, truncated: records.length > maxCount });
      },
    },
    {
      definition: { type: "function", function: { name: "workspace_git_show", description: "显示指定 Git 提交的详细信息。", parameters: { type: "object", properties: { rev: { type: "string" }, contextLines: { type: "number" }, maxBytes: { type: "number" } } } } },
      execute: async (args: any) => {
        if (!isRepo(ws.root)) return JSON.stringify({ is_repo: false });
        const rev = sanitizeGitRevision(args.rev ?? "HEAD");
        const context = Math.max(0, Number(args.contextLines) || 3); const maxBytes = Number(args.maxBytes) || 262144;
        const output = git("show", "--no-ext-diff", "--no-textconv", "--format=fuller", `--unified=${context}`, rev);
        const trunc = truncateTextHead(output, 2000, maxBytes);
        return JSON.stringify({ is_repo: true, rev, content: trunc.content, truncated: trunc.truncated });
      },
    },
    {
      definition: { type: "function", function: { name: "workspace_git_blame", description: "对工作区文件执行 Git Blame。", parameters: { type: "object", properties: { path: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" }, maxLines: { type: "number" } }, required: ["path"] } } },
      execute: async (args: any) => {
        const filePath = String(args.path ?? ""); const resolved = ws.resolveExisting(filePath);
        if (fs.statSync(resolved.resolved).isDirectory()) throw new ToolError("IS_DIRECTORY", `${filePath} 是目录`);
        if (!isRepo(ws.root)) return JSON.stringify({ is_repo: false });
        const startLine = Math.max(1, Number(args.startLine) || 1);
        const maxLines = Math.min(1000, Math.max(1, Number(args.maxLines) || 200));
        const finalLine = Math.min(args.endLine !== undefined ? Number(args.endLine) : (startLine + maxLines - 1), startLine + maxLines - 1);
        const output = git("blame", "--line-porcelain", `-L${startLine},${finalLine}`, "--", resolved.display);
        return JSON.stringify({ is_repo: true, path: resolved.display, start_line: startLine, end_line: finalLine, lines: parseGitBlame(output), truncated: false });
      },
    },
  ];
}

function runGitAt(dir: string, args: string[], timeout: number): string {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    TEMP: dir,
    TMP: dir,
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: dir,
    GIT_CONFIG_GLOBAL: path.join(dir, ".agent-empty-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
  // Windows 子进程初始化需要这些变量；Linux 上无意义，不注入。
  if (process.platform === "win32") {
    env.PATHEXT = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    env.ComSpec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
  }
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    throw new ToolError("GIT_FAILED", stderr || `Git 退出码 ${result.status ?? -1}`);
  }
  return String(result.stdout ?? "");
}

function sanitizeGitRevision(value: unknown): string {
  const revision = String(value ?? "HEAD").trim();
  if (!revision || revision.startsWith("-") || revision.includes("..") || !/^[a-zA-Z0-9._~^:/-]+$/.test(revision)) {
    throw new ToolError("INVALID_ARGUMENT", "Git revision 格式无效。");
  }
  return revision;
}
