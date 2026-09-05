import type { BotToolRegistration } from "../../tooling.js";
import type { PromptBuildInput } from "../../types.js";
import { getInputMessage } from "../../security/access-control.js";

type PlanStatus = "pending" | "in_progress" | "completed" | "blocked";

type PlanItem = {
  id: string;
  title: string;
  status: PlanStatus;
  note?: string;
};

const allowedStatuses = new Set<PlanStatus>(["pending", "in_progress", "completed", "blocked"]);

export const AGENT_PLAN_SYSTEM_PROMPT = [
  "你可以使用 agent_plan_update / agent_plan_view 维护当前任务的内部计划板。",
  "当用户提出多步骤、需要检查/修改/验证/对比/排查的任务时，先创建 2-6 项简短计划，并在关键阶段更新状态。",
  "计划板是执行约束，不是聊天内容；最终回复只同步必要结论、已完成项、受阻项和下一步。",
].join("\n");

export function createAgentPlanToolRegistrations(): BotToolRegistration[] {
  const plans = new Map<string, PlanItem[]>();

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "agent_plan_update",
          description:
            "维护当前对话任务的内部计划板。适合多步骤排查、实现、审阅、写作、对比等任务。每次传入完整 items 会替换当前计划。",
          parameters: {
            type: "object",
            properties: {
              items: {
                type: "array",
                description: "完整计划项列表，建议 2-6 项。",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "稳定短 ID，例如 inspect、edit、verify" },
                    title: { type: "string", description: "计划项标题" },
                    status: {
                      type: "string",
                      enum: ["pending", "in_progress", "completed", "blocked"],
                      description: "计划项状态",
                    },
                    note: { type: "string", description: "可选简短备注" },
                  },
                  required: ["id", "title", "status"],
                },
              },
            },
            required: ["items"],
          },
        },
      },
      execute: async (args, input) => {
        const sessionKey = getSessionKey(input);
        const items = parsePlanItems(args.items);
        plans.set(sessionKey, items);
        return formatPlan(items);
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "agent_plan_view",
          description: "查看当前对话任务的内部计划板。",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      },
      execute: async (_args, input) => {
        const items = plans.get(getSessionKey(input)) ?? [];
        return items.length > 0 ? formatPlan(items) : "当前没有内部计划。";
      },
    },
  ];
}

function parsePlanItems(value: unknown): PlanItem[] {
  const rawItems = Array.isArray(value) ? value : [];
  if (rawItems.length === 0) {
    throw new Error("items 必须至少包含一项。");
  }
  if (rawItems.length > 12) {
    throw new Error("计划项过多，请控制在 12 项以内。");
  }

  const seen = new Set<string>();
  return rawItems.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`items[${index}] 必须是对象。`);
    }

    const item = raw as Record<string, unknown>;
    const id = requireText(item.id, `items[${index}].id`, 80);
    if (seen.has(id)) throw new Error(`重复计划项 id：${id}`);
    seen.add(id);

    const title = requireText(item.title, `items[${index}].title`, 160);
    const status = requireText(item.status, `items[${index}].status`, 40) as PlanStatus;
    if (!allowedStatuses.has(status)) {
      throw new Error(`无效状态：${status}`);
    }

    const note = typeof item.note === "string" && item.note.trim()
      ? item.note.trim().slice(0, 200)
      : undefined;
    return { id, title, status, note };
  });
}

function getSessionKey(input: PromptBuildInput): string {
  const message = getInputMessage(input);
  return message.type === "group" ? `group:${message.groupId ?? "unknown"}` : `private:${message.userId ?? "unknown"}`;
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 必须是非空字符串。`);
  }
  return value.trim().slice(0, maxLength);
}

function formatPlan(items: PlanItem[]): string {
  const labels: Record<PlanStatus, string> = {
    pending: "待处理",
    in_progress: "进行中",
    completed: "已完成",
    blocked: "受阻",
  };
  return [
    "当前内部计划：",
    ...items.map((item) => `- ${item.id} | ${labels[item.status]} | ${item.title}${item.note ? ` | ${item.note}` : ""}`),
  ].join("\n");
}
