import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BotMessage, ImgGenPlugin, MenuPlugin, OneBotMessageSegment, PluginContext } from "../types.js";
import type { OneBotClient } from "../onebot.js";
import {
  editAndSaveImage,
  editAndSaveImageNewApi,
  generateAndSaveImage,
  generateAndSaveImageNewApi,
  type ImageGenConfig,
  type ImageGenNewApiConfig,
} from "./mmorpg/image-gen-client.js";
import { convertImageToWebp } from "./mmorpg/screenshot.js";

const execFileAsync = promisify(execFile);
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp|gif|avif)$/i;
const HARD_EDGE_PROMPT_RE = /(文字|文本|字体|字样|logo|徽标|标志|海报|招牌|包装|封面|标题|图标|icon|logo|typography|text|poster|sign|label|ui|界面|按钮|watermark|meme)/i;
const MEDIA_PLACEHOLDER_RE = /\[[^\]\n]*\s+file=[^\]]+\]/g;

type ResolvedImageSource = {
  filePath: string;
  displayName: string;
  cleanupAfterUse: boolean;
};

type ImgGenRuntimeConfig = PluginContext["config"]["pluginSettings"]["imgGen"];

function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "image";
}

function isSupportedImageName(value: string): boolean {
  return IMAGE_EXT_RE.test(value.split("?")[0].split("#")[0]);
}

function normalizeExt(value: string, fallback = ".png"): string {
  const ext = path.extname(value.split("?")[0].split("#")[0]).toLowerCase();
  return IMAGE_EXT_RE.test(ext) ? ext : fallback;
}

function buildTarget(message: BotMessage) {
  return message.type === "group"
    ? { type: "group" as const, id: message.groupId! }
    : { type: "private" as const, id: message.userId! };
}

function stripMediaPlaceholders(text: string): string {
  return text.replace(MEDIA_PLACEHOLDER_RE, " ").replace(/\s+/g, " ").trim();
}

function getSegments(message: BotMessage): OneBotMessageSegment[] {
  return Array.isArray(message.raw.message) ? message.raw.message : [];
}

async function downloadImageToTemp(url: string, outputDir: string, preferredName?: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载图片失败：HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = normalizeExt(preferredName || url);
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `imgedit-${Date.now()}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function resolveFileSegmentPath(
  segment: OneBotMessageSegment,
  outputDir: string,
): Promise<ResolvedImageSource | null> {
  const data = segment.data;
  const name = typeof data.name === "string" ? data.name : "";
  const localPathCandidates = [
    typeof data.path === "string" ? data.path : "",
    typeof data.file === "string" ? data.file : "",
  ].filter(Boolean);

  for (const candidate of localPathCandidates) {
    if (!isSupportedImageName(candidate) && !isSupportedImageName(name)) continue;
    if (fs.existsSync(candidate)) {
      return {
        filePath: candidate,
        displayName: safeFileName(name || path.basename(candidate)),
        cleanupAfterUse: false,
      };
    }
  }

  const url = typeof data.url === "string" ? data.url : "";
  if (url && (isSupportedImageName(url) || isSupportedImageName(name))) {
    const filePath = await downloadImageToTemp(url, outputDir, name || url);
    return {
      filePath,
      displayName: safeFileName(name || path.basename(filePath)),
      cleanupAfterUse: true,
    };
  }

  return null;
}

async function resolveImageFromSegments(
  segments: OneBotMessageSegment[],
  ctx: PluginContext,
  outputDir: string,
): Promise<ResolvedImageSource | null> {
  for (const segment of segments) {
    if (segment.type === "image") {
      const fileId = typeof segment.data.file === "string" ? segment.data.file : "";
      if (!fileId) continue;
      const filePath = await ctx.getImageFilePath(fileId);
      if (!filePath) continue;
      return {
        filePath,
        displayName: safeFileName(path.basename(filePath)),
        cleanupAfterUse: false,
      };
    }

    if (segment.type === "file") {
      const resolved = await resolveFileSegmentPath(segment, outputDir);
      if (resolved) return resolved;
    }
  }

  return null;
}

async function resolveEditableImage(
  message: BotMessage,
  ctx: PluginContext,
  onebot: OneBotClient,
  outputDir: string,
): Promise<ResolvedImageSource | null> {
  const direct = await resolveImageFromSegments(getSegments(message), ctx, outputDir);
  if (direct) return direct;

  if (message.replyToMessageId) {
    const replied = await onebot.getMessage(message.replyToMessageId);
    if (replied) {
      const fromReply = await resolveImageFromSegments(getSegments(replied), ctx, outputDir);
      if (fromReply) return fromReply;
    }
  }

  return null;
}

function getSynthIdBinaryPath(): string | null {
  const dir = path.join(process.cwd(), "scripts", "synthid-remove");
  const exe = process.platform === "win32" ? "synthid-remove.exe" : "synthid-remove";
  const binaryPath = path.join(dir, exe);
  return fs.existsSync(binaryPath) ? binaryPath : null;
}

async function removeSynthID(inputPath: string, strength: string): Promise<string> {
  const binaryPath = getSynthIdBinaryPath();
  if (!binaryPath) {
    console.warn("[ImgGen] synthid-remove 二进制未找到，跳过 SynthID 去除。请编译 scripts/synthid-remove/");
    return inputPath;
  }

  const outputPath = inputPath.replace(/\.(png|jpe?g|webp)$/i, "_clean.png");
  try {
    const { stdout } = await execFileAsync(
      binaryPath,
      ["-i", inputPath, "-o", outputPath, "-s", strength],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    const result = JSON.parse(stdout.trim());
    console.log(`[ImgGen] SynthID 去除完成: PSNR=${result.psnr}dB, stages=${result.stages?.join(",") ?? "none"}`);
    return outputPath;
  } catch (error) {
    console.error("[ImgGen] SynthID 去除失败，使用原图:", error);
    return inputPath;
  }
}

function getRealESRGANPath(): string | null {
  const dir = path.join(process.cwd(), "scripts", "realesrgan");
  const exe = process.platform === "win32" ? "realesrgan-ncnn-vulkan.exe" : "realesrgan-ncnn-vulkan";
  const binaryPath = path.join(dir, exe);
  return fs.existsSync(binaryPath) ? binaryPath : null;
}

async function superResolve(
  inputPath: string,
  model: string,
  scale: number,
  denoise: number,
): Promise<string> {
  const binaryPath = getRealESRGANPath();
  if (!binaryPath) {
    console.warn("[ImgGen] realesrgan-ncnn-vulkan 未找到，跳过超分。请安装 scripts/realesrgan/");
    return inputPath;
  }

  const outputPath = inputPath.replace(/\.(png|jpe?g|webp)$/i, "_sr.png");
  const args = ["-i", inputPath, "-o", outputPath, "-n", model, "-s", String(scale)];
  if (denoise > 0) {
    args.push("-d", String(denoise));
  }

  try {
    const startTime = Date.now();
    await execFileAsync(binaryPath, args, {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ImgGen] 超分完成: ${model} ${scale}x, 耗时 ${elapsed}s`);
    return outputPath;
  } catch (error) {
    console.error("[ImgGen] 超分失败，使用原图:", error);
    return inputPath;
  }
}

async function safeUpscaleWithBrowser(
  ctx: PluginContext,
  inputPath: string,
  scale: number,
): Promise<string> {
  const buffer = await fs.promises.readFile(inputPath);
  const ext = path.extname(inputPath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  const outputPath = inputPath.replace(/\.(png|jpe?g|webp)$/i, "_safeup.png");
  const page = await ctx.newPage();
  try {
    await page.setContent("<!DOCTYPE html><html><body></body></html>", { waitUntil: "load" });
    const imageBase64 = await page.evaluate(`(() => {
      const payload = ${JSON.stringify({ dataUrl, scale })};
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.naturalWidth * payload.scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * payload.scale));
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("canvas context unavailable"));
            return;
          }
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/png").split(",")[1]);
        };
        img.onerror = () => reject(new Error("image load failed"));
        img.src = payload.dataUrl;
      });
    })()`) as string;
    await fs.promises.writeFile(outputPath, Buffer.from(imageBase64, "base64"));
    console.log(`[ImgGen] 安全放大完成: ${scale}x`);
    return outputPath;
  } finally {
    await page.close();
  }
}

function shouldTreatAsHardEdge(prompt: string, cfg: ImgGenRuntimeConfig): boolean {
  if (!cfg.superResolution.enabled) return false;
  if (!cfg.superResolution.preserveTextAndLogo) return false;
  return HARD_EDGE_PROMPT_RE.test(prompt);
}

async function applyPostProcessing(
  ctx: PluginContext,
  cfg: ImgGenRuntimeConfig,
  prompt: string,
  filePath: string,
): Promise<string> {
  const hardEdge = shouldTreatAsHardEdge(prompt, cfg);

  if (cfg.synthIdRemoval.enabled && !hardEdge) {
    filePath = await removeSynthID(filePath, cfg.synthIdRemoval.strength);
  } else if (cfg.synthIdRemoval.enabled && hardEdge) {
    console.log("[ImgGen] 检测到文字/logo/UI 类提示词，跳过 SynthID 去除以保护硬边细节");
  }

  if (!cfg.superResolution.enabled) {
    return filePath;
  }

  const strategy = cfg.superResolution.strategy;
  const useSafeUpscale = strategy === "safe" || (strategy === "auto" && hardEdge);
  if (useSafeUpscale) {
    const safeScale = hardEdge ? cfg.superResolution.safeScale : cfg.superResolution.scale;
    return safeUpscaleWithBrowser(ctx, filePath, safeScale);
  }

  return superResolve(
    filePath,
    cfg.superResolution.model,
    cfg.superResolution.scale,
    cfg.superResolution.denoise,
  );
}

export function createImgGenPlugin(menuPlugin: MenuPlugin, onebot: OneBotClient): ImgGenPlugin {
  let ctxRef: PluginContext | null = null;

  function getApiConfig() {
    const cfg = ctxRef!.config.pluginSettings.imgGen;
    const useNewApi = !!(cfg.newApiBaseUrl && cfg.cookie);
    const useLegacy = !!(cfg.baseUrl && cfg.apiKey);
    return { cfg, useNewApi, useLegacy };
  }

  const plugin: ImgGenPlugin = {
    name: "imggen",
    description: "通用图片生成插件：提供 AI 生图、原图编辑和生成后处理能力",

    async onLoad(ctx) {
      ctxRef = ctx;

      menuPlugin.registerCommand(
        "imggen",
        "使用 AI 根据提示词生成图片",
        async (message, args) => {
          const prompt = stripMediaPlaceholders(args.join(" "));
          if (!prompt) {
            await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}imggen <提示词>\n示例：${menuPlugin.getPrefix()}imggen 一只穿着太空服的猫咪`);
            return;
          }

          const { useNewApi, useLegacy } = getApiConfig();
          if (!useNewApi && !useLegacy) {
            await ctx.replyText(message, "图片生成功能尚未配置。请在 pluginSettings.imgGen 中设置 API 信息。");
            return;
          }

          await ctx.replyText(message, "正在生成图片，请稍候…");

          try {
            const outputDir = path.join(process.cwd(), "data", "imggen");
            const fileName = `imggen_${message.userId ?? "unknown"}_${Date.now()}.png`;
            const result = await plugin.generateImageFile(prompt, outputDir, fileName);
            let finalPath = result.filePath;
            try {
              finalPath = await convertImageToWebp(result.filePath);
            } catch {
              // keep png
            }
            await ctx.sendImage(buildTarget(message), finalPath, "图片生成完成！");
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error("[ImgGen] 图片生成失败:", error);
            await ctx.replyText(message, `图片生成失败：${msg}`);
          }
        },
      );

      menuPlugin.registerCommand(
        "imgedit",
        `编辑原图：直接带图或回复图片后发送 ${menuPlugin.getPrefix()}imgedit <修改要求>`,
        async (message, args) => {
          const prompt = stripMediaPlaceholders(args.join(" "));
          if (!prompt) {
            await ctx.replyText(message, `用法：${menuPlugin.getPrefix()}imgedit <修改要求>\n示例：回复一张图后发送 ${menuPlugin.getPrefix()}imgedit 保留文字与logo，改成银白科技风背景`);
            return;
          }

          const { useNewApi, useLegacy } = getApiConfig();
          if (!useNewApi && !useLegacy) {
            await ctx.replyText(message, "图片编辑功能尚未配置。请在 pluginSettings.imgGen 中设置 API 信息。");
            return;
          }

          const outputDir = path.join(process.cwd(), "data", "imggen");
          const source = await resolveEditableImage(message, ctx, onebot, outputDir);
          if (!source) {
            await ctx.replyText(message, `未找到可编辑的原图。请直接随 ${menuPlugin.getPrefix()}imgedit 发送图片，或回复一张图片/图片型群文件消息后再发送命令。`);
            return;
          }

          await ctx.replyText(message, "正在编辑图片，请稍候…");

          try {
            const fileName = `imgedit_${message.userId ?? "unknown"}_${Date.now()}.png`;
            const result = await plugin.editImageFile(source.filePath, prompt, outputDir, fileName);
            let finalPath = result.filePath;
            try {
              finalPath = await convertImageToWebp(result.filePath);
            } catch {
              // keep png
            }
            await ctx.sendImage(buildTarget(message), finalPath, `图片编辑完成：${source.displayName}`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error("[ImgGen] 图片编辑失败:", error);
            await ctx.replyText(message, `图片编辑失败：${msg}`);
          } finally {
            if (source.cleanupAfterUse) {
              fs.unlink(source.filePath, () => {});
            }
          }
        },
      );

      console.log("[ImgGen] 图片生成插件已加载");
    },

    async generateImageFile(prompt, outputDir, fileName, options) {
      const { cfg, useNewApi } = getApiConfig();

      let filePath: string;
      let generatedAt: string;

      if (useNewApi) {
        const newApiConfig: ImageGenNewApiConfig = {
          baseUrl: cfg.newApiBaseUrl,
          cookie: cfg.cookie,
        };
        const result = await generateAndSaveImageNewApi(
          newApiConfig,
          prompt,
          outputDir,
          fileName,
          { size: options?.size ?? "auto" },
        );
        filePath = result.filePath;
        generatedAt = result.created ? new Date(result.created * 1000).toISOString() : new Date().toISOString();
      } else {
        const imageGenConfig: ImageGenConfig = {
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
        };
        filePath = await generateAndSaveImage(
          imageGenConfig,
          prompt,
          outputDir,
          fileName,
          { size: options?.size ?? "1024x1024", quality: options?.quality ?? "high" },
        );
        generatedAt = new Date().toISOString();
      }

      filePath = await applyPostProcessing(ctxRef!, cfg, prompt, filePath);
      return { filePath, generatedAt };
    },

    async editImageFile(inputPath, prompt, outputDir, fileName, options) {
      const { cfg, useNewApi, useLegacy } = getApiConfig();

      let filePath: string | null = null;
      let generatedAt: string | null = null;
      let newApiError: unknown = null;

      if (useNewApi) {
        try {
          const result = await editAndSaveImageNewApi(
            {
              baseUrl: cfg.newApiBaseUrl,
              cookie: cfg.cookie,
            },
            prompt,
            inputPath,
            outputDir,
            fileName,
            {
              size: options?.size ?? "auto",
              editPath: cfg.newApiEditPath,
              outputFormat: "png",
              moderation: "auto",
            },
          );
          filePath = result.filePath;
          generatedAt = result.created ? new Date(result.created * 1000).toISOString() : new Date().toISOString();
        } catch (error) {
          newApiError = error;
          console.warn("[ImgGen] NewApi 图片编辑失败，准备尝试兼容编辑端点:", error);
        }
      }

      if (!filePath && useLegacy) {
        const legacyResultPath = await editAndSaveImage(
          {
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            model: cfg.model,
          },
          prompt,
          inputPath,
          outputDir,
          fileName,
          {
            size: options?.size ?? "1024x1024",
            quality: options?.quality ?? "high",
            editPath: cfg.legacyEditPath,
          },
        );
        filePath = legacyResultPath;
        generatedAt = new Date().toISOString();
      }

      if (!filePath || !generatedAt) {
        if (newApiError) {
          throw new Error(`当前后端未成功提供图片编辑端点。NewApi 错误：${newApiError instanceof Error ? newApiError.message : String(newApiError)}`);
        }
        throw new Error("当前配置未启用可用的图片编辑后端。");
      }

      filePath = await applyPostProcessing(ctxRef!, cfg, prompt, filePath);
      return { filePath, generatedAt };
    },
  };

  return plugin;
}
