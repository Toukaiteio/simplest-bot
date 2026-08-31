import fs from "node:fs";
import path from "node:path";
import { ToolError, Workspace } from "./workspace.js";
import { readTextFile } from "./utils.js";

export function createWriteToolRegistrations(workspace: Workspace): any[] {
  const ws = workspace;

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "workspace_apply_patch",
          description: "对工作区文件应用 Patch 补丁。支持添加、删除、更新文件和上下文匹配更新。可使用 dry_run=true 预览变更而不实际写入。",
          parameters: {
            type: "object",
            properties: {
              patch: { type: "string", description: "Patch 补丁内容，格式：*** Begin Patch / *** End Patch 包裹" },
              dryRun: { type: "boolean", description: "预览模式，不实际写入" },
            },
            required: ["patch"],
          },
        },
      },
      execute: async (args: any) => {
        const patch = String(args.patch ?? "");
        const dryRun = Boolean(args.dryRun);
        const operations = parsePatch(patch);
        const staged = new Map<string, string | null>();
        const affected: { path: string; operation: string; oldPath?: string }[] = [];
        const summaries: string[] = [];

        for (const op of operations) {
          if (op.kind === "add") {
            const target = ws.resolveForWrite(op.path);
            if (target.existed) throw new ToolError("PATCH_FAILED", `文件已存在: ${op.path}`);
            staged.set(target.display, op.addContent ?? "");
            affected.push({ path: target.display, operation: "add" }); summaries.push(`A ${target.display}`);
          } else if (op.kind === "delete") {
            const target = ws.resolveExisting(op.path);
            if (fs.statSync(target.resolved).isDirectory()) throw new ToolError("PATCH_FAILED", "不能删除目录");
            staged.set(target.display, null);
            affected.push({ path: target.display, operation: "delete" }); summaries.push(`D ${target.display}`);
          } else if (op.kind === "update") {
            const source = ws.resolveExisting(op.path);
            if (fs.statSync(source.resolved).isDirectory()) throw new ToolError("PATCH_FAILED", "不能更新目录");
            const current = staged.get(source.display);
            if (current === null) throw new ToolError("PATCH_FAILED", "不能更新已删除的文件");
            const content = current !== undefined && current !== null ? current : readTextFile(source.resolved);
            const updated = applyUpdateHunks(content, op.hunks ?? [], op.path);
            if (op.moveTo) {
              const dest = ws.resolveForWrite(op.moveTo);
              if (dest.existed && dest.display !== source.display) throw new ToolError("PATCH_FAILED", "不能移动到已存在的文件");
              staged.set(source.display, null); staged.set(dest.display, updated);
              affected.push({ path: dest.display, oldPath: source.display, operation: "move" }); summaries.push(`R ${source.display} -> ${dest.display}`);
            } else {
              staged.set(source.display, updated);
              affected.push({ path: source.display, operation: "update" }); summaries.push(`M ${source.display}`);
            }
          }
        }
        if (!affected.length) throw new ToolError("PATCH_FAILED", "没有文件被修改");
        if (!dryRun) {
          const backups = new Map<string, Buffer | null>();
          try {
            for (const [rel] of staged) { const t = ws.resolveForWrite(rel); backups.set(rel, fs.existsSync(t.resolved) && !fs.statSync(t.resolved).isDirectory() ? fs.readFileSync(t.resolved) : null); }
            for (const [rel, content] of staged) {
              const target = ws.resolveForWrite(rel);
              if (content === null) { if (fs.existsSync(target.resolved)) fs.unlinkSync(target.resolved); }
              else { const dir = path.dirname(target.resolved); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(target.resolved, content, "utf-8"); }
            }
          } catch (err) {
            for (const [rel, backup] of backups) {
              try { const t = ws.resolveForWrite(rel); if (backup === null) { if (fs.existsSync(t.resolved)) fs.unlinkSync(t.resolved); } else { const d = path.dirname(t.resolved); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(t.resolved, backup); } } catch {}
            }
            throw err;
          }
        }
        return JSON.stringify({ dry_run: dryRun, clean: true, summary: summaries.join("\n"), affected_files: affected });
      },
    },
  ];
}

interface PatchOp { kind: "add" | "delete" | "update"; path: string; addContent?: string; hunks?: string[][]; moveTo?: string; }

function parsePatch(patch: string): PatchOp[] {
  const lines = patch.split("\n");
  if (!lines.length || lines[0].trim() !== "*** Begin Patch" || lines[lines.length - 1].trim() !== "*** End Patch")
    throw new ToolError("PATCH_FAILED", "Patch 必须使用 *** Begin Patch / *** End Patch 包裹");
  const ops: PatchOp[] = []; let i = 1;
  while (i < lines.length - 1) {
    const line = lines[i]; if (!line.trim()) { i++; continue; }
    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim(); i++;
      const contentLines: string[] = [];
      while (i < lines.length - 1 && !lines[i].startsWith("*** ")) { if (!lines[i].startsWith("+")) throw new ToolError("PATCH_FAILED", "添加文件行必须以 '+' 开头"); contentLines.push(lines[i].slice(1)); i++; }
      ops.push({ kind: "add", path: filePath, addContent: contentLines.join("\n") + "\n" });
    } else if (line.startsWith("*** Delete File: ")) {
      ops.push({ kind: "delete", path: line.slice("*** Delete File: ".length).trim() }); i++;
    } else if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim(); i++;
      let moveTo: string | undefined;
      if (i < lines.length - 1 && lines[i].startsWith("*** Move to: ")) { moveTo = lines[i].slice("*** Move to: ".length).trim(); i++; }
      const hunks: string[][] = []; let current: string[] = [];
      while (i < lines.length - 1 && !lines[i].startsWith("*** ")) { if (lines[i].startsWith("@@")) { if (current.length) hunks.push(current); current = []; } current.push(lines[i]); i++; }
      if (current.length) hunks.push(current);
      ops.push({ kind: "update", path: filePath, hunks, moveTo });
    } else throw new ToolError("PATCH_FAILED", `无法识别的 Patch 行: ${line}`);
  }
  return ops;
}

function applyUpdateHunks(content: string, hunks: string[][], filePath: string): string {
  if (!hunks || !hunks.length) return content;
  const lines = content.split("\n");
  const allMatches: { start: number; end: number; newLines: string[] }[] = [];
  for (const hunk of hunks) {
    const oldLines: string[] = []; const newLines: string[] = [];
    for (const raw of hunk) {
      if (!raw) throw new ToolError("PATCH_FAILED", `Patch 包含空行: ${filePath}`);
      const marker = raw[0], value = raw.slice(1);
      if (marker === " ") { oldLines.push(value); newLines.push(value); }
      else if (marker === "-") oldLines.push(value);
      else if (marker === "+") newLines.push(value);
      else throw new ToolError("PATCH_FAILED", `更新行必须以空格/'-'/'+' 开头: ${filePath}`);
    }
    if (!oldLines.length) { allMatches.push({ start: 0, end: 0, newLines }); }
    else {
      const matchIndex = findSubsequence(lines, oldLines);
      if (matchIndex < 0) throw new ToolError("PATCH_FAILED", `Patch 上下文不匹配: ${filePath}`);
      allMatches.push({ start: matchIndex, end: matchIndex + oldLines.length, newLines });
    }
  }
  allMatches.sort((a, b) => b.start - a.start);
  for (const match of allMatches) lines.splice(match.start, match.end - match.start, ...match.newLines);
  return lines.join("\n") + (content.endsWith("\n") ? "\n" : "");
}

function findSubsequence(lines: string[], needle: string[]): number {
  if (!needle.length) return 0;
  for (let i = 0; i <= lines.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) { if (lines[i + j] !== needle[j]) { match = false; break; } }
    if (match) return i;
  }
  return -1;
}
