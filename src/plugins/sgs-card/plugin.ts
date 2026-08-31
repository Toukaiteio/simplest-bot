import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { BotMessage, Plugin, PluginContext, SgsCardPluginDeps } from "../../types.js";
import { parseCardData } from "./parser.js";
import {
  buildCardDesignPrompt,
  buildNicknameSimplifyPrompt,
  buildRepairPrompt,
  buildSkillRepairPrompt,
  buildSkillTunePrompt,
  buildSkillValidationPrompt,
} from "./prompts.js";
import { renderSgsCardImage, renderSgsStoryImage } from "./canvas-renderer.js";
import type { SgsCardData, SkillValidation } from "./schema.js";

const CREATE_SGS_CARD_FUNCTION = {
  name: "create_sgs_card",
  description: "创建一张原创三国杀武将牌，所有字段必须可直接用于卡面渲染。",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "title", "faction", "hp", "maxHp", "armor", "flavor", "skills", "backstory", "designNotes"],
    properties: {
      name: {
        type: "string",
        pattern: "^[\\u3400-\\u9fff\\uf900-\\ufaff]{1,5}$",
        description: "武将名，必须来自角色名称，不得使用刘备、关羽、张飞、曹操、孙权等官方三国人物名。",
      },
      title: { type: "string", description: "称号，2-6个简体中文字符。" },
      faction: { type: "string", enum: ["魏", "蜀", "吴", "群", "晋", "神"] },
      hp: { type: "integer", minimum: 1, maximum: 6 },
      maxHp: { type: "integer", minimum: 1, maximum: 6 },
      armor: { type: "integer", minimum: 0, maximum: 3 },
      flavor: { type: "string", description: "角色名言，12字以内的简体中文短句。" },
      skills: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "type", "desc"],
          properties: {
            name: {
              type: "string",
              pattern: "^[\\u3400-\\u9fff\\uf900-\\ufaff]{2}$",
              description: "技能名，必须且只能是两个中文字符，不得带括号、空格、英文、数字、标点或技能类型。",
            },
            type: { type: "string", enum: ["锁定技", "限定技", "觉醒技", "转换技", "使命技", "普通技"] },
            desc: { type: "string", minLength: 8, maxLength: 112 },
          },
        },
      },
      backstory: { type: "string", minLength: 30, maxLength: 150 },
      designNotes: {
        type: "array",
        maxItems: 3,
        items: { type: "string", maxLength: 40 },
      },
    },
  },
};

const TUNE_SGS_SKILLS_FUNCTION = {
  name: "tune_sgs_skill_descriptions",
  description: "根据用户微调意见和专业判断，只调整已有武将技能的描述文本。",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["skills", "aiOpinion"],
    properties: {
      skills: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "desc"],
          properties: {
            index: {
              type: "integer",
              minimum: 1,
              maximum: 4,
              description: "要调整的原技能序号，从1开始。不得新增或删除技能。",
            },
            desc: {
              type: "string",
              minLength: 8,
              maxLength: 112,
              description: "调整后的技能描述。只能是desc文本，不包含技能名或技能类型。",
            },
            reason: {
              type: "string",
              maxLength: 60,
              description: "这条技能为什么这样微调，需结合用户意见和AI专业判断。",
            },
          },
        },
      },
      aiOpinion: {
        type: "string",
        maxLength: 120,
        description: "AI自己的整体微调意见，说明对用户意见做了哪些保留、克制或增强。",
      },
    },
  },
};

function fetchUrlAsDataUri(url: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrlAsDataUri(res.headers.location, timeoutMs).then(resolve);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const mime = res.headers["content-type"] || "image/jpeg";
        resolve(`data:${mime};base64,${buf.toString("base64")}`);
      });
      res.on("error", () => resolve(""));
    });
    req.on("timeout", () => { req.destroy(); resolve(""); });
    req.on("error", () => resolve(""));
  });
}

async function fetchAvatarDataUri(userId: string): Promise<string> {
  if (!userId || !/^\d{5,}$/.test(userId)) return "";
  const urls = [
    `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=640`,
    `https://q2.qlogo.cn/headimg_dl?dst_uin=${userId}&spec=640`,
  ];
  for (const url of urls) {
    const dataUri = await fetchUrlAsDataUri(url);
    if (dataUri.length > 100) return dataUri;
  }
  return "";
}

type StoredCard = {
  userId: string;
  data: SgsCardData;
  imagePath: string;
  createdAt: number;
};

function getTarget(message: BotMessage) {
  return message.type === "group" && message.groupId
    ? { type: "group" as const, id: message.groupId }
    : { type: "private" as const, id: message.userId! };
}

function sanitizeStem(value: string): string {
  return value.replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 48) || `sgs-${Date.now()}`;
}

function displaySkillName(value: string): string {
  const hanChars = [...value].filter((char) => /[\u3400-\u9fff\uf900-\ufaff]/u.test(char));
  if (hanChars.length >= 2) return hanChars.slice(0, 2).join("");
  if (hanChars.length === 1) return `${hanChars[0]}技`;
  return "未名";
}

function stableFallbackCharacterName(userId: string): string {
  const suffix = userId.replace(/\D/g, "").slice(-3);
  return suffix ? `群友${suffix}` : "群友";
}

function sanitizeCharacterName(value: string, fallback: string): string {
  const hanChars = [...value].filter((char) => /[\u3400-\u9fff\uf900-\ufaff]/u.test(char));
  if (hanChars.length > 0) {
    return hanChars.slice(0, 5).join("");
  }
  return fallback;
}

function normalizeCandidateUserId(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  if (!text || text.toLowerCase() === "all") return undefined;
  const match = text.match(/\d{5,}/);
  return match?.[0];
}

function parseTargetUserIdArg(args: string[], message: BotMessage): string | undefined {
  if (Array.isArray(message.raw.message)) {
    for (const segment of message.raw.message) {
      if (segment.type !== "at") continue;
      const userId = normalizeCandidateUserId(segment.data.qq);
      if (userId) return userId;
    }
  }

  const argText = args.join(" ");
  const cqAtMatch = argText.match(/\[CQ:at,[^\]]*qq=(\d{5,})[^\]]*\]/i);
  if (cqAtMatch?.[1]) return cqAtMatch[1];

  const atTextMatch = argText.match(/@(\d{5,})/);
  if (atTextMatch?.[1]) return atTextMatch[1];

  for (const arg of args) {
    if (/^\d{5,}$/.test(arg)) return arg;
  }

  return undefined;
}

function extractTuneInstruction(args: string[], message: BotMessage): string {
  const targetUserId = parseTargetUserIdArg(args, message);
  const text = args
    .filter((arg) => {
      if (!targetUserId) return true;
      if (arg === targetUserId) return false;
      if (arg === `@${targetUserId}`) return false;
      if (arg.includes(`[CQ:at`) && arg.includes(targetUserId)) return false;
      return true;
    })
    .join(" ")
    .replace(/\[CQ:at,[^\]]*qq=\d{5,}[^\]]*\]/gi, "")
    .replace(/@\d{5,}/g, "")
    .trim();
  return text;
}

function clipText(value: unknown, maxLen: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function anchorCardName(card: SgsCardData, characterName: string): SgsCardData {
  return {
    ...card,
    name: sanitizeCharacterName(characterName, "群友"),
  };
}

class CardStore {
  private readonly filePath: string;
  private cards: Map<string, StoredCard> = new Map();
  private loaded = false;

  constructor(outputDir: string) {
    this.filePath = path.join(outputDir, "card-store.json");
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, StoredCard>;
        this.cards = new Map(Object.entries(parsed));
      }
    } catch {
      this.cards = new Map();
    }
    this.loaded = true;
  }

  private save() {
    const obj = Object.fromEntries(this.cards);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
  }

  get(userId: string): StoredCard | undefined {
    return this.cards.get(userId);
  }

  has(userId: string): boolean {
    return this.cards.has(userId);
  }

  set(userId: string, card: StoredCard) {
    this.cards.set(userId, card);
    this.save();
  }

  delete(userId: string) {
    this.cards.delete(userId);
    this.save();
  }
}

async function resolveCharacterName(
  ctx: PluginContext,
  llmAsk: SgsCardPluginDeps["llm"]["askLlm"],
  userId: string,
  message: BotMessage,
  args: string[],
): Promise<{ name: string; desc: string; isSelf: boolean }> {
  const targetUserId = parseTargetUserIdArg(args, message);
  const isSelf = !targetUserId;
  const effectiveUserId = targetUserId || userId;
  const fallbackName = stableFallbackCharacterName(effectiveUserId);

  const nickname = await ctx.getGroupNickname(effectiveUserId, message.groupId).catch(() => "");

  if (!nickname.trim()) {
    return {
      name: fallbackName,
      desc: `群名片为空，使用稳定代号${fallbackName}生成原创武将。`,
      isSelf,
    };
  }

  const locallyCleaned = sanitizeCharacterName(nickname, fallbackName);
  if (locallyCleaned !== fallbackName || nickname.length <= 10) {
    return {
      name: locallyCleaned,
      desc: locallyCleaned === fallbackName
        ? `群名片“${nickname}”缺少可用中文名，使用稳定代号${fallbackName}生成原创武将。`
        : `群名片“${nickname}”清洗为“${locallyCleaned}”。`,
      isSelf,
    };
  }

  const simplified = await llmAsk(
    "压缩群名片。",
    buildNicknameSimplifyPrompt(nickname, 20),
  );

  const cleanSimplified = sanitizeCharacterName(
    simplified.trim().replace(/^["""]|["""]$/g, ""),
    locallyCleaned,
  );
  return {
    name: cleanSimplified,
    desc: `群名片“${nickname}”压缩并清洗为“${cleanSimplified}”。`,
    isSelf,
  };
}

async function generateCardData(
  llmClient: SgsCardPluginDeps["llm"],
  characterName: string,
  characterDesc: string,
  userFacts: string[],
): Promise<SgsCardData> {
  const systemPrompt = "你是一名精通三国杀原创设计的卡牌策划。必须通过指定函数提交武将牌数据。";
  const userPrompt = buildCardDesignPrompt(characterName, characterDesc, userFacts);
  const functionArgs = await llmClient.askLlmWithFunction(
    systemPrompt,
    `${userPrompt}\n\n请调用 create_sgs_card 函数提交最终武将牌，不要直接输出正文。`,
    CREATE_SGS_CARD_FUNCTION,
    { maxTokens: 8096, reasoningEffort: "high" },
  );
  if (functionArgs) {
    try {
      return parseCardData(JSON.stringify(functionArgs));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[SGS] function call 武将数据无效，回退文本 JSON: ${errMsg}`);
    }
  }

  const raw = await llmClient.askLlm(
    "你是一名精通三国杀原创设计的卡牌策划。严格按用户要求输出 JSON。",
    `${userPrompt}\n\n函数调用不可用时，请直接输出符合上述结构的合法 JSON，不要代码块。`,
    { maxTokens: 8096, reasoningEffort: "high" },
  );

  try {
    return parseCardData(raw);
  } catch {
    const repaired = await llmClient.askLlm(
      "你是 JSON 修复器。",
      buildRepairPrompt(raw),
    );
    return parseCardData(repaired);
  }
}

async function validateSkills(
  llmAsk: SgsCardPluginDeps["llm"]["askLlm"],
  card: SgsCardData,
): Promise<SkillValidation> {
  try {
    const raw = await llmAsk("武将技能审核。", buildSkillValidationPrompt(card));
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { valid: true, issues: [], suggestions: [] };
    return JSON.parse(jsonMatch[0]) as SkillValidation;
  } catch {
    return { valid: true, issues: [], suggestions: [] };
  }
}

async function repairSkills(
  llmClient: SgsCardPluginDeps["llm"],
  card: SgsCardData,
  validation: SkillValidation,
): Promise<SgsCardData> {
  const repairPrompt = buildSkillRepairPrompt(card, validation);
  const functionArgs = await llmClient.askLlmWithFunction(
    "你是一名三国杀原创武将设计师。必须通过指定函数提交修复后的完整武将牌数据。",
    `${repairPrompt}\n\n请调用 create_sgs_card 函数提交修复结果，不要直接输出正文。`,
    CREATE_SGS_CARD_FUNCTION,
  );
  if (functionArgs) {
    try {
      return parseCardData(JSON.stringify(functionArgs));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[SGS] function call 修复数据无效，回退文本 JSON: ${errMsg}`);
    }
  }

  const raw = await llmClient.askLlm("重新设计技能。", repairPrompt);
  try {
    return parseCardData(raw);
  } catch {
    return card;
  }
}

async function tuneSkillDescriptions(
  llmClient: SgsCardPluginDeps["llm"],
  card: SgsCardData,
  userInstruction: string,
): Promise<{ card: SgsCardData; aiOpinion: string }> {
  const tunePrompt = buildSkillTunePrompt(card, userInstruction);
  const functionArgs = await llmClient.askLlmWithFunction(
    "你是一名三国杀技能微调策划。必须通过指定函数提交微调后的技能描述。",
    `${tunePrompt}\n\n请调用 tune_sgs_skill_descriptions 函数提交结果，不要直接输出正文。`,
    TUNE_SGS_SKILLS_FUNCTION,
    { maxTokens: 4096, reasoningEffort: "medium" },
  );

  if (!functionArgs || !Array.isArray(functionArgs.skills)) {
    throw new Error("AI 未返回有效的技能微调结果。");
  }

  const nextSkills = card.skills.map((skill) => ({ ...skill }));
  let changed = false;

  for (const item of functionArgs.skills) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const index = Number(raw.index);
    if (!Number.isInteger(index) || index < 1 || index > nextSkills.length) continue;
    const desc = clipText(raw.desc, 112);
    if (!desc) continue;
    nextSkills[index - 1] = { ...nextSkills[index - 1], desc };
    changed = true;
  }

  if (!changed) {
    throw new Error("AI 未提供可应用的技能描述调整。");
  }

  return {
    card: {
      ...card,
      skills: nextSkills,
    },
    aiOpinion: clipText(functionArgs.aiOpinion, 120) || "已按用户意见微调技能描述，并保留原武将结构。",
  };
}

export function createSgsCardPlugin(deps: SgsCardPluginDeps): Plugin {
  const { llm, menu, getUserFacts } = deps;
  let liveCtx: PluginContext | null = null;
  let store: CardStore | null = null;

  return {
    name: "sgs-card",
    description: "基于群名片生成三国杀风格武将牌",
    async onLoad(ctx) {
      liveCtx = ctx;
      const settings = ctx.config.pluginSettings.sgsCard;
      const outputDir = path.resolve(process.cwd(), settings.outputDir);
      store = new CardStore(outputDir);
      const commandBase = settings.commandPrefix.trim().toLowerCase();

      menu.registerCommandGroup(commandBase, "SGS 卡牌", "基于群名片生成三国杀风格武将牌");

      menu.registerCommand(
        commandBase,
        `生成武将牌：${menu.getPrefix()}${commandBase} [QQ号|@用户]`,
        async (message, args) => {
          if (!liveCtx || !store) throw new Error("插件上下文未就绪。");

          const targetUserId = parseTargetUserIdArg(args, message);
          const userId = message.userId || "";
          const effectiveUserId = targetUserId || userId;

          if (store.has(effectiveUserId)) {
            const existing = store.get(effectiveUserId)!;
            await liveCtx.replyText(
              message,
              `该用户已有武将牌（${existing.data.name} · ${existing.data.faction}）。\n` +
              `如需重新生成，请使用 ${menu.getPrefix()}${commandBase}-regen${targetUserId ? ` ${targetUserId}` : ""}`,
            );
            return;
          }

          await doGenerate(liveCtx, store, llm, message, args, getUserFacts);
        },
        { group: commandBase, aliases: [`${commandBase}-card`] },
      );

      menu.registerCommand(
        `${commandBase}-regen`,
        `重新生成武将牌：${menu.getPrefix()}${commandBase}-regen [QQ号|@用户]`,
        async (message, args) => {
          if (!liveCtx || !store) throw new Error("插件上下文未就绪。");
          await doGenerate(liveCtx, store, llm, message, args, getUserFacts);
        },
        { group: commandBase },
      );

      menu.registerCommand(
        `${commandBase}-show`,
        `查看武将牌：${menu.getPrefix()}${commandBase}-show [QQ号|@用户]`,
        async (message, args) => {
          if (!liveCtx || !store) throw new Error("插件上下文未就绪。");

          const targetUserId = parseTargetUserIdArg(args, message);
          const userId = message.userId || "";
          const effectiveUserId = targetUserId || userId;

          const stored = store.get(effectiveUserId);
          if (!stored) {
            await liveCtx.replyText(message, "该用户还没有武将牌，先使用生成命令创建一张吧。");
            return;
          }

           const card = stored.data;
          const target = getTarget(message);

          // Always refresh avatar and re-render on show
          const settings2 = liveCtx.config.pluginSettings.sgsCard;
          const outputDir2 = path.resolve(process.cwd(), settings2.outputDir);
          card.artImage = await fetchAvatarDataUri(effectiveUserId);
          const newPath = await renderSgsCardImage({
            outputDir: outputDir2,
            data: card,
            fileStem: sanitizeStem(`${card.name}-show-${Date.now()}`),
          });
          store.set(effectiveUserId, { ...stored, imagePath: newPath });
          const summary = [
            `角色：${card.name} · ${card.title} · ${card.faction}`,
            `数值：${card.hp}/${card.maxHp}${card.armor > 0 ? ` · 护甲 ${card.armor}` : ""}`,
            `技能：${card.skills.map((s) => displaySkillName(s.name)).join("、")}`,
          ].join("\n");
          await liveCtx.sendImage(target, newPath, summary);
        },
        { group: commandBase },
      );

      menu.registerCommand(
        `${commandBase}-story`,
        `查看武将故事：${menu.getPrefix()}${commandBase}-story [QQ号|@用户]`,
        async (message, args) => {
          if (!liveCtx || !store) throw new Error("插件上下文未就绪。");

          const targetUserId = parseTargetUserIdArg(args, message);
          const userId = message.userId || "";
          const effectiveUserId = targetUserId || userId;

          const stored = store.get(effectiveUserId);
          if (!stored) {
            await liveCtx.replyText(message, "该用户还没有武将牌，先使用生成命令创建一张吧。");
            return;
          }

          const card = stored.data;
          const target = getTarget(message);
          const settings2 = liveCtx.config.pluginSettings.sgsCard;
          const outputDir2 = path.resolve(process.cwd(), settings2.outputDir);
          card.artImage = await fetchAvatarDataUri(effectiveUserId);
          const storyPath = await renderSgsStoryImage({
            outputDir: outputDir2,
            data: card,
            fileStem: sanitizeStem(`${card.name}-story-${Date.now()}`),
          });
          store.set(effectiveUserId, { ...stored, data: card, imagePath: stored.imagePath });

          const summary = [
            `武将故事：${card.name} · ${card.title} · ${card.faction}`,
            `名言：${card.flavor}`,
          ].join("\n");
          await liveCtx.sendImage(target, storyPath, summary);
        },
        { group: commandBase, aliases: [`${commandBase}-lore`] },
      );

      menu.registerCommand(
        `${commandBase}-tune`,
        `微调技能描述：${menu.getPrefix()}${commandBase}-tune [QQ号|@用户] <微调意见>`,
        async (message, args) => {
          if (!liveCtx || !store) throw new Error("插件上下文未就绪。");

          const userInstruction = extractTuneInstruction(args, message);
          if (!userInstruction) {
            await liveCtx.replyText(
              message,
              `请提供微调意见，例如：${menu.getPrefix()}${commandBase}-tune @用户 强化回合外防御，但不要增加爆发。`,
            );
            return;
          }

          const targetUserId = parseTargetUserIdArg(args, message);
          const userId = message.userId || "";
          const effectiveUserId = targetUserId || userId;
          const stored = store.get(effectiveUserId);
          if (!stored) {
            await liveCtx.replyText(message, "该用户还没有武将牌，先使用生成命令创建一张吧。");
            return;
          }

          await liveCtx.replyText(message, "正在按你的意见微调技能描述...");

          const tuned = await tuneSkillDescriptions(llm, stored.data, userInstruction);
          const card = tuned.card;
          const target = getTarget(message);
          const settings2 = liveCtx.config.pluginSettings.sgsCard;
          const outputDir2 = path.resolve(process.cwd(), settings2.outputDir);
          card.artImage = await fetchAvatarDataUri(effectiveUserId);
          const imagePath = await renderSgsCardImage({
            outputDir: outputDir2,
            data: card,
            fileStem: sanitizeStem(`${card.name}-tune-${effectiveUserId}-${Date.now()}`),
          });

          store.set(effectiveUserId, {
            ...stored,
            data: card,
            imagePath,
          });

          const summary = [
            `技能已微调：${card.name} · ${card.title} · ${card.faction}`,
            `用户意见：${userInstruction}`,
            `AI意见：${tuned.aiOpinion}`,
            `技能：${card.skills.map((s) => displaySkillName(s.name)).join("、")}`,
          ].join("\n");
          await liveCtx.sendImage(target, imagePath, summary);
        },
        { group: commandBase, aliases: [`${commandBase}-adjust`] },
      );

      menu.registerCommand(
        `${commandBase}-help`,
        `查看使用说明：${menu.getPrefix()}${commandBase}-help`,
        async (message) => {
          if (!liveCtx) throw new Error("插件上下文未就绪。");
          await liveCtx.replyText(
            message,
            [
              "SGS 卡牌用法：",
              `1. ${menu.getPrefix()}${commandBase} —— 基于自己的群名片生成武将牌`,
              `2. ${menu.getPrefix()}${commandBase} [QQ号|@用户] —— 为指定用户生成`,
              `3. ${menu.getPrefix()}${commandBase}-show [QQ号|@用户] —— 查看武将牌`,
              `4. ${menu.getPrefix()}${commandBase}-story [QQ号|@用户] —— 查看武将故事图片`,
              `5. ${menu.getPrefix()}${commandBase}-tune [QQ号|@用户] <微调意见> —— 只微调技能描述`,
              `6. ${menu.getPrefix()}${commandBase}-regen [QQ号|@用户] —— 强制重新生成`,
              "注意：每人限一张，需重新生成请使用 regen 命令。",
            ].join("\n"),
          );
        },
        { group: commandBase },
      );
    },
  };
}

async function doGenerate(
  ctx: PluginContext,
  store: CardStore,
  llmClient: SgsCardPluginDeps["llm"],
  message: BotMessage,
  args: string[],
  getUserFacts?: (userId: string) => Promise<string[]>,
) {
  const target = getTarget(message);
  const userId = message.userId || "";

  await ctx.replyText(message, "正在读取群名片并设计武将...");

  try {
    const character = await resolveCharacterName(ctx, llmClient.askLlm.bind(llmClient), userId, message, args);

    await ctx.replyText(
      message,
      `角色：${character.name}\n势力由 AI 判定\n正在设计技能与背景故事...`,
    );

    // Fetch user memory facts to personalize card design
    const targetUserId = parseTargetUserIdArg(args, message) || userId;
    const userFacts = getUserFacts ? await getUserFacts(targetUserId) : [];

    let card = anchorCardName(
      await generateCardData(llmClient, character.name, character.desc, userFacts),
      character.name,
    );

    await ctx.replyText(message, "正在审核技能设计...");

    const validation = await validateSkills(llmClient.askLlm.bind(llmClient), card);
    if (!validation.valid && (validation.issues.length > 0 || validation.suggestions.length > 0)) {
      await ctx.replyText(
        message,
        `审核建议：${validation.suggestions.join("；")}\n正在优化...`,
      );
      card = anchorCardName(await repairSkills(llmClient, card, validation), character.name);
    }

    // Fetch QQ avatar for card artwork
    await ctx.replyText(message, "正在获取头像...");
    card.artImage = await fetchAvatarDataUri(targetUserId);

    const settings = ctx.config.pluginSettings.sgsCard;
    const outputDir = path.resolve(process.cwd(), settings.outputDir);
    const imagePath = await renderSgsCardImage({
      outputDir,
      data: card,
      fileStem: sanitizeStem(`${card.name}-${targetUserId}`),
    });

    store.set(targetUserId, {
      userId: targetUserId,
      data: card,
      imagePath,
      createdAt: Date.now(),
    });

    const summary = [
      `角色：${card.name} · ${card.title} · ${card.faction}`,
      `数值：${card.hp}/${card.maxHp}${card.armor > 0 ? ` · 护甲 ${card.armor}` : ""}`,
      `技能：${card.skills.map((s) => displaySkillName(s.name)).join("、")}`,
    ].join("\n");

    await ctx.sendImage(target, imagePath, summary);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await ctx.replyText(message, `武将牌生成失败：${errMsg}`);
  }
}
