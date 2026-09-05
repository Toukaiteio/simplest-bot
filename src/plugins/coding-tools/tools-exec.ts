import { ToolError, Workspace } from "./workspace.js";
import { runRestrictedCommand } from "./sandbox-shell.js";

export function createExecToolRegistration(workspace: Workspace): any[] {
  const ws = workspace;

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "workspace_exec_command",
          description: "在当前用户隔离的受限 workspace 中执行一个受限命令。普通用户和管理员普通对话可用；禁止 shell 拼接、绝对路径、环境变量展开和未允许程序。管理员真实环境请使用 agent_real_exec_command。",
          parameters: {
            type: "object",
            properties: {
              cmd: { type: "string", description: "要执行的命令" },
              timeoutMs: { type: "number", description: "超时时间（毫秒，默认 30000）" },
            },
            required: ["cmd"],
          },
        },
      },
      execute: async (args: any, _input: any) => {
        const cmd = String(args.cmd ?? "");
        if (!cmd) throw new ToolError("INVALID_ARGUMENT", "cmd 是必需的");
        const timeoutMs = Math.min(30000, Math.max(1000, Number(args.timeoutMs) || 30000));
        return runRestrictedCommand(cmd, ws.root, timeoutMs);
      },
    },
  ];
}
