import { spawnSync } from "node:child_process";
import path from "node:path";

const ALLOWED_EXECUTABLES = new Set([
  "bun",
  "cargo",
  "deno",
  "dotnet",
  "find",
  "git",
  "go",
  "java",
  "javac",
  "node",
  "npm",
  "npx",
  "pnpm",
  "python",
  "python3",
  "pytest",
  "rg",
  "ruby",
  "rustc",
  "tsc",
  "tsx",
  "where",
]);

const BLOCKED_ARGUMENTS = new Set([
  "-c",
  "/c",
  "-command",
  "-encodedcommand",
  "-e",
  "--eval",
  "--print",
  "-p",
  "--require",
  "-r",
  "--inspect",
  "--inspect-brk",
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "--config",
  "--config-env",
  "--upload-pack",
  "--receive-pack",
]);

const BLOCKED_SUBCOMMANDS = new Set([
  "add",
  "clone",
  "config",
  "create",
  "dlx",
  "global",
  "init",
  "install",
  "link",
  "publish",
  "remote",
  "remove",
  "reset",
  "submodule",
  "uninstall",
  "update",
]);

const MAX_COMMAND_LENGTH = 4000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Execute one allow-listed program without a shell and inside one scoped root.
 * This is an application-level sandbox: it removes shell composition,
 * absolute-path arguments, inherited secrets and dangerous command families.
 * A deployment that needs a kernel-enforced sandbox should still run the bot
 * under a dedicated OS account/container.
 */
export function runRestrictedCommand(
  command: string,
  root: string,
  timeoutMs: number,
): string {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("cmd 是必需的。");
  if (trimmed.length > MAX_COMMAND_LENGTH) throw new Error("cmd 不能超过 4000 个字符。");
  if (/[\u0000\r\n&|;<>`]/.test(trimmed) || /\$\(|\$\{|%[^%]+%/.test(trimmed)) {
    throw new Error("受限 shell 不允许命令拼接、重定向、命令替换或环境变量展开。");
  }

  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 0) throw new Error("无法解析命令。");

  if (!/^[a-zA-Z0-9_-]+(?:\.(?:cmd|exe))?$/.test(tokens[0])) {
    throw new Error("受限 shell 只允许执行白名单中的程序名，不允许带路径的可执行文件。");
  }
  const executable = normalizeExecutable(tokens[0]);
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    throw new Error(`受限 shell 不允许执行程序：${executable}`);
  }

  for (const token of tokens.slice(1)) {
    const normalized = token.toLowerCase();
    const optionName = normalized.includes("=") ? normalized.slice(0, normalized.indexOf("=")) : normalized;
    if (BLOCKED_ARGUMENTS.has(normalized) || BLOCKED_ARGUMENTS.has(optionName)) {
      throw new Error(`受限 shell 禁止参数：${token}`);
    }
    validateArgument(token, root);
  }

  if ((executable === "git" || executable === "npm" || executable === "pnpm" || executable === "npx")
    && tokens.slice(1).some((token) => BLOCKED_SUBCOMMANDS.has(token.toLowerCase()))) {
    throw new Error("受限 shell 禁止该包管理器或 Git 操作。");
  }

  const result = spawnSync(tokens[0], tokens.slice(1), {
    cwd: root,
    encoding: "utf8",
    timeout: Math.min(30_000, Math.max(1_000, timeoutMs)),
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
    env: createSandboxEnvironment(root),
  });

  if (result.error) {
    return JSON.stringify({
      exit_code: result.status ?? -1,
      stdout: truncateOutput(String(result.stdout ?? "")),
      stderr: truncateOutput(String(result.stderr ?? "")),
      error: result.error.message,
    });
  }

  return JSON.stringify({
    exit_code: result.status ?? -1,
    signal: result.signal ?? null,
    stdout: truncateOutput(String(result.stdout ?? "")),
    stderr: truncateOutput(String(result.stderr ?? "")),
    timed_out: result.signal === "SIGTERM" && result.status === null,
  });
}

function normalizeExecutable(value: string): string {
  const base = path.basename(value).toLowerCase();
  return base.endsWith(".cmd") || base.endsWith(".exe")
    ? base.slice(0, -4)
    : base;
}

function validateArgument(token: string, root: string): void {
  const value = token.includes("=") && token.startsWith("-")
    ? token.slice(token.indexOf("=") + 1)
    : token;
  if (!value) return;
  if (/^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    throw new Error("受限 shell 不允许绝对路径参数。");
  }
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    throw new Error("受限 shell 不允许 home 路径参数。");
  }
  const segments = value.split(/[\\/]/).filter(Boolean);
  if (segments.includes("..")) throw new Error("受限 shell 不允许访问上级目录。");

  // Relative path-like arguments are checked against the scoped root. This
  // also rejects a symlinked path when the target escapes the workspace.
  if (segments.length > 1 || value.startsWith(".")) {
    const candidate = path.resolve(root, value);
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("命令参数超出受限 workspace。");
    }
  }
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote) throw new Error("命令引号未闭合。");
  if (current) tokens.push(current);
  return tokens;
}

function createSandboxEnvironment(root: string): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
    TEMP: root,
    TMP: root,
    NO_COLOR: "1",
    AGENT_SANDBOX: "1",
    PWD: root,
  };
  return allowed;
}

function truncateOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES) return value;
  return `${value.slice(0, MAX_OUTPUT_BYTES)}\n... (输出截断) ...`;
}
