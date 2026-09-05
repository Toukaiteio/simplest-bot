/**
 * gemini-web2api 的 Node.js 移植：Gemini Web 上游调用（StreamGenerate）。
 * 与 python 版 gemini_web2api/gemini.py 1:1 对齐：仅纯文本通道，无图片上传（TODO）。
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { ResolvedModel } from "./models.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type GeminiUpstreamConfig = {
  cookieFile: string;
  xsrfToken: string;
  authUser: string;
  geminiBl: string;
  requestTimeoutSec: number;
  retryAttempts: number;
  retryDelaySec: number;
  temporaryChats: boolean;
  logRequests: boolean;
  fetchFn: FetchLike;
};

type CookieState = {
  cookie: string;
  sapisid: string | null;
  /** 以下字段在 JSON 格式中可选；存在时作为单源真值覆盖配置，不存在时回落配置。 */
  xsrfToken: string | null;
  geminiBl: string | null;
  authUser: string | null;
};

let cookieCache: { mtimeMs: number; state: CookieState } | null = null;

/**
 * 读取 Cookie 文件（mtime 缓存）。支持 JSON {cookie,sapisid,xsrf_token,gemini_bl,auth_user}
 * 或单行 Cookie 串（仅解析 SAPISID）。JSON 中的认证字段优先级高于配置项，
 * 使 cookie 文件成为认证信息的单一真源（避免 gemini_bl 过期导致上游被拒）。
 */
export function loadCookie(cookieFile: string): CookieState {
  if (!cookieFile.trim()) return { cookie: "", sapisid: null, xsrfToken: null, geminiBl: null, authUser: null };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(cookieFile);
  } catch {
    return { cookie: "", sapisid: null, xsrfToken: null, geminiBl: null, authUser: null };
  }
  if (cookieCache && cookieCache.mtimeMs === stat.mtimeMs) return cookieCache.state;

  const raw = fs.readFileSync(cookieFile, "utf8");
  let cookie = "";
  let sapisid: string | null = null;
  let xsrfToken: string | null = null;
  let geminiBl: string | null = null;
  let authUser: string | null = null;
  if (raw.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as {
        cookie?: string; sapisid?: string;
        xsrf_token?: string; gemini_bl?: string; auth_user?: string;
      };
      cookie = parsed.cookie ?? "";
      sapisid = parsed.sapisid ?? null;
      xsrfToken = parsed.xsrf_token ?? null;
      geminiBl = parsed.gemini_bl ?? null;
      authUser = parsed.auth_user ?? null;
    } catch {
      cookie = "";
    }
  } else {
    cookie = raw.trim();
    for (const part of cookie.split("; ")) {
      const index = part.indexOf("=");
      if (index <= 0) continue;
      const key = part.slice(0, index);
      if (key === "SAPISID") sapisid = part.slice(index + 1);
    }
  }
  cookieCache = { mtimeMs: stat.mtimeMs, state: { cookie, sapisid, xsrfToken, geminiBl, authUser } };
  return { cookie, sapisid, xsrfToken, geminiBl, authUser };
}

/** SAPISIDHASH {ts}_{sha1("{ts} {sapisid} https://gemini.google.com")}，ts 取秒。 */
export function buildSapisidHash(sapisid: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const hash = createHash("sha1").update(`${ts} ${sapisid} https://gemini.google.com`, "utf8").digest("hex");
  return `SAPISIDHASH ${ts}_${hash}`;
}

/**
 * 102 槽位 payload。inner[0] 的 refs 携带图片文件引用（Scotty 上传所得）；
 * 有图时为 `[prompt, 0, null, refs, ...]`，纯文本时 refs 为空元素（与 python 一致）。
 * extra（enhanced 模型 {31:2, 80:3}）在后覆盖。
 */
export function buildPayload(
  prompt: string,
  resolved: ResolvedModel,
  config: GeminiUpstreamConfig,
  fileRefs?: string[],
): unknown[] {
  const inner: unknown[] = new Array(102).fill(null);
  // refs 放在 inner[0] 索引 3；每个文件引用按 python 再包一层 [null, null, ref]。
  const wrappedRefs = fileRefs && fileRefs.length > 0
    ? fileRefs.map((ref) => [null, null, ref])
    : null;
  inner[0] = [prompt, 0, null, wrappedRefs, null, null, 0];
  inner[1] = ["en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[resolved.thinkMode]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = config.temporaryChats ? [1] : [2];
  if (config.temporaryChats) inner[45] = 1;
  inner[53] = 0;
  inner[59] = randomUUID();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = resolved.modeId;
  if (resolved.extra) {
    for (const [key, value] of Object.entries(resolved.extra)) inner[Number(key)] = value;
  }
  return inner;
}

/** 与 python json.dumps(ensure_ascii=True) 等价：非 ASCII 转 \\uXXXX（代理对拆分）。 */
export function asciiJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0) ? String(value) : "null";
  }
  if (typeof value === "string") return quoteAsciiString(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => asciiJson(item)).join(", ")}]`;
  }
  // python json.dumps 默认分隔符 (', ', ': ')
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${quoteAsciiString(key)}: ${asciiJson(item)}`)
    .join(", ")}}`;
}

function quoteAsciiString(value: string): string {
  let out = "\"";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0x22) out += "\\\"";
    else if (code === 0x5c) out += "\\\\";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0d) out += "\\r";
    else if (code === 0x09) out += "\\t";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x0c) out += "\\f";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else if (code < 0x7f) out += char;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else {
      const offset = code - 0x10000;
      const high = 0xd800 + (offset >> 10);
      const low = 0xdc00 + (offset & 0x3ff);
      out += `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
    }
  }
  return `${out}"`;
}

/** python urllib.parse.quote_plus 等价：空格→+，字母数字 ._-~ 保留，其余 UTF-8 字节 %XX。 */
export function quotePlus(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9._~-]/.test(char)) out += char;
    else if (char === " ") out += "+";
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** f.req= 表单体；xsrfToken 存在时追加 at=。 */
/**
 * 解析上游请求实际使用的认证字段：cookie 文件（JSON）中的字段优先，
 * 缺失时回落到配置项。使 gemini-auth.json 成为认证信息的单一真源。
 */
export function resolveAuthConfig(config: GeminiUpstreamConfig): {
  cookie: string; sapisid: string | null;
  xsrfToken: string; geminiBl: string; authUser: string;
} {
  const cs = loadCookie(config.cookieFile);
  return {
    cookie: cs.cookie,
    sapisid: cs.sapisid,
    xsrfToken: cs.xsrfToken ?? config.xsrfToken,
    geminiBl: cs.geminiBl ?? config.geminiBl,
    authUser: cs.authUser ?? config.authUser,
  };
}

export function buildFormBody(
  prompt: string,
  resolved: ResolvedModel,
  config: GeminiUpstreamConfig,
  fileRefs?: string[],
): string {
  const outer = [null, asciiJson(buildPayload(prompt, resolved, config, fileRefs))];
  const params: Array<[string, string]> = [["f.req", asciiJson(outer)]];
  const { xsrfToken } = resolveAuthConfig(config);
  if (xsrfToken.trim()) params.push(["at", xsrfToken]);
  return params.map(([key, value]) => `${quotePlus(key)}=${quotePlus(value)}`).join("&");
}

export function buildUpstreamUrl(config: GeminiUpstreamConfig): string {
  const { authUser, geminiBl } = resolveAuthConfig(config);
  const accountPrefix = authUser.trim() ? `/u/${authUser.trim()}` : "";
  const reqid = (Math.floor(Date.now() / 1000) % 1000000).toString();
  return `https://gemini.google.com${accountPrefix}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`
    + `?bl=${geminiBl}&hl=en&_reqid=${reqid}&rt=c`;
}

function buildUpstreamHeaders(config: GeminiUpstreamConfig): Record<string, string> {
  const { cookie, sapisid, authUser } = resolveAuthConfig(config);
  const accountPrefix = authUser.trim() ? `/u/${authUser.trim()}` : "";
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://gemini.google.com",
    "Referer": `https://gemini.google.com${accountPrefix}/app`,
    "X-Same-Domain": "1",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };
  if (accountPrefix) headers["X-Goog-AuthUser"] = authUser.trim();
  if (cookie) headers["Cookie"] = cookie;
  if (sapisid) headers["Authorization"] = buildSapisidHash(sapisid);
  return headers;
}

/**
 * wrb.fr 行为有效行且长度≥200；arr[0][2] 为内层 JSON 串；
 * inner[4] 为候选片段列表（多模型/重试版本）。与 python _extract_texts_from_line
 * 一致：返回每个片段 body 内字符串拼接后的文本列表（不再折叠为单个最长文本）。
 */
function extractTextsFromLineList(line: string): string[] {
  if (!line.includes("\"wrb.fr\"") || line.length < 200) return [];
  let inner: unknown;
  try {
    const arr = JSON.parse(line) as unknown[];
    const innerStr = (arr[0] as unknown[] | undefined)?.[2];
    if (typeof innerStr !== "string" || innerStr.length < 50) return [];
    inner = JSON.parse(innerStr);
  } catch {
    return [];
  }
  if (!Array.isArray(inner) || inner.length <= 4 || !inner[4]) return [];
  const fragments = inner[4] as unknown[];
  const texts: string[] = [];
  for (const fragment of fragments) {
    if (!Array.isArray(fragment) || fragment.length <= 1) continue;
    const body = fragment[1];
    if (!Array.isArray(body)) continue;
    let text = "";
    for (const item of body) {
      if (typeof item === "string" && item.length > 0) text += item;
    }
    if (text) texts.push(text);
  }
  return texts;
}

/** 兼容旧调用：单行内取最长文本（非流式语义，与 python generate 一致）。 */
function extractTextsFromLine(line: string): string {
  let best = "";
  for (const text of extractTextsFromLineList(line)) {
    if (text.length > best.length) best = text;
  }
  return best;
}

/** 剥离上游的代码引用输出与卡片链接残留。strip=false 用于流式 delta。 */
export function cleanRelayText(text: string, strip = true): string {
  const cleaned = text
    .replace(/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n.*?```\n?/gsu, "")
    .replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/gu, "");
  return strip ? cleaned.trim() : cleaned;
}

/** 非流式：所有 wrb.fr 行中取最长文本片段（与 python generate 一致）。 */
export function extractResponseText(raw: string): string {
  let lastText = "";
  for (const line of raw.split("\n")) {
    const text = extractTextsFromLine(line);
    if (text.length > lastText.length) lastText = text;
  }
  return cleanRelayText(lastText);
}

const BARD_ERROR_PATTERN = /BardErrorInfo\s*\[(\d+)\]/u;

/**
 * 上游"软拒绝"话术：生成中途/开头插入的拒绝声明（非 BardErrorInfo 格式），
 * 如"我只是一个语言模型…""由于程序代码的局限…""我只会生成文本…"。
 * 出现在末行且不带已发送正文前缀时视为本轮被掐断。
 */
const SOFT_REFUSAL_PATTERN =
  /(语言模型|程序代码的局限|程序逻辑范畴|没法帮|没法办到|无法(?:帮助|回答|生成|执行)|帮不上|无法提供)/u;

/** 预扫描所有 wrb.fr 文本：返回（最长正文，是否软拒绝收尾）。 */
function scanRawTexts(raw: string): { longest: string; endsWithSoftRefusal: boolean } {
  let longest = "";
  let last = "";
  let any = false;
  for (const line of raw.split("\n")) {
    for (const text of extractTextsFromLineList(line)) {
      if (text.length > longest.length) longest = text;
      last = text;
      any = true;
    }
  }
  return {
    longest,
    // 两种形态都算被拒：(a) 末行是拒绝话术且正文更长（中途掐断）；
    // (b) 整轮唯一文本就是拒绝话术（开头即拒，last === longest，
    //     实测会以 200 + 30 字左右拒语通过，必须同样重试）。
    endsWithSoftRefusal: any && SOFT_REFUSAL_PATTERN.test(last)
      && (last.length < longest.length || longest.length < 400),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发起上游请求并完整读取响应体，超时覆盖「连接 + 响应体读取」全程。
 *
 * 此前 fetchWithTimeout 在拿到 Response（HTTP 头）后就 clearTimeout，
 * 之后 `response.text()`（读取 body）不再受控；当上游/代理推送长内容缓慢或
 * 连接挂起时，body 读取会永久挂起，进而让整个下游 agent 会话卡死不恢复。
 * 把 timer 延到 body 读取结束，保证任何情况下到 `requestTimeoutSec` 秒都会
 * abort（abort 会让 fetch 与 body 流一起 reject）。
 */
type RelayFetchResult = {
  status: number;
  body: string;
};

async function fetchRelayBody(config: GeminiUpstreamConfig, url: string, init: RequestInit): Promise<RelayFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutSec * 1000);
  try {
    const response = await config.fetchFn(url, { ...init, signal: controller.signal });
    // body 读取仍在 timer 的超时范围内：长/慢响应不会无限卡住。
    return {
      status: response.status,
      body: await response.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 非流式生成：重试 retryAttempts 次，BardErrorInfo 视为请求被拒。 */
export async function generateRelayText(
  prompt: string,
  resolved: ResolvedModel,
  config: GeminiUpstreamConfig,
  fileRefs?: string[],
): Promise<string> {
  const url = buildUpstreamUrl(config);
  const body = buildFormBody(prompt, resolved, config, fileRefs);
  if (config.logRequests) console.log(`[Relay] upstream generate: model=${resolved.name} chars=${prompt.length} images=${fileRefs?.length ?? 0}`);
  let lastError: unknown = new Error("Gemini upstream request failed");
  for (let attempt = 0; attempt < config.retryAttempts; attempt += 1) {
    try {
      const fetched = await fetchRelayBody(config, url, {
        method: "POST",
        headers: buildUpstreamHeaders(config),
        body,
      });
      if (fetched.status < 200 || fetched.status >= 300) {
        throw new Error(`Gemini upstream HTTP ${fetched.status}`);
      }
      const raw = fetched.body;
      const bardError = raw.match(BARD_ERROR_PATTERN);
      if (bardError) {
        throw new Error(`Gemini upstream rejected request: BardErrorInfo [${bardError[1]}]`);
      }
      // 中途软拒绝：末行是拒绝话术 → 无论正文多长都整轮重试。
      // 正文几百字被掐断与一句话被掐断对用户同样不可接受；服务端 SSE
      // 内部已全量缓冲（发送前重试），不存在重放问题。
      const { longest, endsWithSoftRefusal } = scanRawTexts(raw);
      if (endsWithSoftRefusal) {
        if (config.logRequests) console.log(`[Relay] 上游软拒绝（正文 ${longest.length} 字符被掐断），重试`);
        throw new Error("Gemini upstream soft-refused mid-stream");
      }
      const text = cleanRelayText(longest);
      if (!text) {
        if (config.logRequests) {
          console.warn(`[Relay] 上游响应无可解析正文：HTTP ${fetched.status}，响应体 ${raw.length} 字符`);
        }
        throw new Error("Gemini upstream returned no parseable text");
      }
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < config.retryAttempts - 1) await sleep(config.retryDelaySec * 1000);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Gemini upstream request failed: ${String(lastError)}`);
}

/** 流式生成（按行差分，python generate_stream 语义）。当前服务端 SSE 端点内部
 * 已改走非流式（发送前整轮重试），此函数保留供需要真流式的调用方复用。 */
export async function* streamGenerateRelayText(
  prompt: string,
  resolved: ResolvedModel,
  config: GeminiUpstreamConfig,
  fileRefs?: string[],
): AsyncGenerator<string> {
  const url = buildUpstreamUrl(config);
  const body = buildFormBody(prompt, resolved, config, fileRefs);
  if (config.logRequests) console.log(`[Relay] upstream stream: model=${resolved.name} chars=${prompt.length} images=${fileRefs?.length ?? 0}`);
  let lastError: unknown = new Error("Gemini upstream stream failed");
  let yieldedAny = false;

  for (let attempt = 0; attempt < config.retryAttempts; attempt += 1) {
    try {
      const fetched = await fetchRelayBody(config, url, {
        method: "POST",
        headers: buildUpstreamHeaders(config),
        body,
      });
      if (fetched.status < 200 || fetched.status >= 300) {
        throw new Error(`Gemini upstream HTTP ${fetched.status}`);
      }
      const rawText = fetched.body;
      if (rawText.includes("BardErrorInfo")) {
        const bardError = rawText.match(BARD_ERROR_PATTERN);
        throw new Error(`Gemini upstream rejected request: BardErrorInfo [${bardError?.[1] ?? "?"}]`);
      }

      // 上游返回纯文本行（非 SSE）：buffered 读取整段后按行差分，
      // 与 python 的逐行 retry/delta 逻辑一致（每个后续行是累计全文）。
      // 与 python 一致：每行返回文本列表，逐一做前缀差分；非累计内容
      // （另一个片段/候选版本，含中途插入的软拒绝话术）跳过而非抛错，
      // 避免长回复中途断流。
      // 预扫描：整轮几乎无正文且软拒绝收尾 → 尚未发出 delta，可安全重试整轮。
      const pre = scanRawTexts(rawText);
      if (pre.endsWithSoftRefusal && pre.longest.length < 200) {
        throw new Error("Gemini upstream soft-refused mid-stream");
      }
      if (!pre.longest) {
        if (config.logRequests) {
          console.warn(`[Relay] 上游流式响应无可解析正文：HTTP ${fetched.status}，响应体 ${rawText.length} 字符`);
        }
        throw new Error("Gemini upstream returned no parseable text");
      }
      let emittedRawText = "";
      for (const line of rawText.split("\n")) {
        for (const text of extractTextsFromLineList(line)) {
          if (!text) continue;
          if (text === emittedRawText || emittedRawText.startsWith(text)) continue;
          if (!text.startsWith(emittedRawText)) continue; // 非累计前缀（其他片段/候选），跳过
          const delta = cleanRelayText(text.slice(emittedRawText.length), false);
          emittedRawText = text;
          if (delta) {
            yieldedAny = true;
            yield delta;
          }
        }
      }
      return;
    } catch (error) {
      lastError = error;
      // 一旦已向客户端产出过 delta，重试会导致内容重放，只能放弃重试。
      if (yieldedAny) break;
      if (attempt < config.retryAttempts - 1) await sleep(config.retryDelaySec * 1000);
    }
  }
  if (yieldedAny) return; // 已发出部分内容，静默结束（避免半句重放）
  throw lastError instanceof Error
    ? lastError
    : new Error(`Gemini upstream stream failed: ${String(lastError)}`);
}
