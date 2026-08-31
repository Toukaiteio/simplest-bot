import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BotMessage, MenuPlugin, OneBotMessageSegment, Plugin, PluginContext } from "../../types.js";
import type { OneBotClient } from "../../onebot.js";

type FftImagePluginOptions = {
  outputDir: string;
  cacheDir: string;
  maxTransformSize: number;
  renderScale: number;
  resultCleanupDelayMs: number;
  cacheRetentionHours: number;
};

type ResolvedImageSource = {
  filePath: string;
  displayName: string;
  cleanupAfterUse: boolean;
  fromReply: boolean;
  sourceKind: "image" | "file";
};

type CachedSpectrumRecord = {
  token: string;
  createdAt: number;
  sourceName: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  real: number[];
  imag: number[];
};

type BrowserForwardResult = {
  imageBase64: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  real: number[];
  imag: number[];
};

type BrowserInverseResult = {
  imageBase64: string;
  width: number;
  height: number;
};

const DEFAULT_OPTIONS: FftImagePluginOptions = {
  outputDir: "data/fft-images",
  cacheDir: "data/fft-cache",
  maxTransformSize: 256,
  renderScale: 1.5,
  resultCleanupDelayMs: 120_000,
  cacheRetentionHours: 72,
};

const TOKEN_RE = /\[FFT:([a-z0-9-]+)\]/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp|gif|avif)$/i;

const FORWARD_TRANSFORM_SCRIPT = String.raw`
async function runFftForward(args) {
  const renderScale = Math.max(1, Number(args.renderScale) || 1);
  function floorPowerOfTwo(value) {
    let result = 1;
    while (result * 2 <= value) result *= 2;
    return result;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("image load failed"));
      image.src = src;
    });
  }

  function fft1d(real, imag, inverse) {
    const n = real.length;
    let j = 0;
    for (let i = 1; i < n; i++) {
      let bit = n >> 1;
      while (j & bit) {
        j ^= bit;
        bit >>= 1;
      }
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const angle = (inverse ? 2 : -2) * Math.PI / len;
      const wLenCos = Math.cos(angle);
      const wLenSin = Math.sin(angle);
      for (let start = 0; start < n; start += len) {
        let wCos = 1;
        let wSin = 0;
        for (let offset = 0; offset < len / 2; offset++) {
          const evenIndex = start + offset;
          const oddIndex = evenIndex + len / 2;
          const oddReal = real[oddIndex] * wCos - imag[oddIndex] * wSin;
          const oddImag = real[oddIndex] * wSin + imag[oddIndex] * wCos;

          real[oddIndex] = real[evenIndex] - oddReal;
          imag[oddIndex] = imag[evenIndex] - oddImag;
          real[evenIndex] += oddReal;
          imag[evenIndex] += oddImag;

          const nextCos = wCos * wLenCos - wSin * wLenSin;
          wSin = wCos * wLenSin + wSin * wLenCos;
          wCos = nextCos;
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < n; i++) {
        real[i] /= n;
        imag[i] /= n;
      }
    }
  }

  function fft2d(real, imag, width, height) {
    for (let y = 0; y < height; y++) {
      const rowReal = new Float64Array(width);
      const rowImag = new Float64Array(width);
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        rowReal[x] = real[idx];
        rowImag[x] = imag[idx];
      }
      fft1d(rowReal, rowImag, false);
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        real[idx] = rowReal[x];
        imag[idx] = rowImag[x];
      }
    }

    for (let x = 0; x < width; x++) {
      const colReal = new Float64Array(height);
      const colImag = new Float64Array(height);
      for (let y = 0; y < height; y++) {
        const idx = y * width + x;
        colReal[y] = real[idx];
        colImag[y] = imag[idx];
      }
      fft1d(colReal, colImag, false);
      for (let y = 0; y < height; y++) {
        const idx = y * width + x;
        real[idx] = colReal[y];
        imag[idx] = colImag[y];
      }
    }
  }

  function samplePalette(t) {
    const stops = [
      { t: 0.0, c: [8, 11, 16] },
      { t: 0.16, c: [18, 31, 46] },
      { t: 0.38, c: [28, 74, 102] },
      { t: 0.62, c: [72, 151, 188] },
      { t: 0.82, c: [177, 225, 233] },
      { t: 1.0, c: [246, 248, 251] },
    ];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i].t) {
        const prev = stops[i - 1];
        const next = stops[i];
        const local = (t - prev.t) / (next.t - prev.t || 1);
        return [
          Math.round(prev.c[0] + (next.c[0] - prev.c[0]) * local),
          Math.round(prev.c[1] + (next.c[1] - prev.c[1]) * local),
          Math.round(prev.c[2] + (next.c[2] - prev.c[2]) * local),
        ];
      }
    }
    return stops[stops.length - 1].c.slice();
  }

  const image = await loadImage(args.imageSrc);
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const scale = Math.min(1, args.maxSize / Math.max(sourceWidth, sourceHeight));
  const scaledWidth = Math.max(32, Math.round(sourceWidth * scale));
  const scaledHeight = Math.max(32, Math.round(sourceHeight * scale));
  const width = Math.max(32, floorPowerOfTwo(scaledWidth));
  const height = Math.max(32, floorPowerOfTwo(scaledHeight));

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceCtx = sourceCanvas.getContext("2d");
  if (!sourceCtx) throw new Error("canvas context unavailable");
  sourceCtx.drawImage(image, 0, 0, width, height);
  const imageData = sourceCtx.getImageData(0, 0, width, height);
  const pixels = imageData.data;

  const real = new Float64Array(width * height);
  const imag = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    real[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    imag[i] = 0;
  }

  fft2d(real, imag, width, height);

  const shiftedMagnitude = new Float64Array(width * height);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIndex = y * width + x;
      const shiftedX = (x + width / 2) % width;
      const shiftedY = (y + height / 2) % height;
      const dstIndex = shiftedY * width + shiftedX;
      const magnitude = Math.log1p(Math.hypot(real[srcIndex], imag[srcIndex]));
      shiftedMagnitude[dstIndex] = magnitude;
      if (magnitude < min) min = magnitude;
      if (magnitude > max) max = magnitude;
    }
  }

  const renderCanvas = document.createElement("canvas");
  renderCanvas.width = width;
  renderCanvas.height = height;
  const renderCtx = renderCanvas.getContext("2d");
  if (!renderCtx) throw new Error("render context unavailable");
  const output = renderCtx.createImageData(width, height);
  const range = Math.max(max - min, 1e-6);
  for (let i = 0; i < shiftedMagnitude.length; i++) {
    const normalized = Math.max(0, Math.min(1, (shiftedMagnitude[i] - min) / range));
    const boosted = Math.pow(normalized, 0.78);
    const color = samplePalette(boosted);
    output.data[i * 4] = color[0];
    output.data[i * 4 + 1] = color[1];
    output.data[i * 4 + 2] = color[2];
    output.data[i * 4 + 3] = 255;
  }
  renderCtx.putImageData(output, 0, 0);

  const panelPadding = 44;
  const sideInfoWidth = 112;
  const panelWidth = width + panelPadding * 2 + sideInfoWidth;
  const panelHeight = height + panelPadding * 2;
  const cardCanvas = document.createElement("canvas");
  cardCanvas.width = Math.round(panelWidth * renderScale);
  cardCanvas.height = Math.round(panelHeight * renderScale);
  const cardCtx = cardCanvas.getContext("2d");
  if (!cardCtx) throw new Error("card context unavailable");
  cardCtx.scale(renderScale, renderScale);

  const background = cardCtx.createLinearGradient(0, 0, panelWidth, panelHeight);
  background.addColorStop(0, "#070a0f");
  background.addColorStop(0.56, "#0b121b");
  background.addColorStop(1, "#111c28");
  cardCtx.fillStyle = background;
  cardCtx.fillRect(0, 0, panelWidth, panelHeight);

  const haze = cardCtx.createRadialGradient(panelPadding + width / 2, panelPadding + height / 2, 8, panelPadding + width / 2, panelPadding + height / 2, Math.max(width, height) * 0.85);
  haze.addColorStop(0, "rgba(132, 208, 227, 0.18)");
  haze.addColorStop(1, "rgba(132, 208, 227, 0)");
  cardCtx.fillStyle = haze;
  cardCtx.fillRect(0, 0, panelWidth, panelHeight);

  const panelX = panelPadding;
  const panelY = panelPadding;
  cardCtx.fillStyle = "#09111a";
  cardCtx.fillRect(panelX - 12, panelY - 12, width + 24, height + 24);
  cardCtx.strokeStyle = "rgba(148, 223, 240, 0.32)";
  cardCtx.lineWidth = 1;
  cardCtx.strokeRect(panelX - 12.5, panelY - 12.5, width + 25, height + 25);

  cardCtx.drawImage(renderCanvas, panelX, panelY);

  cardCtx.save();
  cardCtx.strokeStyle = "rgba(196, 233, 244, 0.12)";
  cardCtx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const x = panelX + (width / 4) * i;
    const y = panelY + (height / 4) * i;
    cardCtx.beginPath();
    cardCtx.moveTo(x + 0.5, panelY);
    cardCtx.lineTo(x + 0.5, panelY + height);
    cardCtx.stroke();
    cardCtx.beginPath();
    cardCtx.moveTo(panelX, y + 0.5);
    cardCtx.lineTo(panelX + width, y + 0.5);
    cardCtx.stroke();
  }
  cardCtx.strokeStyle = "rgba(244, 248, 251, 0.22)";
  cardCtx.beginPath();
  cardCtx.moveTo(panelX + width / 2 + 0.5, panelY);
  cardCtx.lineTo(panelX + width / 2 + 0.5, panelY + height);
  cardCtx.stroke();
  cardCtx.beginPath();
  cardCtx.moveTo(panelX, panelY + height / 2 + 0.5);
  cardCtx.lineTo(panelX + width, panelY + height / 2 + 0.5);
  cardCtx.stroke();
  cardCtx.restore();

  cardCtx.fillStyle = "rgba(240, 247, 251, 0.92)";
  cardCtx.font = "600 15px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
  cardCtx.fillText("Fourier Spectrum", panelX, 24);
  cardCtx.fillStyle = "rgba(150, 178, 196, 0.82)";
  cardCtx.font = "12px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
  cardCtx.fillText("center-shifted magnitude", panelX, 40);

  cardCtx.save();
  cardCtx.translate(panelX + width + 34, panelY + 4);
  cardCtx.fillStyle = "rgba(238, 244, 248, 0.9)";
  cardCtx.font = "600 13px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
  cardCtx.fillText("Domain", 0, 0);
  cardCtx.fillStyle = "rgba(144, 171, 187, 0.84)";
  cardCtx.font = "12px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
  cardCtx.fillText("frequency", 0, 24);
  cardCtx.fillText(width + " × " + height, 0, 48);
  cardCtx.fillStyle = "rgba(109, 214, 232, 0.92)";
  cardCtx.fillRect(0, 68, 44, 2);
  cardCtx.fillStyle = "rgba(180, 202, 214, 0.76)";
  cardCtx.fillText("DC centered", 0, 88);
  cardCtx.fillText("low → high", 0, 112);
  cardCtx.restore();

  cardCtx.fillStyle = "rgba(140, 168, 182, 0.72)";
  cardCtx.font = "11px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
  cardCtx.fillText("-fx", panelX - 8, panelY + height / 2 - 8);
  cardCtx.fillText("+fx", panelX + width - 18, panelY + height / 2 - 8);
  cardCtx.fillText("+fy", panelX + width / 2 - 8, panelY + 14);
  cardCtx.fillText("-fy", panelX + width / 2 - 8, panelY + height + 22);

  return {
    imageBase64: cardCanvas.toDataURL("image/png").split(",")[1],
    width: panelWidth,
    height: panelHeight,
    sourceWidth,
    sourceHeight,
    real: Array.from(real),
    imag: Array.from(imag),
  };
}
`;

const INVERSE_TRANSFORM_SCRIPT = String.raw`
async function runFftInverse(payload) {
  const renderScale = Math.max(1, Number(payload.renderScale) || 1);
  function fft1d(real, imag, inverse) {
    const n = real.length;
    let j = 0;
    for (let i = 1; i < n; i++) {
      let bit = n >> 1;
      while (j & bit) {
        j ^= bit;
        bit >>= 1;
      }
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const angle = (inverse ? 2 : -2) * Math.PI / len;
      const wLenCos = Math.cos(angle);
      const wLenSin = Math.sin(angle);
      for (let start = 0; start < n; start += len) {
        let wCos = 1;
        let wSin = 0;
        for (let offset = 0; offset < len / 2; offset++) {
          const evenIndex = start + offset;
          const oddIndex = evenIndex + len / 2;
          const oddReal = real[oddIndex] * wCos - imag[oddIndex] * wSin;
          const oddImag = real[oddIndex] * wSin + imag[oddIndex] * wCos;

          real[oddIndex] = real[evenIndex] - oddReal;
          imag[oddIndex] = imag[evenIndex] - oddImag;
          real[evenIndex] += oddReal;
          imag[evenIndex] += oddImag;

          const nextCos = wCos * wLenCos - wSin * wLenSin;
          wSin = wCos * wLenSin + wSin * wLenCos;
          wCos = nextCos;
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < n; i++) {
        real[i] /= n;
        imag[i] /= n;
      }
    }
  }

  function ifft2d(real, imag, width, height) {
    for (let y = 0; y < height; y++) {
      const rowReal = new Float64Array(width);
      const rowImag = new Float64Array(width);
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        rowReal[x] = real[idx];
        rowImag[x] = imag[idx];
      }
      fft1d(rowReal, rowImag, true);
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        real[idx] = rowReal[x];
        imag[idx] = rowImag[x];
      }
    }

    for (let x = 0; x < width; x++) {
      const colReal = new Float64Array(height);
      const colImag = new Float64Array(height);
      for (let y = 0; y < height; y++) {
        const idx = y * width + x;
        colReal[y] = real[idx];
        colImag[y] = imag[idx];
      }
      fft1d(colReal, colImag, true);
      for (let y = 0; y < height; y++) {
        const idx = y * width + x;
        real[idx] = colReal[y];
        imag[idx] = colImag[y];
      }
    }
  }

  const width = payload.width;
  const height = payload.height;
  const real = Float64Array.from(payload.real);
  const imag = Float64Array.from(payload.imag);

  ifft2d(real, imag, width, height);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context unavailable");
  const imageData = ctx.createImageData(width, height);
  for (let i = 0; i < real.length; i++) {
    const value = Math.max(0, Math.min(255, Math.round(real[i])));
    imageData.data[i * 4] = value;
    imageData.data[i * 4 + 1] = value;
    imageData.data[i * 4 + 2] = value;
    imageData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);

  const framePadding = 30;
  const cardCanvas = document.createElement("canvas");
  cardCanvas.width = Math.round((width + framePadding * 2) * renderScale);
  cardCanvas.height = Math.round((height + framePadding * 2 + 18) * renderScale);
  const cardCtx = cardCanvas.getContext("2d");
  if (!cardCtx) throw new Error("card context unavailable");
  cardCtx.scale(renderScale, renderScale);

  const bg = cardCtx.createLinearGradient(0, 0, cardCanvas.width, cardCanvas.height);
  bg.addColorStop(0, "#f0f4f7");
  bg.addColorStop(1, "#d7e0e7");
  cardCtx.fillStyle = bg;
  cardCtx.fillRect(0, 0, cardCanvas.width, cardCanvas.height);

  cardCtx.fillStyle = "rgba(12, 18, 24, 0.05)";
  cardCtx.fillRect(framePadding - 8, framePadding - 8, width + 16, height + 16);
  cardCtx.fillStyle = "#f8fbfd";
  cardCtx.fillRect(framePadding, framePadding, width, height);
  cardCtx.drawImage(canvas, framePadding, framePadding);
  cardCtx.strokeStyle = "rgba(29, 49, 64, 0.16)";
  cardCtx.lineWidth = 1;
  cardCtx.strokeRect(framePadding - 0.5, framePadding - 0.5, width + 1, height + 1);
  cardCtx.fillStyle = "rgba(31, 47, 60, 0.78)";
  cardCtx.font = "12px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
  cardCtx.fillText("Inverse reconstruction", framePadding, cardCanvas.height - 12);

  return {
    imageBase64: cardCanvas.toDataURL("image/png").split(",")[1],
    width: cardCanvas.width,
    height: cardCanvas.height,
  };
}
`;

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function scheduleCleanup(filePath: string, delayMs: number): void {
  setTimeout(() => {
    fs.unlink(filePath, () => {});
  }, delayMs).unref?.();
}

function parseToken(value: string): string | null {
  const match = value.match(TOKEN_RE);
  return match?.[1] ?? null;
}

function isSupportedImageName(value: string): boolean {
  const clean = value.split("?")[0].split("#")[0];
  return IMAGE_EXT_RE.test(clean);
}

function normalizeExt(value: string, fallback = ".png"): string {
  const clean = value.split("?")[0].split("#")[0];
  const ext = path.extname(clean).toLowerCase();
  return IMAGE_EXT_RE.test(ext) ? ext : fallback;
}

function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".avif") return "image/avif";
  return "image/png";
}

function getSegments(message: BotMessage): OneBotMessageSegment[] {
  return Array.isArray(message.raw.message) ? message.raw.message : [];
}

function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "image";
}

function pruneOldCacheFiles(dirPath: string, maxAgeMs: number): void {
  if (!fs.existsSync(dirPath)) return;
  const now = Date.now();
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(dirPath, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fullPath);
      }
    } catch {
      // ignore cleanup failures
    }
  }
}

async function downloadImageToTemp(url: string, outputDir: string, preferredName?: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载群文件图片失败：HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = normalizeExt(preferredName || url);
  const filePath = path.join(outputDir, `download-${Date.now()}-${randomUUID().slice(0, 8)}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function resolveFileSegmentPath(
  segment: OneBotMessageSegment,
  options: FftImagePluginOptions,
): Promise<{ filePath: string; displayName: string; cleanupAfterUse: boolean } | null> {
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
    ensureDir(options.outputDir);
    const filePath = await downloadImageToTemp(url, options.outputDir, name || url);
    return {
      filePath,
      displayName: safeFileName(name || path.basename(filePath)),
      cleanupAfterUse: true,
    };
  }

  return null;
}

async function resolveFromSegments(
  segments: OneBotMessageSegment[],
  ctx: PluginContext,
  options: FftImagePluginOptions,
  fromReply: boolean,
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
        fromReply,
        sourceKind: "image",
      };
    }

    if (segment.type === "file") {
      const resolved = await resolveFileSegmentPath(segment, options);
      if (!resolved) continue;
      return {
        ...resolved,
        fromReply,
        sourceKind: "file",
      };
    }
  }

  return null;
}

async function resolveImageSource(
  message: BotMessage,
  ctx: PluginContext,
  onebot: OneBotClient,
  options: FftImagePluginOptions,
): Promise<ResolvedImageSource | null> {
  const direct = await resolveFromSegments(getSegments(message), ctx, options, false);
  if (direct) return direct;

  if (message.replyToMessageId) {
    const replied = await onebot.getMessage(message.replyToMessageId);
    if (replied) {
      const fromReply = await resolveFromSegments(getSegments(replied), ctx, options, true);
      if (fromReply) return fromReply;
    }
  }

  return null;
}

async function readImageAsDataUrl(filePath: string): Promise<string> {
  const buffer = await fs.promises.readFile(filePath);
  return `data:${inferMimeType(filePath)};base64,${buffer.toString("base64")}`;
}

async function writeBase64Png(filePath: string, base64: string): Promise<void> {
  await fs.promises.writeFile(filePath, Buffer.from(base64, "base64"));
}

async function evaluateBrowserScript<T>(
  ctx: PluginContext,
  runnerName: "runFftForward" | "runFftInverse",
  scriptSource: string,
  payload: unknown,
): Promise<T> {
  const page = await ctx.newPage();
  try {
    await page.setContent("<!DOCTYPE html><html><body></body></html>", { waitUntil: "load" });
    const expression = `(() => {
      const payload = ${JSON.stringify(payload)};
      ${scriptSource}
      return ${runnerName}(payload);
    })()`;
    return await page.evaluate(expression) as T;
  } finally {
    await page.close();
  }
}

async function runForwardTransform(
  ctx: PluginContext,
  sourcePath: string,
  maxTransformSize: number,
  renderScale: number,
): Promise<BrowserForwardResult> {
  const dataUrl = await readImageAsDataUrl(sourcePath);
  return evaluateBrowserScript<BrowserForwardResult>(
    ctx,
    "runFftForward",
    FORWARD_TRANSFORM_SCRIPT,
    { imageSrc: dataUrl, maxSize: maxTransformSize, renderScale },
  );
}

async function runInverseTransform(
  ctx: PluginContext,
  record: CachedSpectrumRecord,
  renderScale: number,
): Promise<BrowserInverseResult> {
  return evaluateBrowserScript<BrowserInverseResult>(
    ctx,
    "runFftInverse",
    INVERSE_TRANSFORM_SCRIPT,
    { ...record, renderScale },
  );
}

async function saveSpectrumRecord(cacheDir: string, record: CachedSpectrumRecord): Promise<void> {
  ensureDir(cacheDir);
  const filePath = path.join(cacheDir, `${record.token}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(record), "utf8");
}

async function loadSpectrumRecord(cacheDir: string, token: string): Promise<CachedSpectrumRecord | null> {
  const filePath = path.join(cacheDir, `${token}.json`);
  if (!fs.existsSync(filePath)) return null;
  const raw = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(raw) as CachedSpectrumRecord;
}

async function extractFftTokenFromReply(message: BotMessage, onebot: OneBotClient): Promise<string | null> {
  if (!message.replyToMessageId) return null;
  const replied = await onebot.getMessage(message.replyToMessageId);
  if (!replied) return null;
  return parseToken(replied.text);
}

function buildTarget(message: BotMessage) {
  return message.type === "group"
    ? { type: "group" as const, id: message.groupId! }
    : { type: "private" as const, id: message.userId! };
}

export function createFftImagePlugin(menu: MenuPlugin, onebot: OneBotClient): Plugin {
  let ctxRef: PluginContext | null = null;
  let options = DEFAULT_OPTIONS;

  async function handleForward(message: BotMessage): Promise<void> {
    const ctx = ctxRef!;
    pruneOldCacheFiles(path.resolve(options.cacheDir), options.cacheRetentionHours * 3600 * 1000);

    const source = await resolveImageSource(message, ctx, onebot, options);
    if (!source) {
      await ctx.replyText(
        message,
        [
          "未找到可处理的图片。",
          `支持三种来源：直接随 ${menu.getPrefix()}fft 发送图片、回复一条图片消息、回复一条图片型群文件消息。`,
        ].join("\n"),
      );
      return;
    }

    await ctx.replyText(message, "正在进行傅里叶变换，请稍候…");

    try {
      ensureDir(path.resolve(options.outputDir));
      const token = randomUUID().slice(0, 8);
      const forward = await runForwardTransform(
        ctx,
        source.filePath,
        options.maxTransformSize,
        options.renderScale,
      );
      const outputPath = path.resolve(options.outputDir, `fft-${token}.png`);
      await writeBase64Png(outputPath, forward.imageBase64);
      scheduleCleanup(outputPath, options.resultCleanupDelayMs);

      await saveSpectrumRecord(path.resolve(options.cacheDir), {
        token,
        createdAt: Date.now(),
        sourceName: source.displayName,
        width: forward.width,
        height: forward.height,
        sourceWidth: forward.sourceWidth,
        sourceHeight: forward.sourceHeight,
        real: forward.real,
        imag: forward.imag,
      });

      if (source.cleanupAfterUse) {
        scheduleCleanup(source.filePath, options.resultCleanupDelayMs);
      }

      const originText = source.fromReply ? "引用内容" : "当前消息";
      await ctx.sendImage(
        buildTarget(message),
        outputPath,
        [
          `傅里叶频谱已生成：${source.displayName}`,
          `来源：${originText}${source.sourceKind === "file" ? "（群文件）" : ""}`,
          `尺寸：${forward.width}×${forward.height} 灰度频域`,
          `回复此图发送 ${menu.getPrefix()}ifft 可还原缓存中的处理版本`,
          `[FFT:${token}]`,
        ].join("\n"),
      );
    } catch (error) {
      if (source.cleanupAfterUse) {
        scheduleCleanup(source.filePath, options.resultCleanupDelayMs);
      }
      throw error;
    }
  }

  async function handleInverse(message: BotMessage, args: string[]): Promise<void> {
    const ctx = ctxRef!;
    pruneOldCacheFiles(path.resolve(options.cacheDir), options.cacheRetentionHours * 3600 * 1000);

    const tokenFromArgs = args[0] ? parseToken(args[0]) ?? args[0].trim() : null;
    const token = tokenFromArgs || await extractFftTokenFromReply(message, onebot);
    if (!token) {
      await ctx.replyText(
        message,
        [
          "未找到可还原的 FFT 标识。",
          `请直接回复本插件生成的频谱图后发送 ${menu.getPrefix()}ifft，或手动输入 ${menu.getPrefix()}ifft <token>。`,
        ].join("\n"),
      );
      return;
    }

    const record = await loadSpectrumRecord(path.resolve(options.cacheDir), token);
    if (!record) {
      await ctx.replyText(
        message,
        `未找到 [FFT:${token}] 的本地频谱缓存，无法还原。只有本插件之前生成且缓存尚未过期的结果才能逆变换。`,
      );
      return;
    }

    await ctx.replyText(message, "正在执行逆傅里叶还原，请稍候…");

    const inverse = await runInverseTransform(ctx, record, options.renderScale);
    ensureDir(path.resolve(options.outputDir));
    const outputPath = path.resolve(options.outputDir, `ifft-${token}.png`);
    await writeBase64Png(outputPath, inverse.imageBase64);
    scheduleCleanup(outputPath, options.resultCleanupDelayMs);

    await ctx.sendImage(
      buildTarget(message),
      outputPath,
      [
        `已还原 [FFT:${token}]`,
        `来源：${record.sourceName}`,
        `还原结果为插件缓存中的灰度处理版本，尺寸 ${inverse.width}×${inverse.height}`,
      ].join("\n"),
    );
  }

  return {
    name: "fft-image",
    description: "对图片执行二维傅里叶变换并支持基于缓存的逆变换还原",

    onLoad(ctx) {
      ctxRef = ctx;
      options = {
        ...DEFAULT_OPTIONS,
        ...ctx.config.pluginSettings.fftImage,
      };

      menu.registerCommandGroup("image", "图像工具", "图片频域变换、逆变换与图像类处理");

      menu.registerCommand(
        "fft",
        `对图片做傅里叶变换：直接带图、回复图片，或回复图片型群文件后发送 ${menu.getPrefix()}fft`,
        async (message) => {
          await handleForward(message);
        },
        { group: "image" },
      );

      menu.registerCommand(
        "ifft",
        `对本插件生成的频谱图做逆变换还原：回复频谱图发送 ${menu.getPrefix()}ifft`,
        async (message, args) => {
          await handleInverse(message, args);
        },
        { group: "image" },
      );
    },
  };
}
