/**
 * Agent 发起的 HTTP(S) 请求目标校验。
 *
 * browse / watch_url 等工具会用宿主网络去请求用户指定的 URL。普通用户不允许
 * 指向本机或内网地址（SSRF：借 bot 之口探测/读取内网服务）；管理员明确可信，
 * 允许访问内网（运维场景常见）。
 */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?(fe80|fc00|fd00):/i,
  /\.local$/i,
  /\.internal$/i,
];

export type UrlGuardOptions = {
  /** 管理员可放行内网/本机地址（默认拒绝）。 */
  allowLocalNetwork?: boolean;
};

export function parseFetchableHttpUrl(rawUrl: string, options: UrlGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error(`无效的 URL：${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只允许 http/https 协议的 URL。");
  }
  if (!options.allowLocalNetwork && isLocalNetworkHost(url.hostname)) {
    throw new Error(`不允许访问本机或内网地址：${url.hostname}（如确有必要请联系管理员执行）。`);
  }
  return url;
}

function isLocalNetworkHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(bare));
}
