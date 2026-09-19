import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BotToolRegistration } from "../../tooling.js";
import type { BotConfig } from "../../types.js";
import { assertToolAccess } from "../../security/access-control.js";

/** Tools exposed only after an administrator explicitly enters real mode. */
export function createAgentRealToolRegistrations(config: BotConfig): BotToolRegistration[] {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "agent_real_exec_command",
          description: "在管理员真实环境任务中执行命令。可访问物理环境与任意 cwd；仅管理员通过 $real-work 发起的任务可用。命令有 120 秒超时和输出上限。",
          parameters: {
            type: "object",
            properties: {
              cmd: { type: "string", description: "要在宿主 shell 中执行的完整命令" },
              cwd: { type: "string", description: "可选工作目录；默认当前 bot 进程目录" },
              timeoutMs: { type: "number", description: "超时时间（毫秒，1000-120000）" },
            },
            required: ["cmd"],
            additionalProperties: false,
          },
        },
      },
      execute: async (args, input) => {
        // The registration is wrapped by index.ts as well. Keep a local check
        // here so direct/legacy execution cannot accidentally skip the mode gate.
        assertToolAccess("agent_real_exec_command", input, config);

        const cmd = typeof args.cmd === "string" ? args.cmd.trim() : "";
        if (!cmd) throw new Error("cmd 必须为非空字符串。");
        if (cmd.length > 12000) throw new Error("cmd 不能超过 12000 个字符。");

        const cwd = resolveCwd(args.cwd);
        const timeoutMs = Math.min(120000, Math.max(1000, Number(args.timeoutMs) || 120000));
        try {
          const output = execSync(cmd, {
            cwd,
            encoding: "utf8",
            timeout: timeoutMs,
            maxBuffer: 256 * 1024,
            windowsHide: true,
            // Linux 无 ComSpec；POSIX 上 execSync 默认 /bin/sh，这里显式声明避免回退到 cmd.exe。
            shell: process.env.ComSpec || (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
          });
          return JSON.stringify({
            cwd,
            exit_code: 0,
            stdout: truncate(String(output)),
            stderr: "",
          });
        } catch (error) {
          const err = error as NodeJS.ErrnoException & {
            status?: number;
            stdout?: string | Buffer;
            stderr?: string | Buffer;
            killed?: boolean;
          };
          return JSON.stringify({
            cwd,
            exit_code: err.status ?? -1,
            stdout: truncate(String(err.stdout ?? "")),
            stderr: truncate(String(err.stderr ?? err.message ?? "")),
            timed_out: err.killed === true,
          });
        }
      },
    },
  ];
}

function resolveCwd(value: unknown): string {
  const cwd = typeof value === "string" && value.trim()
    ? path.resolve(process.cwd(), value.trim())
    : process.cwd();
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`cwd 不是存在的目录：${cwd}`);
  }
  return cwd;
}

function truncate(text: string): string {
  return text.length > 250000 ? `${text.slice(0, 250000)}\n... (输出截断) ...` : text;
}
