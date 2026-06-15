import fs from "node:fs";
import path from "node:path";
import type { BotMessage, MenuPlugin, NotifyTarget, Plugin, PluginContext, PromptBuildInput } from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";

type ChatScope = {
  target: NotifyTarget;
  rootDir: string;
  label: string;
};

type FileWorkspacePlugin = Plugin & {
  getToolRegistrations: () => BotToolRegistration[];
};

const TEXT_FILE_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".tsx", ".jsx", ".css", ".html", ".xml",
  ".yaml", ".yml", ".csv", ".log", ".ini", ".cfg",
]);

export function createFileWorkspacePlugin(menuPlugin: MenuPlugin): FileWorkspacePlugin {
  let ctxRef: PluginContext | null = null;
  let cleanupTimer: NodeJS.Timeout | null = null;

  const plugin: FileWorkspacePlugin = {
    name: "file-workspace",
    description: "房间级临时文件工作区，支持下载、查看、编辑与发送文件",
    systemPromptAppend: [
      "你可以使用文件工具管理当前会话的临时文件工作区。",
      "文件工具仅能访问当前群聊或私聊隔离出的临时目录。",
      "发送文件只允许发送当前会话文件工作区内的文件。",
      "发送图片和语音时，可使用当前工作区文件，或当前仓库 workspace 内的文件。",
    ].join("\n"),

    async onLoad(ctx) {
      ctxRef = ctx;
      cleanupAllScopes(ctx);
      cleanupTimer = setInterval(() => cleanupAllScopes(ctx), 6 * 60 * 60 * 1000);

      menuPlugin.registerCommand("files", "列出当前会话的临时文件", async (message) => {
        const scope = getScopeForMessage(message, ctx);
        const files = listScopeFiles(scope, ctx);
        if (files.length === 0) {
          await ctx.replyText(message, "当前会话还没有临时文件。");
          return;
        }

        const text = [
          `当前会话文件 (${scope.label})：`,
          ...files.map((file) => `- ${file.name} (${formatSize(file.size)})`),
        ].join("\n");
        await ctx.replyText(message, text);
      });

      menuPlugin.registerCommand("download", `下载文件到当前会话：${menuPlugin.getPrefix()}download <url> [文件名]`, async (message, args) => {
        const url = args[0];
        const fileName = args[1];
        if (!url) {
          await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}download <url> [文件名]`);
          return;
        }

        const scope = getScopeForMessage(message, ctx);
        const savedPath = await downloadIntoScope(scope, url, ctx, fileName);
        await ctx.replyText(message, `文件已下载到当前会话：${path.basename(savedPath)}`);
      });

      menuPlugin.registerCommand("view_file", `查看当前会话文件：${menuPlugin.getPrefix()}view_file <文件名>`, async (message, args) => {
        const fileName = args[0];
        if (!fileName) {
          await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}view_file <文件名>`);
          return;
        }

        const scope = getScopeForMessage(message, ctx);
        const result = viewScopeFile(scope, fileName, ctx, ctx.config.pluginSettings.fileWorkspace.maxViewChars);
        await ctx.replyText(message, result);
      });

      menuPlugin.registerCommand("send_file", `发送当前会话文件：${menuPlugin.getPrefix()}send_file <文件名>`, async (message, args) => {
        const fileName = args[0];
        if (!fileName) {
          await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}send_file <文件名>`);
          return;
        }

        const scope = getScopeForMessage(message, ctx);
        const filePath = resolveScopeFile(scope, fileName, ctx);
        touchFile(filePath);
        await ctx.sendFile(scope.target, filePath, path.basename(filePath));
      });
    },

    async onMessage(message, ctx) {
      const scope = getScopeForMessage(message, ctx);
      const files = listScopeFiles(scope, ctx);

      for (const file of files) {
        if (message.text.includes(file.name)) {
          touchFile(file.path);
        }
      }

      return false;
    },

    getToolRegistrations() {
      const registrations: BotToolRegistration[] = [
        makeTool("list_files", "列出当前会话隔离工作区中的临时文件。", {
          type: "object",
          properties: {},
          required: [],
        }, async (_args, input) => {
          const ctx = ensureContext(ctxRef);
          const scope = getScopeForInput(input, ctx);
          const files = listScopeFiles(scope, ctx);
          return files.length > 0
            ? files.map((file) => `${file.name} (${formatSize(file.size)})`).join("\n")
            : "当前会话还没有临时文件。";
        }),
        makeTool("download_file", "下载 URL 到当前会话的隔离临时目录。", {
          type: "object",
          properties: {
            url: { type: "string", description: "要下载的 http/https URL" },
            fileName: { type: "string", description: "可选，保存文件名" },
          },
          required: ["url"],
        }, async (args, input) => {
          const ctx = ensureContext(ctxRef);
          const scope = getScopeForInput(input, ctx);
          const savedPath = await downloadIntoScope(scope, requireString(args.url, "url"), ctx, optionalString(args.fileName));
          return `文件已下载：${path.basename(savedPath)}`;
        }),
        makeTool("view_file", "查看当前会话隔离目录中的文本文件内容。", {
          type: "object",
          properties: {
            fileName: { type: "string", description: "当前会话中的文件名" },
            maxChars: { type: "number", description: "最多读取的字符数" },
          },
          required: ["fileName"],
        }, async (args, input) => {
          const ctx = ensureContext(ctxRef);
          const scope = getScopeForInput(input, ctx);
          return viewScopeFile(scope, requireString(args.fileName, "fileName"), ctx, optionalNumber(args.maxChars) ?? ctx.config.pluginSettings.fileWorkspace.maxViewChars);
        }),
        makeTool("edit_file", "编辑当前会话隔离目录中的文本文件。", {
          type: "object",
          properties: {
            fileName: { type: "string", description: "当前会话中的文件名" },
            mode: { type: "string", enum: ["overwrite", "append", "replace"], description: "编辑模式" },
            content: { type: "string", description: "overwrite/append 模式下要写入的内容" },
            findText: { type: "string", description: "replace 模式下要查找的文本" },
            replaceText: { type: "string", description: "replace 模式下的替换文本" },
          },
          required: ["fileName", "mode"],
        }, async (args, input) => {
          const ctx = ensureContext(ctxRef);
          const scope = getScopeForInput(input, ctx);
          return editScopeFile(scope, {
            fileName: requireString(args.fileName, "fileName"),
            mode: requireString(args.mode, "mode") as "overwrite" | "append" | "replace",
            content: optionalString(args.content),
            findText: optionalString(args.findText),
            replaceText: optionalString(args.replaceText),
          }, ctx);
        }),
        makeTool("send_file", "发送当前会话隔离目录中的文件。仅允许发送该目录内的文件。", {
          type: "object",
          properties: {
            fileName: { type: "string", description: "当前会话中的文件名" },
          },
          required: ["fileName"],
        }, async (args, input) => {
          const ctx = ensureContext(ctxRef);
          const scope = getScopeForInput(input, ctx);
          const filePath = resolveScopeFile(scope, requireString(args.fileName, "fileName"), ctx);
          touchFile(filePath);
          await ctx.sendFile(scope.target, filePath, path.basename(filePath));
          return `已发送文件：${path.basename(filePath)}`;
        }),
        makeTool("send_image", "发送图片。支持当前会话目录内文件，或当前 workspace 内的图片文件。", {
          type: "object",
          properties: {
            filePath: { type: "string", description: "图片路径，可以是当前会话文件名或 workspace 相对路径" },
            caption: { type: "string", description: "可选，图片附带文案" },
          },
          required: ["filePath"],
        }, async (args, input) => {
          const ctx = ensureContext(ctxRef);
          const scope = getScopeForInput(input, ctx);
          const filePath = resolveMediaPath(scope, requireString(args.filePath, "filePath"), ctx);
          await ctx.sendImage(scope.target, filePath, optionalString(args.caption));
          return `已发送图片：${path.basename(filePath)}`;
        }),
        makeTool("send_voice", "发送语音。支持当前会话目录内文件，或当前 workspace 内的语音文件。", {
          type: "object",
          properties: {
            filePath: { type: "string", description: "语音路径，可以是当前会话文件名或 workspace 相对路径" },
          },
          required: ["filePath"],
        }, async (args, input) => {
          const ctx = ensureContext(ctxRef);
          const scope = getScopeForInput(input, ctx);
          const filePath = resolveMediaPath(scope, requireString(args.filePath, "filePath"), ctx);
          await ctx.sendVoice(scope.target, filePath);
          return `已发送语音：${path.basename(filePath)}`;
        }),
      ];

      return registrations;
    },
  };

  return plugin;
}

function makeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: BotToolRegistration["execute"]
): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description,
        parameters,
      },
    },
    execute,
  };
}

function getScopeForInput(input: PromptBuildInput, ctx: PluginContext): ChatScope {
  return input.mode === "single"
    ? getScopeForMessage(input.message, ctx)
    : getScopeForMessage(input.messages[input.messages.length - 1], ctx);
}

function getScopeForMessage(message: BotMessage, ctx: PluginContext): ChatScope {
  const baseDir = path.resolve(process.cwd(), ctx.config.pluginSettings.fileWorkspace.rootDir);

  if (message.type === "group" && message.groupId) {
    const rootDir = path.join(baseDir, "group", message.groupId);
    fs.mkdirSync(rootDir, { recursive: true });
    return {
      target: { type: "group", id: message.groupId },
      rootDir,
      label: `group:${message.groupId}`,
    };
  }

  const privateId = message.userId ?? "unknown";
  const rootDir = path.join(baseDir, "private", privateId);
  fs.mkdirSync(rootDir, { recursive: true });
  return {
    target: { type: "private", id: privateId },
    rootDir,
    label: `private:${privateId}`,
  };
}

function cleanupAllScopes(ctx: PluginContext) {
  const baseDir = path.resolve(process.cwd(), ctx.config.pluginSettings.fileWorkspace.rootDir);
  if (!fs.existsSync(baseDir)) {
    return;
  }

  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const scopeTypeDir = path.join(baseDir, entry.name);
    if (!entry.isDirectory()) continue;
    for (const scopeEntry of fs.readdirSync(scopeTypeDir, { withFileTypes: true })) {
      if (!scopeEntry.isDirectory()) continue;
      cleanupExpiredFiles(path.join(scopeTypeDir, scopeEntry.name), ctx);
    }
  }
}

function cleanupExpiredFiles(scopeDir: string, ctx: PluginContext) {
  if (!fs.existsSync(scopeDir)) {
    return;
  }

  const ttlMs = ctx.config.pluginSettings.fileWorkspace.expirationDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const entry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
    const entryPath = path.join(scopeDir, entry.name);
    if (entry.isDirectory()) {
      cleanupExpiredFiles(entryPath, ctx);
      if (fs.readdirSync(entryPath).length === 0) {
        fs.rmdirSync(entryPath);
      }
      continue;
    }

    const stat = fs.statSync(entryPath);
    if (now - stat.mtimeMs > ttlMs) {
      fs.unlinkSync(entryPath);
    }
  }
}

function listScopeFiles(scope: ChatScope, ctx: PluginContext): Array<{ name: string; path: string; size: number }> {
  cleanupExpiredFiles(scope.rootDir, ctx);
  if (!fs.existsSync(scope.rootDir)) {
    return [];
  }

  return fs.readdirSync(scope.rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullPath = path.join(scope.rootDir, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        size: stat.size,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

async function downloadIntoScope(scope: ChatScope, url: string, ctx: PluginContext, requestedName?: string): Promise<string> {
  cleanupExpiredFiles(scope.rootDir, ctx);
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持下载 http/https 文件。");
  }

  const response = await fetch(parsed);
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }

  const safeName = sanitizeFileName(requestedName || decodeURIComponent(path.basename(parsed.pathname)) || `download-${Date.now()}`);
  if (!safeName) {
    throw new Error("无法确定下载文件名。");
  }

  const outputPath = path.join(scope.rootDir, safeName);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  touchFile(outputPath);

  return outputPath;
}

function viewScopeFile(scope: ChatScope, fileName: string, ctx: PluginContext, maxChars: number): string {
  const filePath = resolveScopeFile(scope, fileName, ctx);
  const ext = path.extname(filePath).toLowerCase();
  if (!TEXT_FILE_EXTENSIONS.has(ext)) {
    throw new Error(`该文件类型不支持直接查看文本内容：${ext || "无扩展名"}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  touchFile(filePath);
  const trimmed = content.length > maxChars ? `${content.slice(0, maxChars)}\n\n[内容已截断]` : content;
  return `文件：${path.basename(filePath)}\n${trimmed}`;
}

function editScopeFile(
  scope: ChatScope,
  input: {
    fileName: string;
    mode: "overwrite" | "append" | "replace";
    content?: string;
    findText?: string;
    replaceText?: string;
  },
  ctx: PluginContext
): string {
  const filePath = resolveScopeFile(scope, input.fileName, ctx, { allowCreate: input.mode !== "replace" });
  const ext = path.extname(filePath).toLowerCase();
  if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) {
    throw new Error(`该文件类型不支持文本编辑：${ext}`);
  }

  if (input.mode === "overwrite") {
    fs.writeFileSync(filePath, input.content ?? "", "utf-8");
    touchFile(filePath);
    return `已覆盖写入文件：${path.basename(filePath)}`;
  }

  if (input.mode === "append") {
    fs.appendFileSync(filePath, input.content ?? "", "utf-8");
    touchFile(filePath);
    return `已追加写入文件：${path.basename(filePath)}`;
  }

  const findText = input.findText ?? "";
  if (!findText) {
    throw new Error("replace 模式必须提供 findText。");
  }

  const current = fs.readFileSync(filePath, "utf-8");
  if (!current.includes(findText)) {
    throw new Error("文件中未找到指定的 findText。");
  }
  const next = current.replaceAll(findText, input.replaceText ?? "");
  fs.writeFileSync(filePath, next, "utf-8");
  touchFile(filePath);
  return `已替换文件内容：${path.basename(filePath)}`;
}

function resolveScopeFile(
  scope: ChatScope,
  fileName: string,
  ctx: PluginContext,
  options: { allowCreate?: boolean } = {}
): string {
  cleanupExpiredFiles(scope.rootDir, ctx);
  const sanitized = sanitizeRelativePath(fileName);
  const filePath = path.resolve(scope.rootDir, sanitized);

  if (!isSubPath(filePath, scope.rootDir)) {
    throw new Error("文件路径越界。");
  }

  if (!fs.existsSync(filePath)) {
    if (options.allowCreate) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      return filePath;
    }
    throw new Error(`文件不存在：${fileName}`);
  }

  return filePath;
}

function resolveMediaPath(scope: ChatScope, inputPath: string, ctx: PluginContext): string {
  try {
    const scopeFile = resolveScopeFile(scope, inputPath, ctx);
    touchFile(scopeFile);
    return scopeFile;
  } catch {
    const workspacePath = path.resolve(process.cwd(), sanitizeRelativePath(inputPath));
    if (!isSubPath(workspacePath, process.cwd())) {
      throw new Error("图片/语音路径超出当前 workspace。");
    }
    if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isFile()) {
      throw new Error(`文件不存在：${inputPath}`);
    }
    return workspacePath;
  }
}

function touchFile(filePath: string) {
  const now = new Date();
  fs.utimesSync(filePath, now, now);
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}

function sanitizeRelativePath(filePath: string): string {
  const normalized = path.normalize(filePath).replace(/^([\\/])+/, "");
  if (normalized.includes("..")) {
    throw new Error("不允许访问上级目录。");
  }
  return normalized;
}

function isSubPath(candidate: string, rootDir: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 必须为非空字符串。`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ensureContext(ctx: PluginContext | null): PluginContext {
  if (!ctx) {
    throw new Error("插件上下文尚未初始化。");
  }
  return ctx;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
