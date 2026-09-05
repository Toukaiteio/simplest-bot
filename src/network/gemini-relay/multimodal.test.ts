import assert from "node:assert/strict";
import {
  detectImageMime,
  resolveImageBytes,
  fetchImageBytes,
  createGeminiImageUploader,
  type ImagePart,
} from "./multimodal.js";
import { buildPayload, buildFormBody, type GeminiUpstreamConfig, type FetchLike } from "./upstream.js";
import { resolveModel } from "./models.js";

// ── MIME 探测 ──
function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}
assert.equal(detectImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
assert.equal(detectImageMime(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
assert.equal(detectImageMime(bytes(0x47, 0x49, 0x46, 0x38, 0x37)), "image/gif");
assert.equal(detectImageMime(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)), "image/webp");
assert.equal(detectImageMime(bytes(1, 2, 3)), "image/png", "未知签名回落默认");

// ── resolveImageBytes：data URL / base64 / 远程 URL ──
{
  const dataPart: ImagePart = { dataUrl: "data:image/jpeg;base64,/9j/4AAQ" };
  const resolved = await resolveImageBytes(dataPart, async () => new Response("", { status: 200 }));
  assert.equal(resolved?.mime, "image/jpeg");
  assert.ok(resolved && resolved.bytes.length > 0);

  const base64Part: ImagePart = { data: "AAAA", mime: "image/png" };
  const base64Resolved = await resolveImageBytes(base64Part, async () => new Response("", { status: 200 }));
  assert.equal(base64Resolved?.mime, "image/png");

  // 远程 URL：download 返回 bytes
  const pngBytes = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
  const remotePart: ImagePart = { url: "https://example.com/a.png" };
  const remote = await resolveImageBytes(remotePart, async (input) => {
    assert.equal(input, "https://example.com/a.png");
    return new Response(new Uint8Array(pngBytes), { status: 200 });
  });
  assert.equal(remote?.bytes.length, pngBytes.length);

  // 无法解析 → null
  const empty = await resolveImageBytes({}, async () => new Response("", { status: 200 }));
  assert.equal(empty, null);
}

// fetchImageBytes：非 2xx → null
{
  const failed = await fetchImageBytes("https://example.com/404.png", async () => new Response("", { status: 404 }));
  assert.equal(failed, null);
}

// ── Guppy 两步上传（模拟 start 响应头 + finalize 响应体，含页面 token 抓取）──
{
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const urlText = String(input);
    if (urlText === "https://gemini.google.com/app") {
      return Promise.resolve(new Response("<html>no tokens</html>", { status: 200 }));
    }
    if (urlText === "https://content-push.googleapis.com/upload/") {
      return Promise.resolve(new Response("", {
        status: 200,
        headers: { "X-Goog-Upload-URL": "https://upload.example.test/push?upload_id=abc" },
      }));
    }
    // finalize 步骤返回文件引用 /images/xxx
    return Promise.resolve(new Response("/images/mock-file-ref", { status: 200 }));
  }) as FetchLike;

  const uploader = createGeminiImageUploader({
    cookieFile: "",
    fetchFn: fakeFetch,
    log: () => {},
  });

  const imageBytes = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9);
  const ref = await uploader.uploadImage(imageBytes, "image/png");
  assert.equal(ref, "/images/mock-file-ref");
  // 页面 token + start + finalize 三步各一次
  assert.equal(calls.length, 3, "page-token + start + finalize 各一次");
  assert.equal(calls[1]!.url, "https://content-push.googleapis.com/upload/", "第二次调用为上传 start");

  // start 头应携带 resumable 协议与 Push-ID
  const startCall = calls[1]!.init as Record<string, unknown>;
  const startHeaders = (startCall.headers ?? {}) as Record<string, string>;
  assert.equal(startHeaders["X-Goog-Upload-Protocol"], "resumable");
  assert.ok(startHeaders["Push-ID"], "应携带 Push-ID");

  // resolveImage：探测 MIME（PNG 签名）
  const resolved = await uploader.resolveImage({ url: "https://example.com/a.png" });
  assert.equal(resolved.mime, "image/png");
}

// ── upstream 织入 refs ──
{
  const config: GeminiUpstreamConfig = {
    cookieFile: "",
    xsrfToken: "",
    authUser: "",
    geminiBl: "bl",
    requestTimeoutSec: 30,
    retryAttempts: 1,
    retryDelaySec: 0,
    temporaryChats: true,
    logRequests: false,
    fetchFn: async () => new Response("", { status: 200 }),
  };
  const resolved = resolveModel("gemini-3.6-flash");

  // 无图：inner[0][3] 为 null
  const noRef = buildPayload("hello", resolved, config) as unknown[];
  assert.equal((noRef[0] as unknown[])[3], null);

  // 有图：inner[0][3] 为 refs 数组（每个 ref 再包一层 [null, null, ref]，与 python 一致）
  const withRef = (buildPayload("hello", resolved, config, ["/images/a", "/images/b"]) as unknown[])[0] as unknown[];
  assert.deepEqual(withRef[3], [[null, null, "/images/a"], [null, null, "/images/b"]]);

  // 海外 form 体经 quotePlus 编码后仍含图片引用（'/' 被百分号编码为 %2F）
  const body = buildFormBody("hello", resolved, config, ["/images/ref"]);
  assert.ok(body.includes("%2Fimages%2Fref"), "form 体应包含（URL 编码后的）图片引用");
}

console.log("✅ Gemini relay multimodal/上传/refs 织入测试通过");