import { randomBytes } from "node:crypto";
import type { BotConfig, BotMessage, Plugin, PromptBuildInput } from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";
import { getAgentIdentity, getInputMessage, isAdminInput } from "../../security/access-control.js";
import { parseFetchableHttpUrl } from "../../security/url-guard.js";
import { runRestrictedCommandAsync, validateRestrictedCommand } from "../coding-tools/sandbox-shell.js";
import { getScopedWorkspaceRoot } from "../coding-tools/workspace-scope.js";

type TaskKind = "url_watch" | "command" | "reminder";
type TaskStatus = "running" | "completed" | "failed" | "timeout" | "cancelled";

type BackgroundTask = {
  id: string;
  kind: TaskKind;
  description: string;
  status: TaskStatus;
  userId: string | null;
  conversationKey: string;
  originMessage: BotMessage;
  createdAt: number;
  finishedAt: number | null;
  result: string;
  cancelRequested: boolean;
  cancel: () => void;
};

export type BackgroundWakeHandler = (
  message: BotMessage,
  dynamicPromptAppends: string[],
) => Promise<unknown>;

export type AgentBackgroundPlugin = Plugin & {
  setWakeHandler: (handler: BackgroundWakeHandler) => void;
  getToolRegistrations: () => BotToolRegistration[];
};

/** 单用户并行后台任务上限（防自我复制风暴的第一道闸）。 */
const MAX_ACTIVE_PER_USER = 4;
/** 全局并行后台任务上限。 */
const MAX_ACTIVE_GLOBAL = 32;
/** 登记表保留的已完成任务数上限（供 list 查询，超出丢弃最旧）。 */
const MAX_FINISHED_TASKS = 60;
/** 每会话每小时最多唤醒次数（防“任务完成→再建任务→再唤醒”的自我维持循环）。 */
const MAX_WAKES_PER_HOUR = 12;

const WATCH_URL_INTERVAL_MIN_SEC = 15;
const WATCH_URL_INTERVAL_MAX_SEC = 300;
const WATCH_URL_TIMEOUT_MAX_SEC = 3_600;
const COMMAND_TIMEOUT_MAX_SEC = 600;
const REMINDER_MAX_SEC = 86_400;
const SLEEP_MAX_SEC = 120;

/**
 * 后台任务能力：sleep（轮询等待）、URL 监控、后台受限命令、定时提醒。
 *
 * 任务在 bot 进程内异步运行，不阻塞当前 Agent 轮次；完成后把结果作为一轮新的
 * 输入“唤醒”该会话的 Agent（走受限工作流），由 Agent 决定后续动作并汇报用户。
 * 任务随进程结束而消失（不落盘）。
 */
export function createAgentBackgroundPlugin(config: BotConfig): AgentBackgroundPlugin {
  const tasks = new Map<string, BackgroundTask>();
  const wakeTimestamps = new Map<string, number[]>();
  let wakeHandler: BackgroundWakeHandler | null = null;

  const plugin: AgentBackgroundPlugin = {
    name: "agent-background",
    description: "Agent 后台任务：URL 轮询监控、后台受限命令、定时提醒与 sleep 等待",
    systemPromptAppend: [
      "[后台任务能力]",
      "耗时等待不要反复 sleep 阻塞当前轮次：等待几秒可用 agent_sleep；需要轮询 URL、跑长命令或延时提醒时，用 watch_url / run_background_command / set_reminder 挂成后台任务，任务完成后系统会带着结果唤醒你继续处理。",
      "后台命令在当前用户隔离的受限 workspace 中执行（与 workspace_exec_command 同一白名单）。",
      "被唤醒后根据结果决定是否需要向用户汇报；不要为同一目标重复创建后台任务。",
    ].join("\n"),

    setWakeHandler(handler) {
      wakeHandler = handler;
    },

    getToolRegistrations() {
      return [
        makeSleepTool(),
        makeWatchUrlTool(),
        makeRunBackgroundCommandTool(),
        makeSetReminderTool(),
        makeListTool(),
        makeStopTool(),
      ];
    },
  };

  // ===== 任务生命周期 =====

  function createTask(kind: TaskKind, description: string, input: PromptBuildInput): BackgroundTask {
    const message = getInputMessage(input);
    const identity = getAgentIdentity(message, config);
    const id = `${kind}-${randomBytes(4).toString("hex")}`;
    const task: BackgroundTask = {
      id,
      kind,
      description,
      status: "running",
      userId: identity.userId,
      conversationKey: identity.conversationKey,
      originMessage: message,
      createdAt: Date.now(),
      finishedAt: null,
      result: "",
      cancelRequested: false,
      cancel: () => {},
    };
    tasks.set(id, task);
    pruneFinishedTasks();
    return task;
  }

  function activeCountFor(userId: string | null): number {
    let count = 0;
    for (const task of tasks.values()) {
      if (task.status === "running" && task.userId === userId) count += 1;
    }
    return count;
  }

  function activeCountGlobal(): number {
    let count = 0;
    for (const task of tasks.values()) {
      if (task.status === "running") count += 1;
    }
    return count;
  }

  function pruneFinishedTasks(): void {
    const finished = [...tasks.values()]
      .filter((task) => task.status !== "running")
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const task of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_TASKS))) {
      tasks.delete(task.id);
    }
  }

  async function finish(task: BackgroundTask, status: TaskStatus, result: string): Promise<void> {
    if (task.status !== "running") return;
    task.status = status;
    task.finishedAt = Date.now();
    task.result = result;
    console.log(`[Background] 任务 ${task.id}（${task.kind}）${status}：${result.slice(0, 120)}`);
    if (status !== "cancelled") {
      await wake(task);
    }
  }

  async function wake(task: BackgroundTask): Promise<void> {
    if (!wakeHandler) {
      console.warn("[Background] 未接入唤醒通道（chat 插件不可用），任务结果仅记录在后台任务列表中。");
      return;
    }
    // 限流：同一会话每小时最多 MAX_WAKES_PER_HOUR 次唤醒，阻断自我维持的循环。
    const now = Date.now();
    const recent = (wakeTimestamps.get(task.conversationKey) ?? []).filter((ts) => now - ts < 3_600_000);
    if (recent.length >= MAX_WAKES_PER_HOUR) {
      console.warn(`[Background] 会话 ${task.conversationKey} 唤醒频率超限，任务 ${task.id} 结果不再唤醒 Agent（可用 agent_list_background_tasks 查询）。`);
      return;
    }
    recent.push(now);
    wakeTimestamps.set(task.conversationKey, recent);

    const statusText: Record<TaskStatus, string> = {
      running: "仍在运行",
      completed: "已完成",
      failed: "失败",
      timeout: "超时未达成",
      cancelled: "已取消",
    };
    const directive = [
      "[后台任务完成通知]",
      `后台任务「${task.description}」（类型：${task.kind}，ID：${task.id}）${statusText[task.status]}。`,
      `结果：${task.result}`,
      "请根据该结果决定后续动作：需要告知用户就调用 send_current_reply 提交简要汇报；无需处理则简短确认后结束。不要为同一目标重复创建后台任务。",
    ].join("\n");
    try {
      await wakeHandler(task.originMessage, [directive]);
    } catch (error) {
      console.error(`[Background] 唤醒 Agent 失败（任务 ${task.id}）：`, error);
    }
  }

  /** 可取消等待：cancel() 立即结束。 */
  function cancellableSleep(ms: number, task: BackgroundTask): Promise<void> {
    return new Promise((resolve) => {
      if (task.cancelRequested) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      function done(): void {
        task.cancel = () => {};
        resolve();
      }
      task.cancel = () => {
        task.cancelRequested = true;
        clearTimeout(timer);
        done();
      };
    });
  }

  async function runUrlWatch(
    task: BackgroundTask,
    params: { url: string; containsText: string | null; statusCode: number | null; intervalSec: number; timeoutSec: number },
  ): Promise<void> {
    const deadline = Date.now() + params.timeoutSec * 1_000;
    let consecutiveErrors = 0;
    let lastObservation = "尚未请求";
    while (Date.now() < deadline && !task.cancelRequested) {
      try {
        const response = await fetch(params.url, {
          headers: { "user-agent": "simplest-bot/1.0 (url-watch)" },
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });
        const body = params.containsText ? await response.text().then(
          (text) => text.slice(0, 200_000),
          () => "",
        ) : "";
        const statusOk = params.statusCode === null || response.status === params.statusCode;
        const textOk = params.containsText === null || body.includes(params.containsText);
        lastObservation = `HTTP ${response.status}${params.containsText ? "，目标文本未出现" : ""}`;
        if (statusOk && textOk) {
          const snippet = params.containsText
            ? snippetAround(body, params.containsText)
            : body.slice(0, 800);
          await finish(task, "completed", `条件已满足：HTTP ${response.status}。片段：${snippet}`);
          return;
        }
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        lastObservation = `请求失败：${error instanceof Error ? error.message : String(error)}`;
        if (consecutiveErrors >= 5) {
          await finish(task, "failed", `连续 5 次请求失败，最后错误：${lastObservation}`);
          return;
        }
      }
      await cancellableSleep(params.intervalSec * 1_000, task);
    }
    if (task.cancelRequested) {
      await finish(task, "cancelled", "已被手动取消。");
    } else {
      await finish(task, "timeout", `超时未满足条件。最后观察：${lastObservation}`);
    }
  }

  async function runBackgroundCommand(
    task: BackgroundTask,
    params: { cmd: string; timeoutSec: number; root: string },
  ): Promise<void> {
    const runner = runRestrictedCommandAsync(params.cmd, params.root, params.timeoutSec * 1_000);
    task.cancel = () => {
      task.cancelRequested = true;
      runner.kill();
    };
    const output = await runner.promise;
    if (task.cancelRequested) {
      await finish(task, "cancelled", `命令被手动终止。输出：${output.slice(0, 1_500)}`);
      return;
    }
    let exitCode = -1;
    try {
      exitCode = (JSON.parse(output) as { exit_code?: number }).exit_code ?? -1;
    } catch { /* 保持 -1 */ }
    await finish(task, exitCode === 0 ? "completed" : "failed", `命令输出：${output.slice(0, 2_000)}`);
  }

  async function runReminder(task: BackgroundTask, params: { afterSec: number; note: string }): Promise<void> {
    await cancellableSleep(params.afterSec * 1_000, task);
    if (task.cancelRequested) {
      await finish(task, "cancelled", "提醒已被手动取消。");
    } else {
      await finish(task, "completed", `定时提醒（${formatDuration(params.afterSec)}前设置）：${params.note}`);
    }
  }

  // ===== 工具 =====

  function makeSleepTool(): BotToolRegistration {
    return {
      definition: {
        type: "function",
        function: {
          name: "agent_sleep",
          description: `等待指定秒数（1-${SLEEP_MAX_SEC}）后继续。适合几秒到一两分钟的短等待/轮询间隔；注意单轮任务总时长有 240 秒上限，更长的等待必须改用后台任务（watch_url / run_background_command / set_reminder）。`,
          parameters: {
            type: "object",
            properties: {
              seconds: { type: "number", description: "等待秒数（1-120）" },
            },
            required: ["seconds"],
            additionalProperties: false,
          },
        },
      },
      execute: async (args) => {
        const seconds = Math.min(SLEEP_MAX_SEC, Math.max(1, Math.floor(Number(args.seconds) || 0)));
        await new Promise((resolve) => {
          setTimeout(resolve, seconds * 1_000);
        });
        return `已等待 ${seconds} 秒，可以继续检查。`;
      },
    };
  }

  function makeWatchUrlTool(): BotToolRegistration {
    return {
      definition: {
        type: "function",
        function: {
          name: "watch_url",
          description: "挂一个后台任务轮询监控 URL：按间隔访问，直到状态码/页面文本满足条件或超时。任务完成（或超时/失败）后系统会带结果唤醒你继续处理。",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "要监控的 http(s) URL" },
              contains_text: { type: "string", description: "目标条件：页面包含该文本（与 status_code 至少填一个）" },
              status_code: { type: "number", description: "目标条件：HTTP 状态码等于该值" },
              interval_sec: { type: "number", description: `轮询间隔秒数（${WATCH_URL_INTERVAL_MIN_SEC}-${WATCH_URL_INTERVAL_MAX_SEC}，默认 60）` },
              timeout_sec: { type: "number", description: `总超时秒数（60-${WATCH_URL_TIMEOUT_MAX_SEC}，默认 900）` },
              description: { type: "string", description: "任务用途一句话说明（唤醒通知里会引用）" },
            },
            required: ["url", "description"],
            additionalProperties: false,
          },
        },
      },
      execute: async (args, input) => {
        const url = parseFetchableHttpUrl(
          typeof args.url === "string" ? args.url : "",
          { allowLocalNetwork: isAdminInput(input, config) },
        ).toString();
        const containsText = typeof args.contains_text === "string" && args.contains_text.trim()
          ? args.contains_text.trim()
          : null;
        const statusCode = Number.isInteger(args.status_code) && Number(args.status_code) >= 100 && Number(args.status_code) < 600
          ? Number(args.status_code)
          : null;
        if (!containsText && statusCode === null) {
          throw new Error("必须提供 contains_text 或 status_code 之一作为完成条件。");
        }
        const description = requireDescription(args);
        const capacityError = assertCapacity(input);
        if (capacityError) throw new Error(capacityError);

        const task = createTask("url_watch", description, input);
        void runUrlWatch(task, {
          url,
          containsText,
          statusCode,
          intervalSec: clamp(Number(args.interval_sec) || 60, WATCH_URL_INTERVAL_MIN_SEC, WATCH_URL_INTERVAL_MAX_SEC),
          timeoutSec: clamp(Number(args.timeout_sec) || 900, 60, WATCH_URL_TIMEOUT_MAX_SEC),
        });
        return `后台监控已启动（ID：${task.id}）。间隔 ${clamp(Number(args.interval_sec) || 60, WATCH_URL_INTERVAL_MIN_SEC, WATCH_URL_INTERVAL_MAX_SEC)} 秒，` +
          `最长 ${clamp(Number(args.timeout_sec) || 900, 60, WATCH_URL_TIMEOUT_MAX_SEC)} 秒。任务完成后会自动唤醒继续处理；期间你可以做其他事。`;
      },
    };
  }

  function makeRunBackgroundCommandTool(): BotToolRegistration {
    return {
      definition: {
        type: "function",
        function: {
          name: "run_background_command",
          description: "在当前用户隔离的受限 workspace 中后台执行一条受限命令（与 workspace_exec_command 同一白名单与路径限制），不阻塞当前轮次。命令结束后系统会带输出唤醒你继续处理。适合构建、测试等较长的命令。",
          parameters: {
            type: "object",
            properties: {
              cmd: { type: "string", description: "要执行的命令（白名单程序、单条命令、workspace 相对路径）" },
              timeout_sec: { type: "number", description: `超时秒数（10-${COMMAND_TIMEOUT_MAX_SEC}，默认 300）` },
              description: { type: "string", description: "任务用途一句话说明（唤醒通知里会引用）" },
            },
            required: ["cmd", "description"],
            additionalProperties: false,
          },
        },
      },
      execute: async (args, input) => {
        const cmd = typeof args.cmd === "string" ? args.cmd.trim() : "";
        if (!cmd) throw new Error("cmd 不能为空。");
        const description = requireDescription(args);
        const capacityError = assertCapacity(input);
        if (capacityError) throw new Error(capacityError);

        // workspace 解析与命令校验都放在创建任务之前：拒绝必须作为工具错误
        // 返回给模型，而不是变成无人处理的异步异常。
        let root: string;
        try {
          root = getScopedWorkspaceRoot(config, input);
        } catch (error) {
          throw new Error(`无法解析受限 workspace：${error instanceof Error ? error.message : String(error)}`);
        }
        validateRestrictedCommand(cmd, root);

        const timeoutSec = clamp(Number(args.timeout_sec) || 300, 10, COMMAND_TIMEOUT_MAX_SEC);
        const task = createTask("command", description, input);
        void runBackgroundCommand(task, { cmd, timeoutSec, root });
        return `后台命令已启动（ID：${task.id}，最长 ${timeoutSec} 秒）。命令结束后会自动唤醒并带回输出。`;
      },
    };
  }

  function makeSetReminderTool(): BotToolRegistration {
    return {
      definition: {
        type: "function",
        function: {
          name: "set_reminder",
          description: `设置延时提醒：${formatDuration(1)}到 24 小时后唤醒你处理备忘（例如“10 分钟后检查构建结果”）。到点后系统会唤醒你继续处理。`,
          parameters: {
            type: "object",
            properties: {
              after_sec: { type: "number", description: "多少秒后提醒（30-86400）" },
              note: { type: "string", description: "提醒内容/到点要做的事" },
            },
            required: ["after_sec", "note"],
            additionalProperties: false,
          },
        },
      },
      execute: async (args, input) => {
        const afterSec = clamp(Math.floor(Number(args.after_sec) || 0), 30, REMINDER_MAX_SEC);
        if (!Number.isFinite(Number(args.after_sec)) || Number(args.after_sec) <= 0) {
          throw new Error("after_sec 必须为正数秒。");
        }
        const note = typeof args.note === "string" && args.note.trim() ? args.note.trim().slice(0, 2_000) : "";
        if (!note) throw new Error("note 不能为空。");
        const capacityError = assertCapacity(input);
        if (capacityError) throw new Error(capacityError);

        const task = createTask("reminder", `提醒：${note}`, input);
        void runReminder(task, { afterSec, note });
        return `提醒已设置（ID：${task.id}），${formatDuration(afterSec)}后唤醒。`;
      },
    };
  }

  function makeListTool(): BotToolRegistration {
    return {
      definition: {
        type: "function",
        function: {
          name: "agent_list_background_tasks",
          description: "查询当前用户的后台任务（含已完成）：状态、用途与结果摘要。任务完成但唤醒被限流时用这个工具主动查询。",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
      execute: async (_args, input) => {
        const message = getInputMessage(input);
        const identity = getAgentIdentity(message, config);
        const mine = [...tasks.values()]
          .filter((task) => task.userId === identity.userId || identity.isAdmin)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 20);
        if (mine.length === 0) return "当前没有后台任务。";
        return mine.map((task) => {
          const age = Math.round((Date.now() - task.createdAt) / 1_000);
          const result = task.status === "running" ? "" : `；结果：${task.result.slice(0, 200)}`;
          return `- ${task.id} [${task.kind}] ${task.status}（${age}s 前）「${task.description}」${result}`;
        }).join("\n");
      },
    };
  }

  function makeStopTool(): BotToolRegistration {
    return {
      definition: {
        type: "function",
        function: {
          name: "agent_stop_background_task",
          description: "终止自己创建的（或管理员终止任意）后台任务。",
          parameters: {
            type: "object",
            properties: {
              task_id: { type: "string", description: "任务 ID" },
            },
            required: ["task_id"],
            additionalProperties: false,
          },
        },
      },
      execute: async (args, input) => {
        const id = typeof args.task_id === "string" ? args.task_id.trim() : "";
        const task = tasks.get(id);
        if (!task) throw new Error(`未找到后台任务：${id || "(空)"}`);
        const message = getInputMessage(input);
        const identity = getAgentIdentity(message, config);
        if (task.userId !== identity.userId && !identity.isAdmin) {
          throw new Error("只能终止自己创建的后台任务。");
        }
        if (task.status !== "running") {
          return `任务 ${task.id} 已处于 ${task.status} 状态，无需终止。`;
        }
        task.cancel();
        return `已请求终止任务 ${task.id}。`;
      },
    };
  }

  function assertCapacity(input: PromptBuildInput): string | null {
    const identity = getAgentIdentity(getInputMessage(input), config);
    if (activeCountGlobal() >= MAX_ACTIVE_GLOBAL) {
      return `全局后台任务已达上限（${MAX_ACTIVE_GLOBAL}），请稍后再试。`;
    }
    if (activeCountFor(identity.userId) >= MAX_ACTIVE_PER_USER) {
      return `你的后台任务已达上限（${MAX_ACTIVE_PER_USER} 个运行中），可用 agent_list_background_tasks 查看、agent_stop_background_task 终止。`;
    }
    return null;
  }

  return plugin;
}

function requireDescription(args: Record<string, unknown>): string {
  const description = typeof args.description === "string" ? args.description.trim() : "";
  if (!description) throw new Error("description 不能为空（用于任务列表与唤醒通知）。");
  return description.slice(0, 200);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} 分钟`;
  return `${Math.round(seconds / 3_600)} 小时`;
}

function snippetAround(body: string, needle: string): string {
  const index = body.indexOf(needle);
  if (index < 0) return "";
  const start = Math.max(0, index - 120);
  return body.slice(start, index + needle.length + 200).replace(/\s+/gu, " ").trim().slice(0, 400);
}
