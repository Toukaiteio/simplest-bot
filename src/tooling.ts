import type { ChatOpenAICallOptions } from "@langchain/openai";
import type { PromptBuildInput } from "./types.js";

export type BotToolDefinition = NonNullable<ChatOpenAICallOptions["tools"]>[number];

export type ToolMediaAttachment = {
  type: "image";
  mime: string;
  base64: string;
};

export type ToolExecuteResult =
  | string
  | {
      text: string;
      media?: ToolMediaAttachment[];
      /** 标记此结果为最终回复，跳过模型后续生成 */
      final?: boolean;
      /** Internal delivery marker used when a tool has already sent a fallback response. */
      deliveredText?: string;
    };

export type BotToolRegistration = {
  definition: BotToolDefinition;
  execute: (args: Record<string, unknown>, input: PromptBuildInput) => Promise<ToolExecuteResult>;
};
