import assert from "node:assert/strict";
import { createGeminiRelayServer, buildRelayFetchFn, type GeminiRelayServerConfig } from "./server.js";
import type { ProxyConfig } from "../../types.js";

/** 构造一条满足 wrb.fr 过滤条件（含引号、len>=200）的累计全文行。 */
function buildWrbLine(...fragments: string[]): string {
  const innerPayload: unknown[] = new Array(9).fill(null);
  innerPayload[4] = fragments.map((fragment) => [null, [fragment]]);
  // arr[0] 为包裹数组、arr[0][2] 为内层 JSON 串、arr[0][1]=="wrb.fr"（与 python 解析一致）。
  const arr = [[null, "wrb.fr", JSON.stringify(innerPayload), null, null]];
  const lineText = JSON.stringify(arr);
  return lineText.padEnd(200 + lineText.length, " ");
}

/** 三行累计全文：流式按行差分出 delta，非流式取最长行。 */
const UPSTREAM_TEXT = [
  buildWrbLine("你好"),
  buildWrbLine("你好，世界"),
  buildWrbLine("你好，世界，这是完整回复"),
].join("\n");

function makeConfig(overrides: Partial<GeminiRelayServerConfig> = {}): GeminiRelayServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    cookieFile: "",
    xsrfToken: "",
    authUser: "",
    geminiBl: "bl",
    defaultModel: "gemini-3.6-flash",
    requestTimeoutSec: 30,
    retryAttempts: 1,
    retryDelaySec: 0,
    logRequests: false,
    temporaryChats: false,
    apiKeys: [],
    ...overrides,
  };
}

function chatBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "gemini-3.7-flash",
    messages: [{ role: "user", content: "你好" }],
    ...overrides,
  });
}

function post(server: { port: number }, path: string, body?: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    ...(body !== undefined ? { body } : {}),
  });
}

async function parseSseFrames(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice("data: ".length)) as unknown);
}

async function main(): Promise<void> {
  const server = createGeminiRelayServer(makeConfig(), {
    fetchFn: async () => new Response(UPSTREAM_TEXT, { status: 200 }),
  });
  await server.start();

  try {
    // 健康检查
    const health = await (await fetch(`http://127.0.0.1:${server.port}/`)).json() as { status?: string };
    assert.equal(health.status, "ok");

    // 模型列表
    const models = await (await fetch(`http://127.0.0.1:${server.port}/v1/models`)).json() as {
      data: Array<{ id: string }>;
    };
    assert.ok(models.data.some((model) => model.id === "gemini-3.7-flash"), "模型表应含 gemini-3.7-flash");

    // 非流式 chat completions
    const chat = await (await post(server, "/v1/chat/completions", chatBody())).json() as {
      choices: Array<{ message: { content: string | null }; finish_reason: string }>;
      usage: { total_tokens: number };
    };
    assert.equal(chat.choices[0].message.content, "你好，世界，这是完整回复");
    assert.equal(chat.choices[0].finish_reason, "stop");
    assert.ok(chat.usage.total_tokens > 0);

    // 流式 chat completions（逐帧断言）
    const streamResponse = await post(server, "/v1/chat/completions", chatBody({ stream: true }));
    assert.equal(streamResponse.headers.get("content-type"), "text/event-stream");
    const frames = await parseSseFrames(streamResponse) as Array<{
      choices?: Array<{ delta?: { role?: string; content?: string }; finish_reason?: string | null }>;
      usage?: { total_tokens: number };
    }>;
    assert.equal(frames[0]?.choices?.[0]?.delta?.role, "assistant", "首块应声明 assistant 角色");
    const streamedContent = frames
      .filter((frame) => frame.choices?.[0]?.delta?.content !== undefined)
      .map((frame) => frame.choices![0].delta!.content!)
      .join("");
    assert.equal(streamedContent, "你好，世界，这是完整回复", "流式内容应完整还原");
    const finishFrame = frames.find((frame) => frame.choices?.[0]?.finish_reason === "stop");
    assert.ok(finishFrame, "应存在 finish_reason=stop 的结束帧");
    const usageFrame = frames.find((frame) => frame.usage !== undefined);
    assert.ok(usageFrame?.usage !== undefined && usageFrame.usage.total_tokens > 0, "应存在 usage 帧");

    // 空 prompt → 400
    const empty = await post(server, "/v1/chat/completions", chatBody({ messages: [{ role: "user", content: "" }] }));
    assert.equal(empty.status, 400);

    // 非法 @think → 400
    const badModel = await post(server, "/v1/chat/completions", chatBody({ model: "gemini-3.6-flash@think=abc" }));
    assert.equal(badModel.status, 400);

    // 未知路径 → 404（/v1/responses 未实现）
    const notFound = await post(server, "/v1/responses", chatBody());
    assert.equal(notFound.status, 404);

    // generateContent 非流式
    const gc = await (await post(
      server,
      "/v1beta/models/gemini-3.7-flash:generateContent",
      JSON.stringify({
        systemInstruction: { parts: [{ text: "系统说明" }] },
        contents: [{ role: "user", parts: [{ text: "你好" }] }],
      }),
    )).json() as {
      candidates: Array<{ content: { parts: Array<{ text: string }> }; finishReason: string }>;
      usageMetadata: { totalTokenCount: number };
    };
    assert.equal(gc.candidates[0].content.parts[0].text, "你好，世界，这是完整回复");
    assert.equal(gc.candidates[0].finishReason, "STOP");

    // generateContent 流式
    const gcs = await post(
      server,
      "/v1beta/models/gemini-3.7-flash:streamGenerateContent",
      JSON.stringify({ contents: [{ role: "user", parts: [{ text: "你好" }] }] }),
    );
    const gcFrames = await parseSseFrames(gcs) as Array<{
      candidates?: Array<{ finishReason?: string }>;
      usageMetadata?: { totalTokenCount: number };
    }>;
    const gcFinal = gcFrames.find((frame) => frame.candidates?.[0]?.finishReason === "STOP");
    assert.ok(gcFinal, "流式 generateContent 应存在 STOP 终帧");
    assert.ok(
      gcFinal?.usageMetadata !== undefined && gcFinal.usageMetadata.totalTokenCount > 0,
      "STOP 终帧应带 usageMetadata",
    );

    // 上游失败 → 502
    const failServer = createGeminiRelayServer(makeConfig(), {
      fetchFn: async () => {
        throw new Error("upstream boom");
      },
    });
    await failServer.start();
    try {
      const failResponse = await post(failServer, "/v1/chat/completions", chatBody());
      assert.equal(failResponse.status, 502);
    } finally {
      await failServer.close();
    }

    // 上游返回 HTTP 200 但没有可解析正文时，也必须对下游暴露为失败，
    // 不能生成一个 content=null 的“成功”响应。
    const emptyServer = createGeminiRelayServer(makeConfig(), {
      fetchFn: async () => new Response("", { status: 200 }),
    });
    await emptyServer.start();
    try {
      const emptyResponse = await post(emptyServer, "/v1/chat/completions", chatBody());
      assert.equal(emptyResponse.status, 502, "空上游响应应映射为 502");
    } finally {
      await emptyServer.close();
    }
  } finally {
    await server.close();
  }

  // 鉴权：apiKeys 非空时未授权 401，Bearer 通过
  const authServer = createGeminiRelayServer(makeConfig({ apiKeys: ["k1"] }), {
    fetchFn: async () => new Response(UPSTREAM_TEXT, { status: 200 }),
  });
  await authServer.start();
  try {
    const noKey = await fetch(`http://127.0.0.1:${authServer.port}/v1/models`);
    assert.equal(noKey.status, 401, "无 key 应 401");
    const withKey = await fetch(`http://127.0.0.1:${authServer.port}/v1/models`, {
      headers: { authorization: "Bearer k1" },
    });
    assert.equal(withKey.status, 200, "Bearer key 应通过");
    const queryKey = await fetch(`http://127.0.0.1:${authServer.port}/v1/models?key=k1`);
    assert.equal(queryKey.status, 200, "?key= 应通过");
  } finally {
    await authServer.close();
  }

  // ── proxy 配置：未设置/禁用 → 不注入 dispatcher；启用 → 注入专用 dispatcher ──
  const recorded: Array<{ input: string | URL; init?: Record<string, unknown> }> = [];
  const spyFetch = ((input: string | URL, init?: RequestInit) => {
    recorded.push({ input, init: (init as Record<string, unknown> | undefined) });
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as Parameters<typeof buildRelayFetchFn>[1];

  // 1) proxy 未设置 → 直接透传 fetchImpl，不注入 dispatcher。
  recorded.length = 0;
  const noProxyFn = buildRelayFetchFn(undefined, spyFetch);
  await noProxyFn("http://example.test", { method: "POST" });
  assert.equal(recorded.length, 1, "无 proxy 时应调用一次 fetchImpl");
  assert.equal(recorded[0]?.init?.dispatcher, undefined, "无 proxy 时不应注入 dispatcher");

  // 2) proxy enabled=false → 同上，不注入 dispatcher。
  recorded.length = 0;
  const disabledProxy: ProxyConfig = { enabled: false, mode: "custom", url: "http://127.0.0.1:1", noProxy: "" };
  await buildRelayFetchFn(disabledProxy, spyFetch)("http://example.test", { method: "POST" });
  assert.equal(recorded[0]?.init?.dispatcher, undefined, "proxy disabled 时不应注入 dispatcher");

  // 3) proxy enabled=true → 注入专用 dispatcher（由 createDispatcher 构造，非空对象）。
  recorded.length = 0;
  const enabledProxy: ProxyConfig = { enabled: true, mode: "custom", url: "http://127.0.0.1:55268", noProxy: "localhost,127.0.0.1" };
  const proxyFn = buildRelayFetchFn(enabledProxy, spyFetch);
  await proxyFn("https://gemini.google.com/test", { method: "POST" });
  assert.equal(recorded.length, 1, "启用 proxy 时应调用一次 fetchImpl");
  const dispatcher = recorded[0]?.init?.dispatcher;
  assert.ok(dispatcher, "启用 proxy 时应注入 dispatcher");
  assert.equal(typeof dispatcher, "object", "dispatcher 应为对象（undici Dispatcher）");

  // 4) proxy 分支返回的 fetch 会透传 init（不丢弃调用方传入的其它字段）。
  recorded.length = 0;
  await proxyFn("https://gemini.google.com/test", { method: "POST", headers: { "x-test": "1" } });
  assert.equal((recorded[0]?.init?.headers as Record<string, string> | undefined)?.["x-test"], "1", "proxy 分支应透传调用方 init");

  // ── 图片上传 + refs 织入：携带图片的消息应触发上传并把 ref 织入上游 payload ──
  {
    const capturedBodies: string[] = [];
    const imageFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlText = String(input);
      if (urlText === "https://gemini.google.com/app") {
        return new Response("<html>no tokens</html>", { status: 200 });
      }
      if (urlText === "https://content-push.googleapis.com/upload/") {
        return new Response("", {
          status: 200,
          headers: { "X-Goog-Upload-URL": "https://upload.example.test/push" },
        });
      }
      if (urlText.includes("StreamGenerate")) {
        // 上游 generate：返回标准的 wrb.fr 累计全文；并捕获表单体以断言 refs 织入
        const body = typeof init?.body === "string" ? init.body : "";
        capturedBodies.push(body);
        return new Response(UPSTREAM_TEXT, { status: 200 });
      }
      const body = typeof init?.body === "string" ? init.body : "";
      capturedBodies.push(body);
      return new Response("/images/ref-abc", { status: 200 });
    }) as Parameters<typeof buildRelayFetchFn>[1];

    const imgServer = createGeminiRelayServer(makeConfig(), { fetchFn: imageFetch });
    await imgServer.start();
    try {
      const pngBase64 = "iVBORw0KGgo="; // 1x1 PNG 片段签名足够探测
      const response = await post(imgServer, "/v1/chat/completions", chatBody({
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "图中是什么" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}`, mime_type: "image/png" } },
          ],
        }],
      }));
      const chat = await response.json() as { choices: Array<{ message: { content: string } }> };
      assert.equal(chat.choices[0].message.content, "你好，世界，这是完整回复");
      // 上游表单应包含上传的 ref（URL 编码后 %2Fimages%2Fref-abc）
      assert.ok(
        capturedBodies.some((b) => b.includes("%2Fimages%2Fref-abc")),
        "上游请求应织入图片 ref",
      );
    } finally {
      await imgServer.close();
    }
  }

  console.log("✅ Gemini relay 服务端路由/流式/错误映射/鉴权/proxy 配置/图片refs 测试通过");
}

await main();
