import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { Plugin, PromptBuildInput, NotifyTarget } from "../types.js";
import type { BotToolRegistration } from "../tooling.js";

export type SearchProviderConfig = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
};

export type SearchPluginConfig = {
  providers: SearchProviderConfig[];
  defaultProvider: string;
  maxResultChars: number;
};

export function createSearchPlugin(): Plugin {
  return {
    name: "search",
    description: "网络搜索插件（通过配置的模型代理搜索，无需搜索引擎 API Key）",
  };
}

export function searchToolRegistration(
  config: SearchPluginConfig,
  sendMessage?: (target: NotifyTarget, text: string) => Promise<void>
): BotToolRegistration {
  const provider = config.providers.find((p) => p.name === config.defaultProvider)
    ?? config.providers[0];

  return {
    definition: {
      type: "function",
      function: {
        name: "web_search",
        description:
          "搜索互联网获取最新信息。当你需要了解实时新闻、百科知识、特定网站内容或其他网络信息时使用此工具。" +
          "mode=full 时搜索结果将直接作为回复发送给用户（过长自动转为合并转发），你无需重复回复。",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索查询词，尽量准确简短",
            },
            mode: {
              type: "string",
              enum: ["half", "full", "auto"],
              description:
                "half：结果返回给你整理再回复；full：结果直接作为回复发送给用户并加入到上下文，你无需再回复；auto：默认 half",
            },
          },
          required: ["query"],
        },
      },
    },
    async execute(args: Record<string, unknown>, input: PromptBuildInput) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        throw new Error("搜索关键词不能为空。");
      }
      const modeRaw = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "";
      const mode = modeRaw === "full" ? "full" : "half";

      const result = await searchViaLLM(provider, query, config.maxResultChars);

      if (mode === "full") {
        // 全委托：将结果直接发送给用户，并标记为最终回复
        if (sendMessage) {
          const target = getTargetForInput(input);
          await sendMessage(target, `🔍 搜索结果：${query}\n\n${result}`);
        }
        return {
          text: `搜索结果已直接发送。\n\n${result}`,
          final: true,
        };
      }

      // 半委托：返回结果给模型整理
      return result;
    },
  };
}

async function searchViaLLM(
  provider: SearchProviderConfig,
  query: string,
  maxChars: number
): Promise<string> {
  const chatModel = new ChatOpenAI({
    modelName: provider.model,
    configuration: { baseURL: provider.baseUrl },
    apiKey: provider.apiKey || undefined,
    maxTokens: maxChars,
  });

  const systemMsg = new SystemMessage(
    provider.systemPrompt
    ?? "你是一个网络搜索助手。当用户提出问题时，你会进行网络搜索并返回准确、简洁的答案。请注明信息来源。"
  );
  const userMsg = new HumanMessage(query);

  try {
    const response = await chatModel.invoke([systemMsg, userMsg]);
    const content = typeof response.content === "string"
      ? response.content
      : "（搜索无返回）";

    if (content.length > maxChars) {
      return content.slice(0, maxChars) + "\n\n[搜索结果已截断]";
    }
    return content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `搜索失败：${message}`;
  }
}

function getTargetForInput(input: PromptBuildInput): NotifyTarget {
  const msg = input.mode === "single" ? input.message : input.messages[input.messages.length - 1];
  if (msg.type === "group" && msg.groupId) {
    return { type: "group", id: msg.groupId };
  }
  return { type: "private", id: msg.userId ?? "unknown" };
}
