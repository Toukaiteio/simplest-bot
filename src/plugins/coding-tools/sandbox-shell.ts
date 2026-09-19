import { spawn, spawnSync } from "node:child_process";
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
  const plan = planRestrictedCommand(command, root);
  const result = spawnSync(plan.tokens[0], plan.tokens.slice(1), {
    cwd: root,
    encoding: "utf8",
    timeout: Math.min(30_000, Math.max(1_000, timeoutMs)),
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
    env: plan.env,
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

export type RestrictedCommandPlan = {
  tokens: string[];
  env: NodeJS.ProcessEnv;
};

/** 只做校验不执行：后台任务在创建前先同步校验，拒绝要作为工具错误返回给模型。 */
export function validateRestrictedCommand(command: string, root: string): void {
  planRestrictedCommand(command, root);
}

/** 校验并解析一条受限命令：白名单程序、无 shell 拼接、参数不出 workspace。 */
function planRestrictedCommand(command: string, root: string): RestrictedCommandPlan {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("cmd 是必需的。");
  if (trimmed.length > MAX_COMMAND_LENGTH) throw new Error("cmd 不能超过 4000 个字符。");
  if (/[\u0000\r\n&|;<>`]/u.test(trimmed) || /\$\(|\$\{|%[^%]+%/u.test(trimmed)) {
    throw new Error("受限 shell 不允许命令拼接、重定向、命令替换或环境变量展开。");
  }

  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 0) throw new Error("无法解析命令。");

  if (!/^[a-zA-Z0-9_-]+(?:\.(?:cmd|exe))?$/u.test(tokens[0])) {
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

  return { tokens, env: createSandboxEnvironment(root) };
}

export type AsyncRestrictedCommand = {
  /** 命令结束后 resolve 为与同步版相同结构的 JSON 字符串。 */
  promise: Promise<string>;
  /** 终止进程（幂等）。 */
  kill: () => void;
};

/** 后台任务的异步受限命令：与同步版同一套校验，超时可到 10 分钟，不阻塞事件循环。 */
export function runRestrictedCommandAsync(
  command: string,
  root: string,
  timeoutMs: number,
): AsyncRestrictedCommand {
  const plan = planRestrictedCommand(command, root);
  const boundedTimeout = Math.min(600_000, Math.max(1_000, timeoutMs));
  const child = spawn(plan.tokens[0], plan.tokens.slice(1), {
    cwd: root,
    shell: false,
    windowsHide: true,
    env: plan.env,
  });

  let stdout = "";
  let stderr = "";
  // 累积上限防止失控输出吃内存；结果再走 truncateOutput。
  const accumulate = (current: string, chunk: Buffer | string): string => {
    if (current.length >= MAX_OUTPUT_BYTES) return current;
    return current + String(chunk).slice(0, MAX_OUTPUT_BYTES - current.length);
  };
  child.stdout?.on("data", (chunk: Buffer | string) => { stdout = accumulate(stdout, chunk); });
  child.stderr?.on("data", (chunk: Buffer | string) => { stderr = accumulate(stderr, chunk); });

  let timedOut = false;
  let killed = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killed = true;
    child.kill();
  }, boundedTimeout);
  timer.unref?.();

  const promise = new Promise<string>((resolve) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve(JSON.stringify({
        exit_code: -1,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        error: error.message,
      }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve(JSON.stringify({
        exit_code: code ?? -1,
        signal: signal ?? null,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        timed_out: timedOut,
        killed,
      }));
    });
  });

  return {
    promise,
    kill: () => {
      killed = true;
      child.kill();
    },
  };
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
  if (/^[a-z]:[\\/]/iu.test(value) || /^\\\\/u.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    throw new Error("受限 shell 不允许绝对路径参数。");
  }
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    throw new Error("受限 shell 不允许 home 路径参数。");
  }
  const segments = value.split(/[\\/]/u).filter(Boolean);
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
    if (/\s/u.test(char)) {
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
    TEMP: root,
    TMP: root,
    NO_COLOR: "1",
    AGENT_SANDBOX: "1",
    PWD: root,
  };
  // Windows 子进程初始化需要这些变量（缺失会导致部分程序启动失败）；Linux 上无意义，不注入。
  if (process.platform === "win32") {
    allowed.PATHEXT = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    allowed.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    allowed.ComSpec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
  }
  return allowed;
}

function truncateOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES) return value;
  return `${value.slice(0, MAX_OUTPUT_BYTES)}\n... (输出截断) ...`;
}
