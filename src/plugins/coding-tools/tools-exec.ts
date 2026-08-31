import { execSync } from "node:child_process";
import { ToolError, Workspace } from "./workspace.js";

export function createExecToolRegistration(workspace: Workspace): any[] {
  const ws = workspace;

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "workspace_exec_command",
          description: "在工作区目录中执行命令。仅限管理员使用。注意：此工具可在工作区中执行任意命令。",
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
      execute: async (args: any, input: any) => {
        const msg = input.mode === "single" ? input.message : input.messages[input.messages.length - 1];
        const userId = msg.userId;
        // Admin check happens in the main plugin
        const cmd = String(args.cmd ?? "");
        if (!cmd) throw new ToolError("INVALID_ARGUMENT", "cmd 是必需的");
        const timeoutMs = Math.min(120000, Math.max(1000, Number(args.timeoutMs) || 30000));
        try {
          const output = execSync(cmd, { cwd: ws.root, encoding: "utf-8", timeout: timeoutMs, maxBuffer: 65536 });
          const truncated = output.length > 64000;
          return JSON.stringify({ exit_code: 0, stdout: truncated ? output.slice(0, 64000) + "\n... (输出截断) ..." : output, stderr: "", truncated });
        } catch (e: any) {
          return JSON.stringify({ exit_code: e.status || -1, stdout: e.stdout || "", stderr: e.stderr || e.message || "", error: e.message?.slice(0, 500) });
        }
      },
    },
  ];
}
