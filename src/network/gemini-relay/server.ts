/**
 * gemini-web2api 的 Node.js 移植：HTTP 服务端（node:http）。
 * 纯文本通道：/v1/chat/completions（流式+非流式）、/v1/models、/v1beta/models、
 * /v1beta/models/*:generateContent（流式+非流式）、健康检查、api_keys 鉴权。
 * 未实现（TODO）：/v1/responses、/v1/caches、图片上传。
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import { resolveModel, GEMINI_MODELS, type ResolvedModel } from "./models.js";
import { messagesToPrompt, googleContentsToPrompt, type GoogleContent } from "./prompt.js";
import { createGeminiImageUploader, type ImagePart } from "./multimodal.js";
import {
  generateRelayText,
  type FetchLike,
  type GeminiUpstreamConfig,
} from "./upstream.js";
import { createDispatcher } from "../proxy.js";
import type { ProxyConfig } from "../../types.js";

const RELAY_VERSION = "1.1.0";
const EMPTY_RESPONSE_FALLBACK = "I apologize, but I was unable to generate a response. Please try again.";

export type GeminiRelayServerConfig = {
  host: string;
  port: number;
  cookieFile: string;
  xsrfToken: string;
  authUser: string;
  geminiBl: string;
  defaultModel: string;
  requestTimeoutSec: number;
  retryAttempts: number;
  retryDelaySec: number;
  logRequests: boolean;
  temporaryChats: boolean;
  apiKeys: string[];
  /** 上游 gemini.google.com 的专用代理。未设置时沿用全局 fetch（已由 configureGlobalProxy 包装）。 */
  proxy?: ProxyConfig;
};

export type GeminiRelayServer = {
  start: () => Promise<void>;
  close: () => Promise<void>;
  port: number;
  host: string;
};

/**
 * 构造 relay 上游请求的 fetch。
 * - proxy 未设置或 enabled=false → 直接返回 fetchImpl（默认 undiciFetch，遵循全局 dispatcher，
 *   即沿用 configureGlobalProxy 设置的全局代理）。
 * - proxy 已设置且 enabled → 用 fetchImpl + 专用 dispatcher，使 gemini.google.com 走独立代理通道，
 *   与 bot 其它出站流量解耦（例如全局直连、而 Gemini 上游需要科学上网）。
 *
 * 注意：代理分支必须用 undiciFetch（而非 globalThis.fetch）调用，因为 configureGlobalProxy
 * 包装的 globalThis.fetch 会用全局 dispatcher 覆盖 init 里的 dispatcher；直接用 undiciFetch
 * 才能把 relay 的专用 dispatcher 生效。
 *
 * @param fetchImpl 供测试注入 spy；默认 undiciFetch。
 */
export function buildRelayFetchFn(
  proxy?: ProxyConfig,
  fetchImpl: FetchLike = (input, init) => undiciFetch(input as never, init as never) as unknown as Promise<Response>,
): FetchLike {
  if (!proxy || !proxy.enabled) return fetchImpl;
  const dispatcher = createDispatcher(proxy);
  return ((input, init) =>
    fetchImpl(input, { ...(init ?? {}), dispatcher } as never)) as FetchLike;
}

export function createGeminiRelayServer(
  config: GeminiRelayServerConfig,
  options: { fetchFn?: FetchLike; log?: (message: string) => void } = {},
): GeminiRelayServer {
  const log = options.log ?? ((message: string) => console.log(message));
  const relayFetchFn = options.fetchFn ?? buildRelayFetchFn(config.proxy);
  const upstreamConfig: GeminiUpstreamConfig = {
    cookieFile: config.cookieFile,
    xsrfToken: config.xsrfToken,
    authUser: config.authUser,
    geminiBl: config.geminiBl,
    requestTimeoutSec: config.requestTimeoutSec,
    retryAttempts: config.retryAttempts,
    retryDelaySec: config.retryDelaySec,
    temporaryChats: config.temporaryChats,
    logRequests: config.logRequests,
    fetchFn: relayFetchFn,
  };

  // 图片上传器：复用与上游相同的 fetch（测试注入 options.fetchFn；生产走 relay 专用代理）
  // + cookie 鉴权；内部带页面 token 缓存。
  const imageUploader = createGeminiImageUploader({
    cookieFile: config.cookieFile,
    fetchFn: relayFetchFn,
    log: (message) => log(message),
  });

  let server: http.Server | null = null;
  let boundPort = config.port;

  /** 逐张上传图片 part → file refs；单张失败视为整体失败（与 python 一致）。 */
  async function uploadImageRefs(images: ImagePart[]): Promise<string[]> {
    const refs: string[] = [];
    for (const image of images) {
      const resolved = await imageUploader.resolveImage(image);
      const mime = resolved.mime || "image/png";
      const ref = await imageUploader.uploadImage(resolved.bytes, mime);
      refs.push(ref);
    }
    return refs;
  }

  /** 有图：上传为 refs 后走上游；无图：退化为纯文本。任一步骤失败抛错由调用方转 5xx。 */
  async function generateWithImages(
    prompt: string,
    images: ImagePart[],
    resolved: ResolvedModel,
  ): Promise<string> {
    let refs: string[] | undefined;
    if (images.length > 0) {
      refs = await uploadImageRefs(images);
    }
    return generateRelayText(prompt, resolved, upstreamConfig, refs);
  }

  async function start(): Promise<void> {
    server = http.createServer((request, response) => {
      void handleRequest(request, response).catch((error) => {
        try {
          sendJson(response, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
        } catch {
          // 响应可能已开始发送。
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(config.port, config.host, () => {
        server!.off("error", reject);
        const address = server!.address();
        if (typeof address === "object" && address !== null) boundPort = address.port;
        resolve();
      });
    });
    log(`[Relay] 已监听 http://${config.host}:${boundPort}（gemini-web2api Node 版 v${RELAY_VERSION}）`);
  }

  async function close(): Promise<void> {
    const current = server;
    server = null;
    if (!current) return;
    await new Promise<void>((resolve) => current.close(() => resolve()));
  }

  async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    const url = parseRequestUrl(request.url ?? "/");
    const path = url.pathname;

    if (request.method === "GET") {
      if (path === "/") {
        sendJson(response, 200, {
          status: "ok",
          version: RELAY_VERSION,
          models: Object.keys(GEMINI_MODELS),
        });
        return;
      }
      if (path === "/v1/models") {
        if (!isAuthorized(request, config.apiKeys, path)) {
          sendJson(response, 401, { error: { message: "invalid api key" } });
          return;
        }
        sendJson(response, 200, {
          object: "list",
          data: Object.entries(GEMINI_MODELS).map(([id, model]) => ({
            id,
            object: "model",
            created: 1700000000,
            owned_by: "google",
            description: model.desc,
          })),
        });
        return;
      }
      if (path === "/v1beta/models") {
        sendJson(response, 200, {
          models: Object.entries(GEMINI_MODELS).map(([name, model]) => ({
            name: `models/${name}`,
            displayName: name,
            description: model.desc,
            supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
          })),
        });
        return;
      }
      if (path.startsWith("/v1/caches/")) {
        sendJson(response, 404, { error: { message: "cache not found" } });
        return;
      }
      sendJson(response, 404, { error: "not found" });
      return;
    }

    if (request.method === "POST") {
      if (!isAuthorized(request, config.apiKeys, path)) {
        sendJson(response, 401, { error: { message: "invalid api key" } });
        return;
      }

      if (path === "/v1/chat/completions") {
        await handleChatCompletions(request, response, url.searchParams);
        return;
      }
      const googleMatch = path.match(/^\/v1beta\/models\/([^:?]+)(?::(generateContent|streamGenerateContent))?$/u);
      if (googleMatch) {
        const modelName = googleMatch[1] ?? config.defaultModel;
        const stream = googleMatch[2] === "streamGenerateContent";
        await handleGenerateContent(request, response, modelName, stream);
        return;
      }
      if (path === "/v1/caches") {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      if (path === "/v1/responses") {
        // TODO: Responses API（Codex CLI 兼容面）未实现。
        sendJson(response, 404, { error: "not found" });
        return;
      }
      sendJson(response, 404, { error: "not found" });
      return;
    }

    sendJson(response, 404, { error: "not found" });
  }

  async function handleChatCompletions(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    query: URLSearchParams,
  ): Promise<void> {
    const body = await readRequestBody(request);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      sendJson(response, 400, { error: { message: "invalid JSON" } });
      return;
    }

    const resolved = resolveModel(
      typeof payload.model === "string" ? payload.model : config.defaultModel,
      config.defaultModel,
    );
    if (resolved.error) {
      sendJson(response, 400, { error: { message: resolved.error } });
      return;
    }

    const messages = Array.isArray(payload.messages) ? payload.messages as never[] : [];
    const flattened = messagesToPrompt(messages);
    const prompt = flattened.prompt.trim();
    if (!prompt) {
      sendJson(response, 400, { error: { message: "empty prompt" } });
      return;
    }
    const images = flattened.images;

    const stream = payload.stream === true;
    const runStream = stream && noTools(payload);
    if (runStream) {
      await streamChatCompletions(response, prompt, images, resolved);
      return;
    }
    await completeChatCompletions(response, prompt, images, resolved);
  }

  function noTools(payload: Record<string, unknown>): boolean {
    const tools = payload.tools;
    if (!Array.isArray(tools) || tools.length === 0) return true;
    const toolChoice = payload.tool_choice;
    return toolChoice === "none";
  }

  async function completeChatCompletions(
    response: http.ServerResponse,
    prompt: string,
    images: ImagePart[],
    resolved: ResolvedModel,
  ): Promise<void> {
    let text: string;
    try {
      text = await generateWithImages(prompt, images, resolved);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[Relay] 非流式上游调用失败（重试耗尽）：${reason}`);
      sendJson(response, 502, { error: { message: `upstream error: ${reason}` } });
      return;
    }
    const modelName = resolved.name;
    const message: Record<string, unknown> = { role: "assistant", content: text || null };
    const finish = "stop";
    sendJson(response, 200, {
      id: `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: usageEstimate(prompt, text),
    });
  }

  async function streamChatCompletions(
    response: http.ServerResponse,
    prompt: string,
    images: ImagePart[],
    resolved: ResolvedModel,
  ): Promise<void> {
    // 虽然 SSE 协议在接口层保留（pi-ai 客户端硬编码 stream:true），但内部走
    // 非流式生成：上游响应本就是全量缓冲的假流，bot 侧回复也是整段交付。
    // 换来的关键收益：上游错误/空响应可在尚未发出任何内容前整轮重试，
    // 重试耗尽返回 502 让客户端回退其它提供商，而不是把半截回复发给用户。
    // 正文内容（含疑似拒绝话术）不做重试，诚实转发。
    let text: string;
    try {
      text = await generateWithImages(prompt, images, resolved);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[Relay] 流式上游调用失败（重试耗尽）：${reason}`);
      sendJson(response, 502, { error: { message: `upstream error: ${reason}` } });
      return;
    }

    const modelName = resolved.name;
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
      "Connection": "keep-alive",
    });

    sendSse(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelName,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });

    if (text) {
      sendSse(response, {
        id,
        object: "chat.completion.chunk",
        created,
        model: modelName,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
    }

    sendSse(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelName,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    sendSse(response, {
      choices: [],
      usage: usageEstimate(prompt, text),
    });
    response.write("data: [DONE]\n\n");
    response.end();
  }

  async function handleGenerateContent(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    modelName: string,
    stream: boolean,
  ): Promise<void> {
    const body = await readRequestBody(request);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      sendJson(response, 400, { error: { message: "invalid JSON" } });
      return;
    }

    const resolved = resolveModel(modelName, config.defaultModel);
    if (resolved.error) {
      sendJson(response, 400, { error: { message: resolved.error } });
      return;
    }

    const contents = Array.isArray(payload.contents) ? payload.contents as GoogleContent[] : [];
    const systemInstruction = payload.systemInstruction as { parts?: GoogleContent["parts"] } | undefined;
    const googlePrompt = googleContentsToPrompt(systemInstruction, contents);
    const prompt = googlePrompt.prompt.trim();
    if (!prompt) {
      sendJson(response, 400, { error: { message: "empty prompt" } });
      return;
    }
    const images = googlePrompt.images;

    if (stream) {
      await streamGenerateContent(response, prompt, images, resolved);
    } else {
      await completeGenerateContent(response, prompt, images, resolved);
    }
  }

  async function completeGenerateContent(
    response: http.ServerResponse,
    prompt: string,
    images: ImagePart[],
    resolved: ResolvedModel,
  ): Promise<void> {
    let text: string;
    try {
      text = await generateWithImages(prompt, images, resolved);
    } catch (error) {
      sendJson(response, 502, { error: { message: `upstream error: ${error instanceof Error ? error.message : String(error)}` } });
      return;
    }
    const contentText = text || EMPTY_RESPONSE_FALLBACK;
    sendJson(response, 200, {
      candidates: [{
        content: { parts: [{ text: contentText }], role: "model" },
        finishReason: "STOP",
        index: 0,
      }],
      usageMetadata: googleUsageEstimate(prompt, text),
      modelVersion: resolved.name,
    });
  }

  async function streamGenerateContent(
    response: http.ServerResponse,
    prompt: string,
    images: ImagePart[],
    resolved: ResolvedModel,
  ): Promise<void> {
    // 与 streamChatCompletions 相同：SSE 接口保留，内部走非流式生成以获得
    // 发送前整轮重试（上游错误/空响应）与 502 回退语义。
    let text: string;
    try {
      text = await generateWithImages(prompt, images, resolved);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[Relay] generateContent 上游调用失败（重试耗尽）：${reason}`);
      sendJson(response, 502, { error: { message: `upstream error: ${reason}` } });
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
      "Connection": "keep-alive",
    });

    if (text) {
      sendSse(response, {
        candidates: [{
          content: { parts: [{ text }], role: "model" },
          index: 0,
        }],
        modelVersion: resolved.name,
      });
    }

    sendSse(response, {
      candidates: [{ finishReason: "STOP", index: 0 }],
      usageMetadata: googleUsageEstimate(prompt, text),
      modelVersion: resolved.name,
    });
    response.end();
  }

  return {
    start,
    close,
    host: config.host,
    get port(): number {
      return boundPort;
    },
  };
}

function usageEstimate(prompt: string, completion: string): Record<string, unknown> {
  return {
    prompt_tokens: Math.floor(prompt.length / 4),
    completion_tokens: Math.floor((completion ?? "").length / 4),
    total_tokens: Math.floor((prompt.length + (completion ?? "").length) / 4),
    prompt_tokens_details: { cached_tokens: 0 },
  };
}

function googleUsageEstimate(prompt: string, completion: string): Record<string, unknown> {
  return {
    promptTokenCount: Math.floor(prompt.length / 4),
    candidatesTokenCount: Math.floor((completion ?? "").length / 4),
    totalTokenCount: Math.floor((prompt.length + (completion ?? "").length) / 4),
  };
}

function sendSse(response: http.ServerResponse, data: unknown): void {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendJson(response: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function isAuthorized(request: http.IncomingMessage, apiKeys: string[], path: string): boolean {
  if (apiKeys.length === 0) return true;
  if (!path.startsWith("/v1")) return true; // /v1beta 不鉴权（与 python 一致）
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    if (apiKeys.includes(authorization.slice("Bearer ".length).trim())) return true;
  }
  const apiKeyHeader = request.headers["x-api-key"] ?? request.headers["x-goog-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeys.includes(apiKeyHeader)) return true;
  const qs = new URL(request.url ?? "/", "http://localhost").searchParams;
  const queryKey = qs.get("key");
  if (queryKey && apiKeys.includes(queryKey)) return true;
  return false;
}

function parseRequestUrl(raw: string): URL {
  return new URL(raw, "http://localhost");
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const transferEncoding = String(request.headers["transfer-encoding"] ?? "").toLowerCase();
  if (transferEncoding.includes("chunked")) {
    return readChunkedBody(request);
  }
  const length = Number(request.headers["content-length"] ?? 0);
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    received += buffer.length;
    if (received > length) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** python 同款 chunked 处理：16 进制大小行 + 分块 + CRLF，0 后读 trailer 至空行。 */
async function readChunkedBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  const decoder = new TextDecoder();
  let sizeText = "";
  let readingSize = true;
  let remaining = 0;

  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const text = decoder.decode(chunk, { stream: true });
    let offset = 0;
    while (offset < text.length) {
      if (readingSize) {
        const newline = text.indexOf("\n", offset);
        if (newline === -1) {
          sizeText += text.slice(offset);
          offset = text.length;
          break;
        }
        sizeText += text.slice(offset, newline);
        offset = newline + 1;
        const sizeToken = sizeText.split(";", 1)[0].trim();
        sizeText = "";
        const size = Number.parseInt(sizeToken, 16);
        if (Number.isNaN(size)) throw new Error("invalid chunk size");
        if (size === 0) {
          readingSize = false;
          continue; // 等待 trailer 空行
        }
        remaining = size;
        readingSize = false;
      } else if (remaining > 0) {
        const take = Math.min(remaining, text.length - offset);
        const slice = text.slice(offset, offset + take);
        chunks.push(Buffer.from(slice));
        remaining -= take;
        offset += take;
        if (remaining === 0) {
          // 消费块尾 CRLF
          offset += 2;
          readingSize = true;
        }
      } else {
        // trailer 段：读到空行结束
        const newline = text.indexOf("\n", offset);
        if (newline === -1) {
          offset = text.length;
          break;
        }
        const line = text.slice(offset, newline).trim();
        offset = newline + 1;
        if (line === "") {
          readingSize = true;
          break;
        }
      }
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
