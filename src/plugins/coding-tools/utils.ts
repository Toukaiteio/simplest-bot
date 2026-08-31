import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { ToolError, Workspace, DEFAULT_EXCLUDED_NAMES, sanitizeRelativePath } from "./workspace.js";

export function isBinary(data: Buffer): boolean {
  if (data.length === 0) return false;
  for (let i = 0; i < Math.min(4096, data.length); i++) { if (data[i] === 0) return true; }
  return false;
}

export function truncateTextHead(text: string, maxLines: number, maxBytes: number): { content: string; truncated: boolean; truncatedBy: string | null } {
  if (maxLines <= 0) maxLines = 1;
  if (maxBytes <= 0) maxBytes = 1;
  const totalBytes = Buffer.byteLength(text, "utf-8");
  const lines = text.split("\n");
  if (lines.length <= maxLines && totalBytes <= maxBytes) return { content: text, truncated: false, truncatedBy: null };
  const output: string[] = [];
  let outputBytes = 0, truncatedBy: string | null = "lines";
  for (const line of lines) {
    if (output.length >= maxLines) { truncatedBy = "lines"; break; }
    const lineBytes = Buffer.byteLength(line, "utf-8") + (output.length > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) { truncatedBy = "bytes"; break; }
    output.push(line); outputBytes += lineBytes;
  }
  return { content: output.join("\n"), truncated: true, truncatedBy };
}

export function walkFiles(root: string, includeHidden = false): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (!includeHidden && entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) { if (!DEFAULT_EXCLUDED_NAMES.has(entry.name)) walk(full); }
      else results.push(full);
    }
  }
  walk(root);
  return results;
}

export function globMatch(filePath: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "___DS___").replace(/\*/g, "[^/]*").replace(/___DS___/g, ".*");
  return new RegExp(`^${escaped}$`).test(filePath.replace(/\\/g, "/"));
}

export function findLiteralLine(line: string, query: string, caseSensitive: boolean): number {
  const haystack = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  return haystack.indexOf(needle);
}

export function readTextFile(filePath: string): string { return fs.readFileSync(filePath, "utf-8"); }

export function searchWithRg(
  workspaceRoot: string, searchDir: string, query: string, regex: boolean, caseSensitive: boolean,
  includeGlobs: string[], excludeGlobs: string[], contextLines: number, maxResults: number,
): any | null {
  try {
    const rg = execSync("where rg", { encoding: "utf-8", timeout: 5000 }).split("\n")[0].trim() || "rg";
    let args = `${rg} --json --line-number --color=never`;
    if (!caseSensitive) args += " --ignore-case";
    if (!regex) args += " --fixed-strings";
    if (includeGlobs.length) args += includeGlobs.map(g => ` --glob "${g}"`).join("");
    if (excludeGlobs.length) args += excludeGlobs.map(g => ` --glob "!${g}"`).join("");
    const output = execSync(`${args} -- "${query}" "${searchDir}"`, { encoding: "utf-8", timeout: 10000, maxBuffer: 5*1024*1024 });
    const matches: any[] = []; let total = 0; const fileCache: Record<string, string[]> = {};
    for (const raw of output.split("\n")) {
      if (!raw.trim()) continue;
      try {
        const event = JSON.parse(raw); if (event.type !== "match") continue;
        const data = event.data || {}; const pt = data.path?.text; const ln = data.line_number; const lt = data.lines?.text || "";
        if (!pt || !ln) continue; total++;
        if (matches.length >= maxResults) continue;
        const rp = path.resolve(workspaceRoot, pt); const rel = path.relative(workspaceRoot, rp).replace(/\\/g, "/");
        const col = (data.submatches?.[0]?.start || 0) + 1; const preview = lt.replace(/\r?\n/g, "");
        let fl = fileCache[rel]; if (!fl) { try { fl = fs.readFileSync(rp, "utf-8").split("\n"); } catch { fl = []; } fileCache[rel] = fl; }
        const idx = ln - 1;
        matches.push({ path: rel, line: ln, column: col, preview: preview.length > 200 ? preview.slice(0,197)+"..." : preview, before: fl.slice(Math.max(0, idx-contextLines), idx), after: fl.slice(idx+1, idx+1+contextLines) });
      } catch { continue; }
    }
    return { query, matches, total_matches: total, truncated: total > matches.length, engine: "rg", warnings: total > matches.length ? ["结果数量达到上限"] : [] };
  } catch { return null; }
}

export function parseGitBlame(output: string): { commit: string; author: string; author_mail: string; time: string; line: number; content: string }[] {
  const lines: any[] = [];
  for (const block of output.split("\n\n")) {
    if (!block.trim()) continue;
    const parts = block.split("\n"); if (!parts.length) continue;
    const header: Record<string, string> = {}; let content = "", lineNum = 0;
    for (const part of parts) {
      const si = part.indexOf(" ");
      if (si > 0) {
        const key = part.slice(0, si), value = part.slice(si + 1);
        if (key === "filename") continue;
        if (key.match(/^[0-9a-f]{40}$/)) { header["commit"] = key; const rem = part.slice(key.length).trim().split(/\s+/); if (rem.length >= 3) lineNum = parseInt(rem[1], 10); continue; }
        header[key] = value;
      } else content = part;
    }
    if (header["commit"]) lines.push({ commit: header["commit"].slice(0, 8), author: header["author"] || "", author_mail: (header["author-mail"] || "").replace(/[<>]/g, ""), time: header["author-time"] || "", line: lineNum, content });
  }
  return lines;
}
