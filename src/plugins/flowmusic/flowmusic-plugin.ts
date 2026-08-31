import fs from "node:fs";
import path from "node:path";
import type { Page, CookieParam } from "puppeteer-core";
import type { Plugin, PluginContext, BotMessage, MenuPlugin } from "../../types.js";
import { getBrowser } from "../../browser/browser-manager.js";

const OUTPUT_DIR = path.resolve(process.cwd(), "data", "flowmusic");
const COOKIE_PATH = path.join(OUTPUT_DIR, "cookies.json");
const SESSION_STORE_PATH = path.join(OUTPUT_DIR, "sessions.json");
const FLOWMUSIC_URL = "https://www.flowmusic.app";
const API_BASE = `${FLOWMUSIC_URL}/__api`;
const SSE_TIMEOUT_MS = 300_000; // 5 minutes
const GENERATION_TIMEOUT_MS = 180_000;
const GENERATION_IDLE_SETTLE_MS = 8_000;
const PERSONALIZE_LEVEL = { upgraded: false, level: "learning" } as const;
const LOGIN_SIGNAL_TEXTS = ["New session", "Songs", "Playlists", "Projects", "Profile", "Ask Producer", "Compose"] as const;
const GENERATE_MUSIC_SCRIPT = String.raw`
async function runFlowMusicGenerate(payload) {
  const promptText = payload.promptText;
  const apiBase = payload.apiBase;
  const sseTimeoutMs = payload.sseTimeoutMs;
  const personalizeLevel = payload.personalizeLevel;
  const authToken = payload.authToken;
  const authHeaders = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + authToken,
  };

  async function postJSON(endpoint, body) {
    return fetch(apiBase + endpoint, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
      credentials: "include",
    });
  }

  const levelResp = await postJSON("/personalize/level", personalizeLevel);
  if (!levelResp.ok) {
    return { ok: false, reason: "personalize/level failed: HTTP " + levelResp.status };
  }

  const convBody = {
    parts: [{ content: promptText, part_kind: "user-prompt" }],
    client_context: {
      selected_model: null,
      lyrics_id_map: {},
      ghostwriter_version: "standard",
    },
    model_name: "producer:standard",
    mode: "standard",
  };
  const convResp = await postJSON("/conversation", convBody);
  if (!convResp.ok) {
    return { ok: false, reason: "conversation failed: HTTP " + convResp.status };
  }

  let conversationId = null;
  let streamId = null;
  try {
    const convData = await convResp.json();
    conversationId = convData?.id || convData?.conversation_id || null;
    streamId = convData?.job_id || convData?.id || convData?.conversation_id || null;
  } catch {
    // ignore non-json response
  }

  if (!streamId) {
    const pathMatch = window.location.pathname.match(/\/session\/([a-f0-9-]+)/i);
    if (pathMatch) {
      conversationId = pathMatch[1];
      streamId = pathMatch[1];
    }
  }

  if (!streamId) {
    try {
      const nextRouter = window.__NEXT_ROUTER__ || window.next?.router;
      if (nextRouter?.query?.id) {
        const id = nextRouter.query.id;
        const normalized = Array.isArray(id) ? id[0] : id;
        conversationId = normalized;
        streamId = normalized;
      }
    } catch {
      // ignore
    }
  }

  if (!streamId) {
    return { ok: false, reason: "Could not determine conversation or job ID" };
  }

  const toolCalls = [];
  const seenToolCallIds = new Set();
  let streamError = null;
  await new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("SSE timeout"));
    }, sseTimeoutMs);
    try {
      const streamResp = await fetch(apiBase + "/messages/" + streamId + "/stream?last_id=0", {
        method: "GET",
        headers: { "Authorization": "Bearer " + authToken },
        credentials: "include",
      });
      if (!streamResp.ok) {
        clearTimeout(timeout);
        reject(new Error("stream failed: HTTP " + streamResp.status));
        return;
      }
      if (!streamResp.body) {
        clearTimeout(timeout);
        reject(new Error("stream body missing"));
        return;
      }

      const reader = streamResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      function handleEvent(eventName, dataText) {
        let data = null;
        try {
          data = dataText ? JSON.parse(dataText) : null;
        } catch {
          return false;
        }
        if (eventName === "conversation_id" && data?.id) {
          conversationId = data.id;
          return false;
        }
        if (eventName === "part" && data?.part) {
          const part = data.part;
          if (
            part.part_kind === "tool-call" &&
            part.tool_name === "audio__create_song" &&
            part.tool_call_id &&
            !seenToolCallIds.has(part.tool_call_id)
          ) {
            seenToolCallIds.add(part.tool_call_id);
            toolCalls.push({
              tool_call_id: part.tool_call_id,
              tool_name: part.tool_name,
              args: part.args || {},
            });
          }
          return false;
        }
        return eventName === "final";
      }

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        let boundaryIndex = buffer.indexOf("\n\n");
        while (boundaryIndex >= 0) {
          const rawEvent = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);
          const lines = rawEvent.split("\n");
          let eventName = "message";
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
          const shouldStop = handleEvent(eventName, dataLines.join("\n"));
          if (shouldStop) {
            clearTimeout(timeout);
            resolve();
            return;
          }
          boundaryIndex = buffer.indexOf("\n\n");
        }
      }
      clearTimeout(timeout);
      resolve();
    } catch (err) {
      clearTimeout(timeout);
      reject(err);
    }
  }).catch((err) => {
    streamError = err?.message || String(err);
  });

  if (streamError) {
    return { ok: false, reason: "SSE error: " + streamError };
  }

  if (toolCalls.length === 0) {
    return { ok: false, reason: "No audio creation detected in response" };
  }

  return { ok: true, toolCalls, conversationId: conversationId || streamId };
}
`;
const REPORT_PERSONALIZE_SCRIPT = String.raw`
async function runFlowMusicReportPersonalize(payload) {
  const resp = await fetch(payload.apiBase + "/personalize/event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + payload.authToken,
    },
    body: JSON.stringify({ event: "create-2", metadata: {} }),
    credentials: "include",
  });
  return { ok: resp.ok, status: resp.status };
}
`;
const AUDIO_STATUS_SCRIPT = String.raw`
async function runFlowMusicAudioStatus(payload) {
  const resp = await fetch(payload.apiBase + "/audio-create-song-status/" + payload.operationId, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + payload.authToken,
    },
    body: JSON.stringify({ operation_id: payload.operationId }),
    credentials: "include",
  });
  if (!resp.ok) {
    return { ok: false, status: null, clipId: null };
  }
  const data = await resp.json();
  return { ok: true, status: data.status, clipId: data.clip_id };
}
`;
const CLIP_DETAILS_SCRIPT = String.raw`
async function runFlowMusicClipDetails(payload) {
  const resp = await fetch(payload.apiBase + "/clips", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + payload.authToken,
    },
    body: JSON.stringify({ clip_ids: payload.clipIds }),
    credentials: "include",
  });
  if (!resp.ok) {
    return { ok: false, clips: null };
  }
  const data = await resp.json();
  return { ok: true, clips: data.clips };
}
`;

type GenerateResult =
  | { ok: true; clips: FlowClipResult[]; conversationId: string }
  | { ok: false; reason: string };

type FlowClipResult = {
  clipId: string;
  opId: string;
  title: string;
  audioUrl: string;
  conversationId: string;
  opType: string;
  createdAt: string;
};

type FlowSessionEntry = {
  conversationId: string;
  updatedAt: string;
  titles: string[];
};

type FlowSessionStore = Record<string, FlowSessionEntry[]>;

function ensureOutputDir(userId: string): string {
  const dir = path.join(OUTPUT_DIR, userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadSessionStore(): FlowSessionStore {
  if (!fs.existsSync(SESSION_STORE_PATH)) return {};
  try {
    const raw = fs.readFileSync(SESSION_STORE_PATH, "utf-8");
    return JSON.parse(raw) as FlowSessionStore;
  } catch (error) {
    console.error("[FlowMusicPlugin] Failed to load session store:", error);
    return {};
  }
}

function saveSessionStore(store: FlowSessionStore): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(SESSION_STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function rememberSession(userId: string, conversationId: string, titles: string[]): void {
  const store = loadSessionStore();
  const nextEntry: FlowSessionEntry = {
    conversationId,
    updatedAt: new Date().toISOString(),
    titles,
  };
  const existing = (store[userId] ?? []).filter((entry) => entry.conversationId !== conversationId);
  store[userId] = [nextEntry, ...existing].slice(0, 10);
  saveSessionStore(store);
}

function getRecentSessions(userId: string): FlowSessionEntry[] {
  return loadSessionStore()[userId] ?? [];
}

function resolveSessionReference(userId: string, ref: string): FlowSessionEntry | null {
  const sessions = getRecentSessions(userId);
  if (sessions.length === 0) return null;
  if (!ref || ref.toLowerCase() === "last" || ref === "最近") {
    return sessions[0] ?? null;
  }
  return sessions.find((entry) => entry.conversationId === ref) ?? null;
}

function parseAccessTokenFromCookies(cookies: CookieParam[]): string | null {
  const joined = cookies
    .filter((cookie) => cookie.name.startsWith("sb-sb-auth-token."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cookie) => cookie.value)
    .join("");
  if (!joined) return null;
  try {
    const decoded = Buffer.from(joined.replace(/^base64-/, ""), "base64").toString("utf8");
    const payload = JSON.parse(decoded) as { access_token?: string };
    return typeof payload.access_token === "string" && payload.access_token.length > 0
      ? payload.access_token
      : null;
  } catch (error) {
    console.error("[FlowMusicPlugin] Failed to parse access token from cookies:", error);
    return null;
  }
}

async function loadCookies(page: Page): Promise<boolean> {
  if (!fs.existsSync(COOKIE_PATH)) return false;
  try {
    const raw = fs.readFileSync(COOKIE_PATH, "utf-8");
    const cookies = JSON.parse(raw) as CookieParam[];
    if (cookies.length === 0) return false;
    await page.setCookie(...cookies);
    return true;
  } catch (error) {
    console.error("[FlowMusicPlugin] Failed to load cookies:", error);
    return false;
  }
}

async function saveCookies(page: Page): Promise<void> {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const cookies = await page.cookies(FLOWMUSIC_URL);
    fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2), "utf-8");
  } catch (error) {
    console.error("[FlowMusicPlugin] Failed to save cookies:", error);
  }
}

async function getAccessToken(page: Page): Promise<string | null> {
  try {
    const pageCookies = await page.cookies(FLOWMUSIC_URL);
    const token = parseAccessTokenFromCookies(pageCookies);
    if (token) return token;
  } catch (error) {
    console.error("[FlowMusicPlugin] Failed to read page cookies:", error);
  }

  if (!fs.existsSync(COOKIE_PATH)) return null;
  try {
    const raw = fs.readFileSync(COOKIE_PATH, "utf-8");
    const cookies = JSON.parse(raw) as CookieParam[];
    return parseAccessTokenFromCookies(cookies);
  } catch (error) {
    console.error("[FlowMusicPlugin] Failed to read cookie file for token:", error);
    return null;
  }
}

function extractConversationIdFromUrl(url: string): string | null {
  const match = url.match(/\/session\/([a-f0-9-]+)/i);
  return match?.[1] ?? null;
}

async function submitPromptInFlowPage(page: Page, prompt: string): Promise<void> {
  const selector = 'textarea[placeholder*="Ask Producer"], textarea[aria-label="Chat message"]';
  await page.waitForSelector(selector, { timeout: 20_000 });
  await page.focus(selector);
  await page.evaluate((sel) => {
    const textarea = document.querySelector(sel) as HTMLTextAreaElement | null;
    if (!textarea) return;
    textarea.value = "";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector);
  await page.type(selector, prompt, { delay: 12 });
  await page.keyboard.press("Enter");
}

async function collectGeneratedClips(
  page: Page,
  startedAtMs: number,
  initialConversationId: string | null,
  onProgress?: (msg: string) => void,
): Promise<{ conversationId: string | null; clips: FlowClipResult[] }> {
  const observedOperationIds = new Set<string>();
  const clipsById = new Map<string, FlowClipResult>();
  let conversationId = initialConversationId;
  let lastRelevantAt = Date.now();
  let lastReportedCount = 0;

  const onResponse = async (response: Awaited<ReturnType<Page["waitForResponse"]>>) => {
    const url = response.url();
    if (url.includes("/__api/audio-create-song-status/")) {
      try {
        const raw = await response.text();
        const data = JSON.parse(raw) as { operation_id?: string; status?: string };
        if (data.operation_id) {
          observedOperationIds.add(data.operation_id);
          lastRelevantAt = Date.now();
          if (observedOperationIds.size > lastReportedCount) {
            lastReportedCount = observedOperationIds.size;
            onProgress?.(`已检测到 ${lastReportedCount} 个生成任务，正在等待音频完成...`);
          }
        }
      } catch {
        // ignore parse failure
      }
      return;
    }

    if (!url.endsWith("/__api/clips")) {
      return;
    }

    try {
      const raw = await response.text();
      const data = JSON.parse(raw) as {
        clips?: Record<string, {
          id?: string;
          op_id?: string;
          title?: string;
          audio_url?: string;
          created_at?: string;
          op_type?: string;
          operation?: { conversation_id?: string };
        }>;
      };

      for (const [clipId, clip] of Object.entries(data.clips ?? {})) {
        const clipConversationId = clip.operation?.conversation_id ?? null;
        if (!conversationId && clipConversationId) {
          conversationId = clipConversationId;
        }
        const createdAtMs = clip.created_at ? Date.parse(clip.created_at) : 0;
        const matchesRecentCreation = Number.isFinite(createdAtMs) && createdAtMs >= startedAtMs - 15_000;
        const matchesObservedOperation = !!clip.op_id && observedOperationIds.has(clip.op_id);
        const matchesConversation = !!conversationId && clipConversationId === conversationId && matchesRecentCreation;
        if (!clip.id || !clip.op_id || !clip.audio_url || !clip.title) continue;
        if (!matchesObservedOperation && !matchesConversation) continue;

        clipsById.set(clipId, {
          clipId,
          opId: clip.op_id,
          title: clip.title,
          audioUrl: clip.audio_url,
          conversationId: clipConversationId ?? conversationId ?? "",
          opType: clip.op_type ?? "audio__create_song",
          createdAt: clip.created_at ?? new Date().toISOString(),
        });
        lastRelevantAt = Date.now();
      }
    } catch {
      // ignore parse failure
    }
  };

  page.on("response", onResponse);
  try {
    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const currentConversationId = extractConversationIdFromUrl(page.url());
      if (currentConversationId) {
        conversationId = currentConversationId;
      }
      if (clipsById.size > 0 && Date.now() - lastRelevantAt >= GENERATION_IDLE_SETTLE_MS) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    page.off("response", onResponse);
  }

  const clips = [...clipsById.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { conversationId, clips };
}

async function evaluateFlowBrowserScript<T>(
  page: Page,
  runnerName:
    | "runFlowMusicGenerate"
    | "runFlowMusicReportPersonalize"
    | "runFlowMusicAudioStatus"
    | "runFlowMusicClipDetails",
  scriptSource: string,
  payload: unknown,
): Promise<T> {
  const expression = `(() => {
    const payload = ${JSON.stringify(payload)};
    ${scriptSource}
    return ${runnerName}(payload);
  })()`;
  return await page.evaluate(expression) as T;
}

async function downloadAudio(url: string, destPath: string): Promise<boolean> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return false;
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    return true;
  } catch {
    return false;
  }
}

async function isLoggedIn(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const currentUrl = window.location.href;
    if (/accounts\.google\.com|signin|login|oauth/i.test(currentUrl)) {
      return false;
    }

    const selectors = [
      'textarea[placeholder*="描述"]',
      'textarea[placeholder*="prompt"]',
      'textarea[placeholder*="Describe"]',
      'textarea[placeholder*="Prompt"]',
      'textarea[placeholder*="Ask Producer"]',
      'textarea[aria-label*="Ask Producer"]',
      'button[aria-label*="Compose"]',
      '[data-testid="compose-input"]',
      '[data-testid="user-avatar"]',
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
    ];
    for (const sel of selectors) {
      if (document.querySelector(sel)) return true;
    }
    const pageText = document.body?.innerText ?? "";
    const matchedSignals = ["New session", "Songs", "Playlists", "Projects", "Profile", "Ask Producer", "Compose"]
      .filter((text) => pageText.includes(text))
      .length;
    if (matchedSignals >= 3) return true;

    if (window.location.pathname.includes("/session/")) return true;
    return false;
  });
}

async function generateMusicInPage(
  page: Page,
  prompt: string,
  conversationId: string | null,
  onProgress?: (msg: string) => void
): Promise<GenerateResult> {
  const startedAtMs = Date.now();
  await submitPromptInFlowPage(page, prompt);
  const result = await collectGeneratedClips(page, startedAtMs, conversationId, onProgress);
  if (!result.conversationId) {
    return { ok: false, reason: "未能获取会话 ID。" };
  }
  if (result.clips.length === 0) {
    return { ok: false, reason: "等待生成结果超时，未捕获到新的音频片段。" };
  }
  return { ok: true, clips: result.clips, conversationId: result.conversationId };
}

async function generateMusicViaApiFallback(
  page: Page,
  prompt: string,
  onProgress?: (msg: string) => void
): Promise<GenerateResult> {
  const authToken = await getAccessToken(page);
  if (!authToken) {
    return { ok: false, reason: "缺少登录令牌，请重新执行 $flow login 完成登录。" };
  }

  const result = await evaluateFlowBrowserScript<
    | { ok: true; toolCalls: Array<{ tool_call_id: string; tool_name: string; args: { sound_prompt?: string; title?: string } }>; conversationId: string }
    | { ok: false; reason: string }
  >(
    page,
    "runFlowMusicGenerate",
    GENERATE_MUSIC_SCRIPT,
    {
      promptText: prompt,
      apiBase: API_BASE,
      sseTimeoutMs: SSE_TIMEOUT_MS,
      personalizeLevel: PERSONALIZE_LEVEL,
      authToken,
    },
  );

  if (!result.ok) {
    return result;
  }

  const { toolCalls, conversationId } = result as { toolCalls: Array<{ tool_call_id: string; tool_name: string; args: { sound_prompt?: string; title?: string } }>; conversationId: string };

  onProgress?.(`已检测到 ${toolCalls.length} 首歌曲生成中...`);

  // Step 4: Report personalize event
  await evaluateFlowBrowserScript<{ ok: boolean; status: number }>(
    page,
    "runFlowMusicReportPersonalize",
    REPORT_PERSONALIZE_SCRIPT,
    { apiBase: API_BASE, authToken },
  );

  // Step 5: Poll for audio status and get clip details
  const clips: FlowClipResult[] = [];

  for (const tc of toolCalls) {
    const opId = tc.tool_call_id; // Use tool_call_id as operation ID
    const title = tc.args?.title || "Untitled";

    // Poll for status
    let clipId: string | null = null;
    let statusComplete = false;

    for (let attempt = 0; attempt < 60; attempt++) {
      const statusResult = await evaluateFlowBrowserScript<{ ok: boolean; status: string | null; clipId: string | null }>(
        page,
        "runFlowMusicAudioStatus",
        AUDIO_STATUS_SCRIPT,
        { apiBase: API_BASE, operationId: opId, authToken },
      );

      if (statusResult.ok && statusResult.status === "complete" && statusResult.clipId) {
        clipId = statusResult.clipId;
        statusComplete = true;
        break;
      }

      if (statusResult.ok && statusResult.status === "error") {
        break;
      }

      // Wait 2 seconds before next poll
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!statusComplete || !clipId) {
      onProgress?.(`歌曲 "${title}" 生成超时或失败`);
      continue;
    }

    // Step 6: Get clip details
    const clipResult = await evaluateFlowBrowserScript<{ ok: boolean; clips: Record<string, { audio_url?: string; title?: string }> | null }>(
      page,
      "runFlowMusicClipDetails",
      CLIP_DETAILS_SCRIPT,
      { apiBase: API_BASE, clipIds: [clipId], authToken },
    );

    if (clipResult.ok && clipResult.clips) {
      const clip = clipResult.clips[clipId];
      if (clip?.audio_url) {
        clips.push({
          clipId,
          opId,
          title: clip.title || title,
          audioUrl: clip.audio_url,
          conversationId,
          opType: "audio__create_song",
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  if (clips.length === 0) {
    return { ok: false, reason: "Failed to retrieve audio URLs" };
  }

  return { ok: true, clips, conversationId };
}

export function createFlowMusicPlugin(menu: MenuPlugin): Plugin {
  let ctx: PluginContext;

  return {
    name: "flowmusic",
    description: "AI 音乐生成（Flow Music）",

    onLoad(pluginCtx: PluginContext) {
      ctx = pluginCtx;
      const prefix = menu.getPrefix();

      menu.registerCommand(
        "flow",
        `AI 音乐生成：${prefix}flow <描述> | continue <sessionId> <意见> | sessions | login | status`,
        async (message: BotMessage, args: string[]) => {
          const sub = args[0];

          if (!sub) {
            await ctx.replyText(
              message,
              `用法：\n` +
              `  ${prefix}flow <描述> - 生成音乐\n` +
              `  ${prefix}flow continue <sessionId|last> <意见> - 继续当前会话微调\n` +
              `  ${prefix}flow sessions - 查看最近会话\n` +
              `  ${prefix}flow login - 登录 Flow Music\n` +
              `  ${prefix}flow status - 查看登录状态\n` +
              `示例：\n` +
              `  ${prefix}flow 帮我生成一个8bit像素风格的音乐\n` +
              `  ${prefix}flow continue last 让鼓点更跳一点，保持纯音乐`
            );
            return;
          }

          if (sub === "status") {
            await handleStatus(message, ctx, menu);
            return;
          }

          if (sub === "login") {
            await handleLogin(message, ctx, menu);
            return;
          }

          const userId = message.userId;
          if (!userId) {
            await ctx.replyText(message, "无法确定用户 ID。");
            return;
          }

          if (sub === "sessions") {
            await ctx.replyText(message, formatSessionList(prefix, getRecentSessions(userId)));
            return;
          }

          let prompt = "";
          let targetConversationId: string | null = null;
          let conversationLabel = "新会话";

          if (sub === "continue") {
            const sessionRef = args[1];
            prompt = args.slice(2).join(" ").trim();
            if (!sessionRef || !prompt) {
              await ctx.replyText(message, `用法：${prefix}flow continue <sessionId|last> <意见>`);
              return;
            }
            const session = resolveSessionReference(userId, sessionRef);
            if (!session) {
              await ctx.replyText(message, `[Flow Music] 未找到会话 ${sessionRef}。\n${formatSessionList(prefix, getRecentSessions(userId))}`);
              return;
            }
            targetConversationId = session.conversationId;
            conversationLabel = `会话 ${targetConversationId}`;
          } else {
            prompt = args.join(" ").trim();
          }

          if (!prompt) {
            await ctx.replyText(message, `请提供音乐描述。用法：${prefix}flow <描述>`);
            return;
          }

          const target =
            message.type === "group" && message.groupId
              ? { type: "group" as const, id: message.groupId }
              : { type: "private" as const, id: userId };

          await ctx.sendMessage(target, `[Flow Music] 正在处理 ${conversationLabel}：\"${prompt}\"...`);

          let page: Page | null = null;
          try {
            const browser = await getBrowser();
            page = await browser.newPage();

            // Load saved cookies before navigation
            const cookiesLoaded = await loadCookies(page);
            if (cookiesLoaded) {
              console.log("[FlowMusicPlugin] Cookies loaded from file");
            }

            // Navigate to flowmusic.app
            const entryUrl = targetConversationId
              ? `${FLOWMUSIC_URL}/session/${targetConversationId}?t=true`
              : FLOWMUSIC_URL;
            await page.goto(entryUrl, { waitUntil: "networkidle2", timeout: 30000 });

            // Check login
            const loggedIn = await isLoggedIn(page);
            if (!loggedIn) {
              const screenshotPath = path.join(process.cwd(), "data", "flowmusic-login.png");
              await page.screenshot({ path: screenshotPath, fullPage: false });
              await ctx.sendMessage(
                target,
                `[Flow Music] 未登录，请先登录。使用 ${prefix}flow login 查看登录页面。`
              );
              await ctx.sendImage(target, screenshotPath, "Flow Music 登录页面");
              return;
            }
            await saveCookies(page);

            // Generate music
            let result = await generateMusicInPage(page, prompt, targetConversationId, (msg) => {
              void ctx.sendMessage(target, `[Flow Music] ${msg}`);
            });
            if (!result.ok) {
              console.warn("[FlowMusicPlugin] UI flow failed, fallback to API flow:", result.reason);
              result = await generateMusicViaApiFallback(page, prompt, (msg) => {
                void ctx.sendMessage(target, `[Flow Music] ${msg}`);
              });
            }

            if (!result.ok) {
              await ctx.sendMessage(
                target,
                `[Flow Music] 生成失败：${result.reason}`
              );
              return;
            }

            rememberSession(userId, result.conversationId, result.clips.map((clip) => clip.title));
            await ctx.sendMessage(
              target,
              `[Flow Music] 会话已记录：${result.conversationId}\n继续微调：${prefix}flow continue ${result.conversationId} <意见>`
            );

            // Download and send audio files
            const userDir = ensureOutputDir(userId);
            for (let i = 0; i < result.clips.length; i++) {
              const clip = result.clips[i];
              const url = clip.audioUrl;
              const title = clip.title;
              const fileName = `${Date.now()}_${i}.m4a`;
              const filePath = path.join(userDir, fileName);

              const downloaded = await downloadAudio(url, filePath);
              if (downloaded) {
                await ctx.sendMessage(
                  target,
                  `[Flow Music] 🎵 ${title}`
                );
                await ctx.sendFile(target, filePath, `${title}.m4a`);
              } else {
                await ctx.sendMessage(
                  target,
                  `[Flow Music] 歌曲 "${title}" 下载失败，直接链接：${url}`
                );
              }
            }
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            await ctx.sendMessage(target, `[Flow Music] 执行错误：${errMsg}`);
            console.error("[FlowMusicPlugin] Error:", error);
          } finally {
            if (page) {
              try {
                await page.close();
              } catch {
                // ignore
              }
            }
          }
        }
      );
    },
  };
}

async function handleStatus(message: BotMessage, ctx: PluginContext, menu: MenuPlugin): Promise<void> {
  let page: Page | null = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await loadCookies(page);
    await page.goto(FLOWMUSIC_URL, { waitUntil: "networkidle2", timeout: 30000 });
    const loggedIn = await isLoggedIn(page);
    if (loggedIn) {
      await saveCookies(page);
      await ctx.replyText(message, "[Flow Music] 已登录，可以正常使用。");
    } else {
      await ctx.replyText(message, `[Flow Music] 未登录。使用 ${menu.getPrefix()}flow login 进行登录。`);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await ctx.replyText(message, `[Flow Music] 状态检查失败：${errMsg}`);
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}

async function handleLogin(message: BotMessage, ctx: PluginContext, menu: MenuPlugin): Promise<void> {
  let page: Page | null = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await loadCookies(page);
    await page.goto(FLOWMUSIC_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Check if already logged in
    const loggedIn = await isLoggedIn(page);
    if (loggedIn) {
      await saveCookies(page);
      await ctx.replyText(message, "[Flow Music] 已经登录了，无需再次登录。");
      return;
    }

    // Take screenshot of login page
    const screenshotPath = path.join(process.cwd(), "data", "flowmusic-login.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const target =
      message.type === "group" && message.groupId
        ? { type: "group" as const, id: message.groupId }
        : { type: "private" as const, id: message.userId! };

    await ctx.sendMessage(
      target,
      `[Flow Music] 请在浏览器中完成登录（Google OAuth）。\n` +
      `由于当前为无头模式，请暂时将 bot.config.json 中 browser.headless 设为 false，\n` +
      `重启后执行 ${menu.getPrefix()}flow login，在弹出的浏览器中完成登录。\n` +
      `登录成功后改回 true 即可。`
    );
    await ctx.sendImage(target, screenshotPath, "Flow Music 登录页面");

    // Wait for login to complete (up to 2 minutes)
    await page.waitForFunction(
      (loginSignalTexts) => {
        const currentUrl = window.location.href;
        if (/accounts\.google\.com|signin|login|oauth/i.test(currentUrl)) {
          return false;
        }

        const selectors = [
          'textarea[placeholder*="描述"]',
          'textarea[placeholder*="prompt"]',
          'textarea[placeholder*="Describe"]',
          'textarea[placeholder*="Prompt"]',
          'textarea[placeholder*="Ask Producer"]',
          'textarea[aria-label*="Ask Producer"]',
          '[data-testid="compose-input"]',
          '[data-testid="user-avatar"]',
          'button[aria-label*="Compose"]',
        ];
        if (selectors.some((sel) => document.querySelector(sel))) {
          return true;
        }

        const pageText = document.body?.innerText ?? "";
        const matchedSignals = loginSignalTexts.filter((text) => pageText.includes(text)).length;
        return window.location.pathname.includes("/session/") || matchedSignals >= 3;
      },
      { timeout: 120_000 }
      ,
      [...LOGIN_SIGNAL_TEXTS]
    ).catch(() => {});

    const nowLoggedIn = await isLoggedIn(page);
    if (nowLoggedIn) {
      await saveCookies(page);
      await ctx.replyText(message, "[Flow Music] 登录成功！现在可以使用了。");
    } else {
      await ctx.replyText(message, "[Flow Music] 登录超时，请重试。");
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await ctx.replyText(message, `[Flow Music] 登录失败：${errMsg}`);
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}

function formatSessionList(prefix: string, sessions: FlowSessionEntry[]): string {
  if (sessions.length === 0) {
    return `[Flow Music] 暂无可继续的会话。\n使用 ${prefix}flow <描述> 先生成一轮。`;
  }
  const lines = sessions.slice(0, 5).map((entry, index) => {
    const titleText = entry.titles.length > 0 ? entry.titles.join(" / ") : "未命名";
    return `${index + 1}. ${entry.conversationId} | ${titleText}`;
  });
  return `[Flow Music] 最近会话：\n${lines.join("\n")}\n继续微调：${prefix}flow continue <sessionId|last> <意见>`;
}
