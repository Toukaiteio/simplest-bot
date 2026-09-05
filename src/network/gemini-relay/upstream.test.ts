import assert from "node:assert/strict";
import {
  asciiJson,
  buildSapisidHash,
  buildFormBody,
  buildPayload,
  cleanRelayText,
  extractResponseText,
  generateRelayText,
  quotePlus,
} from "./upstream.js";
import { resolveModel } from "./models.js";

// asciiJson：python json.dumps(ensure_ascii=True) 等价
assert.equal(asciiJson("中文"), "\"\\u4e2d\\u6587\"", "非 ASCII 应转 \\uXXXX");
assert.equal(asciiJson([null, "a"]), "[null, \"a\"]", "列表分隔符应为 ', '");
assert.equal(asciiJson({ b: "c" }), "{\"b\": \"c\"}", "对象分隔符应为 ': '");
assert.equal(asciiJson("😀"), "\"\\ud83d\\ude00\"", "代理对应按 python 拆分转义");

// quotePlus：python urllib.parse.urlencode(quote_plus) 等价
assert.equal(quotePlus("a b/中"), "a+b%2F%E4%B8%AD");
assert.equal(quotePlus("._~-"), "._~-", "python always-safe 字符不转义");

const baseConfig = {
  cookieFile: "",
  xsrfToken: "",
  authUser: "",
  geminiBl: "bl",
  requestTimeoutSec: 30,
  retryAttempts: 1,
  retryDelaySec: 0,
  temporaryChats: false,
  logRequests: false,
  fetchFn: () => Promise.resolve(new Response("")),
};
const resolved = resolveModel("gemini-3.7-flash");

// f.req 表单体：f.req 恒在，at 仅配置 xsrfToken 时追加
const bodyNoAt = buildFormBody("你好", resolved, baseConfig);
assert.ok(bodyNoAt.startsWith("f.req="), "f.req 参数应存在");
assert.ok(!bodyNoAt.includes("at="), "未配置 xsrfToken 时不应有 at 参数");

const bodyWithAt = buildFormBody("你好", resolved, { ...baseConfig, xsrfToken: "xyz" });
assert.ok(bodyWithAt.endsWith("&at=xyz"), "配置 xsrfToken 时应追加 at 参数");

// payload 槽位
const payload = buildPayload("test", resolved, baseConfig);
assert.deepEqual(payload[1], ["en"]);
assert.deepEqual(payload[17], [[4]], "think 深度嵌套在列表中");
assert.deepEqual(payload[41], [2], "默认持久化 [2]");
assert.equal(payload[79], 1, "mode id 写入 [79]");
assert.equal(typeof payload[59], "string", "[59] 应为主机 uuid");

const temporaryPayload = buildPayload("test", resolveModel("gemini-3.7-flash"), {
  ...baseConfig,
  temporaryChats: true,
});
assert.deepEqual(temporaryPayload[41], [1]);
assert.equal(temporaryPayload[45], 1);

// SAPISIDHASH 格式
assert.match(buildSapisidHash("xxx"), /^SAPISIDHASH \d+_[0-9a-f]{40}$/u);

// cleanText
assert.equal(cleanRelayText("abc```python?code_reference&code_event_index=1\nprint(1)\n```def"), "abcdef");
assert.equal(cleanRelayText("  x  "), "x");

// wrb.fr 行解析：多个片段中取最长（python generate 的非流式语义）
const raw = buildWrbLine("内容A", "内容B更长");
assert.equal(extractResponseText(raw), "内容B更长", "应取最长片段");

function buildWrbLine(...fragments: string[]): string {
  // 与 python 解析逻辑一致：line 为数组，arr[0] 是包裹数组且 arr[0][2] 为内层 JSON 串，
  // arr[0][1] == "wrb.fr"（满足 '"wrb.fr"' 过滤）。
  const innerPayload: unknown[] = new Array(9).fill(null);
  innerPayload[4] = fragments.map((fragment) => [null, [fragment]]);
  const arr = [[null, "wrb.fr", JSON.stringify(innerPayload), null, null]];
const lineText = JSON.stringify(arr);
  // padding 到满足 len >= 200 的过滤条件
  return lineText.padEnd(200 + lineText.length, " ");
}

// 上游 HTTP 错误或 200 空响应都不能被包装成“成功但空正文”。否则下游
// pi-agent 会收到 stop 但没有 text，最终只能发通用失败语句，也无法触发备用线路。
{
  await assert.rejects(
    generateRelayText("空响应测试", resolved, {
      ...baseConfig,
      fetchFn: () => Promise.resolve(new Response("", { status: 200 })),
    }),
    /no parseable text/u,
    "HTTP 200 空响应应被视为上游失败",
  );
  await assert.rejects(
    generateRelayText("HTTP 错误测试", resolved, {
      ...baseConfig,
      fetchFn: () => Promise.resolve(new Response("upstream unavailable", { status: 503 })),
    }),
    /HTTP 503/u,
    "上游非 2xx 响应应保留状态码并触发失败",
  );
}

// 回归用：上游返回 Response（连接建立）后 body 永久挂起（长内容/代理推流缓慢），
// 此时 generateRelayText 必须在短超时内抛错，而不是让整个下游会话永久卡死。
// 这正是——修复前 fetchWithTimeout 只在拿到 Response 头部后 clearTimeout，
// 之后 response.text() 读取 body 不再受超时保护——所复现的 bug。
{
  const hangsForeverFetch = (url: string | URL, init?: RequestInit): Promise<Response> => {
    const body = new ReadableStream({
      start(controller) {
        // fetchRelayBody 传入的 signal 被 abort 时，终止 body 流 → response.text() reject。
        init?.signal?.addEventListener("abort", () => controller.error(new Error("request aborted by timeout")));
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };

  const started = Date.now();
  let threw = false;
  try {
    await generateRelayText("写一个很长的恐怖故事（用于触发长响应挂起）", resolved, {
      ...baseConfig,
      requestTimeoutSec: 1,
      retryAttempts: 1,
      retryDelaySec: 0,
      fetchFn: hangsForeverFetch,
    });
  } catch {
    threw = true;
  }
  const elapsed = Date.now() - started;
  assert.ok(threw, "body 读取永久挂起时应在 requestTimeoutSec 后超时抛错，而不是无限等待");
  assert.ok(elapsed < 8000, `body 读取应在短超时内结束，而非永久 hang（耗时 ${elapsed}ms）`);
  console.log(`✅ generateRelayText 在 body 读取挂起时，于 ${elapsed}ms 内超时（不再无限卡死）`);
}

console.log("✅ Gemini relay upstream 序列化与解析测试通过");
