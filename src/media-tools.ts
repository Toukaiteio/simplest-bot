import path from "node:path";
import type { BotToolRegistration } from "./tooling.js";
import type { OneBotClient } from "./onebot.js";
import { decodeMediaId } from "./media-ids.js";
import type { PromptBuildInput } from "./types.js";

export type MediaCapabilities = {
  supportsImages: boolean;
  supportsVideo: boolean;
  supportsVoice: boolean;
};

export function createMediaToolRegistrations(
  onebot: OneBotClient,
  capabilities: MediaCapabilities
): BotToolRegistration[] {
  const tools: BotToolRegistration[] = [];

  if (capabilities.supportsImages) {
    tools.push({
      definition: {
        type: "function",
        function: {
          name: "view_image",
          description:
            "当用户消息中包含 [图片 file=...] 占位，且你需要查看该图片内容时调用。调用后图片会被下载并作为独立消息插入到对话中，供你直接理解。",
          parameters: {
            type: "object",
            properties: {
              file_id: {
                type: "string",
                description: "图片占位符中的 file 值，例如 [图片 file=abc123] 中的 abc123。",
              },
            },
            required: ["file_id"],
          },
        },
      },
      execute: async (args: Record<string, unknown>) => {
        const fileId = decodeMediaId(String(args.file_id ?? ""));
        if (!fileId) return "未提供有效的图片 file_id。";

        const filePath = await onebot.getImageFile(fileId);
        if (!filePath) return `无法获取图片文件：${fileId}`;

        const base64 = await onebot.downloadFileToBase64(filePath);
        if (!base64) return `已找到图片文件 ${filePath}，但读取失败。`;

        const mime = inferImageMime(filePath);
        return {
          text: `已下载并缓存图片 ${fileId}，接下来会把它展示给你。`,
          media: [{ type: "image" as const, mime, base64 }],
        };
      },
    });
  }

  if (capabilities.supportsVideo) {
    tools.push({
      definition: {
        type: "function",
        function: {
          name: "view_video",
          description:
            "当用户消息中包含 [视频 file=...] 占位，且你需要查看该视频内容时调用。当前仅返回视频文件路径/大小等元信息（后续可扩展抽帧）。",
          parameters: {
            type: "object",
            properties: {
              file_id: {
                type: "string",
                description: "视频占位符中的 file 值。",
              },
            },
            required: ["file_id"],
          },
        },
      },
      execute: async (args: Record<string, unknown>) => {
        const fileId = decodeMediaId(String(args.file_id ?? ""));
        if (!fileId) return "未提供有效的视频 file_id。";
        const filePath = await onebot.getVideoFile(fileId);
        return filePath
          ? `已获取视频文件：${filePath}。当前配置不直接解析视频画面，如需抽帧请另行扩展。`
          : `无法获取视频文件：${fileId}`;
      },
    });
  }

  if (capabilities.supportsVoice) {
    tools.push({
      definition: {
        type: "function",
        function: {
          name: "view_voice",
          description:
            "当用户消息中包含 [语音 file=...] 占位，且你需要了解语音内容时调用。当前仅返回语音文件路径，转写能力需接入 ASR。",
          parameters: {
            type: "object",
            properties: {
              file_id: {
                type: "string",
                description: "语音占位符中的 file 值。",
              },
            },
            required: ["file_id"],
          },
        },
      },
      execute: async (args: Record<string, unknown>) => {
        const fileId = decodeMediaId(String(args.file_id ?? ""));
        if (!fileId) return "未提供有效的语音 file_id。";
        const filePath = await onebot.getRecordFile(fileId);
        return filePath
          ? `已获取语音文件：${filePath}。当前配置不直接转写语音内容，请基于路径回复。`
          : `无法获取语音文件：${fileId}`;
      },
    });
  }

  return tools;
}

function inferImageMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}
