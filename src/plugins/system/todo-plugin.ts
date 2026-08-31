import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BotMessage, MenuPlugin, NotifyTarget, Plugin, PluginContext, PromptBuildInput } from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";

type TodoTriggerType = "delay" | "datetime" | "window";
type TodoRecurrenceType = "once" | "interval" | "daily" | "weekly";

type TodoSchedule =
  | {
      triggerType: "delay";
      delayMinutes: number;
    }
  | {
      triggerType: "datetime";
      runAt: string;
    }
  | {
      triggerType: "window";
      windowStart: string;
      windowEnd: string;
    };

type TodoRecurrence =
  | {
      type: "once";
    }
  | {
      type: "interval";
      everyMinutes: number;
    }
  | {
      type: "daily";
    }
  | {
      type: "weekly";
      weekdays: number[];
    };

type TodoItem = {
  id: string;
  title: string;
  content: string;
  target: NotifyTarget;
  creatorUserId?: string;
  schedule: TodoSchedule;
  recurrence: TodoRecurrence;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  totalRuns: number;
  lastTriggeredAt?: string;
};

type TodoState = {
  tasks: TodoItem[];
};

type TodoPlugin = Plugin & {
  getToolRegistrations: () => BotToolRegistration[];
};

type TodoMutation = {
  title?: string;
  content?: string;
  active?: boolean;
  schedule?: TodoSchedule;
  recurrence?: TodoRecurrence;
  nextRunAt?: string;
};

const MAX_TIMEOUT_MS = 2_147_000_000;

export function createTodoPlugin(menuPlugin: MenuPlugin): TodoPlugin {
  let ctxRef: PluginContext | null = null;
  let tasks = new Map<string, TodoItem>();
  let saveTimer: NodeJS.Timeout | null = null;
  const taskTimers = new Map<string, NodeJS.Timeout>();

  const plugin: TodoPlugin = {
    name: "todo",
    description: "待办事项与提醒调度：支持单次、循环、延时和时间窗触发",
    systemPromptAppend: [
      "你可以使用待办事项工具为当前群聊或私聊创建提醒、循环任务和时间窗任务。",
      "未显式指定时，待办事项默认作用于当前会话。",
      "所有时间均按机器人所在机器的本地时间解释；如果是 datetime，请尽量提供完整日期和时间。",
    ].join("\n"),

    async onLoad(ctx) {
      menuPlugin.registerCommandGroup("todo", "待办事项", "创建、查看、管理待办提醒");
      ctxRef = ctx;
      tasks = loadTasks(ctx);
      scheduleAll();

      const prefix = menuPlugin.getPrefix();
      menuPlugin.registerCommand("todo-list", "查看当前会话的待办列表", async (message) => {
        const scoped = listTasksForTarget(getTargetForMessage(message));
        await ctx.replyText(message, formatTodoList(scoped));
      });

      menuPlugin.registerCommand("todo-show", `${prefix}todo-show <id> 查看指定待办`, async (message, args) => {
        const id = args[0];
        if (!id) {
          await ctx.replyText(message, `用法：${prefix}todo-show <id>`);
          return;
        }
        const task = requireTaskInScope(id, getTargetForMessage(message));
        await ctx.replyText(message, formatTodoDetail(task));
      });

      menuPlugin.registerCommand("todo-remove", `${prefix}todo-remove <id> 删除待办`, async (message, args) => {
        const id = args[0];
        if (!id) {
          await ctx.replyText(message, `用法：${prefix}todo-remove <id>`);
          return;
        }
        const task = requireTaskInScope(id, getTargetForMessage(message));
        removeTask(task.id);
        await ctx.replyText(message, `已删除待办 ${task.id}：${task.title}`);
      });

      menuPlugin.registerCommand("todo-pause", `${prefix}todo-pause <id> 暂停待办`, async (message, args) => {
        const id = args[0];
        if (!id) {
          await ctx.replyText(message, `用法：${prefix}todo-pause <id>`);
          return;
        }
        const task = requireTaskInScope(id, getTargetForMessage(message));
        updateTask(task.id, { active: false });
        await ctx.replyText(message, `已暂停待办 ${task.id}：${task.title}`);
      });

      menuPlugin.registerCommand("todo-resume", `${prefix}todo-resume <id> 恢复待办`, async (message, args) => {
        const id = args[0];
        if (!id) {
          await ctx.replyText(message, `用法：${prefix}todo-resume <id>`);
          return;
        }
        const task = requireTaskInScope(id, getTargetForMessage(message));
        const nextRunAt = computeInitialNextRunAt(task.schedule, task.recurrence, new Date());
        if (!nextRunAt) {
          throw new Error("当前待办无法重新计算下一次触发时间，请通过修改工具重设时间。");
        }
        updateTask(task.id, { active: true, nextRunAt: nextRunAt.toISOString() });
        await ctx.replyText(message, `已恢复待办 ${task.id}：${task.title}\n下次触发：${formatDateTime(nextRunAt.toISOString())}`);
      });
    },

    getToolRegistrations() {
      return [
        makeTool(
          "create_todo_item",
          "在指定或当前群聊/私聊创建待办事项，支持延时触发、指定时间触发、时间窗触发，以及单次或循环触发。",
          {
            type: "object",
            properties: {
              title: { type: "string", description: "待办标题" },
              content: { type: "string", description: "提醒时发送的正文内容" },
              triggerType: { type: "string", enum: ["delay", "datetime", "window"], description: "触发方式" },
              recurrenceType: { type: "string", enum: ["once", "interval", "daily", "weekly"], description: "重复方式" },
              delayMinutes: { type: "number", description: "delay 模式下，多少分钟后触发" },
              runAt: { type: "string", description: "datetime 模式下的触发时间，例如 2026-06-12 20:30" },
              windowStart: { type: "string", description: "window 模式下的开始时间，格式 HH:mm" },
              windowEnd: { type: "string", description: "window 模式下的结束时间，格式 HH:mm" },
              intervalMinutes: { type: "number", description: "interval 模式下，每隔多少分钟循环一次" },
              weekdays: {
                type: "array",
                description: "weekly 模式下允许触发的星期，0=周日，1=周一 ... 6=周六",
                items: { type: "number" },
              },
              targetType: { type: "string", enum: ["group", "private"], description: "发送目标类型。不指定则默认当前会话" },
              targetId: { type: "string", description: "群号或用户 ID，与 targetType 配合使用。不指定则默认当前会话" },
              active: { type: "boolean", description: "是否立即启用，默认 true" },
            },
            required: ["title", "content", "triggerType", "recurrenceType"],
          },
          async (args, input) => {
            const ctx = ensureContext(ctxRef);
            const target = resolveTarget(args, input);
            enforceScopeLimit(target, ctx);
            const prepared = prepareScheduleFromArgs(args);
            const now = new Date();
            const nextRunAt = computeInitialNextRunAt(prepared.schedule, prepared.recurrence, now);
            if (!nextRunAt) {
              throw new Error("无法根据当前参数计算首次触发时间。");
            }

            const task: TodoItem = {
              id: createShortId(),
              title: requireString(args.title, "title"),
              content: requireString(args.content, "content"),
              target,
              creatorUserId: getInputCreatorUserId(input),
              schedule: prepared.schedule,
              recurrence: prepared.recurrence,
              active: optionalBoolean(args.active) ?? true,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
              nextRunAt: nextRunAt.toISOString(),
              totalRuns: 0,
            };

            tasks.set(task.id, task);
            persistSoon(ctx);
            scheduleTask(task);

            return `已创建待办 ${task.id}：${task.title}\n${formatTodoSummary(task)}`;
          }
        ),
        makeTool(
          "list_todo_items",
          "列出当前群聊或私聊中的待办事项。",
          {
            type: "object",
            properties: {
              includeInactive: { type: "boolean", description: "是否包含已暂停项" },
            },
            required: [],
          },
          async (args, input) => {
            const target = getTargetForInput(input);
            const includeInactive = optionalBoolean(args.includeInactive) ?? true;
            const scoped = listTasksForTarget(target)
              .filter((task) => includeInactive || task.active);
            return formatTodoList(scoped);
          }
        ),
        makeTool(
          "update_todo_item",
          "修改当前群聊或私聊中的待办事项，可更新标题、内容、触发方式、循环方式和启用状态。",
          {
            type: "object",
            properties: {
              id: { type: "string", description: "待办 ID" },
              title: { type: "string", description: "新的标题" },
              content: { type: "string", description: "新的正文内容" },
              triggerType: { type: "string", enum: ["delay", "datetime", "window"], description: "新的触发方式" },
              recurrenceType: { type: "string", enum: ["once", "interval", "daily", "weekly"], description: "新的重复方式" },
              delayMinutes: { type: "number", description: "delay 模式下，多少分钟后触发" },
              runAt: { type: "string", description: "datetime 模式下的触发时间，例如 2026-06-12 20:30" },
              windowStart: { type: "string", description: "window 模式下的开始时间，格式 HH:mm" },
              windowEnd: { type: "string", description: "window 模式下的结束时间，格式 HH:mm" },
              intervalMinutes: { type: "number", description: "interval 模式下，每隔多少分钟循环一次" },
              weekdays: {
                type: "array",
                description: "weekly 模式下允许触发的星期，0=周日，1=周一 ... 6=周六",
                items: { type: "number" },
              },
              active: { type: "boolean", description: "是否启用" },
            },
            required: ["id"],
          },
          async (args, input) => {
            const ctx = ensureContext(ctxRef);
            const target = getTargetForInput(input);
            const task = requireTaskInScope(requireString(args.id, "id"), target);
            const mutation = buildMutationFromArgs(task, args);
            updateTask(task.id, mutation, ctx);
            const updated = tasks.get(task.id)!;
            return `已更新待办 ${updated.id}：${updated.title}\n${formatTodoSummary(updated)}`;
          }
        ),
        makeTool(
          "remove_todo_item",
          "删除当前群聊或私聊中的待办事项。",
          {
            type: "object",
            properties: {
              id: { type: "string", description: "待办 ID" },
            },
            required: ["id"],
          },
          async (args, input) => {
            const target = getTargetForInput(input);
            const task = requireTaskInScope(requireString(args.id, "id"), target);
            removeTask(task.id);
            return `已删除待办 ${task.id}：${task.title}`;
          }
        ),
      ];
    },
  };

  return plugin;

  function persistSoon(ctx: PluginContext) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(ctx.config.pluginSettings.todo.dataFile), { recursive: true });
      const content = JSON.stringify({ tasks: [...tasks.values()] }, null, 2);
      fs.writeFileSync(ctx.config.pluginSettings.todo.dataFile, content, "utf-8");
    }, 200);
  }

  function scheduleAll() {
    for (const timer of taskTimers.values()) {
      clearTimeout(timer);
    }
    taskTimers.clear();
    for (const task of tasks.values()) {
      scheduleTask(task);
    }
  }

  function scheduleTask(task: TodoItem) {
    const ctx = ctxRef;
    if (!ctx) return;

    const previous = taskTimers.get(task.id);
    if (previous) {
      clearTimeout(previous);
      taskTimers.delete(task.id);
    }

    if (!task.active) {
      return;
    }

    const nextRunAtMs = Date.parse(task.nextRunAt);
    if (!Number.isFinite(nextRunAtMs)) {
      task.active = false;
      persistSoon(ctx);
      return;
    }

    const delay = nextRunAtMs - Date.now();
    if (delay <= 0) {
      const timer = setTimeout(() => {
        void triggerTask(task.id);
      }, 100);
      taskTimers.set(task.id, timer);
      return;
    }

    const safeDelay = Math.min(delay, MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      if (safeDelay < delay) {
        const latest = tasks.get(task.id);
        if (latest) scheduleTask(latest);
        return;
      }
      void triggerTask(task.id);
    }, safeDelay);

    taskTimers.set(task.id, timer);
  }

  async function triggerTask(taskId: string) {
    const ctx = ctxRef;
    const task = tasks.get(taskId);
    if (!ctx || !task || !task.active) {
      return;
    }

    const triggeredAt = new Date();
    const prefix = ctx.config.pluginSettings.todo.defaultReminderPrefix;
    const lines = [
      `${prefix} ${task.title}`,
      task.content,
      `任务编号：${task.id}`,
      `调度方式：${describeSchedule(task.schedule, task.recurrence)}`,
    ];
    if (task.creatorUserId) {
      lines.unshift(`[CQ:at,qq=${task.creatorUserId}]`);
    }

    await ctx.sendMessage(task.target, lines.join("\n"));

    task.totalRuns += 1;
    task.lastTriggeredAt = triggeredAt.toISOString();
    const nextRunAt = computeFollowingNextRunAt(task, triggeredAt);
    if (nextRunAt) {
      task.nextRunAt = nextRunAt.toISOString();
      task.updatedAt = triggeredAt.toISOString();
    } else {
      task.active = false;
      task.updatedAt = triggeredAt.toISOString();
    }

    persistSoon(ctx);
    scheduleTask(task);
  }

  function listTasksForTarget(target: NotifyTarget): TodoItem[] {
    return [...tasks.values()]
      .filter((task) => isSameTarget(task.target, target))
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
  }

  function requireTaskInScope(id: string, target: NotifyTarget): TodoItem {
    const task = tasks.get(id);
    if (!task || !isSameTarget(task.target, target)) {
      throw new Error(`当前会话中不存在待办 ${id}。`);
    }
    return task;
  }

  function updateTask(id: string, mutation: TodoMutation, ctx = ensureContext(ctxRef)) {
    const current = tasks.get(id);
    if (!current) {
      throw new Error(`待办 ${id} 不存在。`);
    }

    const next: TodoItem = {
      ...current,
      title: mutation.title ?? current.title,
      content: mutation.content ?? current.content,
      active: mutation.active ?? current.active,
      schedule: mutation.schedule ?? current.schedule,
      recurrence: mutation.recurrence ?? current.recurrence,
      nextRunAt: mutation.nextRunAt ?? current.nextRunAt,
      updatedAt: new Date().toISOString(),
    };

    tasks.set(id, next);
    persistSoon(ctx);
    scheduleTask(next);
  }

  function removeTask(id: string) {
    const ctx = ensureContext(ctxRef);
    const timer = taskTimers.get(id);
    if (timer) clearTimeout(timer);
    taskTimers.delete(id);
    tasks.delete(id);
    persistSoon(ctx);
  }

  function enforceScopeLimit(target: NotifyTarget, ctx: PluginContext) {
    const count = listTasksForTarget(target).length;
    if (count >= ctx.config.pluginSettings.todo.maxItemsPerChat) {
      throw new Error(`当前会话待办数量已达上限 ${ctx.config.pluginSettings.todo.maxItemsPerChat}。`);
    }
  }
}

function makeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: BotToolRegistration["execute"]
): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description,
        parameters,
      },
    },
    execute,
  };
}

function loadTasks(ctx: PluginContext): Map<string, TodoItem> {
  const filePath = ctx.config.pluginSettings.todo.dataFile;
  try {
    if (!fs.existsSync(filePath)) {
      return new Map();
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as TodoState;
    const entries = parsed.tasks ?? [];
    return new Map(entries.map((task) => [task.id, task]));
  } catch (error) {
    console.error("[Todo] 读取待办文件失败:", error);
    return new Map();
  }
}

function prepareScheduleFromArgs(args: Record<string, unknown>): { schedule: TodoSchedule; recurrence: TodoRecurrence } {
  const triggerType = requireEnum<TodoTriggerType>(args.triggerType, "triggerType", ["delay", "datetime", "window"]);
  const recurrenceType = requireEnum<TodoRecurrenceType>(args.recurrenceType, "recurrenceType", ["once", "interval", "daily", "weekly"]);

  const schedule = buildSchedule(triggerType, args);
  const recurrence = buildRecurrence(recurrenceType, args, triggerType, schedule);
  return { schedule, recurrence };
}

function buildMutationFromArgs(task: TodoItem, args: Record<string, unknown>): TodoMutation {
  const mutation: TodoMutation = {};

  const title = optionalString(args.title);
  if (title !== undefined) mutation.title = title;
  const content = optionalString(args.content);
  if (content !== undefined) mutation.content = content;
  const active = optionalBoolean(args.active);
  if (active !== undefined) mutation.active = active;

  const scheduleFieldsProvided = [
    args.triggerType,
    args.recurrenceType,
    args.delayMinutes,
    args.runAt,
    args.windowStart,
    args.windowEnd,
    args.intervalMinutes,
    args.weekdays,
  ].some((value) => value !== undefined);

  if (!scheduleFieldsProvided) {
    return mutation;
  }

  const prepared = prepareScheduleFromArgs({
    triggerType: args.triggerType ?? task.schedule.triggerType,
    recurrenceType: args.recurrenceType ?? task.recurrence.type,
    delayMinutes: args.delayMinutes ?? (task.schedule.triggerType === "delay" ? task.schedule.delayMinutes : undefined),
    runAt: args.runAt ?? (task.schedule.triggerType === "datetime" ? task.schedule.runAt : undefined),
    windowStart: args.windowStart ?? (task.schedule.triggerType === "window" ? task.schedule.windowStart : undefined),
    windowEnd: args.windowEnd ?? (task.schedule.triggerType === "window" ? task.schedule.windowEnd : undefined),
    intervalMinutes: args.intervalMinutes ?? (task.recurrence.type === "interval" ? task.recurrence.everyMinutes : undefined),
    weekdays: args.weekdays ?? (task.recurrence.type === "weekly" ? task.recurrence.weekdays : undefined),
  });

  const nextRunAt = computeInitialNextRunAt(prepared.schedule, prepared.recurrence, new Date());
  if (!nextRunAt) {
    throw new Error("无法根据新的时间参数计算下一次触发时间。");
  }

  mutation.schedule = prepared.schedule;
  mutation.recurrence = prepared.recurrence;
  mutation.nextRunAt = nextRunAt.toISOString();
  return mutation;
}

function buildSchedule(triggerType: TodoTriggerType, args: Record<string, unknown>): TodoSchedule {
  if (triggerType === "delay") {
    const delayMinutes = requirePositiveNumber(args.delayMinutes, "delayMinutes");
    return { triggerType, delayMinutes };
  }
  if (triggerType === "datetime") {
    const runAt = normalizeDateTimeString(requireString(args.runAt, "runAt"));
    if (!isValidDateTime(runAt)) {
      throw new Error("runAt 不是有效时间，请使用例如 2026-06-12 20:30 的格式。");
    }
    return { triggerType, runAt };
  }

  const windowStart = requireTimeString(args.windowStart, "windowStart");
  const windowEnd = requireTimeString(args.windowEnd, "windowEnd");
  if (windowStart >= windowEnd) {
    throw new Error("windowEnd 必须晚于 windowStart。");
  }
  return { triggerType, windowStart, windowEnd };
}

function buildRecurrence(
  recurrenceType: TodoRecurrenceType,
  args: Record<string, unknown>,
  triggerType: TodoTriggerType,
  schedule: TodoSchedule
): TodoRecurrence {
  if (recurrenceType === "once") {
    return { type: "once" };
  }

  if (recurrenceType === "interval") {
    if (triggerType !== "delay") {
      throw new Error("interval 循环目前仅支持 delay 触发方式。");
    }
    return {
      type: "interval",
      everyMinutes: requirePositiveNumber(args.intervalMinutes, "intervalMinutes"),
    };
  }

  if (recurrenceType === "daily") {
    if (schedule.triggerType === "delay") {
      throw new Error("delay 触发方式不支持 daily 循环，请使用 interval。");
    }
    return { type: "daily" };
  }

  if (schedule.triggerType === "delay") {
    throw new Error("delay 触发方式不支持 weekly 循环，请使用 interval。");
  }

  const weekdays = normalizeWeekdays(args.weekdays);
  return {
    type: "weekly",
    weekdays,
  };
}

function computeInitialNextRunAt(schedule: TodoSchedule, recurrence: TodoRecurrence, now: Date): Date | null {
  if (schedule.triggerType === "delay") {
    return new Date(now.getTime() + schedule.delayMinutes * 60 * 1000);
  }

  if (schedule.triggerType === "datetime") {
    const anchor = new Date(normalizeDateTimeString(schedule.runAt));
    if (!Number.isFinite(anchor.getTime())) {
      return null;
    }
    if (recurrence.type === "once") {
      return anchor.getTime() > now.getTime() ? anchor : null;
    }
    if (recurrence.type === "interval") {
      throw new Error("datetime 触发方式不支持 interval 循环。");
    }
    return advanceDate(anchor, recurrence, now);
  }

  if (recurrence.type === "interval") {
    throw new Error("window 触发方式不支持 interval 循环。");
  }
  return computeNextWindowStart(schedule, recurrence, now);
}

function computeFollowingNextRunAt(task: TodoItem, triggeredAt: Date): Date | null {
  const recurrence = task.recurrence;
  const schedule = task.schedule;
  if (recurrence.type === "once") {
    return null;
  }

  if (schedule.triggerType === "delay") {
    if (recurrence.type !== "interval") {
      return null;
    }
    return new Date(triggeredAt.getTime() + recurrence.everyMinutes * 60 * 1000);
  }

  if (schedule.triggerType === "datetime") {
    const anchor = new Date(task.nextRunAt);
    if (recurrence.type === "interval") {
      throw new Error("datetime 触发方式不支持 interval 循环。");
    }
    return advanceDate(anchor, recurrence, triggeredAt);
  }

  if (recurrence.type === "interval") {
    throw new Error("window 触发方式不支持 interval 循环。");
  }
  return computeNextWindowStart(schedule, recurrence, new Date(triggeredAt.getTime() + 1_000));
}

function advanceDate(anchor: Date, recurrence: Extract<TodoRecurrence, { type: "daily" | "weekly" }>, after: Date): Date | null {
  if (!Number.isFinite(anchor.getTime())) {
    return null;
  }

  let candidate = new Date(anchor);
  while (candidate.getTime() <= after.getTime()) {
    if (recurrence.type === "daily") {
      candidate = addDays(candidate, 1);
      continue;
    }

    candidate = addDays(candidate, 1);
    const weekdays = recurrence.weekdays.length > 0 ? recurrence.weekdays : [anchor.getDay()];
    while (!weekdays.includes(candidate.getDay())) {
      candidate = addDays(candidate, 1);
    }
  }

  return candidate;
}

function computeNextWindowStart(
  schedule: Extract<TodoSchedule, { triggerType: "window" }>,
  recurrence: Extract<TodoRecurrence, { type: "once" | "daily" | "weekly" }>,
  after: Date
): Date | null {
  for (let offset = 0; offset < 370; offset += 1) {
    const day = addDays(startOfDay(after), offset);
    const candidate = combineDayAndTime(day, schedule.windowStart);
    if (candidate.getTime() <= after.getTime()) {
      continue;
    }

    if (recurrence.type === "weekly") {
      const weekdays = recurrence.weekdays.length > 0 ? recurrence.weekdays : [candidate.getDay()];
      if (!weekdays.includes(candidate.getDay())) {
        continue;
      }
    }

    return candidate;
  }

  return null;
}

function formatTodoList(tasks: TodoItem[]): string {
  if (tasks.length === 0) {
    return "当前会话没有待办事项。";
  }

  return [
    "当前会话待办：",
    ...tasks.map((task) => `- ${task.id} | ${task.title} | ${task.active ? "启用" : "暂停"} | ${formatDateTime(task.nextRunAt)} | ${describeSchedule(task.schedule, task.recurrence)}`),
  ].join("\n");
}

function formatTodoDetail(task: TodoItem): string {
  return [
    `待办 ${task.id}`,
    `标题：${task.title}`,
    `内容：${task.content}`,
    `状态：${task.active ? "启用" : "暂停"}`,
    `下次触发：${formatDateTime(task.nextRunAt)}`,
    `调度：${describeSchedule(task.schedule, task.recurrence)}`,
    `累计触发：${task.totalRuns}`,
  ].join("\n");
}

function formatTodoSummary(task: TodoItem): string {
  return [
    `状态：${task.active ? "启用" : "暂停"}`,
    `下次触发：${formatDateTime(task.nextRunAt)}`,
    `调度：${describeSchedule(task.schedule, task.recurrence)}`,
  ].join("\n");
}

function describeSchedule(schedule: TodoSchedule, recurrence: TodoRecurrence): string {
  const recurrenceText =
    recurrence.type === "once"
      ? "单次"
      : recurrence.type === "interval"
        ? `每 ${recurrence.everyMinutes} 分钟`
        : recurrence.type === "daily"
          ? "每日"
          : `每周 ${formatWeekdays(recurrence.weekdays)}`;

  if (schedule.triggerType === "delay") {
    return `延时 ${schedule.delayMinutes} 分钟后触发 / ${recurrenceText}`;
  }
  if (schedule.triggerType === "datetime") {
    return `指定时间 ${formatDateTime(schedule.runAt)} / ${recurrenceText}`;
  }
  return `时间窗 ${schedule.windowStart}-${schedule.windowEnd} / ${recurrenceText}`;
}

function resolveTarget(args: Record<string, unknown>, input: PromptBuildInput): NotifyTarget {
  const targetType = optionalString(args.targetType);
  const targetId = optionalString(args.targetId);
  if (targetType && targetId) {
    if (targetType !== "group" && targetType !== "private") {
      throw new Error("targetType 必须为 group 或 private。");
    }
    return { type: targetType, id: targetId };
  }
  // 只提供了一个，报错
  if (targetType && !targetId) {
    throw new Error("指定了 targetType 但未提供 targetId。");
  }
  if (!targetType && targetId) {
    throw new Error("指定了 targetId 但未提供 targetType。");
  }
  return getTargetForInput(input);
}

function getTargetForInput(input: PromptBuildInput): NotifyTarget {
  return input.mode === "single"
    ? getTargetForMessage(input.message)
    : getTargetForMessage(input.messages[input.messages.length - 1]);
}

function getTargetForMessage(message: BotMessage): NotifyTarget {
  if (message.type === "group" && message.groupId) {
    return { type: "group", id: message.groupId };
  }
  return { type: "private", id: message.userId ?? "unknown" };
}

function getInputCreatorUserId(input: PromptBuildInput): string | undefined {
  return input.mode === "single"
    ? input.message.userId
    : input.messages[input.messages.length - 1]?.userId;
}

function isSameTarget(left: NotifyTarget, right: NotifyTarget): boolean {
  return left.type === right.type && left.id === right.id;
}

function ensureContext(ctx: PluginContext | null): PluginContext {
  if (!ctx) {
    throw new Error("插件上下文尚未初始化。");
  }
  return ctx;
}

function createShortId(): string {
  return randomUUID().slice(0, 8);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 必须为非空字符串。`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} 必须为大于 0 的数字。`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, field: string, allowed: T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} 必须为 ${allowed.join(" / ")} 之一。`);
  }
  return value as T;
}

function requireTimeString(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!/^\d{2}:\d{2}$/.test(text)) {
    throw new Error(`${field} 必须为 HH:mm 格式。`);
  }
  return text;
}

function normalizeDateTimeString(value: string): string {
  return value.includes("T") ? value : value.replace(" ", "T");
}

function isValidDateTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizeWeekdays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }
  const weekdays = value.map((item) => {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 6) {
      throw new Error("weekdays 必须是由 0-6 组成的整数数组。");
    }
    return item;
  });
  return [...new Set(weekdays)];
}

function formatWeekdays(weekdays: number[]): string {
  if (weekdays.length === 0) {
    return "按原始星期";
  }
  const labels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return weekdays.map((weekday) => labels[weekday]).join("、");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function combineDayAndTime(day: Date, time: string): Date {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
}
