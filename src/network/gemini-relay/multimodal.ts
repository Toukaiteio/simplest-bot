/**
 * Gemini Web 图片上传（移植自 gemini_web2api/multimodal.py）。
 *
 * 让 102 槽位 payload 携带图片（file refs）的上传通道：
 *   1. 从 https://gemini.google.com/app 抓 WIZ_global_data 里的 Push-ID / X-Client-Pctx（/ at token），缓存 600s。
 *   2. Scotty resumable upload：POST content-push.googleapis.com/upload 起始，再从响应头的
 *      X-Goog-Upload-URL 上传二进制并 finalize，拿到以 "/" 开头的文件引用。
 *   3. 该引用随后织入 upstream 102 槽位 payload 的 inner[0]（第 4 个元素），
 *      让 Gemini Web 真实"看图"。
 *
 * 依赖与已知风险（与原版一致）：
 *   - 依赖 cookie / SAPISIDHASH 与页面内部的 Push-ID / pctx（未公开、随前端版本变化易失效）。
 *   - 上传走 content-push.googleapis.com，需走代理（沿用 relay 的专用 dispatcher）。
 */
import {
  loadCookie,
  buildSapisidHash,
  type FetchLike,
} from "./upstream.js";

export type ImagePart = {
  /** http(s) 图片 URL（在 server 侧下载为字节再上传）。 */
  url?: string;
  /** data:image/png;base64,.... 数据 URL（解码为字节再上传）。 */
  dataUrl?: string;
  /** base64 原始串（部分客户端直接给二进制 base64）。 */
  data?: string;
  mime?: string;
};

export type GeminiImageUploaderDeps = {
  cookieFile: string;
  fetchFn: FetchLike;
  log?: (message: string) => void;
};

type UploadAuth = {
  cookie: string;
  sapisid: string | null;
};

const PAGE_TOKENS_URL = "https://gemini.google.com/app";
const UPLOAD_START_URL = "https://content-push.googleapis.com/upload/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/** 按文件签名识别常见栅格图 MIME（python detect_image_mime 等价）。 */
export function detectImageMime(imageBytes: Uint8Array, fallback = "image/png"): string {
  if (!imageBytes || imageBytes.length === 0) return fallback;
  const startsWith = (needle: number[]): boolean => {
    if (imageBytes.length < needle.length) return false;
    return needle.every((value, index) => imageBytes[index] === value);
  };
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x47, 0x49, 0x46, 0x38]) && (imageBytes[4] === 0x37 || imageBytes[4] === 0x38)) return "image/gif";
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && thisAscii(imageBytes, 8, 4) === "WEBP") return "image/webp";
  if (startsWith([0x42, 0x4d])) return "image/bmp";
  if (startsWith([0x49, 0x49, 0x2a, 0x00]) || startsWith([0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  if (imageBytes.length >= 12 && thisAscii(imageBytes, 4, 4) === "ftyp") {
    const brand = thisAscii(imageBytes, 8, 4);
    if (["avif", "avis"].includes(brand)) return "image/avif";
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
  }
  return fallback;
}

function thisAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length && offset + i < bytes.length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

/** 下载 http(s) 图片字节（python fetch_image_bytes 等价）。失败返回 null。 */
export async function fetchImageBytes(url: string, fetchFn: FetchLike): Promise<Uint8Array | null> {
  try {
    const response = await fetchFn(url, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch {
    return null;
  }
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const buffer = Buffer.from(value, "base64");
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch {
    return null;
  }
}

/** 把图片 part 解析为「字节 + mime」。无法解析时返回 null。 */
export async function resolveImageBytes(
  part: ImagePart,
  fetchFn: FetchLike,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (part.dataUrl?.startsWith("data:")) {
    const match = part.dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/su);
    if (match) {
      const mime = match[1] || part.mime || "image/png";
      const bytes = match[2]
        ? base64ToBytes(match[3])
        : new Uint8Array(Buffer.from(decodeURIComponent(match[3]), "utf8"));
      if (bytes && bytes.length > 0) return { bytes, mime };
      return null;
    }
  }
  if (part.data) {
    const bytes = base64ToBytes(part.data);
    if (bytes && bytes.length > 0) return { bytes, mime: part.mime || "image/png" };
  }
  if (part.url) {
    const bytes = await fetchImageBytes(part.url, fetchFn);
    if (bytes && bytes.length > 0) return { bytes, mime: part.mime || "image/png" };
  }
  return null;
}

/** 页面 token 抓取（理想情况下返回 {push_id, pctx, at} 的缓存）。失败返回空对象。 */
export async function fetchPageTokens(
  auth: UploadAuth,
  fetchFn: FetchLike,
  log?: (message: string) => void,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (auth.cookie) headers["Cookie"] = auth.cookie;
  if (auth.sapisid) headers["Authorization"] = buildSapisidHash(auth.sapisid);
  try {
    const response = await fetchFn(PAGE_TOKENS_URL, { headers });
    if (!response.ok) return {};
    const html = await response.text();
    const tokens: Record<string, string> = {};
    const patterns: Array<[string, RegExp]> = [
      ["push_id", /"qKIAYe":"([^"]+)"/u],
      ["pctx", /"Ylro7b":"([^"]+)"/u],
      ["at", /"thykhd":"([^"]+)"/u],
    ];
    for (const [key, pattern] of patterns) {
      const match = html.match(pattern);
      if (match) tokens[key] = match[1];
    }
    return tokens;
  } catch (error) {
    log?.(`[Multimodal] Page token fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/** 上游鉴权读取：复用 upstream 的 cookie 解析，返回 { cookie, sapisid }。 */
function resolveAuth(cookieFile: string): UploadAuth {
  const cs = loadCookie(cookieFile);
  return { cookie: cs.cookie, sapisid: cs.sapisid };
}

const fallbackPageTokens = { push_id: "feeds/mcudyrk2a4khkz", pctx: "CgcSBWjK7pYx" };

/**
 * 创建图片上传器。
 * uploadImage：执行 Scotty 两步上传，返回 file reference（形如 "/images/...."）。
 */
export function createGeminiImageUploader(
  deps: GeminiImageUploaderDeps,
): {
  /** 把图片 part 解析为「字节 + 探测后 MIME」。解析失败抛错。 */
  resolveImage: (part: ImagePart) => Promise<{ bytes: Uint8Array; mime: string }>;
  /** 执行 Scotty 两步上传，返回 file reference（形如 "/images/...."）。 */
  uploadImage: (bytes: Uint8Array, mime: string) => Promise<string>;
} {
  const log = deps.log ?? ((message: string) => console.log(message));
  const tokenCache: { tokens: Record<string, string>; ts: number } = { tokens: {}, ts: 0 };

  async function cachedPageTokens(): Promise<Record<string, string>> {
    const now = Date.now();
    if (now - tokenCache.ts > 600_000) {
      tokenCache.tokens = await fetchPageTokens(resolveAuth(deps.cookieFile), deps.fetchFn, log);
      tokenCache.ts = now;
    }
    return tokenCache.tokens;
  }

  async function startUpload(imageBytes: Uint8Array, mime: string): Promise<string> {
    const tokens = await cachedPageTokens();
    const pushId = tokens.push_id || fallbackPageTokens.push_id;
    const pctx = tokens.pctx || fallbackPageTokens.pctx;
    const auth = resolveAuth(deps.cookieFile);

    const startHeaders: Record<string, string> = {
      "Push-ID": pushId,
      "X-Tenant-Id": "bard-storage",
      "X-Client-Pctx": pctx,
      "X-Goog-Upload-Header-Content-Length": String(imageBytes.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      "User-Agent": USER_AGENT,
    };
    if (auth.cookie) startHeaders["Cookie"] = auth.cookie;
    if (auth.sapisid) startHeaders["Authorization"] = buildSapisidHash(auth.sapisid);

    const response = await deps.fetchFn(UPLOAD_START_URL, {
      method: "POST",
      headers: startHeaders,
      body: "",
    });
    if (!response.ok) {
      throw new Error(`image upload start failed: HTTP ${response.status}`);
    }
    const uploadUrl = response.headers.get("X-Goog-Upload-URL");
    if (!uploadUrl) {
      throw new Error("No upload URL in response headers");
    }
    return uploadUrl;
  }

  async function finalizeUpload(uploadUrl: string, imageBytes: Uint8Array): Promise<string> {
    const uploadHeaders: Record<string, string> = {
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
      "Content-Type": "application/octet-stream",
      "User-Agent": USER_AGENT,
    };
    const response = await deps.fetchFn(uploadUrl, {
      method: "POST",
      headers: uploadHeaders,
      body: Buffer.from(imageBytes),
    });
    if (!response.ok) {
      throw new Error(`image upload finalize failed: HTTP ${response.status}`);
    }
    const fileRef = (await response.text()).trim();
    if (!fileRef || !fileRef.startsWith("/")) {
      throw new Error(`Invalid file reference: ${fileRef.slice(0, 100)}`);
    }
    return fileRef;
  }

  return {
    async resolveImage(part: ImagePart): Promise<{ bytes: Uint8Array; mime: string }> {
      const resolved = await resolveImageBytes(part, deps.fetchFn);
      if (!resolved) throw new Error("image fetch/parse failed");
      const mime = detectImageMime(resolved.bytes, resolved.mime || "image/png");
      return { bytes: resolved.bytes, mime };
    },
    async uploadImage(imageBytes: Uint8Array, mime: string): Promise<string> {
      const uploadUrl = await startUpload(imageBytes, mime);
      log(`[Multimodal] Upload session started: ${uploadUrl.slice(0, 80)}...`);
      const fileRef = await finalizeUpload(uploadUrl, imageBytes);
      log(`[Multimodal] Image uploaded: ${fileRef.slice(0, 50)}...`);
      return fileRef;
    },
  };
}

/** 便捷：从 part 解析出字节并上传，返回 file_ref；解析/上传失败抛错。 */
export async function uploadImagePart(
  part: ImagePart,
  deps: GeminiImageUploaderDeps,
): Promise<string> {
  const resolved = await resolveImageBytes(part, deps.fetchFn);
  if (!resolved) throw new Error("image fetch/parse failed");
  const mime = detectImageMime(resolved.bytes, resolved.mime || "image/png");
  const uploader = createGeminiImageUploader(deps);
  return uploader.uploadImage(resolved.bytes, mime);
}