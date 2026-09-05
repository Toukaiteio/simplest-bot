import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import type { Dispatcher } from "undici";
import type { ProxyConfig } from "../types.js";

const originalFetch = globalThis.fetch;
const originalDispatcher = getGlobalDispatcher();
let installedProxyFetch: typeof fetch | null = null;

/**
 * undici Client 默认 maxHeaderSize 取 Node http.maxHeaderSize（16KB）。
 * gemini.google.com/app 的响应头约 26KB（巨型 content-security-policy 列全 Google TLD、
 * reporting-endpoints base64、Set-Cookie），超限会抛 UND_ERR_HEADERS_OVERFLOW，
 * 导致页面 token 抓取（Push-ID/pctx/at，multimodal.ts fetchPageTokens）失败；
 * 而 StreamGenerate 响应头很小不受影响——同一代理通道表现为"能连 StreamGenerate
 * 连不上 /app"。Python urllib 的 http.client 单行上限 64KB，故参考实现不受影响。
 * 这里放宽到 256KB，覆盖超大响应头场景（llhttp 按需增长，平时无额外开销）。
 */
const MAX_RESPONSE_HEADER_SIZE = 256 * 1024;

/**
 * Configure one outbound HTTP dispatcher for the bot process.
 *
 * Node's built-in fetch and the fetch used by pi-ai do not consistently share
 * the npm undici global dispatcher across Node versions. Installing a small
 * undici-backed wrapper makes the configured proxy effective for both paths,
 * while setGlobalDispatcher also covers direct undici consumers.
 */
export function configureGlobalProxy(config: ProxyConfig): void {
  if (!config.enabled) {
    setGlobalDispatcher(originalDispatcher);
    if (installedProxyFetch && globalThis.fetch === installedProxyFetch) {
      globalThis.fetch = originalFetch;
    }
    installedProxyFetch = null;
    console.log("[Network] 全局 HTTP 代理已关闭");
    return;
  }

  const dispatcher = createDispatcher(config);
  setGlobalDispatcher(dispatcher);
  installProxiedFetch(dispatcher);

  const proxyDescription = config.mode === "system"
    ? "system/env + configured fallback"
    : redactProxyUrl(config.url);
  console.log(`[Network] 全局 HTTP 代理已启用：${proxyDescription}`);
}

/**
 * 根据 ProxyConfig 构造 undici dispatcher。
 * 供全局代理与各独立通道（如 gemini-relay 上游）复用，保证代理语义一致。
 */
export function createDispatcher(config: ProxyConfig): Dispatcher {
  const configuredUrl = config.url.trim();
  const noProxy = config.noProxy.trim() || undefined;
  const common = {
    noProxy,
    maxHeaderSize: MAX_RESPONSE_HEADER_SIZE,
  };
  if (config.mode === "custom") {
    return new EnvHttpProxyAgent({
      httpProxy: configuredUrl,
      httpsProxy: configuredUrl,
      ...common,
    });
  }

  // EnvHttpProxyAgent does not implement ALL_PROXY itself. Resolve it here,
  // then keep the configured local proxy as the fallback requested by the bot
  // configuration. Lowercase variables follow common Unix proxy conventions.
  const allProxy = readEnv("all_proxy") ?? readEnv("ALL_PROXY");
  const httpProxy = readEnv("http_proxy") ?? readEnv("HTTP_PROXY") ?? allProxy ?? configuredUrl;
  const httpsProxy = readEnv("https_proxy") ?? readEnv("HTTPS_PROXY") ?? allProxy ?? configuredUrl;
  return new EnvHttpProxyAgent({
    httpProxy,
    httpsProxy,
    ...common,
  });
}

function installProxiedFetch(dispatcher: Dispatcher): void {
  const proxiedFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const requestInit = {
      ...(init ?? {}),
      dispatcher,
    } as unknown;
    return undiciFetch(input as never, requestInit as never) as unknown as ReturnType<typeof fetch>;
  }) as typeof fetch;
  globalThis.fetch = proxiedFetch;
  installedProxyFetch = proxiedFetch;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function redactProxyUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return "configured proxy";
  }
}
