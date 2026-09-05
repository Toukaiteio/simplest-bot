import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Plugin, ResponseTransform, OneBotMessageSegment } from "../../types.js";
import { screenshotHtmlFile } from "../mmorpg/screenshot.js";

type MarkdownImagePluginOptions = {
  outputDir: string;
  format: "png" | "webp";
  quality: number;
  longTextThreshold: number;
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
  longTextThreshold: 450,
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

/**
 * Gemini Web 中继（gemini-relay）响应里偶发携带的追问建议标签：
 *   <FollowUp label="…" query="…"/>
 *   <ElicitationsGroup message="…"><Elicitation label="…" query="…"/>…</ElicitationsGroup>
 * 含此类标签的消息强制走图片渲染，标签解析为"建议卡片"而非原文透出。
 */
export type FollowUpChip = { label: string; query: string };
export type FollowUpSection = { message: string; chips: FollowUpChip[] };

/**
 * Gemini Web 图片代理（image agent）生成的图片标签：
 *   <Image alt="…" caption="…" src="imageagenttag_<id>"/>
 * src 是上游内部工件引用，无公开 URL 可解引用，故渲染为占位卡片（alt/caption 文字呈现）。
 * 终端转录里大写 I 常被误读为小写 l（<lmage），两种拼法都匹配。
 */
export type ImageTagCard = { alt: string; caption: string; src: string };

const FOLLOWUP_TAG_RE = /<FollowUp\b([\s\S]*?)\/>/gu;
const ELICITATION_GROUP_RE = /<ElicitationsGroup\b([\s\S]*?)>([\s\S]*?)<\/ElicitationsGroup>/gu;
const ELICITATION_TAG_RE = /<Elicitation\b([\s\S]*?)\/>/gu;
const IMAGE_TAG_RE = /<[Il]mage\b([\s\S]*?)\/>/gu;
const ATTR_RE = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"/gu;

/** 还原属性值里的常见 HTML 实体（&amp; 最后处理，避免二次解码）。 */
function decodeAttrEntities(value: string): string {
  return value
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const point = Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : _match;
    })
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function parseTagAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of attrText.matchAll(ATTR_RE)) {
    attrs[match[1]] = decodeAttrEntities(match[2]);
  }
  return attrs;
}

function parseChip(tagAttrs: string): FollowUpChip | null {
  const attrs = parseTagAttributes(tagAttrs);
  const query = (attrs.query ?? "").replace(/\s+/g, " ").trim();
  if (!query) return null;
  const label = (attrs.label ?? query).replace(/\s+/g, " ").trim() || query;
  return { label, query };
}

/**
 * 从响应文本中解析追问建议与图片代理标签：
 * 剥掉所有 FollowUp / ElicitationsGroup / Image 标签，返回
 * （去除标签后的正文, 追问建议分组, 图片卡片列表）。
 * 孤立的 FollowUp 归入默认分组；ElicitationsGroup 以其 message 属性为分组标题。
 */
export function extractResponseTags(text: string): {
  body: string;
  sections: FollowUpSection[];
  images: ImageTagCard[];
} {
  const images: ImageTagCard[] = [];
  let body = text.replace(IMAGE_TAG_RE, (_whole, tagAttrs: string) => {
    const attrs = parseTagAttributes(tagAttrs);
    const src = (attrs.src ?? "").trim();
    if (src) {
      images.push({
        alt: (attrs.alt ?? "").replace(/\s+/g, " ").trim(),
        caption: (attrs.caption ?? "").replace(/\s+/g, " ").trim(),
        src,
      });
    }
    return "";
  });

  const sections: FollowUpSection[] = [];
  body = body.replace(ELICITATION_GROUP_RE, (_whole, groupAttrs: string, inner: string) => {
    const chips: FollowUpChip[] = [];
    for (const match of inner.matchAll(ELICITATION_TAG_RE)) {
      const chip = parseChip(match[1]);
      if (chip) chips.push(chip);
    }
    const message = (parseTagAttributes(groupAttrs).message ?? "").replace(/\s+/g, " ").trim();
    if (chips.length > 0) sections.push({ message: message || "想要怎么继续？", chips });
    return "";
  });

  const soloChips: FollowUpChip[] = [];
  body = body.replace(FOLLOWUP_TAG_RE, (_whole, tagAttrs: string) => {
    const chip = parseChip(tagAttrs);
    if (chip) soloChips.push(chip);
    return "";
  });
  if (soloChips.length > 0) {
    sections.push({ message: "猜你想继续：", chips: soloChips });
  }

  // 去掉标签后遗留的连续空行。
  body = body.replace(/\n{3,}/g, "\n\n").trim();
  return { body, sections, images };
}

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

function renderInline(text: string, linkRef: (url: string) => number): string {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts
    .map((part) => {
      if (/^`[^`\n]+`$/.test(part)) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }

      const rendered: string[] = [];
      // 行内/块级公式 $...$ / $$...$$：先用占位符保护，避免内容里含 * _ 时
      // 被下方 Markdown 强调规则误处理；最后还原成原始 LaTeX 文本，交给页面中的
      // KaTeX auto-render（renderMathInElement）统一排版，故不做任何命令替换。
      const math: string[] = [];
      let html = part.replace(/\$\$([^$\n]+)\$\$|\$([^$\n]+)\$/g, (_whole, block: string, inline: string) => {
        const expr = block ?? inline;
        // 还原时保留完整的 $...$ / $$...$$ 语法，让 auto-render 能识别与显示模式。
        math.push(`${block !== undefined ? `$$${block}$$` : `$${inline}$`}`);
        return `\uE201${math.length - 1}\uE202`;
      });
      html = escapeHtml(html);

      // Markdown 链接：先替换为占位符，避免后续裸 URL 规则重复包裹。
      html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
        const safeUrl = escapeHtml(url);
        const n = linkRef(url);
        rendered.push(`<a href="${safeUrl}">${escapeHtml(label)}<sup class="md-link-ref">[${n}]</sup></a>`);
        return `\uE101${rendered.length - 1}\uE102`;
      });
      // 裸 URL：渲染为可点击链接并加角标。
      html = html.replace(/(https?:\/\/[^\s<>]+)/g, (url: string) => {
        const safeUrl = escapeHtml(decodeUrl(url));
        const n = linkRef(url);
        return `<a href="${safeUrl}">${escapeHtml(url)}<sup class="md-link-ref">[${n}]</sup></a>`;
      });
      // 还原 Markdown 链接占位符。
      html = html.replace(/\uE101(\d+)\uE102/gu, (_whole, index: string) => rendered[Number(index)] ?? "");
      html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
      html = html.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
      html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
      html = html.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");
      // 还原公式占位符（原样保留 $...$ / $$...$$，交由 KaTeX 渲染）。
      html = html.replace(/\uE201(\d+)\uE202/gu, (_whole, index: string) => math[Number(index)] ?? "");
      return html;
    })
    .join("");
}

function decodeUrl(url: string): string {
  return url.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/**
 * 表格单元格渲染：单元格内的 <br>（含 <br/>、<br />，大小写不敏感）是 Markdown
 * 表格表示单元格内换行的通行约定，转换为真实换行；其余内容仍走 renderInline
 * 转义渲染（escapeHtml 会把 <br> 变成字面 &lt;br&gt; 文本，故须在转义前替换）。
 */
function renderTableCell(text: string, linkRef: (url: string) => number): string {
  return text
    .replace(/<br\s*\/?>/giu, "\n")
    .split("\n")
    .map((line) => renderInline(line, linkRef))
    .join("<br>");
}

type RenderedMarkdown = {
  html: string;
  links: Array<{ label: string; url: string }>;
};

function renderBlocks(blocks: Block[], linkRef: (url: string) => number): string {
  return blocks
    .map((block) => {
      if (block.type === "heading") {
        return `<h${block.level}>${renderInline(block.text, linkRef)}</h${block.level}>`;
      }
      if (block.type === "paragraph") {
        return `<p>${renderInline(block.lines.join(" "), linkRef)}</p>`;
      }
      if (block.type === "blockquote") {
        const paragraphs = block.lines
          .join("\n")
          .split(/\n{2,}/)
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => `<p>${renderInline(part.replace(/\n+/g, " "), linkRef)}</p>`)
          .join("");
        return `<blockquote>${paragraphs}</blockquote>`;
      }
      if (block.type === "list") {
        const tag = block.ordered ? "ol" : "ul";
        const items = block.items.map((item) => `<li>${renderInline(item, linkRef)}</li>`).join("");
        return `<${tag}>${items}</${tag}>`;
      }
      if (block.type === "code") {
        const language = block.language
          ? `<div class="md-code-lang">${escapeHtml(block.language)}</div>`
          : "";
        return `<section class="md-code">${language}<pre><code>${escapeHtml(block.code)}</code></pre></section>`;
      }
      if (block.type === "table") {
        const headerHtml = block.headers.map((cell) => `<th>${renderTableCell(cell, linkRef)}</th>`).join("");
        const bodyHtml = block.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${renderTableCell(cell, linkRef)}</td>`).join("")}</tr>`)
          .join("");
        return `<div class="md-table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
      }
      return `<hr />`;
    })
    .join("\n");
}

/** 渲染追问建议卡片分组：分组标题 + 卡片列表（label 为主、query 为辅，重复时省略 query）。 */
function renderFollowUpSections(sections: FollowUpSection[]): string {
  if (sections.length === 0) return "";
  return sections
    .map((section) => {
      const chips = section.chips
        .map((chip) => {
          const queryHtml = chip.query !== chip.label
            ? `<div class="md-chip-query">${escapeHtml(chip.query)}</div>`
            : "";
          return `<div class="md-chip"><div class="md-chip-label">${escapeHtml(chip.label)}</div>${queryHtml}</div>`;
        })
        .join("");
      return `<section class="md-followups">
        <div class="md-followups-title">${escapeHtml(section.message)}</div>
        <div class="md-chip-list">${chips}</div>
      </section>`;
    })
    .join("\n");
}

/** 渲染图片代理标签卡片：占位图框（原图未随消息下发）+ 标题（caption）/描述（alt）+ 工件引用。 */
function renderImageTags(images: ImageTagCard[]): string {
  if (images.length === 0) return "";
  return images
    .map((image) => {
      const title = image.caption || image.alt;
      const altHtml = image.alt && image.alt !== image.caption
        ? `<div class="md-image-alt">${escapeHtml(image.alt)}</div>`
        : "";
      const titleHtml = title
        ? `<div class="md-image-caption">${escapeHtml(title)}</div>`
        : "";
      return `<figure class="md-image-card">
        <div class="md-image-placeholder">
          <div class="md-image-glyph">🖼️</div>
          <div class="md-image-note">生成图片 · 原图未随消息下发</div>
          <div class="md-image-ref">${escapeHtml(image.src)}</div>
        </div>
        ${titleHtml || altHtml ? `<figcaption>${titleHtml}${altHtml}</figcaption>` : ""}
      </figure>`;
    })
    .join("\n");
}

/**
 * 返回本地 KaTeX 资源的 file:// URL（从项目 node_modules/katex/dist 读取）。
 * 配合 browser-manager 的 --allow-file-access-from-files，file:// 页面可跨目录加载
 * 这些 CSS/JS/字体资源，实现“本地打包”渲染，不依赖任何 CDN。
 */
function katexAsset(fileName: string): string {
  return pathToFileURL(path.join(process.cwd(), "node_modules", "katex", "dist", fileName)).href;
}

export function buildSheetHtml(
  markdown: string,
  followUpSections: FollowUpSection[] = [],
  imageTags: ImageTagCard[] = [],
): RenderedMarkdown {
  const blocks = parseMarkdownBlocks(markdown);
  const links: Array<{ label: string; url: string }> = [];
  const seen = new Set<string>();
  const linkRef = (url: string): number => {
    const key = decodeUrl(url);
    if (seen.has(key)) return links.findIndex((l) => l.url === key) + 1;
    seen.add(key);
    links.push({ label: "", url: key });
    return links.length;
  };
  const contentHtml = renderBlocks(blocks, linkRef);
  const css = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: #d7d1c7;
  padding: 28px;
  color: #262b33;
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
  color: #2a2f37;
}
h1, h2, h3, h4, h5, h6 {
  margin: 0 0 14px;
  line-height: 1.24;
  font-family: "Georgia", "Times New Roman", "Songti SC", serif;
  font-weight: 700;
  color: #223d57;
}
h1 { font-size: 34px; margin-top: 4px; color: #20425f; }
h2 { font-size: 29px; margin-top: 18px; color: #275670; }
h3 { font-size: 24px; margin-top: 16px; color: #2f5f63; }
h4 { font-size: 21px; margin-top: 14px; color: #43546e; }
h5 { font-size: 18px; margin-top: 12px; color: #4f6a3c; }
h6 { font-size: 16px; margin-top: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: #7a5c2e; }
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
  background: rgba(58, 95, 120, 0.06);
  color: #3a4650;
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
.sup, .md-link-ref {
  display: inline-block;
  min-width: 16px;
  margin: 0 2px;
  padding: 0 3px;
  border-radius: 8px;
  background: #3a5f78;
  color: #fff;
  font-size: 11px;
  font-style: normal;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
  vertical-align: super;
}
strong {
  font-weight: 700;
  color: #8c3a2e;
}
em {
  font-style: italic;
  color: #2f6b6b;
}
del {
  color: rgba(42, 47, 55, 0.58);
}
code {
  font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  font-size: 0.92em;
  background: rgba(90, 74, 140, 0.1);
  color: #4a356b;
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
.md-followups {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px dashed rgba(58, 95, 120, 0.38);
}
.md-followups-title {
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #3a5f78;
}
.md-followups-title::before {
  content: "💬 ";
}
.md-chip-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.md-chip {
  padding: 10px 14px;
  border: 1px solid rgba(58, 95, 120, 0.45);
  border-radius: 10px;
  background: rgba(58, 95, 120, 0.05);
}
.md-chip-label {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.5;
  color: #223d57;
}
.md-chip-label::before {
  content: "▸ ";
  color: #3a5f78;
}
.md-chip-query {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.62;
  color: rgba(42, 47, 55, 0.72);
}
.md-chip-query::before {
  content: "↳ ";
  color: rgba(58, 95, 120, 0.8);
}
.md-image-card {
  margin: 0 0 18px;
  border: 1px solid rgba(22, 24, 27, 0.18);
  background: #fbf8f1;
}
.md-image-card:last-child {
  margin-bottom: 0;
}
.md-image-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 150px;
  padding: 22px 18px;
  border-bottom: 1px dashed rgba(58, 95, 120, 0.4);
  background:
    repeating-linear-gradient(45deg, rgba(58, 95, 120, 0.045) 0 12px, transparent 12px 24px);
}
.md-image-glyph {
  font-size: 30px;
  line-height: 1;
}
.md-image-note {
  font-size: 13px;
  letter-spacing: 0.05em;
  color: rgba(22, 24, 27, 0.55);
}
.md-image-ref {
  max-width: 100%;
  padding: 2px 10px;
  border-radius: 8px;
  background: rgba(58, 95, 120, 0.08);
  font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  font-size: 11px;
  color: #3a5f78;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.md-image-card figcaption {
  padding: 12px 16px;
}
.md-image-caption {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.5;
  color: #223d57;
}
.md-image-caption::before {
  content: "题注 · ";
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.08em;
  color: rgba(58, 95, 120, 0.85);
}
.md-image-alt {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.62;
  color: rgba(42, 47, 55, 0.72);
}
.md-image-alt::before {
  content: "描述 · ";
  font-size: 12px;
  letter-spacing: 0.08em;
  color: rgba(58, 95, 120, 0.85);
}
`;

  const katexCss = katexAsset("katex.min.css");
  const katexJs = katexAsset("katex.min.js");
  const autoRenderJs = katexAsset("contrib/auto-render.min.js");

  return {
    html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Markdown Render</title>
  <link rel="stylesheet" href="${katexCss}" />
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
      ${renderImageTags(imageTags)}
      ${renderFollowUpSections(followUpSections)}
    </div>
  </div>
  <script src="${katexJs}"></script>
  <script src="${autoRenderJs}"></script>
  <script>
    (function () {
      try {
        renderMathInElement(document.body, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false }
          ],
          throwOnError: false,
          strict: false,
          trust: false
        });
      } catch (e) { /* 渲染失败不阻塞页面 */ }
    })();
  </script>
</body>
</html>`,
    links,
  };
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
    description: "将 Markdown 或长文本响应渲染为 WebP 图片，短文本保持文本发送",

    async onTransformResponse(text: string): Promise<ResponseTransform | null> {
      const normalized = normalizeText(text);
      // 先剥离上游结构化标签（FollowUp / ElicitationsGroup / Image）：含此类标签的消息
      // 无论长短、是否 Markdown，一律走图片渲染（标签以卡片形式呈现）。
      const { body, sections, images } = extractResponseTags(normalized);
      const hasTags = sections.length > 0 || images.length > 0;
      if (!body && !hasTags) {
        return null;
      }
      const shouldRenderImage = hasTags
        || body.length >= resolved.longTextThreshold
        || hasHighConfidenceMarkdown(body);
      if (!shouldRenderImage) {
        return null;
      }

      const rendered = buildSheetHtml(body, sections, images);
      fs.mkdirSync(path.resolve(resolved.outputDir), { recursive: true });
      const filePath = path.resolve(
        resolved.outputDir,
        `markdown-${Date.now()}-${randomUUID().slice(0, 8)}.${resolved.format}`,
      );

      await screenshotHtmlFile(rendered.html, filePath, {
        format: resolved.format,
        quality: resolved.quality,
      });
      scheduleCleanup(filePath, resolved.cleanupDelayMs);

      const segments: OneBotMessageSegment[] = [{ type: "image", data: { file: filePath } }];
      // 将图片中编号的链接按条目与顺序单独以文本消息发出。
      if (rendered.links.length > 0) {
        const lines = ["📎 相关链接：", ...rendered.links.map((link, index) => `${index + 1}. ${link.url}`)];
        segments.push({ type: "text", data: { text: lines.join("\n") } });
      }

      return {
        segments,
        remainingText: "",
      };
    },
  };
}
