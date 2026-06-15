import fs from "node:fs";
import path from "node:path";
import { ProxyAgent } from "undici";

export interface ImageGenConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ImageGenResult {
  /** Base64-encoded PNG data (if output_format=png) */
  b64Json?: string;
  /** URL to the image (if the API returns URLs) */
  url?: string;
}

/**
 * Build a fetch dispatcher that routes through HTTPS_PROXY / HTTP_PROXY
 * when set, otherwise returns undefined (use default fetch behaviour).
 */
function getProxyDispatcher(): ProxyAgent | undefined {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy) {
    return new ProxyAgent(proxy);
  }
  return undefined;
}

/**
 * Call an OpenAI-compatible /v1/images/generations endpoint to generate an image.
 * Returns the raw result (b64_json or url).
 */
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
    // Image generation can take a while — 5 minute timeout
    signal: AbortSignal.timeout(300_000),
  } as RequestInit);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Image API error ${response.status}: ${errorText.slice(0, 500)}`,
    );
  }

  const json = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };

  if (!json.data || json.data.length === 0) {
    throw new Error("Image API returned empty data.");
  }

  return json.data[0]!;
}

/**
 * Generate an image and save it to a file. Returns the file path.
 */
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

  if (result.b64Json) {
    const buffer = Buffer.from(result.b64Json, "base64");
    fs.writeFileSync(outputPath, buffer);
  } else if (result.url) {
    // Download from URL (also use proxy)
    const dispatcher = getProxyDispatcher();
    const response = await fetch(result.url, {
      ...(dispatcher ? { dispatcher } : {}),
      signal: AbortSignal.timeout(120_000),
    } as RequestInit);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
  } else {
    throw new Error("Image API returned neither b64_json nor url.");
  }

  return outputPath;
}
