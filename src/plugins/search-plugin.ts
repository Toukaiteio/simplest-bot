import type { Plugin, PromptBuildInput } from "../types.js";
import type { BotToolRegistration } from "../tooling.js";

export type SearchProviderName = "tavily" | "serper" | "duckduckgo";

/** 单个 Tavily 兼容端点（用于多端点负载均衡 + 失败回退）。 */
export type TavilyEndpoint = {
  name?: string;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
};

export type SearchPluginConfig = {
  defaultProvider: string;
  maxResults: number;
  timeoutMs: number;
  maxResultChars: number;
  tavily: {
    baseUrl: string;
    apiKey: string;
    searchDepth: "basic" | "advanced";
    topic: "general" | "news" | "finance";
    includeAnswer: boolean;
    includeRawContent: boolean;
    /** 追加的多个 Tavily 兼容端点；开启后与 tavily 基础配置共同参与负载均衡与失败回退。 */
    endpoints?: TavilyEndpoint[];
  };
  serper: {
    baseUrl: string;
    apiKey: string;
    gl: string;
    hl: string;
  };
  duckduckgo: {
    baseUrl: string;
    region: string;
    safeSearch: "strict" | "moderate" | "off";
  };
  /** Kept for parsing old config files; it is not used by the new provider implementation. */
  providers?: unknown[];
};

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type SearchResponse = {
  provider: SearchProviderName;
  answer?: string;
  results: SearchResult[];
};

export function createSearchPlugin(): Plugin {
  return {
    name: "search",
    description: "网络搜索插件（支持 Tavily、Serper、DuckDuckGo）",
  };
}
export function searchToolRegistration(
  config: SearchPluginConfig,
  _legacySendMessage?: unknown,
): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: {
        name: "web_search",
        description:
          "搜索互联网获取最新信息。当你需要了解实时新闻、百科知识、特定网站内容或其他网络信息时使用此工具。" +
          "支持在 provider 参数中选择 tavily、serper 或 duckduckgo。",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索查询词，尽量准确简短",
            },
            provider: {
              type: "string",
              enum: ["tavily", "serper", "duckduckgo"],
              description: "可选搜索供应商；不填时使用配置中的 defaultProvider",
            },
            mode: {
              type: "string",
              enum: ["half", "full", "auto"],
              description:
                "half/auto/full：返回结果给 Agent 整理；最终正文必须通过 send_current_reply 提交",
            },
          },
          required: ["query"],
        },
      },
    },
    async execute(args: Record<string, unknown>, _input: PromptBuildInput) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        throw new Error("搜索关键词不能为空。");
      }
      if (query.length > 500) {
        throw new Error("搜索关键词不能超过 500 个字符。");
      }

      const provider = resolveProvider(
        typeof args.provider === "string" ? args.provider : config.defaultProvider,
      );
      const result = await searchWeb(config, provider, query);
      const formatted = formatSearchResponse(query, result, config.maxResultChars);

      // Keep the legacy mode parameter for compatibility, but never mark
      // search output as final: the work-agent must submit every user-visible
      // response through send_current_reply.
      return formatted;
    },
  };
}

export async function searchWeb(
  config: SearchPluginConfig,
  provider: SearchProviderName,
  query: string,
): Promise<SearchResponse> {
  switch (provider) {
    case "tavily":
      return searchWithTavily(config, query);
    case "serper":
      return searchWithSerper(config, query);
    case "duckduckgo":
      return searchWithDuckDuckGo(config, query);
  }
}

function resolveProvider(value: string): SearchProviderName {
  const normalized = value.trim().toLowerCase();
  if (normalized === "tavily" || normalized === "serper" || normalized === "duckduckgo") {
    return normalized;
  }
  return "duckduckgo";
}

async function searchWithTavily(config: SearchPluginConfig, query: string): Promise<SearchResponse> {
  const provider = config.tavily;

  // 收集所有可用 Tavily 端点：基础配置 + 追加的 endpoints 数组。
  const primary: TavilyEndpoint = {
    name: "tavily-primary",
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
  };
  const endpoints: TavilyEndpoint[] = [primary];
  if (Array.isArray(provider.endpoints)) {
    for (const ep of provider.endpoints) {
      if (ep.enabled !== false && ep.baseUrl?.trim() && ep.apiKey?.trim()) {
        endpoints.push({ name: ep.name || "tavily", baseUrl: ep.baseUrl, apiKey: ep.apiKey });
      }
    }
  }

  const active = endpoints.filter((ep) => ep.apiKey.trim());
  if (active.length === 0) {
    throw new Error("Tavily 未配置 API Key，请在 pluginSettings.search.tavily.apiKey 或 tavily.endpoints 中填写。");
  }

  // 负载均衡：轮询起始端点，避免每次都从第一个端点发起，从而分散流量。
  const startIndex = nextTavilyIndex(active.length);
  const order = buildRoundRobinOrder(active.length, startIndex);

  // 错误回退：逐个尝试，任何一步成功即返回；全部失败则抛出最后一个错误。
  let lastError: unknown = null;
  for (const index of order) {
    const ep = active[index];
    try {
      return await tavilySearchOnce(config, provider, ep, query);
    } catch (error) {
      lastError = error;
      console.warn(
        `[Search] Tavily 端点回退：${ep.name || ep.baseUrl} 失败，共 ${active.length} 个端点。`,
      );
    }
  }
  throw new Error(
    `所有 Tavily 端点均搜索失败（${active.length} 个）。最后错误：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * 对单个 Tavily 端点执行一次搜索请求。
 * 部分代理会把 /search 封装在 baseUrl 中（无后缀），因此这里做兼容：
 * 若 baseUrl 已含/search（以 /search 结尾）则直接使用，否则拼接 /search。
 */
async function tavilySearchOnce(
  config: SearchPluginConfig,
  provider: SearchPluginConfig["tavily"],
  ep: TavilyEndpoint,
  query: string,
): Promise<SearchResponse> {
  const endpointUrl = /\/search\/?$/i.test(ep.baseUrl) ? ep.baseUrl : joinUrl(ep.baseUrl, "/search");
  const payload = await requestJson(
    endpointUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ep.apiKey}`,
      },
      body: JSON.stringify({
        query,
        topic: provider.topic,
        search_depth: provider.searchDepth,
        max_results: config.maxResults,
        include_answer: provider.includeAnswer,
        include_raw_content: provider.includeRawContent,
      }),
    },
    config.timeoutMs,
  );

  const data = asRecord(payload);
  if (!Array.isArray(data.results)) {
    // 某些代理即使返回 200，也可能不含 results 或结构不一致。
    throw new Error("Tavily 响应缺少 results 字段。");
  }
  const results = data.results
    .map((item) => {
      const row = asRecord(item);
      return normalizeResult(row.title, row.url, row.content ?? row.raw_content);
    })
    .filter((result): result is SearchResult => result !== null)
    .slice(0, config.maxResults);

  return {
    provider: "tavily",
    answer: typeof data.answer === "string" ? data.answer : undefined,
    results,
  };
}

let tavilyRoundRobinCursor = 0;

/** 轮询游标：返回本次应优先使用的端点索引，并推进游标。 */
function nextTavilyIndex(count: number): number {
  if (count <= 1) return 0;
  const index = tavilyRoundRobinCursor % count;
  tavilyRoundRobinCursor = (tavilyRoundRobinCursor + 1) % count;
  return index;
}

/** 构建从 startIndex 开始的轮询顺序（用于失败时顺延回退）。 */
function buildRoundRobinOrder(count: number, startIndex: number): number[] {
  const order: number[] = [];
  for (let i = 0; i < count; i++) {
    order.push((startIndex + i) % count);
  }
  return order;
}

async function searchWithSerper(config: SearchPluginConfig, query: string): Promise<SearchResponse> {
  const provider = config.serper;
  if (!provider.apiKey.trim()) {
    throw new Error("Serper 未配置 API Key，请在 pluginSettings.search.serper.apiKey 中填写。");
  }

  const payload = await requestJson(
    joinUrl(provider.baseUrl, "/search"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": provider.apiKey,
      },
      body: JSON.stringify({
        q: query,
        num: config.maxResults,
        gl: provider.gl,
        hl: provider.hl,
      }),
    },
    config.timeoutMs,
  );

  const data = asRecord(payload);
  const rawResults = Array.isArray(data.organic) ? data.organic : [];
  const results = rawResults
    .map((item) => {
      const row = asRecord(item);
      return normalizeResult(row.title, row.link, row.snippet);
    })
    .filter((result): result is SearchResult => result !== null)
    .slice(0, config.maxResults);

  const answerBox = asRecord(data.answerBox);
  const knowledgeGraph = asRecord(data.knowledgeGraph);
  const answer = firstString(answerBox.answer, answerBox.snippet, knowledgeGraph.description);

  return { provider: "serper", answer, results };
}

async function searchWithDuckDuckGo(config: SearchPluginConfig, query: string): Promise<SearchResponse> {
  const provider = config.duckduckgo;
  const url = new URL(provider.baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("no_redirect", "1");
  url.searchParams.set("skip_disambig", "1");
  url.searchParams.set("kl", provider.region);
  url.searchParams.set("safe_search", provider.safeSearch);

  const payload = await requestJson(url.toString(), {
    headers: { "user-agent": "simplest-bot/1.0" },
  }, config.timeoutMs);
  const data = asRecord(payload);
  const results: SearchResult[] = [];

  const abstractUrl = typeof data.AbstractURL === "string" ? data.AbstractURL : "";
  const abstractText = typeof data.AbstractText === "string" ? data.AbstractText : "";
  const heading = typeof data.Heading === "string" ? data.Heading : "";
  if (abstractUrl && (abstractText || heading)) {
    results.push({
      title: heading || "DuckDuckGo 摘要",
      url: abstractUrl,
      snippet: abstractText || heading,
    });
  }

  appendDuckDuckGoTopics(results, data.RelatedTopics);
  return {
    provider: "duckduckgo",
    answer: typeof data.Answer === "string" && data.Answer.trim() ? data.Answer : undefined,
    results: deduplicateResults(results).slice(0, config.maxResults),
  };
}

function appendDuckDuckGoTopics(results: SearchResult[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const row = asRecord(item);
    if (typeof row.Topics !== "undefined") {
      appendDuckDuckGoTopics(results, row.Topics);
      continue;
    }
    const result = normalizeResult(row.Text, row.FirstURL, row.Text);
    if (result) results.push(result);
  }
}

function normalizeResult(title: unknown, url: unknown, snippet: unknown): SearchResult | null {
  const resultUrl = typeof url === "string" ? url.trim() : "";
  if (!resultUrl || !/^https?:\/\//i.test(resultUrl)) return null;
  const resultTitle = cleanText(typeof title === "string" ? title : "") || resultUrl;
  const resultSnippet = cleanText(typeof snippet === "string" ? snippet : "") || "（无摘要）";
  return { title: resultTitle, url: resultUrl, snippet: resultSnippet };
}

function formatSearchResponse(query: string, response: SearchResponse, maxChars: number): string {
  const providerLabel = response.provider === "duckduckgo"
    ? "DuckDuckGo"
    : response.provider === "tavily" ? "Tavily" : "Serper";
  const lines = [`🔍 搜索结果（${providerLabel}）：${query}`];
  if (response.answer) {
    lines.push("", `摘要：${cleanText(response.answer)}`);
  }
  if (response.results.length === 0) {
    lines.push("", "未找到可用结果。可以尝试换一个更具体的关键词，或切换搜索供应商。");
  } else {
    response.results.forEach((result, index) => {
      lines.push("", `${index + 1}. ${result.title}`, `   ${result.snippet}`, `   来源：${result.url}`);
    });
  }

  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[搜索结果已截断]` : text;
}

async function requestJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`搜索请求失败：HTTP ${response.status}${text ? ` - ${text.slice(0, 300)}` : ""}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("搜索服务返回了无法解析的 JSON。");
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`搜索请求超时（${timeoutMs}ms）。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function cleanText(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}
