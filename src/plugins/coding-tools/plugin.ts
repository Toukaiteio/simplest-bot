import type { Plugin, PluginContext } from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";
import { Workspace } from "./workspace.js";
import { createReadToolRegistrations } from "./tools-read.js";
import { createWriteToolRegistrations } from "./tools-write.js";
import { createGitToolRegistrations } from "./tools-git.js";
import { createExecToolRegistration } from "./tools-exec.js";

type CodingToolsPlugin = Plugin & {
  getToolRegistrations: () => BotToolRegistration[];
};

export function createCodingToolsPlugin(): CodingToolsPlugin {
  let workspace: Workspace | null = null;

  const plugin: CodingToolsPlugin = {
    name: "coding-tools",
    description: "工作区级读写/搜索/Git/补丁工具",
    systemPromptAppend: [
      "你可以使用工作区工具对项目源码进行读写、搜索和 Git 操作。",
      "这些工具操作的是整个项目工作区，而非当前聊天的临时目录。",
      "对于代码修改，推荐使用 workspace_apply_patch 工具，它支持添加、更新、删除文件和上下文匹配。",
      "处理多步骤编码任务时，先用主 agent 的 agent_plan_update 维护简短计划，并在关键阶段更新状态。",
      "不要把 read/search/exec/git 工具返回的 JSON 或大段命令输出原样发给群聊；最终回复只总结原因、改动和验证结果。",
    ].join("\n"),

    async onLoad(ctx: PluginContext) {
      const rootDir = ctx.config.pluginSettings.codingTools?.workspaceRoot || ".";
      workspace = new Workspace(rootDir);
    },

    getToolRegistrations() {
      if (!workspace) return [];
      return [
        ...createReadToolRegistrations(workspace),
        ...createWriteToolRegistrations(workspace),
        ...createGitToolRegistrations(workspace),
        ...createExecToolRegistration(workspace),
      ];
    },
  };

  return plugin;
}
