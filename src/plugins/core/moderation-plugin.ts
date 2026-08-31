import { createHash } from "node:crypto";
import type { BotMessage, Plugin, PluginContext } from "../../types.js";

export type ModerationPluginOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  blockFlagged: boolean;
  replyOnBlocked: boolean;
  ownerName: string;
  replyMessage: string;
  replySuffix: string;
  categoryReplies: Record<string, string>;
  failClosed: boolean;
  logScores: boolean;
};

const CATEGORY_LABELS: Record<string, string> = {
  harassment: "骚扰",
  "harassment/threatening": "骚扰·威胁",
  hate: "仇恨",
  "hate/threatening": "仇恨·威胁",
  illicit: "违法",
  "illicit/violent": "违法·暴力",
  "self-harm": "自残",
  "self-harm/intent": "自残·意图",
  "self-harm/instructions": "自残·指引",
  sexual: "色情",
  "sexual/minors": "色情·未成年",
  violence: "暴力",
  "violence/graphic": "暴力·血腥",
};

const GENERIC_BLOCK_REPLY = "对不起，{ownerName}禁止我对这类问题做出回答。";

const DEFAULT_CATEGORY_REPLIES: Record<string, string> = {
  harassment: "对不起，{ownerName}禁止我回应涉及骚扰他人的内容。",
  "harassment/threatening": "对不起，{ownerName}禁止我回应带威胁性的骚扰内容。",
  hate: "对不起，{ownerName}禁止我回应仇恨言论。",
  "hate/threatening": "对不起，{ownerName}禁止我回应带威胁的仇恨言论。",
  illicit: "对不起，{ownerName}禁止我回应涉及违法行为的内容。",
  "illicit/violent": "对不起，{ownerName}禁止我回应涉及违法暴力行为的内容。",
  "self-harm": "对不起，{ownerName}禁止我回应自残相关的内容。请珍爱生命，如有困扰请及时寻求专业帮助。",
  "self-harm/intent": "对不起，{ownerName}禁止我回应自残相关的内容。请珍爱生命，如有困扰请及时寻求专业帮助。",
  "self-harm/instructions": "对不起，{ownerName}禁止我回应自残相关的内容。请珍爱生命，如有困扰请及时寻求专业帮助。",
  sexual: "对不起，{ownerName}禁止我回应涉及色情的内容。",
  "sexual/minors": "对不起，{ownerName}严格禁止我回应涉及未成年人的不当内容。",
  violence: "对不起，{ownerName}禁止我回应暴力相关的内容。",
  "violence/graphic": "对不起，{ownerName}禁止我回应血腥暴力的内容。",
};

const CATEGORY_PRIORITY: string[] = [
  "sexual/minors",
  "self-harm/instructions",
  "self-harm/intent",
  "self-harm",
  "illicit/violent",
  "illicit",
  "hate/threatening",
  "hate",
  "harassment/threatening",
  "harassment",
  "violence/graphic",
  "violence",
  "sexual",
];

type ModerationResult = {
  flagged: boolean;
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
};

function hashUserId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

function flaggedCategoryText(categories: Record<string, boolean>): string {
  return Object.entries(categories)
    .filter(([, flagged]) => flagged === true)
    .map(([name]) => CATEGORY_LABELS[name] ?? name)
    .join("、");
}

function buildBlockReply(categories: Record<string, boolean>, options: ModerationPluginOptions): string {
  const ownerName = options.ownerName.trim() || "大妖精";
  const primaryCategory = CATEGORY_PRIORITY.find((name) => categories[name] === true);
  const template =
    (primaryCategory
      ? options.categoryReplies[primaryCategory] ?? DEFAULT_CATEGORY_REPLIES[primaryCategory]
      : undefined) ??
    options.replyMessage ??
    GENERIC_BLOCK_REPLY;
  const main = template.replaceAll("{ownerName}", ownerName);
  const suffix = options.replySuffix.trim();
  return suffix ? `${main}\n${suffix}` : main;
}

async function callModeration(text: string, options: ModerationPluginOptions): Promise<ModerationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/moderations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        input: text,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const data = (await response.json()) as {
      results?: Array<{
        flagged?: boolean;
        categories?: Record<string, boolean>;
        category_scores?: Record<string, number>;
      }>;
    };
    const result = data.results?.[0];
    if (!result) throw new Error("审查接口未返回结果");
    return {
      flagged: result.flagged === true,
      categories: result.categories ?? {},
      categoryScores: result.category_scores ?? {},
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createModerationPlugin(options: ModerationPluginOptions): Plugin {
  const enabled = Boolean(options.apiKey);

  return {
    name: "moderation",
    description: "OpenAI 内容审核 - 审查用户输入并拦截不合规消息",

    onLoad: () => {
      if (!enabled) {
        console.warn("[Moderation] 未配置 pluginSettings.moderation.apiKey，插件已停用");
        return;
      }
      console.log(
        `[Moderation] 已启用：模型=${options.model}，拦截=${options.blockFlagged}，` +
          `审核失败策略=${options.failClosed ? "fail-closed（拦截）" : "fail-open（放行）"}`
      );
    },

    onMessage: async (message: BotMessage, ctx: PluginContext): Promise<boolean | void> => {
      if (!enabled) return false;
      const text = (message.text ?? "").trim();
      if (!text) return false;

      try {
        const result = await callModeration(text, options);
        if (options.logScores) {
          console.log(
            `[Moderation] ${message.type === "group" ? `群${message.groupId}` : "私聊"} ` +
              `用户${hashUserId(message.userId ?? "?")}: ${result.flagged ? "违规" : "正常"}` +
              `${result.flagged ? ` (${flaggedCategoryText(result.categories)})` : ""}`
          );
        }
        if (!result.flagged) return false;

        console.warn(
          `[Moderation] 拦截违规消息 用户${message.userId}` +
            `（${message.type === "group" ? `群${message.groupId}` : "私聊"}）: ${text.slice(0, 100)}`
        );
        if (!options.blockFlagged) return false;

        if (options.replyOnBlocked) {
          try {
            await ctx.replyText(message, buildBlockReply(result.categories, options));
          } catch (error) {
            console.error("[Moderation] 发送拦截提示失败:", error);
          }
        }
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `[Moderation] 审核请求失败（${options.failClosed ? "fail-closed，本次消息被拦截" : "fail-open，本次消息放行"}）: ${reason}`
        );
        return options.failClosed;
      }
    },
  };
}
