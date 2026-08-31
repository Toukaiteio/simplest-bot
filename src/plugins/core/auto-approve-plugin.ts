import type { PluginContext, BotMessage, Plugin } from "../../types.js";

type AutoApproveHandler = {
  approveFriendRequest: (flag: string) => Promise<void>;
  approveGroupInvite: (flag: string, groupId: string) => Promise<void>;
};

export type AutoApprovePlugin = Plugin & {
  setHandler: (handler: AutoApproveHandler) => void;
};

export function createAutoApprovePlugin(): AutoApprovePlugin {
  let handler: AutoApproveHandler | null = null;

  return {
    name: "auto-approve",
    description: "自动同意好友添加请求和群邀请入群请求",

    setHandler(h: AutoApproveHandler) {
      handler = h;
    },

    async onLoad() {
      console.log("[AutoApprove] 已启用，将自动同意好友请求和群邀请入群请求");
    },
  };
}
