import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import type { ChatOpenAICallOptions } from "@langchain/openai";
import { OneBotClient, safeCqToSegments, splitLongText } from "./onebot.js";
import { MemoryManager } from "./memory.js";
import { queryUserFacts } from "./memory.js";
import { LLMClient } from "./llm.js";
import { PluginManager } from "./plugin.js";
import { MessageStore } from "./message-store.js";
import { ContextManager } from "./context/context-manager.js";
import { registerSentImageText, lookupSentImageText, initSentImageTexts } from "./sent-image-texts.js";
import { createQuotedMessageResolver } from "./quoted-message.js";

// ========== 编译后 prompt 快照缓存（保证重启前后前缀一致） ==========
const PROMPT_CACHE_FILE = "data/persona/compiled-prompt-cache.json";

type PromptCache = {
  versionKey: string;          // "softCoreVersion:globalStyleVersion"
  personaBlock: string;        // 渲染后的 initialPersonaBlock
  fullPersonaContent: string;  // 完整 baseSystemPrompt + personaBlock + suffix
  updatedAt: number;
};

function personaVersionKey(store: import("./persona/profile-store.js").PersonaStore): string {
  const sc = store.getSoftCore();
  const gs = store.getGlobalStyle();
  return `${sc.version ?? 0}:${gs.version ?? 0}`;
}

function loadPromptCache(): PromptCache | null {
  try {
    if (!fs.existsSync(PROMPT_CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(PROMPT_CACHE_FILE, "utf-8"));
  } catch { return null; }
}

function savePromptCache(cache: PromptCache): void {
  fs.mkdirSync(path.dirname(PROMPT_CACHE_FILE), { recursive: true });
  fs.writeFileSync(PROMPT_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}
import { initBrowserManager, getBrowser, newPage, closeBrowser } from "./browser/browser-manager.js";
import { createBlacklistPlugin } from "./plugins/core/blacklist.js";
import { createModerationPlugin } from "./plugins/core/moderation-plugin.js";
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
import { createAgentPolicyPlugin } from "./plugins/system/agent-policy-plugin.js";
import { createTodoPlugin } from "./plugins/system/todo-plugin.js";
import { AGENT_PLAN_SYSTEM_PROMPT, createAgentPlanToolRegistrations } from "./plugins/system/agent-plan-tool.js";
import { createChatSearchPlugin } from "./plugins/system/chat-search-plugin.js";
import { createTimePlugin } from "./plugins/system/time-plugin.js";
import { createPersonaPlugin } from "./plugins/system/persona-plugin.js";
import { createMarkdownImagePlugin } from "./plugins/system/markdown-image-plugin.js";
import { createFftImagePlugin } from "./plugins/system/fft-image-plugin.js";
import { createDailyReportPlugin, type DailyReportPlugin } from "./plugins/reporting/daily-report-plugin.js";
import { createAgentlyPlugin } from "./plugins/agently/agently-plugin.js";
import { createNeteaseMusicPlugin } from "./plugins/music/netease-music-plugin.js";
import type { NeteaseMusicPlugin } from "./plugins/music/netease-music-plugin.js";
import { createFileWorkspacePlugin } from "./plugins/system/file-workspace-plugin.js";
import { createCodingToolsPlugin } from "./plugins/coding-tools/plugin.js";
import { createAgentRealToolRegistrations } from "./plugins/system/agent-real-tools.js";
import { createDesktopToolRegistrations } from "./plugins/system/desktop-tools.js";
import { createAgentBackgroundPlugin, type AgentBackgroundPlugin } from "./plugins/system/agent-background-plugin.js";
import { browseToolRegistration } from "./plugins/system/browse-tool.js";
import { createVoiceTtsPlugin } from "./plugins/system/voice-tts-plugin.js";
import { initVoiceMessageRegistry } from "./plugins/system/voice-message-registry.js";
import { createWebFetchPlugin, webfetchToolRegistration } from "./plugins/webfetch.js";
import { createSearchPlugin, searchToolRegistration } from "./plugins/search-plugin.js";
import { createBrowserPlugin, browserToolRegistration } from "./plugins/browser-plugin.js";
import {
  CHAT_CONTEXT_CHAR_LIMIT,
  createPiAgentChatPlugin,
  type PiAgentChatPlugin,
} from "./plugins/chat/pi-agent-chat-plugin.js";
import { createGeminiWebRelayPlugin, type GeminiWebRelayPlugin } from "./network/gemini-relay/plugin.js";
import { createMMORPGFrameworkPlugin } from "./plugins/mmorpg/framework-plugin.js";
import { createMediaToolRegistrations } from "./media-tools.js";
import { createMusicPlugin } from "./plugins/music/music-plugin.js";
import { createFlowMusicPlugin } from "./plugins/flowmusic/flowmusic-plugin.js";
import { createGithubIssuePlugin } from "./plugins/github-issue-plugin.js";
import { createImgGenPlugin } from "./plugins/imggen-plugin.js";
import { createFarmPlugin } from "./plugins/farm-plugin.js";
import { createUnoPlugin } from "./plugins/uno-plugin.js";
import { createAnimeGuessrPlugin } from "./plugins/anime-guessr/plugin.js";
import { ResponsePipeline } from "./response-pipeline.js";
import { createPetPlugin } from "./plugins/pet/plugin.js";
import { createSgsCardPlugin } from "./plugins/sgs-card/plugin.js";
import { PersonaStore } from "./persona/profile-store.js";
import { EvolutionEngine } from "./persona/evolution-engine.js";
import { renderGlobalStyle, renderSoftCore } from "./persona/render.js";
import { makeTool } from "./plugins/mmorpg/framework/utils.js";
import type { BotToolRegistration } from "./tooling.js";
import { assertToolAccess, canUseTool, getAdminUserIds, getAgentIdentity, getInputMessage, isAdminMessage, isPrivilegedToolName } from "./security/access-control.js";
import { AGENT_STABLE_WORK_PROMPT } from "./security/agent-prompt.js";
import { configureGlobalProxy } from "./network/proxy.js";
import type {
  PluginContext, BotMessage, ChatRunResult,
  BlacklistPlugin, GroupTriggerPlugin,
  DataStorePlugin, InventoryPlugin, MenuPlugin,
  SocialPlugin, CheckinPlugin, MentionTrackerPlugin, WelfareRewardSystemPlugin,
  ImgGenPlugin,
} from "./types.js";

async function main() {
  console.log("=== Simplest Bot 启动 ===");

  const config = loadConfig();
  console.log("[Config] 配置已加载");
  configureGlobalProxy(config.proxy);

  const messageStore = new MessageStore();
  process.on("exit", () => { messageStore.close(); closeBrowser(); });
  process.on("SIGINT", () => { messageStore.close(); closeBrowser(); process.exit(); });
  process.on("SIGTERM", () => { messageStore.close(); closeBrowser(); process.exit(); });
  const memory = new MemoryManager(config.memory, messageStore);
  await memory.init();
  const onebot = new OneBotClient(config.oneBot);

  // ========== 人格自进化系统 ==========
  // 先加载画像，把软核心 + 全局风格渲染出来；角色设定（persona）只注入语音会话（$voice），
  // 不再追加进全局 systemPrompt（普通聊天与工作 Agent 均为中性提示）。
  const baseSystemPrompt = config.llm.systemPrompt;
  const personaStore = new PersonaStore(config.persona.dataDir, config.persona);
  let initialPersonaBlock = "";
  let currentVersionKey = "";
  if (config.persona.enabled) {
    // 尝试从快照缓存恢复，保证重启前后前缀字节一致
    currentVersionKey = personaVersionKey(personaStore);
    const cached = loadPromptCache();
    if (cached && cached.versionKey === currentVersionKey) {
      initialPersonaBlock = cached.personaBlock;
      console.log(`[Persona] 从快照缓存恢复 persona（version ${currentVersionKey}）`);
    } else {
      initialPersonaBlock =
        `[你的性格画像]\n你的性格是：${renderSoftCore(personaStore.getSoftCore())}。` +
        `这是你跨所有场景一致的性格底色，会随长期互动缓慢成长，但不会轻易改变。\n\n` +
        renderGlobalStyle(personaStore.getGlobalStyle());
      console.log(`[Persona] 软核心与全局风格已渲染（version ${currentVersionKey}，仅 $voice 注入）`);
    }
  }

  const pluginManager = new PluginManager();

  initBrowserManager({
    chromePath: config.pluginSettings.browser.chromePath,
    headless: config.pluginSettings.browser.headless,
    launchArgs: config.pluginSettings.browser.launchArgs,
    userDataDir: config.pluginSettings.browser.userDataDir,
    defaultViewport: {
      width: config.pluginSettings.browser.viewportWidth,
      height: config.pluginSettings.browser.viewportHeight,
    },
  });

  let chatAgentPlugin: PiAgentChatPlugin | null = null;
  const pluginContext: PluginContext = {
    config,
    sendMessage: async () => { throw new Error("插件上下文尚未就绪"); },
    sendImage: async () => { throw new Error("插件上下文尚未就绪"); },
    sendVoice: async () => { throw new Error("插件上下文尚未就绪"); },
    sendFile: async () => { throw new Error("插件上下文尚未就绪"); },
    replyText: async () => { throw new Error("插件上下文尚未就绪"); },
    recallMessage: async () => { throw new Error("插件上下文尚未就绪"); },
    getImageFilePath: async () => { throw new Error("插件上下文尚未就绪"); },
    getGroupNickname: async () => "",
    getBrowser,
    newPage,
    getUserFacts: async (userId: string) => {
      if (!memory) return [];
      return memory.getUserFacts(userId);
    },
    getAgentIdentity: (message) => getAgentIdentity(message, config),
    // 真实环境不再由会话开关决定：只有管理员显式发起的 $real-work 任务会以
    // environment: "real" 走 chat 插件，其余消息驱动流程一律受限环境。
    getAgentEnvironment: () => "restricted",
    getAgentSessionKey: (message) => getAgentIdentity(message, config).conversationKey,
  };

  pluginManager.setContext(pluginContext);

  // This policy gate must run before moderation, commands and debounce so a
  // refused/injection message never enters the Agent context or burst buffer.
  const agentPolicyPlugin = createAgentPolicyPlugin();
  pluginManager.register(agentPolicyPlugin);

  const moderationPlugin = createModerationPlugin(config.pluginSettings.moderation);
  if (config.plugins.moderation) {
    pluginManager.register(moderationPlugin);
  }

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

  const codingToolsPlugin = createCodingToolsPlugin();
  if (config.plugins.codingTools) {
    pluginManager.register(codingToolsPlugin);
  }

  // 后台任务（URL 监控/受限命令/提醒）依赖 chat Agent 的唤醒通道，随 chat 开关。
  const agentBackgroundPlugin: AgentBackgroundPlugin = createAgentBackgroundPlugin(config);
  if (config.plugins.chat) {
    pluginManager.register(agentBackgroundPlugin);
  }
  initVoiceMessageRegistry(config.pluginSettings.tts.voiceRegistryDataFile);
  initSentImageTexts(config.pluginSettings.chatAgent.sentImageTextsDataFile);
  const voiceTtsPlugin = createVoiceTtsPlugin();
  if (config.plugins.tts) {
    pluginManager.register(voiceTtsPlugin);
  }

  // ========== 内置插件（根据配置启用） ==========
  const blacklistPlugin = createBlacklistPlugin(config.blacklist);
  if (config.plugins.blacklist) pluginManager.register(blacklistPlugin);

  const groupTriggerPlugin = createGroupTriggerPlugin();
  if (config.plugins.groupTrigger) pluginManager.register(groupTriggerPlugin);

  const configuredAdminUserIds = [...getAdminUserIds(config)];
  const todoPlugin = createTodoPlugin(menu);
  if (config.plugins.todo) pluginManager.register(todoPlugin);
  const imgGenPlugin: ImgGenPlugin = createImgGenPlugin(menu, onebot);
  if (config.plugins.imgGen) pluginManager.register(imgGenPlugin);
  if (config.plugins.fftImage) {
    pluginManager.register(createFftImagePlugin(menu, onebot));
  }

  const mmorpgFrameworkPlugin = createMMORPGFrameworkPlugin(store, inventory, social, menu, messageStore, rewardSystem, config.plugins.imgGen ? imgGenPlugin : undefined);
  if (config.plugins.mmorpgFramework) pluginManager.register(mmorpgFrameworkPlugin);

  const petPlugin = createPetPlugin(store, menu);
  if (config.plugins.mmorpgFramework) pluginManager.register(petPlugin);

  pluginManager.register(createIdentityPlugin(onebot, menu, configuredAdminUserIds));
  // 人格自进化插件（注入群画像 + rapport + 管理员命令）。EvolutionEngine 稍后装配。
  let personaEngineRef: EvolutionEngine | null = null;
  if (config.persona.enabled) {
    personaEngineRef = new EvolutionEngine(personaStore, messageStore, config.persona, config.llm);
    personaEngineRef.setSocialPlugin(social);
    pluginManager.register(createPersonaPlugin(personaStore, personaEngineRef, messageStore, menu));
  }
  const chatSearchPlugin = createChatSearchPlugin(messageStore, menu);
  if (config.plugins.chatSearch) pluginManager.register(chatSearchPlugin);
  if (config.plugins.githubIssue) {
    pluginManager.register(
      createGithubIssuePlugin(menu, messageStore, onebot, config.pluginSettings.githubIssue.token),
    );
  }
  if (config.plugins.farm) {
    pluginManager.register(createFarmPlugin(menu, messageStore, store, onebot));
  }
  if (config.plugins.uno) {
    pluginManager.register(createUnoPlugin(menu, messageStore, onebot));
  }
  pluginManager.register(createAnimeGuessrPlugin(menu, onebot, {
    adminUserIds: config.auth.adminUserIds,
    dataFile: config.pluginSettings.animeGuessr.dataFile,
    contributionFile: config.pluginSettings.animeGuessr.contributionFile,
    searchCacheFile: config.pluginSettings.animeGuessr.searchCacheFile,
    bangumiToken: config.pluginSettings.animeGuessr.bangumiToken || null,
    bangumiProxy: config.pluginSettings.animeGuessr.bangumiProxy || null,
    backgroundCharactersPerWork: config.pluginSettings.animeGuessr.backgroundCharactersPerWork,
    searchCacheTtlDays: config.pluginSettings.animeGuessr.searchCacheTtlDays,
    searchNegativeCacheTtlDays: config.pluginSettings.animeGuessr.searchNegativeCacheTtlDays,
    bangumiSearchMinIntervalMs: config.pluginSettings.animeGuessr.bangumiSearchMinIntervalMs,
    bangumiSearchDailyLimit: config.pluginSettings.animeGuessr.bangumiSearchDailyLimit,
  }));
  let dailyReportPlugin: DailyReportPlugin | null = null;
  if (config.plugins.dailyReport) {
    dailyReportPlugin = createDailyReportPlugin(messageStore, menu, store, () => llm);
    pluginManager.register(dailyReportPlugin);
  }
  let agentlyPlugin: ReturnType<typeof createAgentlyPlugin> | null = null;
  if (config.plugins.agently) {
    agentlyPlugin = createAgentlyPlugin(menu);
    pluginManager.register(agentlyPlugin);
  }
  let neteaseMusicPlugin: NeteaseMusicPlugin | null = null;
  if (config.plugins.neteaseMusic) {
    neteaseMusicPlugin = createNeteaseMusicPlugin(menu, onebot);
    pluginManager.register(neteaseMusicPlugin);
  }

  if (config.plugins.reply) pluginManager.register(createReplyPlugin());
  if (config.plugins.markdownImage) {
    pluginManager.register(createMarkdownImagePlugin(config.pluginSettings.markdownImage));
  }
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
  appends.unshift(AGENT_PLAN_SYSTEM_PROMPT);
  let pluginAppendBlock = "";
  if (appends.length > 0) {
    pluginAppendBlock = appends.join("\n\n");
    config.llm.systemPrompt += "\n\n" + pluginAppendBlock;
    console.log(`[Config] 系统提示已追加 ${appends.length} 条插件指令`);
  }

  const mediaNotes: string[] = [];
  if (config.llm.supportsImages) mediaNotes.push("图片占位符格式为 [图片 file=ID]，可调用 view_image 工具按需查看原图。");
  if (config.llm.supportsVideo) mediaNotes.push("视频占位符格式为 [视频 file=ID]，可调用 view_video 工具获取视频文件信息。");
  if (config.llm.supportsVoice) mediaNotes.push("语音占位符格式为 [语音 file=ID]，可调用 view_voice 工具获取语音文件信息。");
  let mediaAppendBlock = "";
  if (mediaNotes.length > 0) {
    mediaAppendBlock = mediaNotes.join("\n");
    config.llm.systemPrompt += "\n\n" + mediaAppendBlock;
  }

  // 与性格画像无关、进化后也不应改变的后缀（插件追加 + 媒体说明）
  const systemPromptNonPersonaSuffix = [pluginAppendBlock, mediaAppendBlock].filter(Boolean).join("\n\n");
  const initialPersonaContent = [
    AGENT_STABLE_WORK_PROMPT,
    baseSystemPrompt,
    ...(initialPersonaBlock ? [initialPersonaBlock] : []),
    ...(systemPromptNonPersonaSuffix ? [systemPromptNonPersonaSuffix] : []),
  ].join("\n\n");

  const contextManager = new ContextManager(
    config.contextManagement,
    initialPersonaContent,
    undefined,
    config.llm.supportsImages,
    config.llm.supportsVideo,
    config.llm.supportsVoice,
    messageStore,
    config.llm.contextWindow  // 传入当前模型的上下文窗口
  );

  // 注册压缩前回调：触发人格进化 + 记忆压实
  if (personaEngineRef) {
    contextManager.setOnBeforeCompress(async () => {
      // 1. 人格进化
      await personaEngineRef!.runCycleIfDue();
      // 2. 记忆压实（由 memory 自主判断是否需要压缩）
      //    注意：memory.compact 是 per-session 的，这里只做全局提示
    });
  }

  // 持久化 prompt 快照，供下次启动时恢复
  if (config.persona.enabled && currentVersionKey) {
    const cached: PromptCache = {
      versionKey: currentVersionKey,
      personaBlock: initialPersonaBlock,
      fullPersonaContent: initialPersonaContent,
      updatedAt: Date.now(),
    };
    savePromptCache(cached);
  }

  // system 插件需要 ContextManager 来清理持久化上下文状态
  const systemPlugin = createSystemPlugin(
    memory,
    pluginManager,
    blacklistPlugin,
    groupTriggerPlugin,
    menu,
    contextManager,
    () => chatAgentPlugin,
  );
  pluginManager.register(systemPlugin);
  await pluginManager.loadOne(systemPlugin);

  // 软核心/全局风格进化后，用最新画像刷新 ContextManager 的 immutable 人格层
  if (personaEngineRef) {
    personaEngineRef.setOnPersonaChanged(() => {
      const refreshedPersonaBlock =
        `[你的性格画像]\n你的性格是：${renderSoftCore(personaStore.getSoftCore())}。` +
        `这是你跨所有场景一致的性格底色，会随长期互动缓慢成长，但不会轻易改变。\n\n` +
        renderGlobalStyle(personaStore.getGlobalStyle());
      const refreshedPersonaContent = [
        AGENT_STABLE_WORK_PROMPT,
        baseSystemPrompt,
        ...(refreshedPersonaBlock ? [refreshedPersonaBlock] : []),
        ...(systemPromptNonPersonaSuffix ? [systemPromptNonPersonaSuffix] : []),
      ].join("\n\n");
      contextManager.updatePersona(refreshedPersonaContent);

      // 进化后更新快照缓存，下次重启直接继承
      const newVersionKey = personaVersionKey(personaStore);
      savePromptCache({
        versionKey: newVersionKey,
        personaBlock: refreshedPersonaBlock,
        fullPersonaContent: refreshedPersonaContent,
        updatedAt: Date.now(),
      });
    });
  }

  const llm = new LLMClient(
    config.llm,
    memory,
    contextManager,
    config.contextManagement.maxMessageChars,
    async (messageId) => {
      // 优先：该消息若是 bot 自己发送的"图片型消息"（markdown-image 等把原文转图），
      // 直接还原为生成它的原文文本，避免 AI 只看到 `[图片 file=...]` 占位符。
      const registered = lookupSentImageText(messageId);
      if (registered) {
        return {
          id: messageId,
          type: registered.type,
          selfId: registered.userId,
          userId: registered.userId,
          groupId: registered.groupId,
          text: registered.text,
          raw: { post_type: "message", message_type: registered.type, message_id: messageId } as never,
        };
      }
      const local = messageStore.findMessageById(messageId);
      if (local) return local;
      return onebot.getMessage(messageId);
    },
    async (message) => {
      if (message.type !== "group" || !message.groupId || !message.userId) {
        return null;
      }
      try {
        const [groupInfo, memberInfo, memberList] = await Promise.all([
          onebot.getGroupInfo(message.groupId),
          onebot.getGroupMemberInfo(message.groupId, message.userId),
          onebot.getGroupMemberList(message.groupId),
        ]);
        return {
          groupId: message.groupId,
          groupName: groupInfo.groupName,
          triggerUserId: message.userId,
          memberCard: memberInfo.card,
          memberNickname: memberInfo.nickname,
          members: Object.fromEntries(memberList.map((member) => [member.userId, { card: member.card, nickname: member.nickname }])),
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
    },
    config.llmFallbacks
  );
  console.log(`[LLM] 模型: ${config.llm.model}`);

  // 注入网易云音乐每日推荐依赖
  if (neteaseMusicPlugin && config.plugins.neteaseMusic) {
    neteaseMusicPlugin.setRecommendDeps({
      messageStore,
      askLlm: (systemPrompt: string, userPrompt: string) => llm.askLlm(systemPrompt, userPrompt),
    });
    console.log("[NCM] 每日推荐依赖已注入");
  }

  // LLM 提供商管理插件
  const providerPlugin: import("./types.js").Plugin = {
    name: "provider",
    description: "LLM 提供商管理",
    onLoad(ctx) {
      const prefix = menu.getPrefix();
      menu.registerCommand(
        "provider",
        `LLM 提供商管理：${prefix}provider list | use <名称> | fallback on/off`,
        async (message, args) => {
          const sub = args[0];
          if (!sub || sub === "list") {
            const providers = llm.listProviders();
            const lines = providers.map(p => {
              const status = p.isActive ? " ← 当前" : "";
              const health = p.healthy ? "正常" : "故障";
              const base = p.baseUrl ? ` (${p.baseUrl})` : "";
              return `  ${p.index}. [${p.provider}] ${p.name} · ${p.model}${base} · ${health}${status}`;
            });
            const fallbackStatus = llm.isFallbackEnabled() ? "开启" : "关闭";
            await ctx.replyText(message,
              `LLM 提供商列表（自动切换: ${fallbackStatus}）：\n${lines.join("\n")}`
            );
            return;
          }
          if (sub === "use" && args[1]) {
            const ok = llm.switchProvider(args[1]);
            if (ok) {
              await ctx.replyText(message, `已切换至提供商: ${args[1]}`);
            } else {
              await ctx.replyText(message, `未找到名为 "${args[1]}" 的提供商。使用 ${prefix}provider list 查看可用列表。`);
            }
            return;
          }
          if (sub === "fallback") {
            if (args[1] === "on") {
              llm.setFallback(true);
              await ctx.replyText(message, "自动切换提供商已开启");
            } else if (args[1] === "off") {
              llm.setFallback(false);
              await ctx.replyText(message, "自动切换提供商已关闭");
            } else {
              const current = llm.isFallbackEnabled() ? "开启" : "关闭";
              await ctx.replyText(message, `当前状态: ${current}。用法: ${prefix}provider fallback on/off`);
            }
            return;
          }
          await ctx.replyText(message, `用法: ${prefix}provider list | use <名称> | fallback on/off`);
        },
        { adminOnly: true }
      );
    },
  };
  pluginManager.register(providerPlugin);
  await pluginManager.loadOne(providerPlugin);

  // 撤回消息命令
  const recallPlugin: import("./types.js").Plugin = {
    name: "recall",
    description: "撤回消息",
    onLoad(ctx) {
      const prefix = menu.getPrefix();
      menu.registerCommand(
        "recall",
        `撤回指定消息：${prefix}recall <消息ID>`,
        async (message, args) => {
          if (!args[0]) {
            await ctx.replyText(message, `用法：${prefix}recall <消息ID>`);
            return;
          }
          try {
            await ctx.recallMessage(args[0]);
            await ctx.replyText(message, "已尝试撤回。");
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await ctx.replyText(message, "撤回失败：" + msg.slice(0, 200));
          }
        },
      );
    },
  };
  pluginManager.register(recallPlugin);
  await pluginManager.loadOne(recallPlugin);

  // 音乐生成插件
  if (config.plugins.music) {
    const musicPlugin = createMusicPlugin(llm, menu);
    pluginManager.register(musicPlugin);
    await pluginManager.loadOne(musicPlugin);
  }

  if (config.plugins.flowmusic) {
    const flowmusicPlugin = createFlowMusicPlugin(menu);
    pluginManager.register(flowmusicPlugin);
    await pluginManager.loadOne(flowmusicPlugin);
  }

  if (config.plugins.sgsCard) {
    const sgsCardPlugin = createSgsCardPlugin({ llm, menu, getUserFacts: pluginContext.getUserFacts });
    pluginManager.register(sgsCardPlugin);
    await pluginManager.loadOne(sgsCardPlugin);
  }

  mentionTrackerPlugin.setHandler({
    evaluateAndReply: async (context) => {
      const reply = await llm.evaluateMentionContext(context.botMessage, context.collectedMessages);
      if (reply) {
        const target = { type: "group" as const, id: context.groupId };
        await responsePipeline.send(target, reply, { context: { groupId: target.id } });
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
    approveGroupInvite: async (flag) => {
      await onebot.sendAction("set_group_add_request", { flag, approve: true, sub_type: "invite" });
    },
  });

  // 设置智能压缩回调：历史上下文整理固定使用配置中的主线路，
  // 不受运行期间 provider use 切换到备用线路的影响。
  memory.setCompressCallback((history) => llm.summarizeHistoryWithPrimaryProvider(history));

  // 启动时整理已有的超长标准会话。历史预算比 Relay 硬上限再小一些，
  // 给 standard systemPrompt、当前消息和 Relay 角色前缀留出空间；该操作
  // 只会处理超限快照，后续启动不会重复请求主线路。
  const persistedCompaction = await memory.compactPersistedConversationsForContext(
    Math.max(0, CHAT_CONTEXT_CHAR_LIMIT - 2_800),
  );
  if (persistedCompaction.compressed > 0 || persistedCompaction.failed > 0) {
    console.log(
      `[Memory] 启动历史整理：检查 ${persistedCompaction.checked} 个会话，` +
      `压缩 ${persistedCompaction.compressed} 个，失败 ${persistedCompaction.failed} 个，` +
      `字符 ${persistedCompaction.beforeChars}→${persistedCompaction.afterChars}`,
    );
  }

  // 注册工具
  const toolRegistrations: BotToolRegistration[] = [];
  toolRegistrations.push(...agentPolicyPlugin.getToolRegistrations());
  toolRegistrations.push(...createAgentPlanToolRegistrations());
  toolRegistrations.push(...social.getToolRegistrations());
  if (config.plugins.fileWorkspace) {
    toolRegistrations.push(...fileWorkspacePlugin.getToolRegistrations());
  }
  if (config.plugins.codingTools) {
    toolRegistrations.push(...codingToolsPlugin.getToolRegistrations());
    console.log(`[CodingTools] 已注册工作区级读写工具`);
  }
  if (config.plugins.chat) {
    toolRegistrations.push(...agentBackgroundPlugin.getToolRegistrations());
  }
  if (config.plugins.tts) {
    toolRegistrations.push(...voiceTtsPlugin.getToolRegistrations());
  }
  if (config.plugins.webfetch) {
    toolRegistrations.push(webfetchToolRegistration);
  }
  if (config.plugins.search) {
    toolRegistrations.push(searchToolRegistration(config.pluginSettings.search));
  }
  if (config.plugins.browser) {
    const browserRegistration = browserToolRegistration(
      config.pluginSettings.browser,
      config.llm,
      (input) => {
        const msg = getInputMessage(input);
        const baseDir = path.resolve(process.cwd(), config.pluginSettings.fileWorkspace.rootDir);
        if (msg.type === "group" && msg.groupId && config.pluginSettings.fileWorkspace.sharedGroupWorkspace) {
          const dir = path.join(baseDir, "group", msg.groupId);
          fs.mkdirSync(dir, { recursive: true });
          return dir;
        }
        if (msg.type === "group" && msg.groupId) {
          const dir = path.join(baseDir, "group", msg.groupId, "user", msg.userId ?? "anonymous");
          fs.mkdirSync(dir, { recursive: true });
          return dir;
        }
        const dir = path.join(baseDir, "private", msg.userId ?? "unknown");
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      }
    );
    toolRegistrations.push({
      ...browserRegistration,
      execute: async (args, input) => {
        assertToolAccess("browser_agent", input, config);
        return browserRegistration.execute(args, input);
      },
    });
    // browse：只读浏览（页面结构化为 markdown），普通用户可用；SSRF 防护内建。
    toolRegistrations.push(browseToolRegistration(config));
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
  if (agentlyPlugin) {
    toolRegistrations.push(...agentlyPlugin.getToolRegistrations());
  }
  toolRegistrations.push(...createAgentRealToolRegistrations(config));
  toolRegistrations.push(...createDesktopToolRegistrations(config));
  toolRegistrations.push(
    ...createMediaToolRegistrations(onebot, {
      supportsImages: config.llm.supportsImages,
      supportsVideo: config.llm.supportsVideo,
      supportsVoice: config.llm.supportsVoice,
    })
  );
  if (config.memory.extraction.enabled) {
    toolRegistrations.push(
      makeTool(
        "save_user_fact",
        "当你在对话中识别到关于用户的持久性个人事实（姓名、年龄、所在地、职业、爱好、偏好、重要经历、人际关系等）时，调用此工具保存。每条事实应独立、自包含、简洁（15 字以内为佳）。不保存临时情绪或对话中显而易见的内容；与已知记忆重复则不保存；如果没有新事实则不调用此工具。",
        {
          type: "object",
          properties: {
            facts: {
              type: "array",
              items: { type: "string" },
              description: "提取到的用户个人事实列表",
            },
          },
          required: ["facts"],
        },
        async (args, input) => {
           const msg = getInputMessage(input);
          const userId = msg.userId;
          const facts = args.facts;
          if (!userId || !Array.isArray(facts) || facts.length === 0) {
            return "没有可保存的事实或无法识别用户。";
          }
          const validFacts = facts.filter(
            (f): f is string => typeof f === "string" && f.trim().length > 0
          );
          if (validFacts.length === 0) return "事实列表为空。";
          await memory.saveExtractedFacts(userId, validFacts);
          return `已保存 ${validFacts.length} 条事实。`;
        }
      )
    );
    // 查询用户记忆（包括不活跃的）—— AI 可以通过此工具直接检索
    toolRegistrations.push(
      makeTool(
        "query_user_facts",
        "查询关于用户已存储的个人事实。返回匹配的事实列表及其活跃状态。不活跃的事实（[不活跃] 标记）表示长时间未被提及，但仍然有效。此工具查询的是数据库中的原始记录，不会丢失信息。",
        {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索关键词，支持模糊匹配",
            },
            limit: {
              type: "number",
              description: "最多返回条数（默认 10）",
            },
          },
          required: ["query"],
        },
        async (args, input) => {
           const msg = getInputMessage(input);
          const userId = msg.userId;
          const query = String(args.query ?? "").trim();
          const limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
          if (!userId || !query) return "请提供搜索关键词。";
          const results = queryUserFacts(userId, query, messageStore);
          if (results.length === 0) return `未找到与 "${query}" 相关的事实。`;
          const lines = results.slice(0, limit).map((r) =>
            `${r.active ? "[活跃]" : "[不活跃]"} ${r.content}（访问${r.accessCount}次）`
          );
          return `找到 ${results.length} 条匹配事实：\n${lines.join("\n")}`;
        }
      )
    );
  }
  // Apply one final authorization boundary to every execution path. Individual
  // plugins may also guard themselves, but tool descriptions are not access
  // control and the legacy LangChain path must be protected too.
  const guardedToolRegistrations = toolRegistrations.map((registration) => {
    const definition = registration.definition as unknown as { function?: { name?: string } };
    const toolName = definition.function?.name ?? "unknown_tool";
    if (!isPrivilegedToolName(toolName)) return registration;
    return {
      ...registration,
      execute: async (args: Record<string, unknown>, input: import("./types.js").PromptBuildInput) => {
        assertToolAccess(toolName, input, config);
        return registration.execute(args, input);
      },
    };
  });

  if (guardedToolRegistrations.length > 0) {
    llm.setTools(guardedToolRegistrations);
    llm.setToolAccessFilter((toolName, input) => canUseTool(toolName, input, config));
    console.log(`[LLM] 已注册 ${guardedToolRegistrations.length} 个工具`);
  }

  const responsePipeline = new ResponsePipeline({
    splitResponse: (text) => pluginManager.splitResponse(text),
    transformResponse: (text, context) => pluginManager.transformResponse(text, context),
    parseTextSegments: safeCqToSegments,
    sendSegments: async (target, segments, sourceText) => {
      const sentId = await onebot.sendSegments(target, segments);
      // 若发送的是图片型消息，登记"图片消息 id ↔ 原文"，供后续引用时还原为文本。
      if (sentId && sourceText && segments.some((s) => s.type === "image")) {
        let botSelfId: string | undefined;
        try { botSelfId = await onebot.getBotSelfId(); } catch { /* ignore */ }
        const registered = registerSentImageText(sentId, {
          text: sourceText,
          userId: botSelfId,
          groupId: target.type === "group" ? target.id : undefined,
          type: target.type,
          relTarget: target,
        });
        // 冷启动修复：跨重启登记的条目注册表里没有 selfId（旧数据 / 当时 getLoginInfo 失败），
        // 此处异步补齐，保证 lookupSentImageText 命中时能构造完整 BotMessage。
        if (registered && !registered.userId) {
          void onebot.getBotSelfId()
            .then((selfId) => { registered.userId = selfId; })
            .catch(() => {});
        }
      }
      return sentId ?? undefined;
    },
    splitLongText,
    onAtMention: (target, userId, sourceText) => {
      if (target.type === "group") mentionTrackerPlugin.trackMention(userId, target.id, sourceText);
    },
    maxTextChars: 3000,
  });

  pluginContext.sendMessage = (target, text) => {
    const context = target.type === "group" ? { groupId: target.id } : undefined;
    return responsePipeline.send(target, text, { context });
  };
  pluginContext.sendImage = (target, filePath, caption) => onebot.sendImage(target, filePath, caption);
  pluginContext.sendVoice = (target, filePath) => onebot.sendVoice(target, filePath);
  pluginContext.sendFile = (target, filePath, name) => onebot.sendFile(target, filePath, name);
  pluginContext.replyText = (message, text) => {
    const target = message.type === "group"
      ? { type: "group" as const, id: message.groupId! }
      : { type: "private" as const, id: message.userId! };
    const context = target.type === "group" ? { groupId: target.id } : undefined;
    return responsePipeline.send(target, text, { context });
  };
  pluginContext.recallMessage = (messageId) => onebot.sendAction("delete_msg", { message_id: messageId }).then(() => {});
  pluginContext.getImageFilePath = (fileId) => onebot.getImageFile(fileId);
  pluginContext.getGroupNickname = async (userId, groupId) => {
    if (!groupId) return "";
    try {
      const memberInfo = await onebot.getGroupMemberInfo(groupId, userId);
      return memberInfo.card || memberInfo.nickname || "";
    } catch {
      return "";
    }
  };

  // Chat is a capability plugin: it owns the agent loop, session queue and
  // explicit final-delivery tool, while this layer supplies the transport.
  chatAgentPlugin = config.plugins.chat
    ? createPiAgentChatPlugin({
      config,
      memory,
      llm,
      chatLlm: config.pluginSettings.chatAgent.llm,
      personaPrompt: initialPersonaBlock,
      // standard（普通聊天）通道不传人格、长期记忆或工作设定；历史超限后由
      // chat 插件按字符预算注入压缩摘要（人格与工作协议仍仅保留在 voice/agent 通道）。
      systemPrompt: "",
      getDynamicPromptAppends: (input) => pluginManager.buildDynamicPromptAppends(input),
      // 真实环境只可能由 $real-work 以 deliveryOptions.environment 显式声明，
      // 这里不再从会话状态推导。
      sendReply: (message, text, options) => sendReply(message, text, options),
      resolveQuotedMessage: createQuotedMessageResolver({
        findMessageById: (messageId) => messageStore.findMessageById(messageId),
        getMessage: async (messageId) => onebot.getMessage(messageId),
        getImageFile: (fileId) => onebot.getImageFile(fileId),
        downloadFileToBase64: (filePath) => onebot.downloadFileToBase64(filePath),
        getMediaFileUrl: (action, fileId) => onebot.getMediaFileUrl(action, fileId),
        downloadUrlToBase64: (url) => onebot.downloadUrlToBase64(url),
      }),
          sendReaction: (message, emojiId) => {
            if (!message.id) return Promise.resolve();
            return onebot.setMsgEmojiLike(message.id, emojiId ?? config.pluginSettings.chatAgent.taskStartEmojiId);
          },
    })
    : null;
  if (chatAgentPlugin) {
    chatAgentPlugin.setToolRegistrations(guardedToolRegistrations);
    pluginManager.register(chatAgentPlugin);
    await pluginManager.loadOne(chatAgentPlugin);
    // 后台任务完成 → 以受限 agent 会话唤醒该会话继续处理（永远不进入真实环境）。
    agentBackgroundPlugin.setWakeHandler((message, appends) =>
      chatAgentPlugin!.chat(message, appends, { mode: "agent", quote: false }),
    );
  }

  // 聊天模式命令：$voice（语音会话，注入角色设定 + 强制语音交付）、$work（受限环境
  // 工作 Agent）与 $real-work（管理员专用，单次任务直接以真实环境运行）。普通聊天为
  // 默认 standard 模式；各路径的会话上下文彼此独立。语音不再由 chat 层自动触发。
  // 真实环境没有"进入/退出"开关：它只在管理员显式发起一条 $real-work 任务时存在，
  // 任务结束即消失，避免无限制 shell 长时间暴露给持续处理不可信消息的 LLM。
  if (chatAgentPlugin) {
    const chatModeCommandsPlugin: import("./types.js").Plugin = {
      name: "chat-mode-commands",
      description: "$voice / $work / $real-work 聊天模式命令",
      onLoad() {
        const prefix = menu.getPrefix();
        menu.registerCommandGroup("agent", "工作代理", "工作环境与 Agent 执行流");
        menu.registerCommand(
          "voice",
          `语音聊天：${prefix}voice <内容>（AI 以角色设定生成适合朗读的口语回复，并用语音消息发送）`,
          async (message, args, ctx) => {
            const content = args.join(" ").trim();
            if (!content) {
              await ctx.replyText(message, `用法：${prefix}voice <内容>\n例如：${prefix}voice 讲个冷笑话`);
              return;
            }
            const voiceDirective = [
              "[$voice 命令指令]",
              `用户通过 ${prefix}voice 命令提问：“${content}”。`,
              "请认真回答这个问题。本轮回复已强制以语音交付，请面向朗读组织内容：短句、口语化、标准标点，不要包含链接、代码、命令路径或长表格。",
            ].join("\n");
            await chatAgentPlugin.chat(message, [voiceDirective], { mode: "agent", voice: true, quote: true });
          },
        );
        menu.registerCommand(
          "work",
          `工作执行（受限环境）：${prefix}work <任务>（AI 在用户隔离的受限 workspace 中使用工具完成任务）`,
          async (message, args, ctx) => {
            const content = args.join(" ").trim();
            if (!content) {
              await ctx.replyText(message, `用法：${prefix}work <任务>\n例如：${prefix}work 修复项目里的一个 bug`);
              return;
            }
            const workDirective = [
              "[$work 命令指令]",
              `用户通过 ${prefix}work 命令请求工作：“${content}”。`,
              "这是明确的工作请求：使用可用工具实际完成任务，按工作协议用 send_current_reply 交付结果，不要只给出建议。当前运行在受限工作环境。",
            ].join("\n");
            await chatAgentPlugin.chat(message, [workDirective], { mode: "agent", quote: true });
          },
        );
        menu.registerCommand(
          "real-work",
          `真实环境工作 [管理员]：${prefix}real-work <任务>（仅管理员；单次任务以宿主真实权限运行 Agent）`,
          async (message, args, ctx) => {
            // menu 已按 adminOnly 拦截非管理员；这里再独立校验一次，确保即使
            // 命令注册被绕过，真实环境也不会对非管理员开放。
            if (!isAdminMessage(message, ctx.config)) {
              await ctx.replyText(message, "权限不足，仅管理员可发起真实环境任务。");
              return;
            }
            const content = args.join(" ").trim();
            if (!content) {
              await ctx.replyText(message, `用法：${prefix}real-work <任务>\n例如：${prefix}real-work 重启测试服务并检查日志`);
              return;
            }
            const realWorkDirective = [
              "[$real-work 命令指令]",
              `管理员通过 ${prefix}real-work 命令请求在真实环境中完成工作：“${content}”。`,
              "这是明确的工作请求：使用真实环境工具实际完成任务，按工作协议用 send_current_reply 交付结果，不要只给出建议。",
            ].join("\n");
            await chatAgentPlugin.chat(message, [realWorkDirective], { mode: "agent", quote: true, environment: "real" });
          },
          { adminOnly: true, group: "agent" },
        );
      },
    };
    pluginManager.register(chatModeCommandsPlugin);
    await pluginManager.loadOne(chatModeCommandsPlugin);
  }

  // Gemini Web 中继（gemini-web2api 的 Node.js 内嵌重写）：进程内 OpenAI 兼容纯文本通道，
  // 供 standard 聊天的 chatLlm 使用。端口被外部实例占用且健康时自动复用。
  const geminiRelayPlugin = createGeminiWebRelayPlugin(config);
  if (config.plugins.geminiRelay) {
    pluginManager.register(geminiRelayPlugin);
    await pluginManager.loadOne(geminiRelayPlugin);
  }

  debouncePlugin.setHandler({
    shouldReplyCheck: async (message) => pluginManager.shouldReply(message),
    chatBatch: async (messages, triggerIndex) => {
      const input = {
        mode: "batch" as const,
        messages,
        triggerIndex,
        environment: "restricted" as const,
      };
      const appends = await pluginManager.buildDynamicPromptAppends(input);
      const result: ChatRunResult = chatAgentPlugin
        ? await chatAgentPlugin.chatBatch(messages, appends, triggerIndex)
        : {
          text: await llm.chatBatch(messages, appends, triggerIndex),
          delivered: false,
        };
      if (input.environment === "restricted") {
        try {
          messageStore.appendBatchReply(messages, result.text, result.deliveredMessageIds?.[0]);
        } catch (err) {
          console.error("[MessageStore] 批量存储回复失败:", err);
        }
      }
      return result;
    },
    sendResponse: (target, text, context) => responsePipeline.send(target, text, { context }),
  });

  async function sendReply(
    message: BotMessage,
    reply: string,
    options: { quote?: boolean; onSentMessageIds?: (ids: string[]) => void } = {},
  ) {
    const target = message.type === "group"
      ? { type: "group" as const, id: message.groupId! }
      : { type: "private" as const, id: message.userId! };
    const transformContext = target.type === "group" ? { groupId: target.id } : undefined;
    await responsePipeline.send(target, reply, {
      context: transformContext,
      quoteMessageId: options.quote ? message.id : undefined,
      // 透传调用方的 onSentMessageIds 收集器（chat 插件经 deliverReply 注入），
      // 使 ChatRunResult.deliveredMessageIds 能拿到实际发出的 message_id。
      onSentMessageIds: options.onSentMessageIds,
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

    const blocked = await pluginManager.processMessage(message);
    if (blocked) return;

    // 普通消息流一律受限环境；真实环境只存在于管理员显式发起的 $real-work 任务内。
    const environment = "restricted" as const;
    messageStore.appendIncoming(message);

    const shouldReply = await pluginManager.shouldReply(message);
    if (!shouldReply) return;

    try {
      const dynamicAppends = await pluginManager.buildDynamicPromptAppends({ mode: "single", message, environment });
      const result: ChatRunResult = chatAgentPlugin
        ? await chatAgentPlugin.chat(message, dynamicAppends)
        : {
          text: await llm.chat(message, dynamicAppends),
          delivered: false,
        };
      try {
        // 关联 bot 回复实际发出的 message_id（可能多条，取第一条；由 chat 层经
        // onSentMessageIds 回传），供用户之后引用该消息时通过 findMessageById 回溯。
        messageStore.appendReply(message, result.text, result.deliveredMessageIds?.[0]);
      } catch (err) {
        console.error("[MessageStore] 存储回复失败:", err);
      }
      if (!result.delivered) {
        await sendReply(message, result.text);
      }
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
    if (event.requestType === "group" && event.subType === "invite") {
      console.log(`[AutoApprove] 自动同意群邀请入群：群 ${event.groupId}，邀请人 ${event.userId}`);
      try {
        await onebot.sendAction("set_group_add_request", {
          flag: event.flag,
          approve: true,
          sub_type: "invite",
        });
      } catch (error) {
        console.error("[AutoApprove] 自动同意群邀请入群失败:", error);
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
    // 启动人格进化后台循环
    if (personaEngineRef) {
      personaEngineRef.start();
    }
  } catch (error) {
    console.error("[Bot] 连接失败:", error);
    process.exit(1);
  }

  const shutdown = async () => {
    console.log("\n[Bot] 正在关闭...");
    await geminiRelayPlugin.close();
    chatAgentPlugin?.close();
    if (personaEngineRef) {
      personaEngineRef.stop();
    }
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
