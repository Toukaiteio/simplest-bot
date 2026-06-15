import type { PluginContext, BotMessage, Plugin } from "../../types.js";

type AutoApproveHandler = {
  approveFriendRequest: (flag: string) => Promise<void>;
};

export type AutoApprovePlugin = Plugin & {
  setHandler: (handler: AutoApproveHandler) => void;
};

export function createAutoApprovePlugin(): AutoApprovePlugin {
  let handler: AutoApproveHandler | null = null;

  return {
    name: "auto-approve",
    description: "自动同意所有好友添加请求（谨慎使用）",

    setHandler(h: AutoApproveHandler) {
      handler = h;
    },

    async onLoad() {
      console.log("[AutoApprove] 已启用，将自动同意所有好友请求");
    },
  };
}
