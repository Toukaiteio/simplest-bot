import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BotConfig, Plugin, PluginContext, PromptBuildInput } from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";
import { assertToolAccess, getAgentIdentity, getInputMessage } from "../../security/access-control.js";
import { Workspace } from "./workspace.js";
import { createReadToolRegistrations } from "./tools-read.js";
import { createWriteToolRegistrations } from "./tools-write.js";
import { createGitToolRegistrations } from "./tools-git.js";
import { createExecToolRegistration } from "./tools-exec.js";
import { assertNoSymlinkComponents, ensureSafeDirectory, resolveRestrictedBaseRoot } from "./workspace-scope.js";

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
    return getScopedWorkspaceRootForRoot(restrictedBaseRoot, ctxRef!.config, input);
  }

  return plugin;
}

/** 共享给后台任务插件：同一用户的隔离目录规则必须与 workspace 工具完全一致。 */
export function getScopedWorkspaceRootForRoot(
  restrictedBaseRoot: string,
  config: BotConfig,
  input: PromptBuildInput,
): string {
  const identity = getAgentIdentity(getInputMessage(input), config);
  const rawScope = identity.userId ?? `anonymous-${identity.groupId ?? "unknown"}`;
  const scope = `user-${createHash("sha256").update(rawScope, "utf8").digest("hex")}`;
  const usersRoot = ensureSafeDirectory(restrictedBaseRoot, "users");
  return ensureSafeDirectory(usersRoot, scope);
}

function getRegistrationName(registration: BotToolRegistration): string {
  const definition = registration.definition as unknown as { function?: { name?: string } };
  return definition.function?.name?.trim() ?? "";
}
