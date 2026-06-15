import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import type { ChatOpenAICallOptions } from "@langchain/openai";
import { OneBotClient } from "./onebot.js";
import { MemoryManager } from "./memory.js";
import { LLMClient } from "./llm.js";
import { PluginManager } from "./plugin.js";
import { MessageStore } from "./message-store.js";
import { ContextManager } from "./context/context-manager.js";
import { createBlacklistPlugin } from "./plugins/core/blacklist.js";
import { createGroupTriggerPlugin } from "./plugins/core/group-trigger.js";
import { createAtMentionPlugin } from "./plugins/core/at-mention.js";
import { createReplyPlugin } from "./plugins/core/reply.js";
import { createDebouncePlugin } from "./plugins/core/debounce.js";
import { createMentionTrackerPlugin } from "./plugins/core/mention-tracker-plugin.js";
import { createAutoApprovePlugin } from "./plugins/core/auto-approve-plugin.js";
import { createSplitPlugin } from "./plugins/core/split.js";
import { createCoreCommandPlugin } from "./plugins/core/command-plugin.js";
import { createMenuPlugin } from "./plugins/core/menu-plugin.js";
import { createDataStorePlugin } from "./plugins/economy/data-store.js";
import { createInventoryPlugin } from "./plugins/economy/inventory-plugin.js";
import { createSocialPlugin } from "./plugins/economy/social-plugin.js";
import { createCheckinPlugin } from "./plugins/economy/checkin-plugin.js";
import { createShopPlugin } from "./plugins/economy/shop-plugin.js";
import { createRewardSystemPlugin } from "./plugins/economy/reward-system-plugin.js";
import { createSystemPlugin } from "./plugins/system/system-plugin.js";
import { createIdentityPlugin } from "./plugins/system/identity-plugin.js";
import { createAdminAssistPlugin } from "./plugins/system/admin-assist-plugin.js";
import { createTodoPlugin } from "./plugins/system/todo-plugin.js";
import { createChatSearchPlugin } from "./plugins/system/chat-search-plugin.js";
import { createTimePlugin } from "./plugins/system/time-plugin.js";
import { createDailyReportPlugin, type DailyReportPlugin } from "./plugins/reporting/daily-report-plugin.js";
import { createFileWorkspacePlugin } from "./plugins/system/file-workspace-plugin.js";
import { createWebFetchPlugin, webfetchToolRegistration } from "./plugins/webfetch.js";
import { createSearchPlugin, searchToolRegistration } from "./plugins/search-plugin.js";
import { createBrowserPlugin, browserToolRegistration } from "./plugins/browser-plugin.js";
import { createMMORPGFrameworkPlugin } from "./plugins/mmorpg/framework-plugin.js";
import { createMediaToolRegistrations } from "./media-tools.js";
import type { BotToolRegistration } from "./tooling.js";
import type {
  PluginContext, BotMessage, BlacklistPlugin, GroupTriggerPlugin,
  DataStorePlugin, InventoryPlugin, MenuPlugin,
  SocialPlugin, CheckinPlugin, MentionTrackerPlugin, WelfareRewardSystemPlugin,
} from "./types.js";

async function main() {
  console.log("=== Simplest Bot 启动 ===");

  const config = loadConfig();
  console.log("[Config] 配置已加载");

  const messageStore = new MessageStore();
  process.on("exit", () => messageStore.close());
  process.on("SIGINT", () => { messageStore.close(); process.exit(); });
  process.on("SIGTERM", () => { messageStore.close(); process.exit(); });
  const memory = new MemoryManager(config.memory, messageStore);
  await memory.init();
  const onebot = new OneBotClient(config.oneBot);

  const pluginManager = new PluginManager();

  const pluginContext: PluginContext = {
    config,
    sendMessage: async () => { throw new Error("插件上下文尚未就绪"); },
    sendImage: async () => { throw new Error("插件上下文尚未就绪"); },
    sendVoice: async () => { throw new Error("插件上下文尚未就绪"); },
    sendFile: async () => { throw new Error("插件上下文尚未就绪"); },
    replyText: async () => { throw new Error("插件上下文尚未就绪"); },
  };

  pluginManager.setContext(pluginContext);

  // ========== 核心插件（依赖注入顺序） ==========
  const store: DataStorePlugin = createDataStorePlugin(messageStore);
  pluginManager.register(store);

  const coreCmd = createCoreCommandPlugin(config.auth, config.pluginSettings.coreCommand.prefix);
  pluginManager.register(coreCmd);

  const menu: MenuPlugin = createMenuPlugin(coreCmd);
  pluginManager.register(menu);

  pluginManager.register(createTimePlugin());

  const inventory: InventoryPlugin = createInventoryPlugin(store);
  pluginManager.register(inventory);

  const social: SocialPlugin = createSocialPlugin(store, menu, messageStore, onebot);
  pluginManager.register(social);

  const checkin: CheckinPlugin = createCheckinPlugin(store, social, menu);
  pluginManager.register(checkin);

  pluginManager.register(createShopPlugin(store, inventory, checkin, social, menu));
  const rewardSystem: WelfareRewardSystemPlugin = createRewardSystemPlugin(store, inventory, menu);
  pluginManager.register(rewardSystem);
  const fileWorkspacePlugin = createFileWorkspacePlugin(menu);
  if (config.plugins.fileWorkspace) {
    pluginManager.register(fileWorkspacePlugin);
  }

  // ========== 内置插件（根据配置启用） ==========
  const blacklistPlugin = createBlacklistPlugin(config.blacklist);
  if (config.plugins.blacklist) pluginManager.register(blacklistPlugin);

  const groupTriggerPlugin = createGroupTriggerPlugin();
  if (config.plugins.groupTrigger) pluginManager.register(groupTriggerPlugin);

  const adminAssistPlugin = createAdminAssistPlugin(onebot, config.auth.adminUserIds);
  if (config.plugins.adminAssist) pluginManager.register(adminAssistPlugin);
  const todoPlugin = createTodoPlugin(menu);
  if (config.plugins.todo) pluginManager.register(todoPlugin);
  const mmorpgFrameworkPlugin = createMMORPGFrameworkPlugin(store, inventory, social, menu, messageStore, rewardSystem);
  if (config.plugins.mmorpgFramework) pluginManager.register(mmorpgFrameworkPlugin);
  pluginManager.register(createIdentityPlugin(onebot, menu, config.auth.adminUserIds));
  pluginManager.register(createSystemPlugin(memory, pluginManager, blacklistPlugin, groupTriggerPlugin, menu));
  const chatSearchPlugin = createChatSearchPlugin(messageStore, menu);
  if (config.plugins.chatSearch) pluginManager.register(chatSearchPlugin);
  let dailyReportPlugin: DailyReportPlugin | null = null;
  if (config.plugins.dailyReport) {
    dailyReportPlugin = createDailyReportPlugin(messageStore, menu);
    pluginManager.register(dailyReportPlugin);
  }

  if (config.plugins.reply) pluginManager.register(createReplyPlugin());
  if (config.plugins.atMention) pluginManager.register(createAtMentionPlugin(onebot));
  if (config.plugins.split) pluginManager.register(createSplitPlugin());

  const debouncePlugin = createDebouncePlugin(coreCmd.getPrefix());
  if (config.plugins.debounce) pluginManager.register(debouncePlugin);

  if (config.plugins.webfetch) pluginManager.register(createWebFetchPlugin());
  if (config.plugins.search) pluginManager.register(createSearchPlugin());
  if (config.plugins.browser) pluginManager.register(createBrowserPlugin());

  const mentionTrackerPlugin = createMentionTrackerPlugin();
  pluginManager.register(mentionTrackerPlugin);

  const autoApprovePlugin = createAutoApprovePlugin();
  pluginManager.register(autoApprovePlugin);

  await pluginManager.loadAll();

  const appends = pluginManager.getSystemPromptAppends();
  if (appends.length > 0) {
    config.llm.systemPrompt += "\n\n" + appends.join("\n\n");
    console.log(`[Config] 系统提示已追加 ${appends.length} 条插件指令`);
  }

  const mediaNotes: string[] = [];
  if (config.llm.supportsImages) mediaNotes.push("图片占位符格式为 [图片 file=ID]，可调用 view_image 工具按需查看原图。");
  if (config.llm.supportsVideo) mediaNotes.push("视频占位符格式为 [视频 file=ID]，可调用 view_video 工具获取视频文件信息。");
  if (config.llm.supportsVoice) mediaNotes.push("语音占位符格式为 [语音 file=ID]，可调用 view_voice 工具获取语音文件信息。");
  if (mediaNotes.length > 0) {
    config.llm.systemPrompt += "\n\n" + mediaNotes.join("\n");
  }

  // Inline fact extraction instruction (Plan A: zero extra API calls)
  if (config.memory.extraction.enabled) {
    config.llm.systemPrompt += [
      "",
      "当你从用户消息中识别到关于用户的持久性事实（姓名、年龄、所在地、职业、爱好、偏好、重要经历、人际关系等），请在回复末尾以 HTML 注释格式附加提取结果：",
      "<!-- facts: [\"事实1\", \"事实2\"] -->",
      "规则：只提取独立、自包含的个人事实（每条 15 字以内为佳）；不提取临时情绪或对话中显而易见的内容；如果与已知记忆重复或没有新事实，输出空数组 []。",
    ].join("\n");
  }

  const contextManager = new ContextManager(
    config.contextManagement,
    config.llm.systemPrompt,
    undefined,
    config.llm.supportsImages,
    config.llm.supportsVideo,
    config.llm.supportsVoice
  );

  const llm = new LLMClient(
    config.llm,
    memory,
    contextManager,
    config.contextManagement.maxMessageChars,
    async (messageId) => {
      const local = messageStore.findMessageById(messageId);
      if (local) return local;
      return onebot.getMessage(messageId);
    },
    async (message) => {
      if (message.type !== "group" || !message.groupId || !message.userId) {
        return null;
      }
      try {
        const [groupInfo, memberInfo] = await Promise.all([
          onebot.getGroupInfo(message.groupId),
          onebot.getGroupMemberInfo(message.groupId, message.userId),
        ]);
        return {
          groupId: message.groupId,
          groupName: groupInfo.groupName,
          memberCard: memberInfo.card,
          memberNickname: memberInfo.nickname,
        };
      } catch (error) {
        console.error(`[LLM] 获取群聊上下文失败:`, error);
        return null;
      }
    },
    async (forwardId) => onebot.getForwardMessageText(forwardId, 2000),
    async (userId, limit) => {
      const records = messageStore.queryInteraction(userId, { order: "desc", limit });
      if (records.length === 0) return null;
      const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp);
      const lines = sorted.map((rec) => {
        const d = new Date(rec.timestamp);
        const pad = (n: number) => String(n).padStart(2, "0");
        const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const scope = rec.type === "group" && rec.groupId
          ? `群${rec.groupId}`
          : rec.type === "private" ? "私聊" : "";
        const sender = rec.isBot ? "Bot" : `用户(${rec.userId ?? "?"})`;
        const text = rec.text.length > 120 ? rec.text.slice(0, 120) + "…" : rec.text;
        return `[${time}] ${scope} · ${sender}: ${text}`;
      });
      return `[近期互动回顾]\n${lines.join("\n")}`;
    }
  );
  console.log(`[LLM] 模型: ${config.llm.model}`);

  mentionTrackerPlugin.setHandler({
    evaluateAndReply: async (context) => {
      const reply = await llm.evaluateMentionContext(context.botMessage, context.collectedMessages);
      if (reply) {
        const target = { type: "group" as const, id: context.groupId };
        await onebot.sendText(target, reply);
      }
    },
    sendAutoPrompt: async (groupId, targetUserId) => {
      await onebot.sendSegments(
        { type: "group", id: groupId },
        [
          { type: "at", data: { qq: targetUserId } },
          { type: "text", data: { text: " 怎么不理我了...好感度-3" } },
        ],
      );
    },
    reduceAffinity: (userId) => {
      social.addAIAffinity(userId, -3);
    },
  });

  autoApprovePlugin.setHandler({
    approveFriendRequest: async (flag) => {
      await onebot.sendAction("set_friend_add_request", { flag, approve: true });
    },
  });

  // 设置智能压缩回调
  memory.setCompressCallback((history) => llm.summarizeHistory(history));

  // 注册工具
  const toolRegistrations: BotToolRegistration[] = [];
  toolRegistrations.push(...social.getToolRegistrations());
  if (config.plugins.fileWorkspace) {
    toolRegistrations.push(...fileWorkspacePlugin.getToolRegistrations());
  }
  if (config.plugins.webfetch) {
    toolRegistrations.push(webfetchToolRegistration);
  }
  if (config.plugins.search) {
    toolRegistrations.push(
      searchToolRegistration(config.pluginSettings.search, (target, text) => onebot.sendText(target, text))
    );
  }
  if (config.plugins.browser) {
    toolRegistrations.push(
      browserToolRegistration(
        config.pluginSettings.browser,
        config.llm,
        (input) => {
          const msg = input.mode === "single" ? input.message : input.messages[input.messages.length - 1];
          const baseDir = path.resolve(process.cwd(), config.pluginSettings.fileWorkspace.rootDir);
          if (msg.type === "group" && msg.groupId) {
            const dir = path.join(baseDir, "group", msg.groupId);
            fs.mkdirSync(dir, { recursive: true });
            return dir;
          }
          const dir = path.join(baseDir, "private", msg.userId ?? "unknown");
          fs.mkdirSync(dir, { recursive: true });
          return dir;
        }
      )
    );
  }
  if (config.plugins.adminAssist) {
    adminAssistPlugin.setTruncationProvider(llm);
    toolRegistrations.push(...adminAssistPlugin.getToolRegistrations());
  }
  toolRegistrations.push(...contextManager.getToolRegistrations());
  if (config.plugins.todo) {
    toolRegistrations.push(...todoPlugin.getToolRegistrations());
  }
  if (config.plugins.mmorpgFramework) {
    toolRegistrations.push(...mmorpgFrameworkPlugin.getToolRegistrations());
  }
  if (config.plugins.chatSearch) {
    toolRegistrations.push(...chatSearchPlugin.getToolRegistrations());
  }
  toolRegistrations.push(
    ...createMediaToolRegistrations(onebot, {
      supportsImages: config.llm.supportsImages,
      supportsVideo: config.llm.supportsVideo,
      supportsVoice: config.llm.supportsVoice,
    })
  );
  if (toolRegistrations.length > 0) {
    llm.setTools(toolRegistrations);
    console.log(`[LLM] 已注册 ${toolRegistrations.length} 个工具`);
  }

  pluginContext.sendMessage = (target, text) => onebot.sendText(target, text);
  pluginContext.sendImage = (target, filePath, caption) => onebot.sendImage(target, filePath, caption);
  pluginContext.sendVoice = (target, filePath) => onebot.sendVoice(target, filePath);
  pluginContext.sendFile = (target, filePath, name) => onebot.sendFile(target, filePath, name);
  pluginContext.replyText = (message, text) => {
    const target = message.type === "group"
      ? { type: "group" as const, id: message.groupId! }
      : { type: "private" as const, id: message.userId! };
    return onebot.sendText(target, text);
  };

  debouncePlugin.setHandler({
    shouldReplyCheck: async (message) => pluginManager.shouldReply(message),
    chatBatch: async (messages) => {
      const appends = await pluginManager.buildDynamicPromptAppends({ mode: "batch", messages });
      const reply = await llm.chatBatch(messages, appends);
      messageStore.appendBatchReply(messages, reply);
      return reply;
    },
    sendSegments: async (target, segments) => {
      const textOnly = segments.length === 1 && segments[0].type === "text";
      if (textOnly) {
        const text = String(segments[0].data.text ?? "");
        if (text.length > 3000) {
          await onebot.sendForwardMessage(target, text);
          return;
        }
      }
      await onebot.sendSegments(target, segments);
    },
    transformResponse: (text) => pluginManager.transformResponse(text),
    splitResponse: (text) => pluginManager.splitResponse(text),
  });

  async function sendReply(message: BotMessage, reply: string, options: { quote?: boolean } = {}) {
    const parts = await pluginManager.splitResponse(reply);
    const target = message.type === "group"
      ? { type: "group" as const, id: message.groupId! }
      : { type: "private" as const, id: message.userId! };
    let shouldQuote = options.quote === true && Boolean(message.id);

    const withOptionalQuote = (segments: { type: string; data: Record<string, unknown> }[]) => {
      if (!shouldQuote || !message.id) {
        return segments;
      }
      shouldQuote = false;
      return [{ type: "reply", data: { id: message.id } }, ...segments];
    };

    async function sendTextOrForward(text: string) {
      if (text.length > 3000) {
        await onebot.sendForwardMessage(target, text);
        shouldQuote = false;
      } else {
        await onebot.sendSegments(target, withOptionalQuote([{ type: "text", data: { text } }]));
      }
    }

    function trackAtMentions(segments: { type: string; data: Record<string, unknown> }[], text: string) {
      if (target.type !== "group") return;
      for (const seg of segments) {
        if (seg.type === "at") {
          mentionTrackerPlugin.trackMention(String(seg.data.qq ?? ""), target.id, text);
        }
      }
    }

    const transformContext = target.type === "group" ? { groupId: target.id } : undefined;

    if (parts) {
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const segments = await pluginManager.transformResponse(trimmed, transformContext);
        if (segments) {
          trackAtMentions(segments, trimmed);
          await onebot.sendSegments(target, withOptionalQuote(segments));
        } else {
          await sendTextOrForward(trimmed);
        }
      }
    } else {
      const segments = await pluginManager.transformResponse(reply, transformContext);
      if (segments) {
        trackAtMentions(segments, reply);
        await onebot.sendSegments(target, withOptionalQuote(segments));
      } else {
        await sendTextOrForward(reply);
      }
    }
  }

  if (config.plugins.adminAssist) {
    adminAssistPlugin.setHandler({
      buildDynamicPromptAppends: async (message) => pluginManager.buildDynamicPromptAppends({ mode: "single", message }),
      generateReply: async (message, dynamicPromptAppends) => llm.chat(message, dynamicPromptAppends),
      sendReply: (message, reply) => sendReply(message, reply, { quote: true }),
    });
  }

  async function autoCheckin(message: BotMessage) {
    if (!message.userId) return;
    const userId = message.userId;

    // Welfare: mark today as active (also resets the return-reward flag on a new lapse).
    const wasAbsentForReturn = rewardSystem.hasPendingReturnReward(userId);
    rewardSystem.markActiveToday(userId);

    // Collect welfare hints to append to whichever notice we send.
    const welfareHints: string[] = [];
    if (wasAbsentForReturn) {
      welfareHints.push("👋 欢迎回归！发送 $return-reward 领取回归奖励。");
    }
    // Surface the seven-day welfare once per day when there's an unclaimed day.
    const profile = store.getUserData(userId);
    const sevenDay = profile.sevenDayWelfare;
    if (sevenDay && sevenDay.claimedDays.length < 7) {
      welfareHints.push("🎁 有未领取的七日福利，发送 $welfare-claim 领取。");
    }

    const result = checkin.tryAutoCheckin(userId);
    if (result.didCheckin) {
      const streakText = result.streak > 1 ? `（连续 ${result.streak} 天）` : "";
      const hint = welfareHints.length > 0 ? "\n" + welfareHints.join("\n") : "";
      await pluginContext.replyText(
        message,
        `✨ 已自动触发今日签到，获得 ${result.coins} 金币${streakText}。这次结算与 $checkin 完全相同。${hint}`
      );
      return;
    }

    if (checkin.shouldSendAutoCheckinNotice(userId)) {
      checkin.markAutoCheckinNoticeSent(userId);
      const hint = welfareHints.length > 0 ? "\n" + welfareHints.join("\n") : "";
      await pluginContext.replyText(
        message,
        `📌 今日签到状态已同步：首次对话自动签到与 $checkin 共享同一签到次数。你今天已经领过奖励了。${hint}`
      );
    }
  }

  onebot.on("message", async (message: BotMessage) => {
    console.log(`[Message] ${message.type} | ${message.userId}: ${message.text}`);

    messageStore.appendIncoming(message);

    const blocked = await pluginManager.processMessage(message);
    if (blocked) return;

    const shouldReply = await pluginManager.shouldReply(message);
    if (!shouldReply) return;

    try {
      const dynamicAppends = await pluginManager.buildDynamicPromptAppends({ mode: "single", message });
      const reply = await llm.chat(message, dynamicAppends);
      messageStore.appendReply(message, reply);
      await sendReply(message, reply);
      await autoCheckin(message);
    } catch (error) {
      console.error("[Bot] 回复失败:", error);
    }
  });

  onebot.on("request", async (event) => {
    if (event.requestType === "friend") {
      console.log(`[AutoApprove] 自动同意好友请求：${event.userId}`);
      try {
        await onebot.sendAction("set_friend_add_request", { flag: event.flag, approve: true });
      } catch (error) {
        console.error("[AutoApprove] 自动同意好友请求失败:", error);
      }
    }
  });

  onebot.on("connected", () => {
    console.log("[Bot] 已连接到 NapCat");
  });

  onebot.on("disconnected", () => {
    console.log("[Bot] 已断开连接");
  });

  onebot.on("error", (error) => {
    console.error("[Bot] 错误:", error);
  });

  onebot.start();
  console.log("[Bot] 正在连接 NapCat...");

  try {
    await onebot.waitUntilConnected();
    console.log("[Bot] 连接成功，等待消息...");
    if (dailyReportPlugin) {
      await dailyReportPlugin.runStartupCatchup(pluginContext);
    }
  } catch (error) {
    console.error("[Bot] 连接失败:", error);
    process.exit(1);
  }

  const shutdown = () => {
    console.log("\n[Bot] 正在关闭...");
    store.flush();
    if (config.plugins.mmorpgFramework) {
      mmorpgFrameworkPlugin.flush();
    }
    onebot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});
