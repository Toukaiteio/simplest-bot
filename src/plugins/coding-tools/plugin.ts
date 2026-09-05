import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Plugin, PluginContext, PromptBuildInput } from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";
import { assertToolAccess, getAgentIdentity, getInputMessage } from "../../security/access-control.js";
import { Workspace } from "./workspace.js";
import { createReadToolRegistrations } from "./tools-read.js";
import { createWriteToolRegistrations } from "./tools-write.js";
import { createGitToolRegistrations } from "./tools-git.js";
import { createExecToolRegistration } from "./tools-exec.js";

type CodingToolsPlugin = Plugin & {
  getToolRegistrations: () => BotToolRegistration[];
};

export function createCodingToolsPlugin(): CodingToolsPlugin {
  let restrictedBaseRoot: string | null = null;
  let ctxRef: PluginContext | null = null;

  const plugin: CodingToolsPlugin = {
    name: "coding-tools",
    description: "工作区级读写/搜索/Git/补丁工具",
    systemPromptAppend: [
      "你可以使用 workspace 工具在当前用户隔离的受限 workspace 中读写、搜索和验证项目文件。",
      "workspace_exec_command 是受限 shell：只允许白名单程序、单条命令和当前 workspace 内的相对路径。",
      "对于代码修改，推荐使用 workspace_apply_patch 工具，它支持添加、更新、删除文件和上下文匹配。",
      "处理多步骤编码任务时，先用主 agent 的 agent_plan_update 维护简短计划，并在关键阶段更新状态。",
      "不要把 read/search/exec/git 工具返回的 JSON 或大段命令输出原样发给群聊；最终回复只总结原因、改动和验证结果。",
    ].join("\n"),

    async onLoad(ctx: PluginContext) {
      ctxRef = ctx;
      restrictedBaseRoot = resolveRestrictedBaseRoot(
        ctx.config.pluginSettings.codingTools?.workspaceRoot || "data/agent-workspaces",
      );
      fs.mkdirSync(restrictedBaseRoot, { recursive: true });
      assertNoSymlinkComponents(path.resolve(process.cwd(), "data/agent-workspaces"), restrictedBaseRoot);
      console.log(`[CodingTools] 受限 workspace 根目录：${path.relative(process.cwd(), restrictedBaseRoot) || "."}`);
    },

    getToolRegistrations() {
      if (!restrictedBaseRoot || !ctxRef) return [];
      const templateWorkspace = new Workspace(restrictedBaseRoot);
      const registrations = createRegistrations(templateWorkspace);

      // Bind a fresh Workspace for each call. A group conversation can be
      // shared in the transcript, but its files and shell cwd are per user.
      return registrations.map((registration) => ({
        ...registration,
        execute: async (args, input) => {
          const definition = registration.definition as unknown as { function?: { name?: string } };
          const toolName = definition.function?.name ?? "workspace_tool";
          assertToolAccess(toolName, input, ctxRef!.config);
          const scopedWorkspace = new Workspace(getScopedWorkspaceRoot(input));
          const scopedRegistration = createRegistrations(scopedWorkspace)
            .find((candidate) => getRegistrationName(candidate) === toolName);
          if (!scopedRegistration) throw new Error(`未找到受限 workspace 工具：${toolName}`);
          return scopedRegistration.execute(args, input);
        },
      }));
    },
  };

  function createRegistrations(workspace: Workspace): BotToolRegistration[] {
    return [
      ...createReadToolRegistrations(workspace),
      ...createWriteToolRegistrations(workspace),
      ...createGitToolRegistrations(workspace),
      ...createExecToolRegistration(workspace),
    ] as BotToolRegistration[];
  }

  function getScopedWorkspaceRoot(input: PromptBuildInput): string {
    if (!restrictedBaseRoot) throw new Error("受限 workspace 尚未初始化。");
    const identity = getAgentIdentity(getInputMessage(input), ctxRef!.config);
    const rawScope = identity.userId ?? `anonymous-${identity.groupId ?? "unknown"}`;
    const scope = `user-${createHash("sha256").update(rawScope, "utf8").digest("hex")}`;
    const usersRoot = ensureSafeDirectory(restrictedBaseRoot, "users");
    return ensureSafeDirectory(usersRoot, scope);
  }

  return plugin;
}

function resolveRestrictedBaseRoot(configuredRoot: string): string {
  const sandboxRoot = path.resolve(process.cwd(), "data/agent-workspaces");
  const requested = path.resolve(process.cwd(), configuredRoot);
  return isSubPath(sandboxRoot, requested) ? requested : sandboxRoot;
}

function ensureSafeDirectory(base: string, ...segments: string[]): string {
  let current = path.resolve(base);
  assertNoSymlinkComponents(current, current);
  for (const segment of segments) {
    if (!/^[a-zA-Z0-9._-]+$/.test(segment)) throw new Error("受限 workspace 目录名无效。");
    current = path.join(current, segment);
    fs.mkdirSync(current, { recursive: true });
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("受限 workspace 路径不能包含符号链接。");
    }
    if (!fs.statSync(current).isDirectory()) {
      throw new Error("受限 workspace 路径不是目录。");
    }
  }
  return current;
}

function assertNoSymlinkComponents(root: string, candidate: string): void {
  const rootAbs = path.resolve(root);
  const candidateAbs = path.resolve(candidate);
  if (!isSubPath(rootAbs, candidateAbs)) throw new Error("受限 workspace 路径越界。");
  if (!fs.existsSync(rootAbs)) return;
  if (fs.lstatSync(rootAbs).isSymbolicLink()) throw new Error("受限 workspace 根目录不能是符号链接。");

  let current = rootAbs;
  const relative = path.relative(rootAbs, candidateAbs);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("受限 workspace 路径不能包含符号链接。");
    }
  }
}

function isSubPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getRegistrationName(registration: BotToolRegistration): string {
  const definition = registration.definition as unknown as { function?: { name?: string } };
  return definition.function?.name?.trim() ?? "";
}
