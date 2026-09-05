/**
 * gemini-web2api 的 Node.js 移植：进程内插件壳。
 * plugins.geminiRelay 开关；onLoad 启动 HTTP 服务（host/port 来自 pluginSettings.geminiRelay）；
 * 端口被占用且现有实例健康时复用外部实例（不接管）；close() 关闭服务。
 */
import type { BotConfig, Plugin } from "../../types.js";
import {
  createGeminiRelayServer,
  type GeminiRelayServer,
} from "./server.js";

export type GeminiWebRelayPlugin = Plugin & {
  /** 关闭进程内 HTTP 服务（幂等）。 */
  close: () => Promise<void>;
};

export function createGeminiWebRelayPlugin(config: BotConfig): GeminiWebRelayPlugin {
  let server: GeminiRelayServer | null = null;

  return {
    name: "gemini-web-relay",
    description: "Gemini Web 中继（OpenAI 兼容纯文本通道，进程内 node:http）",

    async onLoad() {
      if (!config.plugins.geminiRelay) return;

      const relayConfig = config.pluginSettings.geminiRelay;
      server = createGeminiRelayServer({
        host: relayConfig.host,
        port: relayConfig.port,
        cookieFile: relayConfig.cookieFile,
        xsrfToken: relayConfig.xsrfToken,
        authUser: relayConfig.authUser,
        geminiBl: relayConfig.geminiBl,
        defaultModel: relayConfig.defaultModel,
        requestTimeoutSec: relayConfig.requestTimeoutSec,
        retryAttempts: relayConfig.retryAttempts,
        retryDelaySec: relayConfig.retryDelaySec,
        logRequests: relayConfig.logRequests,
        temporaryChats: relayConfig.temporaryChats,
        apiKeys: relayConfig.apiKeys,
        proxy: relayConfig.proxy,
      });

      try {
        await server.start();
      } catch (error) {
        const isPortInUse = error instanceof Error && ("code" in error) && error.code === "EADDRINUSE";
        if (!isPortInUse) {
          server = null;
          throw error;
        }
        // 端口已被外部实例占用：探活现有实例，健康则复用（不接管、不负责生命周期）。
        if (await probeHealth(relayConfig.host, relayConfig.port)) {
          console.log(`[Relay] 端口 ${relayConfig.port} 已被现有 Gemini 中继占用且健康，复用外部实例（不接管）。`);
        } else {
          console.error(`[Relay] 端口 ${relayConfig.port} 被占用但现有实例不健康：`, error);
        }
        server = null;
      }
    },

    async close() {
      await server?.close();
      server = null;
    },
  };
}

async function probeHealth(host: string, port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`http://${host}:${port}/`, { signal: controller.signal });
      if (!response.ok) return false;
      const data = await response.json().catch(() => null) as { status?: unknown } | null;
      return data?.status === "ok";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
