import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  BotMessage,
  NotifyTarget,
  OneBotConfig,
  OneBotInboundEvent,
  OneBotMessageSegment,
  TargetType,
} from "./types.js";
import { decodeMediaId, encodeMediaId, mediaPlaceholder } from "./media-ids.js";

const FORWARD_THRESHOLD = 3000;
const FORWARD_CHUNK_SIZE = 4000;

type PendingAction = {
  action: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type OneBotEvents = {
  message: [message: BotMessage];
  request: [event: { requestType: string; userId: string; flag: string; comment: string }];
  connected: [];
  disconnected: [];
  error: [error: Error];
};

export class OneBotClient extends EventEmitter<OneBotEvents> {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private manuallyClosed = false;
  private pendingActions = new Map<string, PendingAction>();
  private botInfo: { userId: string; nickname: string } | null = null;
  /** 媒体文件本地路径缓存：fileId -> path */
  private mediaFileCache = new Map<string, string>();

  constructor(private readonly config: OneBotConfig) {
    super();
  }

  start() {
    this.manuallyClosed = false;
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.connect();
  }

  stop() {
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rejectPendingActions("client stopped");
    this.socket?.close();
    this.socket = undefined;
  }

  isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async waitUntilConnected(timeoutMs = this.config.connectionTimeoutMs) {
    if (this.isConnected()) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("等待 NapCat WebSocket 连接超时。"));
      }, timeoutMs);
      const onConnected = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("connected", onConnected);
      };
      this.on("connected", onConnected);
    });
  }

  async sendText(target: NotifyTarget, text: string) {
    if (text.length > FORWARD_THRESHOLD) {
      await this.sendForwardMessage(target, text);
      return;
    }
    const segments = safeCqToSegments(text);
    await this.sendSegments(target, segments);
  }

  async sendForwardMessage(target: NotifyTarget, text: string) {
    const botInfo = await this.ensureBotInfo();
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += FORWARD_CHUNK_SIZE) {
      chunks.push(text.slice(i, i + FORWARD_CHUNK_SIZE));
    }
    const nodes: OneBotMessageSegment[] = chunks.map((chunk) => ({
      type: "node",
      data: {
        name: botInfo.nickname,
        uin: botInfo.userId,
        content: [{ type: "text", data: { text: chunk } }],
      },
    }));
    if (target.type === "group") {
      await this.sendAction("send_group_forward_msg", { group_id: target.id, messages: nodes });
    } else {
      await this.sendAction("send_private_forward_msg", { user_id: target.id, messages: nodes });
    }
  }

  private async ensureBotInfo(): Promise<{ userId: string; nickname: string }> {
    if (this.botInfo) return this.botInfo;
    try {
      const info = await this.getLoginInfo();
      this.botInfo = { userId: info.userId, nickname: info.nickname ?? "Bot" };
    } catch {
      this.botInfo = { userId: "0", nickname: "Bot" };
    }
    return this.botInfo;
  }

  async sendImage(target: NotifyTarget, filePath: string, caption?: string) {
    const message: OneBotMessageSegment[] = [];
    if (caption?.trim()) message.push({ type: "text", data: { text: `${caption.trim()}\n` } });
    message.push({ type: "image", data: { file: filePath } });
    await this.sendSegments(target, message);
  }

  async sendVoice(target: NotifyTarget, filePath: string) {
    const message: OneBotMessageSegment[] = [{ type: "record", data: { file: filePath } }];
    await this.sendSegments(target, message);
  }

  async sendFile(target: NotifyTarget, filePath: string, name?: string) {
    const message: OneBotMessageSegment[] = [{
      type: "file",
      data: {
        file: filePath,
        name: name ?? filePath.split(/[\\/]/).pop(),
      },
    }];
    await this.sendSegments(target, message);
  }

  async sendSegments(target: NotifyTarget, message: OneBotMessageSegment[]) {
    if (target.type === "group") {
      await this.sendAction("send_group_msg", { group_id: target.id, message });
      return;
    }
    await this.sendAction("send_private_msg", { user_id: target.id, message });
  }

  async sendAction(action: string, params: Record<string, unknown>) {
    if (!this.isConnected() || !this.socket) {
      throw new Error("NapCat WebSocket 未连接。");
    }

    const echo = randomUUID();
    const payload = JSON.stringify({ action, params, echo });
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(echo);
        reject(new Error(`OneBot action ${action} 超时 (${this.config.actionTimeoutMs}ms)。`));
      }, this.config.actionTimeoutMs);
      this.pendingActions.set(echo, { action, resolve, reject, timer });
    });

    this.socket.send(payload, (error) => {
      if (!error) return;
      const pending = this.pendingActions.get(echo);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingActions.delete(echo);
      pending.reject(error);
    });
    return result;
  }

  async getLoginInfo(): Promise<{ userId: string; nickname?: string }> {
    const result = await this.sendAction("get_login_info", {});
    const data = extractActionData(result);
    return {
      userId: String(data.user_id ?? ""),
      nickname: typeof data.nickname === "string" ? data.nickname : undefined,
    };
  }

  async getGroupInfo(groupId: string): Promise<{ groupId: string; groupName?: string }> {
    const result = await this.sendAction("get_group_info", { group_id: groupId, no_cache: false });
    const data = extractActionData(result);
    return {
      groupId: String(data.group_id ?? groupId),
      groupName: typeof data.group_name === "string" ? data.group_name : undefined,
    };
  }

  async getStrangerInfo(userId: string): Promise<{ userId: string; nickname?: string }> {
    const result = await this.sendAction("get_stranger_info", { user_id: userId, no_cache: false });
    const data = extractActionData(result);
    return {
      userId: String(data.user_id ?? userId),
      nickname: typeof data.nickname === "string" ? data.nickname : undefined,
    };
  }

  async getGroupMemberInfo(groupId: string, userId: string): Promise<{ userId: string; nickname?: string; card?: string; role?: string }> {
    const result = await this.sendAction("get_group_member_info", { group_id: groupId, user_id: userId, no_cache: false });
    const data = extractActionData(result);
    return {
      userId: String(data.user_id ?? userId),
      nickname: typeof data.nickname === "string" ? data.nickname : undefined,
      card: typeof data.card === "string" ? data.card : undefined,
      role: typeof data.role === "string" ? data.role : undefined,
    };
  }

  async getFriendList(): Promise<Array<{ userId: string; nickname?: string; remark?: string }>> {
    const result = await this.sendAction("get_friend_list", {});
    if (!result || typeof result !== "object") return [];
    const data = (result as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    return data.map((entry: Record<string, unknown>) => ({
      userId: String(entry.user_id ?? ""),
      nickname: typeof entry.nickname === "string" ? entry.nickname : undefined,
      remark: typeof entry.remark === "string" ? entry.remark : undefined,
    }));
  }

  async isFriend(userId: string): Promise<boolean> {
    const friends = await this.getFriendList();
    return friends.some((f) => f.userId === userId);
  }

  async getGroupList(): Promise<Array<{ groupId: string; groupName?: string; memberCount?: number }>> {
    const result = await this.sendAction("get_group_list", {});
    if (!result || typeof result !== "object") return [];
    const data = (result as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    return data.map((entry: Record<string, unknown>) => ({
      groupId: String(entry.group_id ?? ""),
      groupName: typeof entry.group_name === "string" ? entry.group_name : undefined,
      memberCount: typeof entry.member_count === "number" ? entry.member_count : undefined,
    }));
  }

  async getMessage(messageId: string): Promise<BotMessage | null> {
    try {
      const result = await this.sendAction("get_msg", { message_id: messageId });
      const data = extractActionData(result);
      if (!data || typeof data !== "object") return null;
      const event: OneBotInboundEvent = {
        post_type: "message",
        message_type: String(data.message_type ?? "") as TargetType,
        self_id: data.self_id as OneBotInboundEvent["self_id"],
        user_id: data.user_id as OneBotInboundEvent["user_id"],
        group_id: data.group_id as OneBotInboundEvent["group_id"],
        message_id: data.message_id as OneBotInboundEvent["message_id"],
        message: data.message as OneBotInboundEvent["message"],
        raw_message: typeof data.raw_message === "string" ? data.raw_message : undefined,
        sender: data.sender,
      };
      return mapInboundMessage(event) ?? null;
    } catch (error) {
      console.error(`[OneBot] 获取消息 ${messageId} 失败:`, error);
      return null;
    }
  }

  async getForwardMessage(forwardId: string): Promise<OneBotMessageSegment[] | null> {
    try {
      const result = await this.sendAction("get_forward_msg", { message_id: forwardId, id: forwardId });
      const data = extractActionData(result);
      if (!data || typeof data !== "object") return null;
      const messages = (data as { messages?: unknown }).messages ?? (data as { message?: unknown }).message;
      if (!Array.isArray(messages)) return null;
      return messages
        .filter((m: unknown) => m && typeof m === "object")
        .map((m: Record<string, unknown>) => ({
          type: String(m.type ?? ""),
          data: (m.data ?? {}) as Record<string, unknown>,
        }));
    } catch (error) {
      console.error(`[OneBot] 获取转发消息 ${forwardId} 失败:`, error);
      return null;
    }
  }

  async getForwardMessageText(forwardId: string, maxChars = 2000): Promise<string | null> {
    const segments = await this.getForwardMessage(forwardId);
    if (!segments) return null;

    const lines: string[] = [];
    let total = 0;
    for (const seg of segments) {
      const event: OneBotInboundEvent = {
        post_type: "message",
        message_type: "group",
        message: [seg],
      };
      const line = extractText(event);
      if (!line) continue;
      if (total + line.length > maxChars) {
        const remain = maxChars - total;
        if (remain > 0) {
          lines.push(line.slice(0, remain) + "...");
        }
        break;
      }
      lines.push(line);
      total += line.length;
    }

    return lines.length > 0 ? lines.join("\n") : null;
  }

  async getImageFile(file: string): Promise<string | null> {
    return this.getMediaFile("get_image", file);
  }

  async getRecordFile(file: string): Promise<string | null> {
    return this.getMediaFile("get_record", file);
  }

  async getVideoFile(file: string): Promise<string | null> {
    return this.getMediaFile("get_video", file);
  }

  private async getMediaFile(action: string, file: string): Promise<string | null> {
    const cacheKey = `${action}:${file}`;
    const cached = this.mediaFileCache.get(cacheKey);
    if (cached) return cached;

    try {
      const result = await this.sendAction(action, { file });
      const data = extractActionData(result);
      if (!data || typeof data !== "object") return null;
      const path = (data as { file?: string }).file ?? (data as { path?: string }).path;
      if (typeof path !== "string") return null;
      this.mediaFileCache.set(cacheKey, path);
      return path;
    } catch (error) {
      console.error(`[OneBot] ${action} 失败:`, error);
      return null;
    }
  }

  async downloadFileToBase64(filePath: string): Promise<string | null> {
    try {
      const fs = await import("node:fs/promises");
      const buffer = await fs.readFile(filePath);
      return buffer.toString("base64");
    } catch (error) {
      console.error(`[OneBot] 读取本地文件 ${filePath} 失败:`, error);
      return null;
    }
  }

  private connect() {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;

    const headers = this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : undefined;
    const url = appendAccessToken(this.config.url, this.config.accessToken);
    const socket = new WebSocket(url, { headers });
    this.socket = socket;

    socket.on("open", () => {
      console.log("[OneBot] 已连接到 NapCat");
      this.emit("connected");
    });
    socket.on("message", (payload) => this.handlePayload(payload.toString()));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.rejectPendingActions("WebSocket 连接关闭");
      this.emit("disconnected");
      if (!this.manuallyClosed) this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    console.log(`[OneBot] ${this.config.reconnectIntervalMs}ms 后重连...`);
    this.reconnectTimer = setTimeout(() => this.connect(), this.config.reconnectIntervalMs);
  }

  private handlePayload(payload: string) {
    const parsed = safeJsonParse(payload);
    if (!parsed) return;

    // 检查是否为 action 响应
    const echo = typeof parsed.echo === "string" ? parsed.echo : undefined;
    if (echo && this.pendingActions.has(echo)) {
      const pending = this.pendingActions.get(echo)!;
      clearTimeout(pending.timer);
      this.pendingActions.delete(echo);
      const retcode = typeof parsed.retcode === "number" ? parsed.retcode : undefined;
      if (parsed.status === "failed" || (retcode !== undefined && retcode !== 0)) {
        pending.reject(new Error(`OneBot action 失败: ${JSON.stringify(parsed)}`));
      } else {
        pending.resolve(parsed);
      }
      return;
    }

    // 作为入站消息事件处理
    const message = mapInboundMessage(parsed);
    if (message) {
      this.emit("message", message);
      return;
    }

    // 好友/群请求事件
    if (parsed.post_type === "request") {
      this.emit("request", {
        requestType: String(parsed.request_type ?? ""),
        userId: String(parsed.user_id ?? ""),
        flag: String(parsed.flag ?? ""),
        comment: String(parsed.comment ?? ""),
      });
      return;
    }
  }

  private rejectPendingActions(reason: string) {
    for (const [echo, pending] of this.pendingActions) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`OneBot action ${pending.action} (${echo}) 取消: ${reason}`));
    }
    this.pendingActions.clear();
  }
}

function appendAccessToken(url: string, accessToken: string) {
  if (!accessToken) return url;
  const parsed = new URL(url);
  if (!parsed.searchParams.has("access_token")) parsed.searchParams.set("access_token", accessToken);
  return parsed.toString();
}

function safeJsonParse(payload: string): OneBotInboundEvent | undefined {
  try {
    return JSON.parse(payload) as OneBotInboundEvent;
  } catch {
    return undefined;
  }
}

function extractActionData(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return {};
  }

  const data = (result as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return {};
  }

  return data as Record<string, unknown>;
}

function mapInboundMessage(event: OneBotInboundEvent): BotMessage | undefined {
  if (event.post_type !== "message" || (event.message_type !== "private" && event.message_type !== "group")) return undefined;
  return {
    id: event.message_id?.toString(),
    type: event.message_type,
    selfId: event.self_id?.toString(),
    userId: event.user_id?.toString(),
    groupId: event.group_id?.toString(),
    text: extractText(event),
    replyToMessageId: extractReplyToMessageId(event),
    forwardId: extractForwardId(event),
    raw: event,
  };
}

function extractText(event: OneBotInboundEvent) {
  if (Array.isArray(event.message)) {
    return event.message
      .map((segment) => {
        if (segment.type === "text") return String(segment.data.text ?? "");
        if (segment.type === "at") return `@${String(segment.data.qq ?? "")}`;
        if (segment.type === "reply") return "";
        if (segment.type === "image") {
          return mediaPlaceholder("图片", String(segment.data.file ?? ""));
        }
        if (segment.type === "xml") return parseXmlCard(String(segment.data.data ?? ""));
        if (segment.type === "json") return parseJsonCard(String(segment.data.data ?? ""));
        if (segment.type === "share") {
          const title = String(segment.data.title ?? "").trim();
          const content = String(segment.data.content ?? "").trim();
          const url = String(segment.data.url ?? "").trim();
          const parts = [title, content, url].filter(Boolean);
          return parts.length > 0 ? `[分享] ${parts.join(" - ")}` : "[分享]";
        }
        if (segment.type === "forward") {
          const id = String(segment.data.id ?? "");
          return id ? `[合并转发消息 id=${id}]` : "[合并转发消息]";
        }
        if (segment.type === "contact") {
          const contactType = segment.data.type === "group" ? "群" : "用户";
          return `[推荐${contactType}：${String(segment.data.id ?? "")}]`;
        }
        if (segment.type === "location") {
          const title = String(segment.data.title ?? "").trim();
          return title ? `[位置] ${title}` : "[位置分享]";
        }
        if (segment.type === "face") return mediaPlaceholder("表情", String(segment.data.id ?? ""));
        if (segment.type === "video") return mediaPlaceholder("视频", String(segment.data.file ?? ""));
        if (segment.type === "record") return mediaPlaceholder("语音", String(segment.data.file ?? ""));
        if (segment.type === "file") {
          const name = String(segment.data.name ?? "").trim();
          const fileId = String(segment.data.file ?? "");
          return name ? `[文件 file=${encodeMediaId(fileId)}：${name}]` : mediaPlaceholder("文件", fileId);
        }
        return `[未知消息类型：${segment.type}]`;
      })
      .join("")
      .trim();
  }
  if (typeof event.message === "string") return cqStringToText(event.message);
  if (event.raw_message) return cqStringToText(event.raw_message);
  return "";
}

function extractReplyToMessageId(event: OneBotInboundEvent): string | undefined {
  if (Array.isArray(event.message)) {
    for (const segment of event.message) {
      if (segment.type === "reply") {
        const id = segment.data.id;
        if (typeof id === "string" || typeof id === "number") {
          return String(id);
        }
      }
    }
    return undefined;
  }

  const source = typeof event.message === "string" ? event.message : event.raw_message;
  if (!source) return undefined;

  const match = source.match(/\[CQ:reply(?:,[^\]]*)?,id=(\d+)[^\]]*\]/i);
  if (match) {
    return match[1];
  }
  return undefined;
}

function extractForwardId(event: OneBotInboundEvent): string | undefined {
  if (Array.isArray(event.message)) {
    for (const segment of event.message) {
      if (segment.type === "forward") {
        const id = segment.data.id;
        if (typeof id === "string" || typeof id === "number") {
          return String(id);
        }
      }
    }
    return undefined;
  }

  const source = typeof event.message === "string" ? event.message : event.raw_message;
  if (!source) return undefined;

  const match = source.match(/\[CQ:forward(?:,[^\]]*)?,id=([^,\]]+)[^\]]*\]/i);
  if (match) {
    return match[1];
  }
  return undefined;
}

function parseXmlCard(xmlString: string): string {
  if (!xmlString) return "";

  const prompt = extractXmlAttribute(xmlString, "prompt");
  const title = extractXmlItemAttribute(xmlString, "title");
  const summary = extractXmlItemAttribute(xmlString, "summary");
  const url = extractXmlItemAttribute(xmlString, "url");

  const parts = [prompt, title, summary, url].filter((v) => v && v.trim());
  if (parts.length === 0) {
    // 兜底：提取所有纯文本内容
    const textContent = xmlString
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return textContent ? `[卡片消息] ${textContent}` : "";
  }
  return `[卡片消息] ${parts.join(" | ")}`;
}

function extractXmlAttribute(xml: string, attr: string): string {
  const match = xml.match(new RegExp(`${attr}="([^"]*)"`, "i"));
  return match ? decodeXmlEntities(match[1]) : "";
}

function extractXmlItemAttribute(xml: string, attr: string): string {
  // 匹配 <item ... attr="value"> 或直接 attr="value"
  const patterns = [
    new RegExp(`${attr}="([^"]*)"`, "i"),
    new RegExp(`<item[^>]*${attr}="([^"]*)"`, "i"),
  ];
  for (const pattern of patterns) {
    const match = xml.match(pattern);
    if (match) return decodeXmlEntities(match[1]);
  }
  return "";
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseJsonCard(jsonString: string): string {
  if (!jsonString) return "";
  try {
    const data = JSON.parse(jsonString);
    const desc = String(data.desc ?? "").trim();
    const prompt = String(data.prompt ?? "").trim();
    const meta = data.meta ?? {};

    // 小程序卡片通常有 meta.detail_1 或 meta.news
    const detail = meta.detail_1 ?? meta.news ?? meta.music ?? {};
    const title = String(detail.title ?? "").trim();
    const summary = String(detail.desc ?? detail.summary ?? "").trim();
    const qqdocurl = String(detail.qqdocurl ?? detail.jumpUrl ?? detail.url ?? "").trim();

    const parts = [prompt, desc, title, summary, qqdocurl].filter((v) => v && v !== "undefined");
    if (parts.length === 0) return "[小程序消息]";
    return `[小程序] ${parts.join(" | ")}`;
  } catch {
    return "[小程序消息]";
  }
}

/**
 * 将可能包含 CQ 码的文本转换为安全的消息段数组。
 * 例如 "回复 [CQ:at,qq=123] 你好" → [text("回复 "), at(123), text(" 你好")]
 */
function safeCqToSegments(value: string): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];
  const cqRegex = /\[CQ:([a-zA-Z0-9_]+),([^\]]*)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = cqRegex.exec(value)) !== null) {
    // CQ 码之前的纯文本
    if (match.index > lastIndex) {
      const plain = value.slice(lastIndex, match.index);
      if (plain) segments.push({ type: "text", data: { text: plain } });
    }

    const cqType = match[1];
    const params = parseCqParams(match[2]);
    lastIndex = match.index + match[0].length;

    if (cqType === "at") {
      segments.push({ type: "at", data: { qq: params.qq ?? "" } });
      continue;
    }
    if (cqType === "reply") {
      segments.push({ type: "reply", data: { id: params.id ?? "" } });
      continue;
    }
    if (cqType === "image") {
      segments.push({ type: "image", data: { file: params.file ?? "" } });
      continue;
    }

    // 不识别的 CQ 码也保留为文本，避免直接丢弃用户消息
    segments.push({ type: "text", data: { text: match[0] } });
  }

  // 末尾剩余的纯文本
  if (lastIndex < value.length) {
    segments.push({ type: "text", data: { text: value.slice(lastIndex) } });
  }

  return segments.length > 0 ? segments : [{ type: "text", data: { text: value } }];
}

function cqStringToText(value: string) {
  return value
    .replace(/\[CQ:at,qq=([^,\]]+)[^\]]*\]/g, (_match, qq: string) => `@${qq}`)
    .replace(/\[CQ:reply,[^\]]+\]/g, "")
    .replace(/\[CQ:image,([^\]]*)\]/g, (_match, params: string) => {
      const p = parseCqParams(params);
      return mediaPlaceholder("图片", p.file);
    })
    .replace(/\[CQ:xml,data=([^\]]*)\]/g, (_match, data: string) => {
      const decoded = decodeCqData(data);
      return parseXmlCard(decoded);
    })
    .replace(/\[CQ:json,data=([^\]]*)\]/g, (_match, data: string) => {
      const decoded = decodeCqData(data);
      return parseJsonCard(decoded);
    })
    .replace(/\[CQ:share,([^\]]*)\]/g, (_match, params: string) => {
      const p = parseCqParams(params);
      const parts = [p.title, p.content, p.url].filter(Boolean);
      return parts.length > 0 ? `[分享] ${parts.join(" - ")}` : "[分享]";
    })
    .replace(/\[CQ:forward,id=([^,\]]+)[^\]]*\]/g, (_match, id: string) => `[合并转发消息 id=${id}]`)
    .replace(/\[CQ:forward,[^\]]*\]/g, "[合并转发消息]")
    .replace(/\[CQ:contact,([^\]]*)\]/g, (_match, params: string) => {
      const p = parseCqParams(params);
      const contactType = p.type === "group" ? "群" : "用户";
      return `[推荐${contactType}：${p.id ?? ""}]`;
    })
    .replace(/\[CQ:location,([^\]]*)\]/g, (_match, params: string) => {
      const p = parseCqParams(params);
      return p.title ? `[位置] ${p.title}` : "[位置分享]";
    })
    .replace(/\[CQ:face,([^\]]*)\]/g, (_match, params: string) =>
      mediaPlaceholder("表情", parseCqParams(params).id)
    )
    .replace(/\[CQ:video,([^\]]*)\]/g, (_match, params: string) =>
      mediaPlaceholder("视频", parseCqParams(params).file)
    )
    .replace(/\[CQ:record,([^\]]*)\]/g, (_match, params: string) =>
      mediaPlaceholder("语音", parseCqParams(params).file)
    )
    .replace(/\[CQ:file,([^\]]*)\]/g, (_match, params: string) => {
      const p = parseCqParams(params);
      const fileId = p.file ?? "";
      return p.name ? `[文件 file=${encodeMediaId(fileId)}：${p.name}]` : mediaPlaceholder("文件", fileId);
    })
    .replace(/\[CQ:([a-zA-Z0-9_]+),?[^\]]*\]/g, (_match, type: string) => `[未知消息类型：${type}]`)
    .trim();
}

function decodeCqData(data: string): string {
  try {
    // CQ code data may be HTML-escaped or use &#44; for commas
    return data
      .replace(/&#44;/g, ",")
      .replace(/&#91;/g, "[")
      .replace(/&#93;/g, "]")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  } catch {
    return data;
  }
}

function parseCqParams(params: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of params.split(",")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      const key = pair.slice(0, eqIdx).trim();
      const value = decodeCqData(pair.slice(eqIdx + 1).trim());
      result[key] = value;
    }
  }
  return result;
}
