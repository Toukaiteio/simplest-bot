import fs from "node:fs";
import path from "node:path";

export class ToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ToolError";
  }
}

export const DEFAULT_EXCLUDED_NAMES = new Set([
  ".git", ".reference", "node_modules", "target", "dist", "build",
  ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
  ".ruff_cache", "__pycache__", ".workbuddy",
]);

export class Workspace {
  root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root)) fs.mkdirSync(this.root, { recursive: true });
  }
  resolveExisting(rawPath: string): { display: string; resolved: string } {
    const safe = sanitizeRelativePath(rawPath || ".");
    const abs = path.resolve(this.root, safe);
    if (!abs.startsWith(this.root)) throw new ToolError("PATH_OUTSIDE_WORKSPACE", `路径 ${rawPath} 超出工作区`);
    if (!fs.existsSync(abs)) throw new ToolError("NOT_FOUND", `路径不存在: ${rawPath}`);
    return { display: path.relative(this.root, abs).replace(/\\/g, "/") || ".", resolved: abs };
  }
  resolveForWrite(rawPath: string): { display: string; resolved: string; existed: boolean } {
    const safe = sanitizeRelativePath(rawPath);
    const abs = path.resolve(this.root, safe);
    if (!abs.startsWith(this.root)) throw new ToolError("PATH_OUTSIDE_WORKSPACE", `路径 ${rawPath} 超出工作区`);
    const existed = fs.existsSync(abs);
    return { display: path.relative(this.root, abs).replace(/\\/g, "/"), resolved: abs, existed };
  }
  isIgnored(name: string): boolean { return name.startsWith(".") || DEFAULT_EXCLUDED_NAMES.has(name); }
}

export function sanitizeRelativePath(filePath: string): string {
  const normalized = path.normalize(filePath).replace(/^[/\\]+/, "");
  if (normalized.includes("..")) throw new ToolError("PATH_ESCAPE", "不允许访问上级目录");
  return normalized || ".";
}
