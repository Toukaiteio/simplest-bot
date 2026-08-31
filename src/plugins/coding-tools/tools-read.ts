import fs from "node:fs";
import { ToolError, Workspace } from "./workspace.js";
import { isBinary, truncateTextHead, walkFiles, globMatch, findLiteralLine, readTextFile, searchWithRg } from "./utils.js";

export function createReadToolRegistrations(workspace: Workspace): any[] {
  const ws = workspace;

  return [
    // read_file
    makeReadTool("workspace_read_file", "读取工作区内的文本文件。支持指定 start_line/end_line 读取文件切片，max_bytes 控制最大读取字节数。自动检测二进制文件并拒绝读取。", {
      path: { type: "string", description: "工作区相对路径" },
      startLine: { type: "number", description: "起始行号（从 1 开始，默认 1）" },
      endLine: { type: "number", description: "结束行号（默认文件末尾）" },
      maxBytes: { type: "number", description: "最大读取字节数（默认 131072）" },
    }, ["path"], async (args: any) => {
      const filePath = String(args.path ?? "");
      const startLine = Math.max(1, Number(args.startLine) || 1);
      const endLine = args.endLine !== undefined ? Number(args.endLine) : undefined;
      const maxBytes = Number(args.maxBytes) || 131072;
      const resolved = ws.resolveExisting(filePath);
      const stat = fs.statSync(resolved.resolved);
      if (stat.isDirectory()) throw new ToolError("IS_DIRECTORY", `${filePath} 是目录`);
      const data = fs.readFileSync(resolved.resolved);
      if (isBinary(data)) throw new ToolError("BINARY_FILE", `二进制文件无法读取: ${filePath}`);
      const text = data.toString("utf-8");
      const lines = text.split("\n");
      const totalLines = lines.length;
      const actualEnd = endLine !== undefined ? Math.min(endLine, totalLines) : totalLines;
      const selected = lines.slice(startLine - 1, actualEnd).join("\n");
      const truncation = truncateTextHead(selected, 2000, maxBytes);
      const outputEndLine = Math.min(actualEnd, startLine + (truncation.content.split("\n").length || 1) - 1);
      return JSON.stringify({ path: resolved.display, content: truncation.content, start_line: startLine, end_line: outputEndLine, total_lines: totalLines, total_bytes: data.length, bytes_read: Buffer.byteLength(truncation.content, "utf-8"), truncated: truncation.truncated, truncated_by: truncation.truncatedBy, output_lines: truncation.content.split("\n").length, next_start_line: truncation.truncated && outputEndLine < totalLines ? outputEndLine + 1 : undefined });
    }),

    // list_dir
    makeReadTool("workspace_list_dir", "列出工作区内目录的内容。支持 recursive 递归列出。", {
      path: { type: "string", description: "工作区相对路径（默认 .）" }, recursive: { type: "boolean" }, maxDepth: { type: "number" }, maxEntries: { type: "number" }, includeHidden: { type: "boolean" },
    }, [], async (args: any) => {
      const dirPath = String(args.path ?? "."); const recursive = Boolean(args.recursive);
      const maxDepth = Math.min(20, Math.max(1, Number(args.maxDepth) || 1));
      const maxEntries = Math.min(10000, Math.max(1, Number(args.maxEntries) || 1000));
      const includeHidden = Boolean(args.includeHidden);
      const resolved = ws.resolveExisting(dirPath);
      if (!fs.statSync(resolved.resolved).isDirectory()) throw new ToolError("NOT_A_DIRECTORY", `${dirPath} 不是目录`);
      const entries: any[] = []; let truncated = false;
      function visit(dir: string, depth: number) {
        if (truncated) return;
        let children: fs.Dirent[];
        try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const child of children) {
          if (!includeHidden && child.name.startsWith(".")) continue;
          const full = path_join(dir, child.name);
          const rel = path_relative(resolved.resolved, full);
          try { const s = fs.statSync(full); entries.push({ name: rel, type: child.isDirectory() ? "dir" : "file", size: s.size, modified: s.mtime.toISOString() }); } catch { continue; }
          if (entries.length >= maxEntries) { truncated = true; return; }
          if (recursive && depth < maxDepth && child.isDirectory()) visit(full, depth + 1);
        }
      }
      visit(resolved.resolved, 1);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return JSON.stringify({ path: resolved.display, entries, truncated });
    }),

    // list_files
    makeReadTool("workspace_list_files", "使用 glob 模式搜索工作区内的文件。", {
      path: { type: "string", description: "搜索根目录（默认 .）" }, patterns: { type: "array", items: { type: "string" } },
      excludePatterns: { type: "array", items: { type: "string" } }, includeHidden: { type: "boolean" }, maxResults: { type: "number" },
    }, [], async (args: any) => {
      const searchPath = String(args.path ?? ".");
      const patterns = Array.isArray(args.patterns) && args.patterns.length ? args.patterns.map(String) : ["**/*"];
      const excludePatterns = Array.isArray(args.excludePatterns) ? args.excludePatterns.map(String) : [];
      const includeHidden = Boolean(args.includeHidden);
      const maxResults = Math.min(50000, Math.max(1, Number(args.maxResults) || 5000));
      const resolved = ws.resolveExisting(searchPath);
      const files: any[] = []; let truncated = false;
      const allFiles = walkFiles(resolved.resolved, includeHidden);
      for (const fullPath of allFiles) {
        if (files.length >= maxResults) { truncated = true; break; }
        const rel = path_relative(ws.root, fullPath);
        if (!patterns.some((p: string) => globMatch(rel, p))) continue;
        if (excludePatterns.some((p: string) => globMatch(rel, p))) continue;
        try { const s = fs.lstatSync(fullPath); files.push({ path: rel, type: s.isDirectory() ? "dir" : s.isSymbolicLink() ? "symlink" : "file", size_bytes: s.size, modified: s.mtime.toISOString() }); } catch { continue; }
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      return JSON.stringify({ path: resolved.display, files, truncated });
    }),

    // search_text
    makeReadTool("workspace_search_text", "在工作区文件中搜索文本或正则表达式。", {
      query: { type: "string", description: "搜索文本或正则表达式" }, path: { type: "string" }, regex: { type: "boolean" },
      caseSensitive: { type: "boolean" }, includeGlobs: { type: "array", items: { type: "string" } },
      excludeGlobs: { type: "array", items: { type: "string" } }, contextLines: { type: "number" }, maxResults: { type: "number" },
    }, ["query"], async (args: any) => {
      const query = String(args.query ?? ""); if (!query) throw new ToolError("INVALID_ARGUMENT", "query 是必需的");
      const searchPath = String(args.path ?? "."); const regex = Boolean(args.regex); const caseSensitive = Boolean(args.caseSensitive);
      const includeGlobs = Array.isArray(args.includeGlobs) ? args.includeGlobs.map(String) : [];
      const excludeGlobs = Array.isArray(args.excludeGlobs) ? args.excludeGlobs.map(String) : [];
      const contextLines = Math.min(5, Math.max(0, Number(args.contextLines) || 0));
      const maxResults = Math.min(10000, Math.max(1, Number(args.maxResults) || 1000));
      const resolved = ws.resolveExisting(searchPath);
      try {
        const rgResult = searchWithRg(ws.root, resolved.resolved, query, regex, caseSensitive, includeGlobs, excludeGlobs, contextLines, maxResults);
        if (rgResult !== null) return JSON.stringify(rgResult);
      } catch { /* fall through */ }
      const matches: any[] = []; let total = 0;
      const flags = caseSensitive ? "" : "i";
      let compiled: RegExp | null = null;
      if (regex) { try { compiled = new RegExp(query, flags); } catch (e: any) { throw new ToolError("INVALID_ARGUMENT", `无效正则: ${e.message}`); } }
      const allFiles = walkFiles(resolved.resolved);
      for (const fullPath of allFiles) {
        const rel = path_relative(ws.root, fullPath);
        if (includeGlobs.length && !includeGlobs.some((g: string) => globMatch(rel, g))) continue;
        if (excludeGlobs.some((g: string) => globMatch(rel, g))) continue;
        let data: Buffer; try { data = fs.readFileSync(fullPath); } catch { continue; }
        if (isBinary(data)) continue;
        let text: string; try { text = data.toString("utf-8"); } catch { continue; }
        const lines = text.split("\n");
        for (let idx = 0; idx < lines.length; idx++) {
          const line = lines[idx]; let found = false, col = 0;
          if (compiled) { const m = compiled.exec(line); if (m) { found = true; col = (m.index || 0) + 1; } }
          else { const p = findLiteralLine(line, query, caseSensitive); if (p >= 0) { found = true; col = p + 1; } }
          if (!found) continue; total++;
          if (matches.length >= maxResults) continue;
          matches.push({ path: rel, line: idx + 1, column: col, preview: line.length > 200 ? line.slice(0,197)+"..." : line, before: lines.slice(Math.max(0, idx-contextLines), idx), after: lines.slice(idx+1, idx+1+contextLines) });
        }
      }
      return JSON.stringify({ query, matches, total_matches: total, truncated: total > matches.length });
    }),

    // view_image
    makeReadTool("workspace_view_image", "查看工作区内的图片文件，返回 Base64 编码的图片数据。", {
      path: { type: "string", description: "工作区相对路径" }, maxBytes: { type: "number" }, output: { type: "string", enum: ["data_url", "base64"] },
    }, ["path"], async (args: any) => {
      const filePath = String(args.path ?? ""); const maxBytes = Number(args.maxBytes) || 5_242_880;
      const output = String(args.output ?? "data_url"); const resolved = ws.resolveExisting(filePath);
      const data = fs.readFileSync(resolved.resolved);
      const mimeMap: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp", ".svg": "image/svg+xml" };
      const mimeType = mimeMap[path_ext(resolved.resolved).toLowerCase()] || "application/octet-stream";
      if (data.length > maxBytes) throw new ToolError("OUTPUT_TOO_LARGE", `图片超过 ${maxBytes} 字节限制`);
      const base64 = data.toString("base64"); const dataUrl = `data:${mimeType};base64,${base64}`;
      return JSON.stringify({ path: resolved.display, mime_type: mimeType, bytes: data.length, base64, data_url: dataUrl });
    }),
  ];
}

function makeReadTool(name: string, description: string, properties: any, required: string[], execute: any): any {
  return {
    definition: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } },
    execute: async (args: any, input: any) => execute(args, input),
  };
}

// helper to avoid importing path twice
function path_join(...parts: string[]) { return parts.join("/").replace(/\\/g, "/"); }
function path_relative(from: string, to: string) {
  const f = from.replace(/\\/g, "/").replace(/\/$/, ""); const t = to.replace(/\\/g, "/");
  if (t.startsWith(f + "/")) return t.slice(f.length + 1);
  return t;
}
function path_ext(p: string) { const i = p.lastIndexOf("."); return i >= 0 ? p.slice(i) : ""; }
