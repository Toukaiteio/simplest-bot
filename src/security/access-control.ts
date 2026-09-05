import type { BotConfig, BotMessage, PromptBuildInput } from "../types.js";

export type AgentEnvironment = "restricted" | "real";

export type AgentToolScope = "public" | "restricted" | "admin" | "admin-real";

/**
 * The identity attached to one incoming message.  A QQ group is a shared
 * conversation, but it must not become a shared filesystem or execution
 * principal.
 */
export type AgentIdentity = {
  userId: string | null;
  groupId: string | null;
  channel: "private" | "group";
  isAdmin: boolean;
  conversationKey: string;
  workspaceKey: string;
};

export function getInputMessage(input: PromptBuildInput): BotMessage {
  if (input.mode === "single") {
    return input.message;
  }

  if (input.messages.length === 0) {
    throw new Error("批量输入不能为空。");
  }

  const requestedIndex = input.triggerIndex ?? input.messages.length - 1;
  const index = Math.max(0, Math.min(requestedIndex, input.messages.length - 1));
  return input.messages[index];
}

export function getAgentIdentity(message: BotMessage, config: BotConfig): AgentIdentity {
  const userId = message.userId ?? null;
  const groupId = message.groupId ?? null;
  const isAdmin = userId !== null && getAdminUserIds(config).has(userId);
  const conversationKey = message.type === "private"
    ? `private:${userId ?? "unknown"}`
    : `group:${groupId ?? "unknown"}`;

  // Group chat context is intentionally shared, while all local work files
  // are keyed by the sender. This prevents one group member from reading a
  // different member's downloaded or generated files.
  const workspaceKey = `user:${userId ?? `anonymous-${groupId ?? "unknown"}`}`;

  return {
    userId,
    groupId,
    channel: message.type,
    isAdmin,
    conversationKey,
    workspaceKey,
  };
}

export function getIdentityForInput(input: PromptBuildInput, config: BotConfig): AgentIdentity {
  return getAgentIdentity(getInputMessage(input), config);
}

export function getAgentEnvironment(input: PromptBuildInput): AgentEnvironment {
  return input.environment ?? "restricted";
}

export function getAdminUserIds(config: BotConfig): Set<string> {
  return new Set(config.auth.adminUserIds.filter(Boolean));
}

export function isAdminMessage(message: BotMessage, config: BotConfig): boolean {
  return Boolean(message.userId && getAdminUserIds(config).has(message.userId));
}

export function isAdminInput(input: PromptBuildInput, config: BotConfig): boolean {
  return isAdminMessage(getInputMessage(input), config);
}

/**
 * Classify tool capabilities before exposing or executing them.
 *
 * `restricted` is deliberately available to ordinary users, but each such
 * tool must resolve paths/commands inside the caller's sandbox. `admin-real`
 * is reserved for the explicit administrator real-environment flow.
 */
export function getAgentToolScope(name: string): AgentToolScope {
  if (name.startsWith("workspace_")) return "restricted";
  if (name.startsWith("agent_real_") || name.startsWith("desktop_")) return "admin-real";
  if (name.startsWith("mail_") || name === "browser_agent") return "admin-real";
  if (name.startsWith("agent_policy_")) return "admin";
  return "public";
}

/** Backward-compatible name used by the legacy wrapper path. */
export function isPrivilegedToolName(name: string): boolean {
  return getAgentToolScope(name) !== "public";
}

export function canUseTool(
  toolName: string,
  input: PromptBuildInput,
  config: BotConfig,
): boolean {
  const scope = getAgentToolScope(toolName);
  if (scope === "public" || scope === "restricted") return true;

  const admin = isAdminInput(input, config);
  if (!admin) return false;
  return scope === "admin" || getAgentEnvironment(input) === "real";
}

export function assertToolAccess(
  toolName: string,
  input: PromptBuildInput,
  config: BotConfig,
): void {
  if (!canUseTool(toolName, input, config)) {
    const scope = getAgentToolScope(toolName);
    if (scope === "admin-real") {
      throw new Error(`权限不足：${toolName} 仅允许管理员在真实环境流中使用。`);
    }
    throw new Error(`权限不足：${toolName} 仅允许配置的管理员使用。`);
  }
}
