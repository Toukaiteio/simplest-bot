// strudel 渲染器：本地模块注入 + Puppeteer 评估 + 本地 WAV 合成
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Page } from "puppeteer-core";
import { synthHaps, type SynthHap } from "./audio-synth.js";
import { getLibrary, listLibraries } from "./audio-synth.js";
import { getBrowser } from "../../browser/browser-manager.js";

// ── 从本地 node_modules 读取模块源码（纯 ESM，不走 CDN）───

// fraction.js 在 pnpm store 中的路径（通过 @strudel/core 的 context 解析）
const FRACTION_SRC = (() => {
  const coreEntry = path.resolve(process.cwd(), "node_modules", "@strudel", "core", "dist", "index.mjs");
  // pnpm exposes @strudel/core through a junction; resolve from its real store path
  // so Node can see the package's own transitive dependency on fraction.js.
  const req = createRequire(fs.realpathSync(coreEntry));
  const cjs = req.resolve("fraction.js");
  return fs.readFileSync(cjs.replace(/.js$/, ".mjs"), "utf-8");
})();

const STRUDEL_CORE_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "node_modules", "@strudel", "core", "dist", "index.mjs"),
  "utf-8",
);
const STRUDEL_MINI_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "node_modules", "@strudel", "mini", "dist", "index.mjs"),
  "utf-8",
);

// 创建 data URL：把 JS 源码编码成可在 import map 中使用的 URL
function toDataUrl(code: string): string {
  return "data:application/javascript," + encodeURIComponent(code);
}

// kabelsalat/web dummy（只 export SalatRepl = null）
const KABEL_DUMMY = "export const SalatRepl = null;";

// 自包含的 HTML 页面，不依赖任何 CDN
const STRUDEL_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<script type="importmap">
{
  "imports": {
    "fraction.js": "${toDataUrl(FRACTION_SRC)}",
    "@kabelsalat/web": "${toDataUrl(KABEL_DUMMY)}",
    "@strudel/core": "${toDataUrl(STRUDEL_CORE_SRC)}",
    "@strudel/mini": "${toDataUrl(STRUDEL_MINI_SRC)}"
  }
}
</script>
</head><body>
<script type="module">
import { evalScope, evaluate } from "@strudel/core";
import { mini } from "@strudel/mini";
window.__evaluateStrudel = async function(code, durationSec) {
  try {
    await evalScope(import("@strudel/core"));
    await evalScope(import("@strudel/mini"));
    if (typeof mini === "function") {
      globalThis.mini = mini;
    }
    const evaluated = await evaluate(code);
    const pattern = evaluated?.pattern;
    if (!pattern || typeof pattern.queryArc !== "function") {
      throw new Error("Strudel 代码未返回可执行 Pattern。");
    }
    const toPlainNumber = (value) => {
      if (typeof value === "bigint") return Number(value);
      if (typeof value === "number") return value;
      if (value && typeof value.valueOf === "function") {
        const raw = value.valueOf();
        if (typeof raw === "bigint") return Number(raw);
        if (typeof raw === "number") return raw;
      }
      return Number(value ?? 0);
    };
    const haps = pattern.queryArc(0, durationSec);
    const result = haps.map(hap => ({
      begin: toPlainNumber(hap.whole.begin),
      end: toPlainNumber(hap.whole.end),
      vel: toPlainNumber(hap.value.velocity ?? 0.8),
      s: hap.value.s ?? "piano",
      n: hap.value.n === undefined ? undefined : toPlainNumber(hap.value.n),
      note: hap.value.note,
      freq: hap.value.freq === undefined ? undefined : toPlainNumber(hap.value.freq),
    }));
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ error: e.message ?? String(e) });
  }
};
window.__strudelReady = true;
</script></body></html>`;

export type { SynthHap };

let strudelPage: Page | null = null;

async function getStrudelPage(): Promise<Page> {
  if (strudelPage) {
    try {
      if (strudelPage.isClosed()) strudelPage = null;
      else return strudelPage;
    } catch { strudelPage = null; }
  }

  const browser = await getBrowser();
  const page = await browser.newPage();
  console.log("[StrudelRenderer] 加载 strudel 页面…");
  await page.goto("data:text/html," + encodeURIComponent(STRUDEL_HTML), {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });
  console.log("[StrudelRenderer] 等待 strudel 模块就绪…");
  await page.waitForFunction(
    () => (window as any).__strudelReady === true,
    { timeout: 10000 },
  );
  console.log("[StrudelRenderer] strudel 页面就绪");
  strudelPage = page;
  return page;
}

export async function evaluateStrudelCode(
  code: string,
  durationSec = 16,
): Promise<{ haps: SynthHap[]; error?: string }> {
  const page = await getStrudelPage();
  const raw = await page.evaluate(
    (c: string, d: number) => (window as any).__evaluateStrudel(c, d),
    code,
    durationSec,
  );
  const parsed = JSON.parse(raw as string);
  if (parsed.error) return { haps: [], error: parsed.error };

  const haps = (parsed as any[]).map((h: any): SynthHap => ({
    begin: h.begin,
    end: h.end,
    vel: h.vel,
    s: h.s,
    n: h.n,
    note: h.note,
    freq: h.freq,
  }));

  return { haps };
}

export async function renderStrudelCode(
  code: string,
  options?: { library?: string; duration?: number },
): Promise<Buffer | null> {
  const duration = options?.duration ?? 16;
  const lib = getLibrary(options?.library);
  const { haps, error } = await evaluateStrudelCode(code, duration);
  if (error || haps.length === 0) {
    console.error("[StrudelRenderer] 评估失败:", error || "无音符事件");
    return null;
  }
  return synthHaps(haps, lib, { bpm: 120, duration });
}

export { listLibraries, getLibrary };
