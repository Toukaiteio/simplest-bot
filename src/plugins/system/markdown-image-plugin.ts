import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Plugin, ResponseTransform } from "../../types.js";
import { screenshotHtml } from "../mmorpg/screenshot.js";

type MarkdownImagePluginOptions = {
  outputDir: string;
  format: "png" | "webp";
  quality: number;
  cleanupDelayMs: number;
};

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "blockquote"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language: string; code: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "hr" };

const DEFAULT_OPTIONS: MarkdownImagePluginOptions = {
  outputDir: "data/markdown-images",
  format: "webp",
  quality: 88,
  cleanupDelayMs: 120_000,
};

const FENCE_RE = /^\s*```([^\s`]*)\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BLOCKQUOTE_RE = /^ {0,3}>\s?(.*)$/;
const BULLET_RE = /^(\s*)([-+*])\s+(.+?)\s*$/;
const ORDERED_RE = /^(\s*)(\d+)\.\s+(.+?)\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/;
const TASK_RE = /^(\s*)[-+*]\s+\[(?: |x|X)\]\s+(.+?)\s*$/;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function hasMarkdownTable(lines: string[]): boolean {
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|")) continue;
    if (TABLE_SEPARATOR_RE.test(lines[i + 1])) return true;
  }
  return false;
}

function hasMarkdownList(lines: string[]): boolean {
  let streak = 0;
  for (const line of lines) {
    if (BULLET_RE.test(line) || ORDERED_RE.test(line) || TASK_RE.test(line)) {
      streak += 1;
      if (streak >= 2) return true;
    } else if (line.trim() === "") {
      streak = 0;
    } else {
      streak = 0;
    }
  }
  return false;
}

function hasMarkdownBlockquote(lines: string[]): boolean {
  let streak = 0;
  for (const line of lines) {
    if (BLOCKQUOTE_RE.test(line)) {
      streak += 1;
      if (streak >= 2) return true;
    } else if (line.trim() === "") {
      streak = 0;
    } else {
      streak = 0;
    }
  }
  return false;
}

function hasHighConfidenceMarkdown(text: string): boolean {
  if (!text) return false;
  if (/```[\s\S]*```/.test(text)) return true;

  const lines = text.split("\n");
  if (lines.some((line) => HEADING_RE.test(line))) return true;
  if (lines.some((line) => HR_RE.test(line))) return true;
  if (hasMarkdownTable(lines)) return true;
  if (hasMarkdownList(lines)) return true;
  if (hasMarkdownBlockquote(lines)) return true;
  return false;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isParagraphBreak(line: string): boolean {
  return (
    line.trim() === "" ||
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    BLOCKQUOTE_RE.test(line) ||
    BULLET_RE.test(line) ||
    ORDERED_RE.test(line) ||
    TASK_RE.test(line)
  );
}

function parseMarkdownBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_RE.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: "code",
        language: fenceMatch[1] ?? "",
        code: codeLines.join("\n"),
      });
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[index + 1])) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const match = lines[index].match(BLOCKQUOTE_RE);
        if (!match) break;
        quoteLines.push(match[1]);
        index += 1;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    if (BULLET_RE.test(line) || ORDERED_RE.test(line) || TASK_RE.test(line)) {
      const firstOrdered = ORDERED_RE.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index];
        const taskMatch = current.match(TASK_RE);
        const bulletMatch = current.match(BULLET_RE);
        const orderedMatch = current.match(ORDERED_RE);

        if (taskMatch) {
          items.push(`[ ] ${taskMatch[2]}`);
          index += 1;
          continue;
        }
        if (!firstOrdered && bulletMatch) {
          items.push(bulletMatch[3]);
          index += 1;
          continue;
        }
        if (firstOrdered && orderedMatch) {
          items.push(orderedMatch[3]);
          index += 1;
          continue;
        }
        if (items.length > 0 && current.trim() && /^\s{2,}\S/.test(current)) {
          items[items.length - 1] += ` ${current.trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered: firstOrdered, items });
      continue;
    }

    const paragraphLines = [trimmed];
    index += 1;
    while (index < lines.length && !isParagraphBreak(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraphLines });
  }

  return blocks;
}

function renderInline(text: string): string {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts
    .map((part) => {
      if (/^`[^`\n]+`$/.test(part)) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }

      let html = escapeHtml(part);
      html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
        const safeUrl = escapeHtml(url);
        return `<a href="${safeUrl}">${escapeHtml(label)}</a>`;
      });
      html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
      html = html.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
      html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
      html = html.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");
      return html;
    })
    .join("");
}

function renderBlocks(blocks: Block[]): string {
  return blocks
    .map((block) => {
      if (block.type === "heading") {
        return `<h${block.level}>${renderInline(block.text)}</h${block.level}>`;
      }
      if (block.type === "paragraph") {
        return `<p>${renderInline(block.lines.join(" "))}</p>`;
      }
      if (block.type === "blockquote") {
        const paragraphs = block.lines
          .join("\n")
          .split(/\n{2,}/)
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => `<p>${renderInline(part.replace(/\n+/g, " "))}</p>`)
          .join("");
        return `<blockquote>${paragraphs}</blockquote>`;
      }
      if (block.type === "list") {
        const tag = block.ordered ? "ol" : "ul";
        const items = block.items.map((item) => `<li>${renderInline(item)}</li>`).join("");
        return `<${tag}>${items}</${tag}>`;
      }
      if (block.type === "code") {
        const language = block.language
          ? `<div class="md-code-lang">${escapeHtml(block.language)}</div>`
          : "";
        return `<section class="md-code">${language}<pre><code>${escapeHtml(block.code)}</code></pre></section>`;
      }
      if (block.type === "table") {
        const headerHtml = block.headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
        const bodyHtml = block.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
          .join("");
        return `<div class="md-table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
      }
      return `<hr />`;
    })
    .join("\n");
}

function buildSheetHtml(markdown: string): string {
  const blocks = parseMarkdownBlocks(markdown);
  const contentHtml = renderBlocks(blocks);
  const css = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: #d7d1c7;
  padding: 28px;
  color: #16181b;
  font-family: "Segoe UI Variable Text", "PingFang SC", "Microsoft YaHei UI", sans-serif;
}
.sheet {
  width: 880px;
  background: #f4efe6;
  border: 1px solid #c8beb0;
  box-shadow: 0 16px 40px rgba(15, 17, 20, 0.18);
  position: relative;
  overflow: hidden;
}
.sheet::before {
  content: "";
  position: absolute;
  inset: 14px;
  border: 1px solid rgba(58, 95, 120, 0.18);
  pointer-events: none;
}
.sheet::after {
  content: "";
  position: absolute;
  left: 22px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #3a5f78;
  opacity: 0.92;
}
.md-shell {
  position: relative;
  padding: 26px 32px 30px 48px;
}
.md-rail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(58, 95, 120, 0.24);
}
.md-mark {
  font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  font-size: 12px;
  letter-spacing: 0.18em;
  color: #3a5f78;
  text-transform: uppercase;
}
.md-mark::before {
  content: "[]";
  margin-right: 8px;
  letter-spacing: 0.04em;
}
.md-meta {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: rgba(22, 24, 27, 0.44);
  text-transform: uppercase;
}
.md-content {
  font-size: 17px;
  line-height: 1.78;
  color: #1a1d21;
}
h1, h2, h3, h4, h5, h6 {
  margin: 0 0 14px;
  line-height: 1.24;
  font-family: "Georgia", "Times New Roman", "Songti SC", serif;
  font-weight: 700;
  color: #111316;
}
h1 { font-size: 34px; margin-top: 4px; }
h2 { font-size: 29px; margin-top: 18px; }
h3 { font-size: 24px; margin-top: 16px; }
h4 { font-size: 21px; margin-top: 14px; }
h5 { font-size: 18px; margin-top: 12px; }
h6 { font-size: 16px; margin-top: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
p, blockquote, ul, ol, .md-code, .md-table-wrap, hr { margin: 0 0 16px; }
p:last-child, blockquote:last-child, ul:last-child, ol:last-child, .md-code:last-child, .md-table-wrap:last-child, hr:last-child { margin-bottom: 0; }
ul, ol {
  padding-left: 24px;
}
li + li {
  margin-top: 8px;
}
blockquote {
  padding: 10px 0 10px 18px;
  border-left: 3px solid #3a5f78;
  color: rgba(22, 24, 27, 0.82);
}
blockquote p {
  margin-bottom: 10px;
}
blockquote p:last-child {
  margin-bottom: 0;
}
hr {
  border: 0;
  border-top: 1px solid rgba(58, 95, 120, 0.26);
}
a {
  color: #294f69;
  text-decoration: none;
  border-bottom: 1px solid rgba(41, 79, 105, 0.35);
}
strong {
  font-weight: 700;
}
em {
  font-style: italic;
}
del {
  color: rgba(22, 24, 27, 0.58);
}
code {
  font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  font-size: 0.92em;
  background: rgba(58, 95, 120, 0.08);
  padding: 0.12em 0.38em;
}
.md-code {
  border: 1px solid #1f252c;
  background: #171a1f;
  color: #eef2f7;
}
.md-code-lang {
  padding: 9px 14px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(238, 242, 247, 0.72);
}
pre {
  margin: 0;
  padding: 14px 16px 16px;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}
pre code {
  padding: 0;
  background: transparent;
  color: inherit;
  font-size: 14px;
  line-height: 1.7;
}
.md-table-wrap {
  overflow: hidden;
  border: 1px solid rgba(22, 24, 27, 0.16);
}
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
th, td {
  padding: 10px 12px;
  border-bottom: 1px solid rgba(22, 24, 27, 0.1);
  border-right: 1px solid rgba(22, 24, 27, 0.08);
  text-align: left;
  vertical-align: top;
  word-break: break-word;
}
th:last-child, td:last-child {
  border-right: 0;
}
thead th {
  background: rgba(58, 95, 120, 0.08);
  font-size: 14px;
  font-weight: 700;
}
tbody tr:last-child td {
  border-bottom: 0;
}
`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Markdown Render</title>
  <style>${css}</style>
</head>
<body>
  <div class="sheet">
    <div class="md-shell">
      <div class="md-rail">
        <div class="md-mark">markdown</div>
        <div class="md-meta">rendered message</div>
      </div>
      <article class="md-content">${contentHtml}</article>
    </div>
  </div>
</body>
</html>`;
}

function scheduleCleanup(filePath: string, delayMs: number): void {
  setTimeout(() => {
    fs.unlink(filePath, () => {});
  }, delayMs).unref?.();
}

export function createMarkdownImagePlugin(
  options: Partial<MarkdownImagePluginOptions> = {},
): Plugin {
  const resolved = { ...DEFAULT_OPTIONS, ...options };

  return {
    name: "markdown-image",
    description: "检测高置信度 Markdown 响应并渲染为图片发送",

    async onTransformResponse(text: string): Promise<ResponseTransform | null> {
      const normalized = normalizeText(text);
      if (!normalized || !hasHighConfidenceMarkdown(normalized)) {
        return null;
      }

      const html = buildSheetHtml(normalized);
      fs.mkdirSync(path.resolve(resolved.outputDir), { recursive: true });
      const filePath = path.resolve(
        resolved.outputDir,
        `markdown-${Date.now()}-${randomUUID().slice(0, 8)}.${resolved.format}`,
      );

      await screenshotHtml(html, filePath, {
        format: resolved.format,
        quality: resolved.quality,
      });
      scheduleCleanup(filePath, resolved.cleanupDelayMs);

      return {
        segments: [{ type: "image", data: { file: filePath } }],
        remainingText: "",
      };
    },
  };
}
