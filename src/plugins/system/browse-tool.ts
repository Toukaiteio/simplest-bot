import type { BotToolRegistration } from "../../tooling.js";
import type { BotConfig, PromptBuildInput } from "../../types.js";
import { isAdminInput } from "../../security/access-control.js";
import { parseFetchableHttpUrl } from "../../security/url-guard.js";
import { getBrowser } from "../../browser/browser-manager.js";

/**
 * 注入页面的 DOM→markdown 序列化器。以字符串形式注入：它只在浏览器上下文执行，
 * 不参与 Node 侧类型检查；保持无闭包依赖。
 */
const PAGE_TO_MARKDOWN_SOURCE = `(() => {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED"]);
  const BLOCK = new Set(["ADDRESS", "ARTICLE", "ASIDE", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "HEADER", "LEGEND", "MAIN", "NAV", "SECTION", "SPAN_WRAPPER"]);
  const lines = [];
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  function inline(node, out) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const t = clean(child.textContent);
        if (t) out.push(t);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child;
      const tag = el.tagName;
      if (SKIP.has(tag)) continue;
      if (tag === "BR") { out.push("\\n"); continue; }
      if (tag === "A") {
        const inner = [];
        inline(el, inner);
        const label = inner.join("").replace(/\\s+/g, " ").trim();
        const href = el.getAttribute("href") || "";
        out.push(label ? (href ? label + " (" + href + ")" : label) : href);
        continue;
      }
      if (tag === "IMG") {
        const alt = clean(el.getAttribute("alt")) || "图片";
        const src = el.getAttribute("src") || "";
        out.push("[" + alt + "](" + src + ")");
        continue;
      }
      if (tag === "CODE") {
        const inner = [];
        inline(el, inner);
        const t = inner.join("").replace(/\\s+/g, " ").trim();
        if (t) out.push("\`" + t + "\`");
        continue;
      }
      if (tag === "STRONG" || tag === "B") {
        const inner = [];
        inline(el, inner);
        const t = inner.join("").replace(/\\s+/g, " ").trim();
        if (t) out.push("**" + t + "**");
        continue;
      }
      inline(el, out);
    }
  }
  function walk(el) {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        const t = clean(child.textContent);
        if (t) lines.push(t);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const node = child;
      const tag = node.tagName;
      if (SKIP.has(tag)) continue;
      if (/^H[1-6]$/.test(tag)) {
        const inner = [];
        inline(node, inner);
        const t = inner.join("").replace(/\\s+/g, " ").trim();
        if (t) lines.push("", "#".repeat(Number(tag[1])) + " " + t, "");
        continue;
      }
      if (tag === "P") {
        const inner = [];
        inline(node, inner);
        const t = inner.join("").replace(/\\s+/g, " ").trim();
        if (t) lines.push(t, "");
        continue;
      }
      if (tag === "LI") {
        const inner = [];
        inline(node, inner);
        const t = inner.join("").replace(/\\s+/g, " ").trim();
        if (t) lines.push("- " + t);
        continue;
      }
      if (tag === "PRE") {
        const t = (node.textContent || "").trim();
        if (t) lines.push("", "\`\`\`", t.slice(0, 4000), "\`\`\`", "");
        continue;
      }
      if (tag === "BLOCKQUOTE") {
        const t = clean(node.textContent);
        if (t) lines.push("", "> " + t, "");
        continue;
      }
      if (tag === "HR") { lines.push("", "---", ""); continue; }
      if (tag === "TABLE") {
        for (const row of Array.from(node.querySelectorAll("tr"))) {
          const cells = Array.from(row.querySelectorAll("th,td")).map((c) => clean(c.textContent));
          if (cells.length > 0) lines.push("| " + cells.join(" | ") + " |");
        }
        lines.push("");
        continue;
      }
      if (BLOCK.has(tag)) { lines.push(""); walk(node); lines.push(""); continue; }
      walk(node);
    }
  }
  if (document.body) walk(document.body);
  return lines.join("\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
})()`;

/** 默认输出上限：给 systemPrompt/历史/当前任务留出 relay 字符预算。 */
const DEFAULT_MAX_CHARS = 6_000;
const ABSOLUTE_MAX_CHARS = 12_000;

/**
 * 只读网页浏览：用共享浏览器加载页面（可渲染 JS），把 DOM 结构化为 markdown。
 * 与 browser_agent（管理员真实环境的可交互 LLM 子代理）不同，本工具只导航一次、
 * 只读不点，普通用户在受限工作流中即可使用。
 */
export function browseToolRegistration(config: BotConfig): BotToolRegistration {
  const browserConfig = config.pluginSettings.browser;
  return {
    definition: {
      type: "function",
      function: {
        name: "browse",
        description:
          "用浏览器加载网页并返回结构化 markdown（标题/段落/链接/列表/代码，支持 JS 渲染的页面）。只读不点击；需要与页面交互（点击/输入）时才需要管理员真实环境的 browser_agent。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要访问的 http(s) URL" },
            max_chars: {
              type: "number",
              description: `返回内容字符上限（1000-${ABSOLUTE_MAX_CHARS}，默认 ${DEFAULT_MAX_CHARS}）`,
            },
          },
          required: ["url"],
          additionalProperties: false,
        },
      },
    },
    async execute(args: Record<string, unknown>, input: PromptBuildInput) {
      const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
      if (!rawUrl) throw new Error("url 不能为空。");
      const url = parseFetchableHttpUrl(rawUrl, { allowLocalNetwork: isAdminInput(input, config) });

      const maxChars = Math.min(
        ABSOLUTE_MAX_CHARS,
        Math.max(1_000, Math.floor(Number(args.max_chars) || DEFAULT_MAX_CHARS)),
      );

      let page = null;
      try {
        const browser = await getBrowser();
        page = await browser.newPage();
        page.setDefaultNavigationTimeout(browserConfig.navigationTimeoutMs);
        await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
        // 等网络安静一点再抽取，尽量拿到 JS 渲染后的内容；等不到也不阻塞。
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 3_000 }).catch(() => {});
        const title = await page.title().catch(() => "");
        const markdown = await page.evaluate(PAGE_TO_MARKDOWN_SOURCE);
        const body = typeof markdown === "string" ? markdown.trim() : "";
        if (!body) {
          return `页面已加载（标题：${title || "无"}），但未能提取到文本内容（可能是纯 canvas/图片页面）。`;
        }
        const header = `# ${title || url.hostname}\n\n来源: ${page.url()}\n\n`;
        const content = header + body;
        return content.length > maxChars
          ? `${content.slice(0, maxChars)}\n\n[内容已截断，共 ${content.length} 字符；可用 max_chars 参数调整或换更具体的页面]`
          : content;
      } finally {
        if (page) {
          try { await page.close(); } catch { /* ignore */ }
        }
      }
    },
  };
}
