import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import type { MenuPlugin, Plugin, PluginContext } from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";
import { getInputMessage } from "../../security/access-control.js";

type AgentlyState = {
  authorized: boolean;
  email?: string;
};

const STATE_FILE = path.resolve("data", "agently", "state.json");

// Per-user pending confirmation operations (stores cliArgs + ctk so AI doesn't need to pass token)
interface PendingOp { cliArgs: string[]; ctk: string; summary: string; expiresAt: number }
const pendingOps = new Map<string, PendingOp>();

function loadState(): AgentlyState {
  try {
    if (!fs.existsSync(STATE_FILE)) return { authorized: false };
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as AgentlyState;
  } catch {
    return { authorized: false };
  }
}

function saveState(state: AgentlyState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ── CLI execution helper ──

interface CliResult {
  exitCode: number;
  data?: Record<string, any>;
  raw: string;
  error?: string;
}

function runCli(args: string[], timeoutMs = 30000): Promise<CliResult> {
  return new Promise((resolve) => {
    const proc = spawn("agently-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      timeout: timeoutMs,
    });

    let stdout = "", stderr = "";
    proc.stdout?.on("data", (buf: Buffer) => { stdout += buf.toString("utf-8"); });
    proc.stderr?.on("data", (buf: Buffer) => { stderr += buf.toString("utf-8"); });

    proc.on("error", () => {
      resolve({ exitCode: -1, raw: stdout + stderr, error: "CLI process error" });
    });

    proc.on("exit", (code) => {
      const exitCode = code ?? -1;
      const output = stdout.trim();

      if (exitCode === 0) {
        let data: Record<string, any> | undefined;
        try { data = JSON.parse(output); } catch { /* non-JSON output */ }
        resolve({ exitCode, data, raw: output });
      } else if (exitCode === 3) {
        resolve({ exitCode, raw: output, error: "授权已过期，请运行 $agently-auth 重新授权" });
      } else if (exitCode === 7) {
        resolve({ exitCode, raw: output, error: "请求频率过高，请稍后重试" });
      } else if (exitCode === 8) {
        // Missing confirmation-token — extract ctk from output
        let ctk: string | undefined;
        const ctkMatch = output.match(/ctk_[a-zA-Z0-9_-]+/);
        if (ctkMatch) ctk = ctkMatch[0];
        let data: Record<string, any> | undefined;
        try { data = JSON.parse(output); } catch { /* ignore */ }
        if (data && ctk) data.confirmation_token = ctk;
        resolve({ exitCode, data, raw: output, error: `需要确认。Token: ${ctk ?? "未知"}` });
      } else {
        let errorMsg = stderr.trim() || output || `退出码 ${exitCode}`;
        try {
          const parsed = JSON.parse(output);
          if (parsed?.error?.message) errorMsg = parsed.error.message;
        } catch { /* use raw */ }
        resolve({ exitCode, raw: output, error: errorMsg });
      }
    });
  });
}

function checkAuth(): string | null {
  const state = loadState();
  if (!state.authorized) {
    return "尚未授权。请先让用户运行 $agently-auth 完成 QQ 邮箱授权。";
  }
  return null;
}

// Parse email from +me output (handles both raw JSON and parsed data)
function parseEmail(raw: string, data?: Record<string, any>): string {
  if (data?.data?.aliases?.[0]?.email) return data.data.aliases[0].email;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.data?.aliases?.[0]?.email) return parsed.data.aliases[0].email;
  } catch { /* ignore */ }
  return raw.trim().split("\n")[0].slice(0, 100);
}

// Format message list for display
function formatMessages(messages: any[]): string {
  if (!messages || messages.length === 0) return "没有邮件。";
  return messages.map((m: any, i: number) => {
    const date = m.date ? new Date(m.date).toLocaleDateString("zh-CN") : "";
    return `${i + 1}. [${m.id}] ${m.from_name || m.from || "?"} — ${m.subject || "(无主题)"} (${date})`;
  }).join("\n");
}

// ── Tool: mail_list ──

function makeMailListTool(): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: {
        name: "mail_list",
        description: "列出邮箱中的邮件。支持收件箱(inbox)、已发送(sent)、回收站(trash)、垃圾邮件(spam)。",
        parameters: {
          type: "object",
          properties: {
            dir: { type: "string", enum: ["inbox", "sent", "trash", "spam"], description: "文件夹，默认 inbox" },
            limit: { type: "number", description: "数量，默认10" },
            cursor: { type: "string", description: "翻页游标" },
          },
        },
      },
    },
    execute: async (args) => {
      const authErr = checkAuth();
      if (authErr) return authErr;

      const cliArgs = ["message", "+list"];
      if (args.dir) cliArgs.push("--dir", String(args.dir));
      if (args.limit) cliArgs.push("--limit", String(args.limit));
      if (args.cursor) cliArgs.push("--cursor", String(args.cursor));

      const result = await runCli(cliArgs);
      if (result.exitCode !== 0) {
        if (result.exitCode === 3) saveState({ authorized: false });
        return `[查询失败 exit=${result.exitCode}] ${result.error ?? "未知错误"}。原始输出: ${result.raw.slice(0, 200)}`;
      }

      const messages = result.data?.data?.messages ?? result.data?.messages ?? [];
      const cursor = result.data?.data?.next_cursor ?? result.data?.next_cursor;
      let text = formatMessages(messages);
      if (cursor) text += `\n\n更多邮件：cursor = ${cursor}`;
      return text;
    },
  };
}

// ── Tool: mail_send ──

function makeMailSendTool(): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: {
        name: "mail_send",
        description: "发送邮件。支持抄送(cc)和密送(bcc)。auto_confirm=true 时直接发送（适合简单任务：回复已知联系人、日常通知等）；auto_confirm=false 或不传时走两阶段确认（适合重要任务：敏感内容、新收件人、大额/批量发送等），需要用户确认后再传 user_confirmed=true 完成发送。",
        parameters: {
          type: "object",
          properties: {
            to: { type: "array", items: { type: "string" }, description: "收件人邮箱列表" },
            subject: { type: "string", description: "邮件主题" },
            body: { type: "string", description: "邮件正文" },
            cc: { type: "array", items: { type: "string" }, description: "抄送邮箱列表" },
            bcc: { type: "array", items: { type: "string" }, description: "密送邮箱列表" },
            auto_confirm: { type: "boolean", description: "true=直接发送无需用户确认（简单任务）；false=需要用户确认（重要任务，默认）" },
            user_confirmed: { type: "boolean", description: "两阶段确认模式下，用户确认后第二次调用传 true" },
          },
        },
      },
    },
    execute: async (args, input) => {
      const authErr = checkAuth();
      if (authErr) return authErr;

      const userId = getInputMessage(input).userId;
      const hasEmailArgs = args.to && (args.to as string[]).length > 0 && args.subject && args.body;

      // Phase 2: user confirmed → use stored ctk to complete send
      if (args.user_confirmed && userId) {
        const pending = pendingOps.get(userId);
        if (!pending || Date.now() > pending.expiresAt) {
          pendingOps.delete(userId);
          return "没有待确认的发送操作，或确认已过期（5分钟）。请重新发起发送流程。";
        }
        pendingOps.delete(userId);
        const finalArgs = [...pending.cliArgs, "--confirmation-token", pending.ctk];
        const result = await runCli(finalArgs);
        if (result.exitCode !== 0) {
          if (result.exitCode === 3) saveState({ authorized: false });
          return `[发送失败 exit=${result.exitCode}] ${result.error ?? "未知错误"}。原始输出: ${result.raw.slice(0, 200)}`;
        }
        return "邮件发送成功！";
      }

      // Validate args
      if (!hasEmailArgs) {
        return "缺少必要参数。请传入 to（收件人列表）、subject（主题）、body（正文）。如需抄送用 cc，密送用 bcc。";
      }

      // Build CLI args
      const cliArgs = ["message", "+send"];
      for (const t of (args.to as string[])) cliArgs.push("--to", t);
      cliArgs.push("--subject", String(args.subject));
      cliArgs.push("--body", String(args.body));
      if (args.cc) for (const c of args.cc as string[]) cliArgs.push("--cc", String(c));
      if (args.bcc) for (const b of args.bcc as string[]) cliArgs.push("--bcc", String(b));

      // Phase 1: execute without token → get ctk + summary
      const result = await runCli(cliArgs);

      if (result.exitCode === 3) {
        saveState({ authorized: false });
        return "授权已过期，请让用户运行 $agently-auth 重新授权。";
      }

      const ctk = result.data?.data?.confirmation_token
        ?? result.data?.confirmation_token
        ?? result.raw.match(/ctk_[a-zA-Z0-9_-]+/)?.[0];
      const summary = result.data?.data?.summary
        ?? result.data?.summary
        ?? (result.exitCode === 0 ? result.raw : null);

      if (!ctk) {
        if (result.exitCode !== 0) {
          return `[发送失败 exit=${result.exitCode}] ${result.error ?? "未知错误"}。原始输出: ${result.raw.slice(0, 300)}`;
        }
        return result.raw || "操作完成（未获取到确认令牌，邮件可能已直接发送）。";
      }

      // auto_confirm: immediately complete Phase 2 internally
      if (args.auto_confirm) {
        const finalArgs = [...cliArgs, "--confirmation-token", ctk];
        const sendResult = await runCli(finalArgs);
        if (sendResult.exitCode !== 0) {
          if (sendResult.exitCode === 3) saveState({ authorized: false });
          return `[发送失败 exit=${sendResult.exitCode}] ${sendResult.error ?? "未知错误"}。原始输出: ${sendResult.raw.slice(0, 200)}`;
        }
        return `邮件发送成功！\n${summary ?? ""}`;
      }

      // Two-phase: store pending, return preview for user confirmation
      if (userId) {
        pendingOps.set(userId, {
          cliArgs, ctk,
          summary: summary ?? result.raw,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
      }
      return `发送预览：\n${summary ?? result.raw}\n\n请向用户展示以上内容，询问是否确认发送。用户确认后，再次调用 mail_send 并只传 user_confirmed=true。`;
    },
  };
}

// ── Tool: mail_read ──

function makeMailReadTool(): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: {
        name: "mail_read",
        description: "读取邮件完整内容（正文、附件信息）。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "邮件 ID (msg_xxx 格式)" },
          },
        },
      },
    },
    execute: async (args) => {
      const authErr = checkAuth();
      if (authErr) return authErr;
      if (!args.id) return "缺少必要参数。请传入 id（邮件 ID，格式 msg_xxx）。";

      const result = await runCli(["message", "+read", "--id", String(args.id)]);
      if (result.exitCode !== 0) {
        if (result.exitCode === 3) saveState({ authorized: false });
        return `[读取失败 exit=${result.exitCode}] ${result.error ?? "未知错误"}。原始输出: ${result.raw.slice(0, 200)}`;
      }

      const msg = result.data?.data ?? result.data ?? {};
      const lines: string[] = [];
      if (msg.from_name || msg.from) lines.push(`发件人: ${msg.from_name ?? ""} <${msg.from ?? ""}>`);
      if (msg.to) lines.push(`收件人: ${Array.isArray(msg.to) ? msg.to.join(", ") : msg.to}`);
      if (msg.subject) lines.push(`主题: ${msg.subject}`);
      if (msg.date) lines.push(`日期: ${msg.date}`);
      if (msg.body) lines.push(`\n正文:\n${msg.body}`);
      if (msg.attachments?.length) {
        lines.push("\n附件:");
        for (const att of msg.attachments) {
          if (att.attachment_id) lines.push(`  - ${att.filename ?? att.name} (${att.attachment_id})`);
          else if (att.download_url) lines.push(`  - ${att.filename ?? att.name} (超大附件: ${att.download_url})`);
        }
      }
      return lines.join("\n") || result.raw || "邮件内容为空。";
    },
  };
}

// ── Tool: mail_search ──

function makeMailSearchTool(): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: {
        name: "mail_search",
        description: "搜索邮件。支持关键词、发件人、日期范围等过滤条件。",
        parameters: {
          type: "object",
          properties: {
            q: { type: "string", description: "搜索关键词" },
            from: { type: "string", description: "发件人过滤" },
            dir: { type: "string", enum: ["inbox", "sent", "trash", "spam"], description: "搜索文件夹" },
            after: { type: "string", description: "起始日期 (YYYY-MM-DD)" },
            before: { type: "string", description: "结束日期 (YYYY-MM-DD)" },
            is_unread: { type: "boolean", description: "仅未读" },
            has_attachments: { type: "boolean", description: "仅含附件" },
            limit: { type: "number", description: "数量，默认10" },
            cursor: { type: "string", description: "翻页游标" },
          },
        },
      },
    },
    execute: async (args) => {
      const authErr = checkAuth();
      if (authErr) return authErr;
      if (!args.q) return "缺少必要参数。请传入 q（搜索关键词）。";

      const cliArgs = ["message", "+search", "--q", String(args.q)];
      if (args.from) cliArgs.push("--from", String(args.from));
      if (args.dir) cliArgs.push("--dir", String(args.dir));
      if (args.after) cliArgs.push("--after", String(args.after));
      if (args.before) cliArgs.push("--before", String(args.before));
      if (args.is_unread) cliArgs.push("--is-unread");
      if (args.has_attachments) cliArgs.push("--has-attachments");
      if (args.limit) cliArgs.push("--limit", String(args.limit));
      if (args.cursor) cliArgs.push("--cursor", String(args.cursor));

      const result = await runCli(cliArgs);
      if (result.exitCode !== 0) {
        if (result.exitCode === 3) saveState({ authorized: false });
        return `[搜索失败 exit=${result.exitCode}] ${result.error ?? "未知错误"}。原始输出: ${result.raw.slice(0, 200)}`;
      }

      const messages = result.data?.data?.messages ?? result.data?.messages ?? [];
      const cursor = result.data?.data?.next_cursor ?? result.data?.next_cursor;
      let text = formatMessages(messages);
      if (cursor) text += `\n\n更多结果：cursor = ${cursor}`;
      return text;
    },
  };
}

// ── Tool: mail_trash ──

function makeMailTrashTool(): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: {
        name: "mail_trash",
        description: "将邮件移到回收站（30天后真正删除）。auto_confirm=true 时直接删除（适合垃圾邮件、通知邮件等）；auto_confirm=false 或不传时需要用户确认（适合重要邮件）。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "邮件 ID (msg_xxx)" },
            auto_confirm: { type: "boolean", description: "true=直接删除无需确认；false=需要用户确认（默认）" },
            user_confirmed: { type: "boolean", description: "两阶段确认模式下，用户确认后第二次调用传 true" },
          },
        },
      },
    },
    execute: async (args, input) => {
      const authErr = checkAuth();
      if (authErr) return authErr;

      const userId = getInputMessage(input).userId;

      // Phase 2: user confirmed
      if (args.user_confirmed && userId) {
        const pending = pendingOps.get(userId);
        if (!pending || Date.now() > pending.expiresAt) {
          pendingOps.delete(userId);
          return "没有待确认的删除操作，或确认已过期。请重新调用 mail_trash 传入邮件 id。";
        }
        pendingOps.delete(userId);
        const finalArgs = [...pending.cliArgs, "--confirmation-token", pending.ctk];
        const result = await runCli(finalArgs);
        if (result.exitCode !== 0) {
          if (result.exitCode === 3) saveState({ authorized: false });
          return `[删除失败 exit=${result.exitCode}] ${result.error ?? "未知错误"}。原始输出: ${result.raw.slice(0, 200)}`;
        }
        return "邮件已移到回收站。";
      }

      if (!args.id) {
        return "缺少必要参数。请传入 id（邮件 ID，格式 msg_xxx）。";
      }

      // Phase 1: get ctk
      const cliArgs = ["message", "+trash", "--id", String(args.id)];
      const result = await runCli(cliArgs);

      if (result.exitCode === 3) {
        saveState({ authorized: false });
        return "授权已过期，请让用户运行 $agently-auth 重新授权。";
      }

      const ctk = result.data?.data?.confirmation_token
        ?? result.data?.confirmation_token
        ?? result.raw.match(/ctk_[a-zA-Z0-9_-]+/)?.[0];
      const summary = result.data?.data?.summary ?? result.data?.summary ?? result.raw;

      if (!ctk) {
        if (result.exitCode !== 0) {
          return `[删除失败 exit=${result.exitCode}] ${result.error ?? "未知错误"}。原始输出: ${result.raw.slice(0, 300)}`;
        }
        return result.raw || "操作完成（未获取到确认令牌）。";
      }

      // auto_confirm: immediately complete
      if (args.auto_confirm) {
        const finalArgs = [...cliArgs, "--confirmation-token", ctk];
        const trashResult = await runCli(finalArgs);
        if (trashResult.exitCode !== 0) {
          if (trashResult.exitCode === 3) saveState({ authorized: false });
          return `[删除失败 exit=${trashResult.exitCode}] ${trashResult.error ?? "未知错误"}。原始输出: ${trashResult.raw.slice(0, 200)}`;
        }
        return "邮件已移到回收站。";
      }

      // Two-phase: store pending, return preview
      if (userId) {
        pendingOps.set(userId, {
          cliArgs, ctk,
          summary: summary ?? result.raw,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
      }
      return `确认删除：\n${summary ?? result.raw}\n\n请向用户确认是否要删除此邮件。用户确认后，再次调用 mail_trash 并只传 user_confirmed=true。`;
    },
  };
}

// ── Plugin factory ──

export function createAgentlyPlugin(menuPlugin: MenuPlugin): Plugin & { getToolRegistrations(): BotToolRegistration[] } {
  return {
    name: "agently",
    description: "QQ 邮箱 Agently CLI 集成：授权、收发/搜索/管理邮件",

    systemPromptAppend: [
      "你已集成 QQ 邮箱（Agently CLI）。可以使用以下工具操作邮件：",
      "- mail_list: 列出邮件（支持 inbox/sent/trash/spam 文件夹）",
      "- mail_read: 读取邮件完整内容",
      "- mail_search: 搜索邮件（关键词、发件人、日期等）",
      "- mail_send: 发送邮件（支持 cc 抄送、bcc 密送）",
      "- mail_trash: 将邮件移到回收站",
      "",
      "确认策略（由你自行判断）：",
      "简单任务 → 设 auto_confirm=true，一次调用直接完成。例如：",
      "  - 回复已知联系人的邮件",
      "  - 发送日常通知、状态汇报",
      "  - 删除明显的垃圾邮件、广告邮件",
      "  - 用户明确说「直接发」「不用确认」",
      "",
      "重要任务 → 不设 auto_confirm，走两阶段确认。例如：",
      "  - 发送给新/陌生收件人",
      "  - 涉及敏感内容、财务信息",
      "  - 批量发送给多人",
      "  - 删除重要邮件",
      "  - 用户明确要求「先给我看看」",
      "",
      "两阶段确认流程：",
      "1. 调用 mail_send（传入 to/subject/body），工具返回预览",
      "2. 展示预览给用户，问是否确认",
      "3. 用户确认后，再次调用 mail_send 只传 user_confirmed=true",
      "",
      "如果工具返回「授权已过期」，请告诉用户运行 $agently-auth 重新授权。",
    ].join("\n"),

    async onLoad(ctx: PluginContext) {
      const prefix = menuPlugin.getPrefix();

      menuPlugin.registerCommand("agently-auth", "授权 QQ 邮箱（Agently CLI）", async (message) => {
        const userId = message.userId!;
        await ctx.replyText(message, "正在安装/更新 Agently CLI...");

        try {
          execSync("npm install -g @tencent-qqmail/agently-cli", { stdio: "pipe", timeout: 60000 });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.replyText(message, "安装 Agently CLI 失败：" + msg.slice(0, 200));
          return;
        }

        try {
          execSync("npx skills add https://agent.qq.com --skill -g -y", { stdio: "pipe", timeout: 30000 });
        } catch {
          // Non-fatal: skill may already exist
        }

        await ctx.replyText(message, "正在启动 OAuth 授权，请稍候...");

        const proc = spawn("agently-cli", ["auth", "login"], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
          timeout: 120_000,
        });

        let urlFound = false;
        let outputBuffer = "";

        const onData = (chunk: string) => {
          outputBuffer += chunk;
          if (!urlFound) {
            const m = outputBuffer.match(/https?:\/\/[^\s"'<>)}\]|]+/);
            if (m) {
              urlFound = true;
              ctx.sendMessage(
                { type: "private", id: userId },
                "请点击或复制以下链接在浏览器中完成授权：\n\n```\n" + m[0] + "\n```",
              ).catch(() => {});
            }
          }
        };

        proc.stdout?.on("data", (buf: Buffer) => onData(buf.toString("utf-8")));
        proc.stderr?.on("data", (buf: Buffer) => onData(buf.toString("utf-8")));

        await new Promise<void>((resolve) => {
          proc.on("exit", () => resolve());
          proc.on("error", () => resolve());
        });

        // Verify via +me
        try {
          const result = await runCli(["+me"], 15000);
          if (result.exitCode !== 0) {
            await ctx.sendMessage(
              { type: "private", id: userId },
              "授权验证失败：" + (result.error ?? "未知错误"),
            );
            return;
          }

          const email = parseEmail(result.raw, result.data);
          saveState({ authorized: true, email });

          await ctx.sendMessage(
            { type: "private", id: userId },
            "邮箱地址 " + email + " 已授权成功，可以用它来收发邮件了\n"
            + "你可以试试以下指令：\n"
            + "帮我发一封邮件。\n"
            + "我最近收到了哪些邮件？\n"
            + "帮我整理最近收到的邮件。\n\n"
            + "也可以直接描述你的邮件工作流，让 Agent 帮你处理。",
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.sendMessage(
            { type: "private", id: userId },
            "授权验证失败：" + msg.slice(0, 200),
          );
        }
      }, { adminOnly: true });
    },

    getToolRegistrations(): BotToolRegistration[] {
      return [
        makeMailListTool(),
        makeMailSendTool(),
        makeMailReadTool(),
        makeMailSearchTool(),
        makeMailTrashTool(),
      ];
    },
  };
}
