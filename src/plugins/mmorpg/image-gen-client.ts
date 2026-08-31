import fs from "node:fs";
import path from "node:path";
import { ProxyAgent } from "undici";

export interface ImageGenConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ImageGenResult {
  b64Json?: string;
  url?: string;
}

function getProxyDispatcher(): ProxyAgent | undefined {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy) {
    return new ProxyAgent(proxy);
  }
  return undefined;
}

async function saveImageResult(
  result: ImageGenResult,
  outputPath: string,
  downloadLabel: string,
): Promise<string> {
  if (result.b64Json) {
    const buffer = Buffer.from(result.b64Json, "base64");
    fs.writeFileSync(outputPath, buffer);
    return outputPath;
  }

  if (result.url) {
    const dispatcher = getProxyDispatcher();
    const response = await fetch(result.url, {
      ...(dispatcher ? { dispatcher } : {}),
      signal: AbortSignal.timeout(120_000),
    } as RequestInit);
    if (!response.ok) {
      throw new Error(`Failed to download ${downloadLabel}: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
    return outputPath;
  }

  throw new Error(`${downloadLabel} returned neither b64_json nor url.`);
}

export async function generateImage(
  config: ImageGenConfig,
  prompt: string,
  options?: {
    size?: string;
    quality?: string;
    outputFormat?: string;
  },
): Promise<ImageGenResult> {
  const url = config.baseUrl.replace(/\/+$/, "") + "/images/generations";

  const body = {
    model: config.model,
    prompt,
    n: 1,
    size: options?.size ?? "1024x1024",
    quality: options?.quality ?? "high",
    output_format: options?.outputFormat ?? "png",
  };

  const dispatcher = getProxyDispatcher();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    ...(dispatcher ? { dispatcher } : {}),
    signal: AbortSignal.timeout(300_000),
  } as RequestInit);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Image API error ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const json = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };

  if (!json.data || json.data.length === 0) {
    throw new Error("Image API returned empty data.");
  }

  return json.data[0]!;
}

export async function editImage(
  config: ImageGenConfig,
  prompt: string,
  imagePath: string,
  options?: {
    size?: string;
    quality?: string;
    editPath?: string;
  },
): Promise<ImageGenResult> {
  const url = config.baseUrl.replace(/\/+$/, "") + (options?.editPath ?? "/images/edits");
  const dispatcher = getProxyDispatcher();
  const form = new FormData();
  const fileBuffer = await fs.promises.readFile(imagePath);

  form.append("model", config.model);
  form.append("prompt", prompt);
  form.append("size", options?.size ?? "1024x1024");
  form.append("quality", options?.quality ?? "high");
  form.append("image", new Blob([fileBuffer], { type: "image/png" }), path.basename(imagePath));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: form,
    ...(dispatcher ? { dispatcher } : {}),
    signal: AbortSignal.timeout(300_000),
  } as RequestInit);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Image Edit API error ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const json = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  if (!json.data || json.data.length === 0) {
    throw new Error("Image Edit API returned empty data.");
  }
  return json.data[0]!;
}

export async function generateAndSaveImage(
  config: ImageGenConfig,
  prompt: string,
  outputDir: string,
  fileName: string,
  options?: {
    size?: string;
    quality?: string;
  },
): Promise<string> {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, fileName);
  const result = await generateImage(config, prompt, {
    ...options,
    outputFormat: "png",
  });
  return saveImageResult(result, outputPath, "image");
}

export async function editAndSaveImage(
  config: ImageGenConfig,
  prompt: string,
  imagePath: string,
  outputDir: string,
  fileName: string,
  options?: {
    size?: string;
    quality?: string;
    editPath?: string;
  },
): Promise<string> {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, fileName);
  const result = await editImage(config, prompt, imagePath, options);
  return saveImageResult(result, outputPath, "edited image");
}

export interface ImageGenNewApiConfig {
  baseUrl: string;
  cookie: string;
}

export interface ImageGenNewApiResult {
  b64Json: string;
  created: number;
}

function buildCookieHeader(cookie: string): string {
  return cookie.includes("=") ? cookie : `auth_token=${cookie}`;
}

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".avif") return "image/avif";
  return "image/png";
}

export async function generateImageNewApi(
  config: ImageGenNewApiConfig,
  prompt: string,
  options?: {
    size?: string;
    outputFormat?: string;
    moderation?: string;
  },
): Promise<ImageGenNewApiResult> {
  const url = config.baseUrl.replace(/\/+$/, "") + "/api-proxy/generate";

  const body: Record<string, unknown> = {
    prompt,
    size: options?.size ?? "auto",
    output_format: options?.outputFormat ?? "png",
  };
  if (options?.moderation) body.moderation = options.moderation;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: buildCookieHeader(config.cookie),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Image NewApi error ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const json = (await response.json()) as {
    data?: Array<{ b64_json: string }>;
    created?: number;
  };

  if (!json.data || json.data.length === 0 || !json.data[0]?.b64_json) {
    throw new Error("Image NewApi returned empty data.");
  }

  return { b64Json: json.data[0].b64_json, created: json.created ?? 0 };
}

export async function editImageNewApi(
  config: ImageGenNewApiConfig,
  prompt: string,
  imagePath: string,
  options?: {
    size?: string;
    editPath?: string;
    outputFormat?: string;
    moderation?: string;
  },
): Promise<ImageGenNewApiResult> {
  const url = config.baseUrl.replace(/\/+$/, "") + (options?.editPath ?? "/api-proxy/images/edits");
  const form = new FormData();
  const fileBuffer = await fs.promises.readFile(imagePath);

  form.append("prompt", prompt);
  form.append("size", options?.size ?? "auto");
  form.append("output_format", options?.outputFormat ?? "png");
  form.append("moderation", options?.moderation ?? "auto");
  form.append(
    "image[]",
    new Blob([fileBuffer], { type: detectMimeType(imagePath) }),
    path.basename(imagePath),
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Cookie: buildCookieHeader(config.cookie),
    },
    body: form,
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Image NewApi edit error ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const json = (await response.json()) as {
    data?: Array<{ b64_json: string }>;
    created?: number;
  };
  if (!json.data || json.data.length === 0 || !json.data[0]?.b64_json) {
    throw new Error("Image NewApi edit returned empty data.");
  }
  return { b64Json: json.data[0].b64_json, created: json.created ?? 0 };
}

export async function generateAndSaveImageNewApi(
  config: ImageGenNewApiConfig,
  prompt: string,
  outputDir: string,
  fileName: string,
  options?: {
    size?: string;
    moderation?: string;
  },
): Promise<{ filePath: string; created: number }> {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, fileName);
  const result = await generateImageNewApi(config, prompt, {
    ...options,
    outputFormat: "png",
  });
  const buffer = Buffer.from(result.b64Json, "base64");
  fs.writeFileSync(outputPath, buffer);
  return { filePath: outputPath, created: result.created };
}

export async function editAndSaveImageNewApi(
  config: ImageGenNewApiConfig,
  prompt: string,
  imagePath: string,
  outputDir: string,
  fileName: string,
  options?: {
    size?: string;
    editPath?: string;
    outputFormat?: string;
    moderation?: string;
  },
): Promise<{ filePath: string; created: number }> {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, fileName);
  const result = await editImageNewApi(config, prompt, imagePath, options);
  const buffer = Buffer.from(result.b64Json, "base64");
  fs.writeFileSync(outputPath, buffer);
  return { filePath: outputPath, created: result.created };
}
