import type { Plugin, PromptBuildInput } from "../types.js";
import type { BotToolRegistration } from "../tooling.js";

export function createWebFetchPlugin(): Plugin {
  return {
    name: "webfetch",
    description: "网页抓取工具（Function Calling）",
  };
}

export const webfetchTool = {
  type: "function" as const,
  function: {
    name: "fetch_webpage",
    description: "抓取指定 URL 的网页内容",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要抓取的网页 URL",
        },
      },
      required: ["url"],
    },
  },
};

export const webfetchToolRegistration: BotToolRegistration = {
  definition: webfetchTool,
  async execute(args: Record<string, unknown>, _input: PromptBuildInput) {
    const url = typeof args.url === "string" ? args.url : "";
    if (!url) {
      throw new Error("url 不能为空。");
    }

    const response = await fetch(url, {
      headers: {
        "user-agent": "simplest-bot/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`抓取失败：HTTP ${response.status}`);
    }

    const text = await response.text();
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > 5000 ? `${compact.slice(0, 5000)}\n\n[内容已截断]` : compact;
  },
};
