import type { BlacklistPlugin, PluginContext, BotMessage, BlackListConfig } from "../../types.js";

export function createBlacklistPlugin(config: BlackListConfig): BlacklistPlugin {
  let blockedUsers = new Set(config.blockedUserIds);
  let blockedGroups = new Set(config.blockedGroupIds);

  return {
    name: "blacklist",
    description: "黑名单插件 - 拦截被封禁用户/群组的消息",

    onLoad: (_ctx: PluginContext) => {
      console.log(`[Blacklist] 已加载，封禁用户: ${blockedUsers.size}，封禁群组: ${blockedGroups.size}`);
    },

    onMessage: async (message: BotMessage): Promise<boolean> => {
      if (!config.enabled) return false;

      if (message.userId && blockedUsers.has(message.userId)) {
        console.log(`[Blacklist] 拦截用户 ${message.userId} 的消息`);
        return true;
      }

      if (message.groupId && blockedGroups.has(message.groupId)) {
        console.log(`[Blacklist] 拦截群组 ${message.groupId} 的消息`);
        return true;
      }

      return false;
    },

    addUser: (userId: string) => {
      blockedUsers.add(userId);
      console.log(`[Blacklist] 已添加用户 ${userId} 到黑名单`);
    },

    removeUser: (userId: string) => {
      blockedUsers.delete(userId);
      console.log(`[Blacklist] 已从黑名单移除用户 ${userId}`);
    },

    addGroup: (groupId: string) => {
      blockedGroups.add(groupId);
      console.log(`[Blacklist] 已添加群组 ${groupId} 到黑名单`);
    },

    removeGroup: (groupId: string) => {
      blockedGroups.delete(groupId);
      console.log(`[Blacklist] 已从黑名单移除群组 ${groupId}`);
    },

    getBlockedUsers: () => Array.from(blockedUsers),
    getBlockedGroups: () => Array.from(blockedGroups),
  };
}
