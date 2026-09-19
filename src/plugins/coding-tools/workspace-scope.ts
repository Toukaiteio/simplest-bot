import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BotConfig, PromptBuildInput } from "../../types.js";
import { getAgentIdentity, getInputMessage } from "../../security/access-control.js";

/**
 * 用户隔离 workspace 根目录解析。coding-tools 插件与后台任务插件共用：
 * 同一用户的受限 shell、文件工具与后台命令必须落在同一个隔离目录中。
 */
export function resolveRestrictedBaseRoot(configuredRoot: string): string {
  const sandboxRoot = path.resolve(process.cwd(), "data/agent-workspaces");
  const requested = path.resolve(process.cwd(), configuredRoot);
  return isSubPath(sandboxRoot, requested) ? requested : sandboxRoot;
}

/** 按触发用户解析隔离 workspace 根目录（user-<sha256(userId)>），必要时创建。 */
export function getScopedWorkspaceRoot(config: BotConfig, input: PromptBuildInput): string {
  const baseRoot = resolveRestrictedBaseRoot(
    config.pluginSettings.codingTools?.workspaceRoot || "data/agent-workspaces",
  );
  const identity = getAgentIdentity(getInputMessage(input), config);
  const rawScope = identity.userId ?? `anonymous-${identity.groupId ?? "unknown"}`;
  const scope = `user-${createHash("sha256").update(rawScope, "utf8").digest("hex")}`;
  const usersRoot = ensureSafeDirectory(baseRoot, "users");
  return ensureSafeDirectory(usersRoot, scope);
}

export function ensureSafeDirectory(base: string, ...segments: string[]): string {
  let current = path.resolve(base);
  assertNoSymlinkComponents(current, current);
  for (const segment of segments) {
    if (!/^[a-zA-Z0-9._-]+$/u.test(segment)) throw new Error("受限 workspace 目录名无效。");
    current = path.join(current, segment);
    fs.mkdirSync(current, { recursive: true });
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("受限 workspace 路径不能包含符号链接。");
    }
    if (!fs.statSync(current).isDirectory()) {
      throw new Error("受限 workspace 路径不是目录。");
    }
  }
  return current;
}

export function assertNoSymlinkComponents(root: string, candidate: string): void {
  const rootAbs = path.resolve(root);
  const candidateAbs = path.resolve(candidate);
  if (!isSubPath(rootAbs, candidateAbs)) throw new Error("受限 workspace 路径越界。");
  if (!fs.existsSync(rootAbs)) return;
  if (fs.lstatSync(rootAbs).isSymbolicLink()) throw new Error("受限 workspace 根目录不能是符号链接。");

  let current = rootAbs;
  const relative = path.relative(rootAbs, candidateAbs);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("受限 workspace 路径不能包含符号链接。");
    }
  }
}

export function isSubPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
