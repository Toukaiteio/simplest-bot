import fs from "node:fs";
import path from "node:path";
import { fetch } from "undici";
import QRCode from "qrcode";
import { eapiEncrypt } from "./netease-crypto.js";
import { screenshotHtml } from "../mmorpg/screenshot.js";
import type { Plugin, PluginContext, BotMessage, MenuPlugin } from "../../types.js";
import type { OneBotClient } from "../../onebot.js";
import type { MessageStore, ChatMessageRecord } from "../../message-store.js";

// ── Types ──

type NeteaseTrack = {
  id: number;
  name: string;
  artists: string;
  album: string;
  picUrl: string;
  duration: number;
};

type SearchCache = {
  query: string;
  tracks: NeteaseTrack[];
  page: number;
  timestamp: number;
};

type DailyRec = {
  userId: string;
  date: string;
  count: number;
  recs: Array<{
    track: NeteaseTrack;
    reason: string;
    timestamp: number;
  }>;
};

const MAX_DAILY_RECS = 3;

type RecommendDeps = {
  messageStore: MessageStore;
  askLlm: (systemPrompt: string, userPrompt: string) => Promise<string>;
};

// ── Constants ──

const UA = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/2.10.2.200154";
const API_BASE = "https://interface3.music.163.com";
const CACHE_FILE = path.resolve("data", "ncm", "search-cache.json");
const COOKIE_FILE = path.resolve("data", "ncm", "cookies.json");
const DAILY_RECS_FILE = path.resolve("data", "ncm", "daily-recs.json");
const DATA_DIR = path.resolve("data", "ncm");

// ── Storage ──

function loadDailyRecs(): Record<string, DailyRec> {
  try {
    if (!fs.existsSync(DAILY_RECS_FILE)) return {};
    return JSON.parse(fs.readFileSync(DAILY_RECS_FILE, "utf-8"));
  } catch { return {}; }
}

function saveDailyRecs(recs: Record<string, DailyRec>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DAILY_RECS_FILE, JSON.stringify(recs, null, 2), "utf-8");
}

function loadCache(): Record<string, SearchCache> {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch { return {}; }
}

function saveCache(cache: Record<string, SearchCache>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

function loadCookies(): Record<string, string> {
  try {
    if (!fs.existsSync(COOKIE_FILE)) return {};
    return JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
  } catch { return {}; }
}

function saveCookies(cookies: Record<string, string>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2), "utf-8");
}

function cookieString(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([k, v]) => k + "=" + v).join("; ");
}

function parseSetCookie(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const h of headers) {
    const parts = h.split(";")[0].trim();
    const eqIdx = parts.indexOf("=");
    if (eqIdx > 0) result[parts.slice(0, eqIdx)] = parts.slice(eqIdx + 1);
  }
  return result;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m + ":" + String(sec).padStart(2, "0");
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isToday(timestamp: number): boolean {
  const d = new Date();
  const t = new Date(timestamp);
  return d.getFullYear() === t.getFullYear()
    && d.getMonth() === t.getMonth()
    && d.getDate() === t.getDate();
}

// ── NetEase API ──

async function apiPost(path: string, data: Record<string, unknown>): Promise<unknown> {
  const cookies = loadCookies();
  const url = API_BASE + path;
  const encrypted = eapiEncrypt(path, data);
  const body = "params=" + encodeURIComponent(encrypted);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieString(cookies),
      Referer: "https://music.163.com",
    },
    body,
  });

  const setCookieHeaders = resp.headers.getSetCookie?.() ?? [];
  if (setCookieHeaders.length > 0) {
    const merged = { ...loadCookies(), ...parseSetCookie(setCookieHeaders) };
    saveCookies(merged);
  }

  const text = await resp.text();
  return JSON.parse(text);
}

async function searchNetease(query: string, limit = 8, offset = 0): Promise<NeteaseTrack[]> {
  const result = await apiPost("/eapi/cloudsearch/pc", {
    s: query,
    type: 1,
    limit,
    offset,
    header: { os: "pc", appver: "2.10.2.200154" },
  }) as { result?: { songs?: Array<{ id: number; name: string; ar: Array<{ name: string }>; al: { name: string; picUrl: string }; dt: number }> } };

  const songs = result?.result?.songs ?? [];
  return songs.map((s) => ({
    id: s.id,
    name: s.name,
    artists: s.ar.map((a) => a.name).join(" / "),
    album: s.al.name,
    picUrl: s.al.picUrl,
    duration: s.dt,
  }));
}

async function getTrackDetail(trackId: number): Promise<NeteaseTrack | null> {
  try {
    const result = await apiPost("/eapi/v3/song/detail", {
      c: JSON.stringify([{ id: trackId }]),
      header: { os: "pc", appver: "2.10.2.200154" },
    }) as { songs?: Array<{ id: number; name: string; ar: Array<{ name: string }>; al: { name: string; picUrl: string }; dt: number }> };

    const s = result?.songs?.[0];
    if (s) {
      return {
        id: s.id,
        name: s.name,
        artists: s.ar.map((a) => a.name).join(" / "),
        album: s.al.name,
        picUrl: s.al.picUrl,
        duration: s.dt,
      };
    }
  } catch (e) {
    console.error("Failed to fetch track detail:", e);
  }
  return null;
}

async function getStreamUrl(trackId: number): Promise<string | null> {
  const result = await apiPost("/eapi/song/enhance/player/url/v1", {
    ids: [trackId],
    level: "standard",
    encodeType: "mp3",
    header: { os: "pc", appver: "2.10.2.200154" },
  }) as { data?: Array<{ url: string | null; code: number }> };

  const entry = result?.data?.[0];
  if (entry?.code === 200 && entry?.url) return entry.url;
  if (entry?.code === -110) return null; // needs login
  return null;
}

async function getQrKey(): Promise<string | null> {
  const result = await apiPost("/eapi/login/qrcode/unikey", {
    type: 1,
    header: { os: "pc", appver: "2.10.2.200154" },
  }) as { unikey?: string };
  return result?.unikey ?? null;
}

async function pollQrStatus(unikey: string): Promise<{ code: number; msg?: string }> {
  const result = await apiPost("/eapi/login/qrcode/client/login", {
    type: 1,
    key: unikey,
    header: { os: "pc", appver: "2.10.2.200154" },
  }) as { code?: number; message?: string };
  return { code: result?.code ?? -1, msg: result?.message };
}

// ── 每日推荐核心逻辑 ──

/**
 * 基于用户近期的发言和已知记忆，让 LLM 推荐一首歌，然后去网易云搜索并返回。
 */
async function generateDailyRecommendation(
  userId: string,
  deps: RecommendDeps,
): Promise<{ track: NeteaseTrack; reason: string } | null> {
  try {
    // 1. 获取用户最近发言（非 bot 消息）
    const recentMessages = deps.messageStore.queryMessages({
      userId,
      limit: 30,
      order: "desc",
    }).filter(m => !m.isBot).reverse();

    // 2. 获取用户记忆
    const memories = deps.messageStore.getAllUserFacts(userId);

    // 3. 构建 LLM prompt
    const recentText = recentMessages.length > 0
      ? recentMessages.map(m => m.text).join("\n").slice(0, 2000)
      : "(暂无最近的发言记录)";

    const memoryText = memories.length > 0
      ? memories.map(m => m.content).join("\n").slice(0, 1000)
      : "(暂无用户画像)";

    const systemPrompt = `你是一个音乐推荐助手。你的任务是根据用户的最近发言和已知用户画像，推荐一首最适合该用户当前心情、处境或喜好的歌曲。

规则：
- 只推荐一首歌
- 返回格式：歌曲名 - 歌手名|推荐理由
- 推荐理由 20 字以内，简洁自然
- 优先推荐华语流行、经典、或与用户发言主题相关的歌曲
- 不要推荐过于冷门或生僻的歌曲
- 歌曲和歌手必须在网易云音乐中存在`;

    const userPrompt = `【用户最近发言】
${recentText}

【用户画像/已知信息】
${memoryText}

请根据以上信息推荐一首合适的歌曲。`;

    // 4. 调用 LLM
    const llmResult = await deps.askLlm(systemPrompt, userPrompt);
    if (!llmResult.trim()) return null;

    // 5. 解析结果：格式 "歌曲名 - 歌手名|推荐理由"
    const pipeIdx = llmResult.lastIndexOf("|");
    let songQuery: string;
    let reason: string;

    if (pipeIdx >= 0) {
      songQuery = llmResult.slice(0, pipeIdx).trim();
      reason = llmResult.slice(pipeIdx + 1).trim();
    } else {
      songQuery = llmResult.trim();
      reason = "觉得你会喜欢这首歌";
    }

    // 清理可能的引号、换行
    songQuery = songQuery.replace(/[""""]/g, "").split("\n")[0].trim();
    if (!songQuery) return null;

    // 6. 搜索网易云
    const tracks = await searchNetease(songQuery, 5, 0);
    if (tracks.length === 0) {
      // 尝试只搜索歌曲名部分
      const simpleName = songQuery.split("-")[0]?.trim() || songQuery;
      const fallback = await searchNetease(simpleName, 3, 0);
      if (fallback.length === 0) return null;
      return { track: fallback[0], reason };
    }

    // 找最佳匹配：优先匹配歌手名
    const artistName = songQuery.includes("-") ? songQuery.split("-")[1]?.trim() : "";
    let bestTrack = tracks[0];
    if (artistName) {
      const matched = tracks.find(t =>
        t.artists.toLowerCase().includes(artistName.toLowerCase())
      );
      if (matched) bestTrack = matched;
    }

    return { track: bestTrack, reason };
  } catch (err) {
    console.error(`[NCM-Daily] 为用户 ${userId} 生成推荐失败:`, err);
    return null;
  }
}

// ── HTML card renderers ──

function buildSearchCard(query: string, tracks: NeteaseTrack[], page: number): string {
  const rows = tracks.map((t, i) => {
    const rankCls = i < 3 ? " rank-top rank-top-" + (i + 1) : "";
    return '<div class="trk' + rankCls + '">'
      + '<span class="trk-no">' + (i + 1).toString().padStart(2, "0") + '</span>'
      + '<img class="trk-cover" src="' + escapeHtml(t.picUrl) + '?param=60y60" referrerpolicy="no-referrer" />'
      + '<div class="trk-info"><div class="trk-name">' + escapeHtml(t.name) + '</div>'
      + '<div class="trk-art">' + escapeHtml(t.artists) + '</div></div>'
      + '<div class="trk-right"><span class="trk-dur">' + fmtDuration(t.duration) + '</span>'
      + '<span class="trk-id">ID: ' + t.id + '</span></div>'
      + '</div>';
  }).join("");

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="referrer" content="no-referrer" /><style>'
    + '*{box-sizing:border-box}html,body{margin:0;padding:0;background:#18191c}body{'
    + 'padding:16px;font-family:"Microsoft YaHei","PingFang SC","Helvetica Neue",sans-serif;'
    + 'color:#d0d0d2;font-size:12px;line-height:1.5;-webkit-font-smoothing:antialiased}'
    + '.sheet{width:460px;margin:0 auto;background:#1c1d21;border:1px solid #2d2f34;'
    + 'border-radius:6px;border-top:3px solid #ec4141;padding:16px 14px 12px;'
    + 'box-shadow:0 8px 24px rgba(0,0,0,0.3)}'
    + '.hd{font-size:14px;font-weight:700;padding-bottom:12px;margin-bottom:10px;'
    + 'border-bottom:1px solid #2d2f34;display:flex;align-items:center;gap:8px}'
    + '.hd-title{color:#ffffff;display:flex;align-items:center;gap:6px}'
    + '.hd-title svg{width:16px;height:16px;margin-top:-1px}'
    + '.hd-query{color:#888a91;font-size:11px;font-weight:400;margin-left:auto;'
    + 'background:#2b2c31;padding:2px 8px;border-radius:10px}'
    + '.trk{display:flex;align-items:center;gap:12px;padding:8px 8px;border-radius:4px;'
    + 'margin-bottom:2px;transition:background 0.2s}'
    + '.trk:nth-child(even){background:rgba(255,255,255,0.015)}'
    + '.trk:hover{background:#2c2e33}'
    + '.trk-no{width:20px;color:#616267;font-size:12px;font-weight:700;font-family:monospace;flex-shrink:0;text-align:center}'
    + '.rank-top-1 .trk-no,.rank-top-2 .trk-no,.rank-top-3 .trk-no{color:#ec4141}'
    + '.trk-cover{width:36px;height:36px;border-radius:4px;object-fit:cover;flex-shrink:0;background:#2b2c31}'
    + '.trk-info{flex:1;min-width:0}'
    + '.trk-name{font-size:13px;font-weight:500;color:#e1e1e2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.trk-art{font-size:11px;color:#76787e;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.trk-right{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:2px;flex-shrink:0}'
    + '.trk-dur{font-size:11px;color:#76787e;font-family:monospace}'
    + '.trk-id{font-size:10px;color:#5c5e64;font-family:monospace}'
    + '.ft{color:#76787e;font-size:11px;text-align:center;padding-top:12px;margin-top:10px;'
    + 'border-top:1px solid #2d2f34;font-family:"Microsoft YaHei","PingFang SC",sans-serif}'
    + '</style></head><body><div class="sheet">'
    + '<div class="hd">'
    + '<div class="hd-title">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="#ec4141" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3" fill="#ec4141"/><circle cx="18" cy="16" r="3" fill="#ec4141"/>'
    + '</svg><span>网易云音乐</span></div>'
    + '<span class="hd-query">搜索: ' + escapeHtml(query) + ' (第 ' + page + ' 页)</span></div>'
    + rows
    + '<div class="ft">ncm-play &lt;编号/歌曲ID&gt; 获取播放链接 | ncm-page &lt;页码/next/prev&gt; 翻页</div>'
    + '</div></body></html>';
}

function buildAuthCard(qrDataUrl: string, key: string): string {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><style>'
    + '*{box-sizing:border-box}html,body{margin:0;padding:0;background:#18191c}body{'
    + 'padding:24px;font-family:"Microsoft YaHei","PingFang SC","Helvetica Neue",sans-serif;'
    + 'color:#d0d0d2;font-size:13px;line-height:1.5;text-align:center;-webkit-font-smoothing:antialiased}'
    + '.sheet{width:340px;margin:0 auto;background:#1c1d21;border:1px solid #2d2f34;'
    + 'border-top:3px solid #ec4141;border-radius:6px;padding:24px 20px;box-shadow:0 8px 24px rgba(0,0,0,0.3)}'
    + 'img{width:220px;height:220px;border-radius:4px;margin:16px 0;background:#fff;padding:8px;'
    + 'border:1px solid #2d2f34}'
    + '.tip{color:#76787e;font-size:12px;margin-bottom:8px}'
    + '.key{color:#ec4141;font-size:15px;font-weight:700;font-family:"JetBrains Mono","Consolas",monospace}'
    + '</style></head><body><div class="sheet">'
    + '<div style="font-size:15px;font-weight:700;color:#ffffff">扫码登录网易云音乐</div>'
    + '<img src="' + qrDataUrl + '" />'
    + '<div class="tip">请使用网易云音乐 App 扫码</div>'
    + '<div class="key">' + key + '</div>'
    + '</div></body></html>';
}

function buildPlayCard(track: NeteaseTrack, streamUrl: string): string {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="referrer" content="no-referrer" /><style>'
    + '*{box-sizing:border-box}html,body{margin:0;padding:0;background:#18191c}body{'
    + 'padding:20px;font-family:"Microsoft YaHei","PingFang SC","Helvetica Neue",sans-serif;'
    + 'color:#d0d0d2;font-size:12px;line-height:1.5;-webkit-font-smoothing:antialiased}'
    + '.sheet{width:460px;margin:0 auto;background:#1c1d21;border:1px solid #2d2f34;'
    + 'border-radius:8px;border-top:3px solid #ec4141;padding:20px 16px 16px;'
    + 'box-shadow:0 8px 24px rgba(0,0,0,0.3)}'
    + '.top{display:flex;gap:16px;margin-bottom:16px}'
    + '.cover{width:120px;height:120px;border-radius:6px;object-fit:cover;flex-shrink:0;background:#2b2c31}'
    + '.info{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}'
    + '.title{font-size:16px;font-weight:700;color:#ffffff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.artist{font-size:13px;color:#9b9da3;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.album{font-size:11px;color:#76787e;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.dur{font-size:11px;color:#5c5e64;font-family:monospace;margin-top:6px}'
    + '.play-btn{background:#ec4141;color:#fff;border:none;border-radius:6px;padding:10px 0;font-size:14px;font-weight:600;text-align:center;margin-bottom:12px;cursor:pointer}'
    + '.url-hint{color:#76787e;font-size:10px;text-align:center;word-break:break-all;padding:8px 4px;background:#2b2c31;border-radius:4px;margin-bottom:8px;overflow:hidden}'
    + '.ft{color:#76787e;font-size:11px;text-align:center;padding-top:12px;border-top:1px solid #2d2f34}'
    + '</style></head><body><div class="sheet">'
    + '<div class="top">'
    + '<img class="cover" src="' + escapeHtml(track.picUrl) + '?param=240y240" referrerpolicy="no-referrer" />'
    + '<div class="info"><div class="title">' + escapeHtml(track.name) + '</div>'
    + '<div class="artist">' + escapeHtml(track.artists) + '</div>'
    + '<div class="album">' + escapeHtml(track.album) + '</div>'
    + '<div class="dur">' + fmtDuration(track.duration) + '</div></div></div>'
    + '<div class="play-btn">播放</div>'
    + '<div class="url-hint">' + escapeHtml(streamUrl) + '</div>'
    + '<div class="ft">ncm-play ' + track.id + ' 获取播放链接</div>'
    + '</div></body></html>';
}

function buildDailyRecCard(track: NeteaseTrack, reason: string, dateStr: string): string {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="referrer" content="no-referrer" /><style>'
    + '*{box-sizing:border-box}html,body{margin:0;padding:0;background:#18191c}body{'
    + 'padding:20px;font-family:"Microsoft YaHei","PingFang SC","Helvetica Neue",sans-serif;'
    + 'color:#d0d0d2;font-size:12px;line-height:1.5;-webkit-font-smoothing:antialiased}'
    + '.sheet{width:460px;margin:0 auto;background:#1c1d21;border:1px solid #2d2f34;'
    + 'border-radius:8px;border-top:3px solid #ec4141;padding:20px 16px 16px;'
    + 'box-shadow:0 8px 24px rgba(0,0,0,0.3)}'
    + '.top{display:flex;gap:16px;margin-bottom:16px}'
    + '.cover{width:120px;height:120px;border-radius:6px;object-fit:cover;flex-shrink:0;background:#2b2c31}'
    + '.info{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}'
    + '.title{font-size:16px;font-weight:700;color:#ffffff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.artist{font-size:13px;color:#9b9da3;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.album{font-size:11px;color:#76787e;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.dur{font-size:11px;color:#5c5e64;font-family:monospace;margin-top:6px}'
    + '.reason{background:#2b2c31;border-radius:6px;padding:12px 14px;font-size:13px;'
    + 'color:#e1e1e2;line-height:1.6;margin-bottom:12px}'
    + '.reason::before{content:"🎵 "}'
    + '.date{color:#76787e;font-size:11px;text-align:center;margin-top:12px;padding-top:12px;'
    + 'border-top:1px solid #2d2f34}'
    + '.play-hint{color:#ec4141;font-size:11px;text-align:center;margin-top:6px}'
    + '</style></head><body><div class="sheet">'
    + '<div class="top">'
    + '<img class="cover" src="' + escapeHtml(track.picUrl) + '?param=240y240" referrerpolicy="no-referrer" />'
    + '<div class="info"><div class="title">' + escapeHtml(track.name) + '</div>'
    + '<div class="artist">' + escapeHtml(track.artists) + '</div>'
    + '<div class="album">' + escapeHtml(track.album) + '</div>'
    + '<div class="dur">' + fmtDuration(track.duration) + '</div></div></div>'
    + '<div class="reason">' + escapeHtml(reason) + '</div>'
    + '<div class="date">🎵 ' + dateStr + ' 每日歌曲推荐</div>'
    + '<div class="play-hint">ncm-play ' + track.id + ' 试听 | ncm-daily 获取今日推荐</div>'
    + '</div></body></html>';
}

// ==================== 推荐引擎 ====================

/**
 * 每日推荐引擎，管理活动追踪、计时推送、推荐生成。
 */
class DailyRecommendEngine {
  private deps: RecommendDeps | null = null;
  private onebot: OneBotClient | null = null;
  /** 活跃用户追踪：userId -> 最后活跃时间戳 */
  private activeUsers = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private processingUsers = new Set<string>(); // 防止并发推给同一用户
  private dailyRecs: Record<string, DailyRec> = {};
  private ctxRef: PluginContext | null = null;

  constructor() {
    this.dailyRecs = loadDailyRecs();
  }

  init(deps: RecommendDeps, onebot: OneBotClient, ctx: PluginContext): void {
    this.deps = deps;
    this.onebot = onebot;
    this.ctxRef = ctx;

    // 清理旧记录（保留最近 30 天）
    this.cleanupOldRecords();

    // 每 15 分钟扫描一次
    this.timer = setInterval(() => {
      this.scanForPendingUsers().catch(err => {
        console.error("[NCM-Daily] 扫描异常:", err);
      });
    }, 15 * 60 * 1000);

    // 第一次扫描在 3 分钟后
    setTimeout(() => {
      this.scanForPendingUsers().catch(err => {
        console.error("[NCM-Daily] 首次扫描异常:", err);
      });
    }, 3 * 60 * 1000);
  }

  /** 用户活跃记录 */
  recordActivity(userId: string): void {
    if (!userId) return;
    this.activeUsers.set(userId, Date.now());
  }

  /** 手动为某个用户触发推荐 */
  async recommendForUser(userId: string): Promise<{ track: NeteaseTrack; reason: string; remaining: number } | string | null> {
    if (!this.deps) return "每日推荐引擎尚未就绪";
    if (this.processingUsers.has(userId)) return "正在为你生成推荐，请稍候...";

    const today = todayStr();
    const key = `${userId}:${today}`;
    const cached = this.dailyRecs[key];

    if (cached && cached.count >= MAX_DAILY_RECS) {
      return `今日推荐次数已用尽（${MAX_DAILY_RECS}/${MAX_DAILY_RECS}），明天再来吧！`;
    }

    this.processingUsers.add(userId);
    try {
      const result = await generateDailyRecommendation(userId, this.deps);
      if (!result) return "无法为你推荐合适的歌曲，试试换一天再来？";

      const newRec = { track: result.track, reason: result.reason, timestamp: Date.now() };
      const newCount = (cached?.count ?? 0) + 1;

      this.dailyRecs[key] = {
        userId,
        date: today,
        count: newCount,
        recs: [...(cached?.recs ?? []), newRec],
      };
      saveDailyRecs(this.dailyRecs);

      return { track: result.track, reason: result.reason, remaining: MAX_DAILY_RECS - newCount };
    } finally {
      this.processingUsers.delete(userId);
    }
  }

  /** 发送推荐给用户 */
  async sendRecommendation(userId: string, target: { type: "private" | "group"; id: string }): Promise<void> {
    const result = await this.recommendForUser(userId);
    if (!result || typeof result === "string") {
      if (this.ctxRef && result) {
        await this.ctxRef.sendMessage(target, result);
      }
      return;
    }

    const today = todayStr();
    const html = buildDailyRecCard(result.track, result.reason, today);
    const dir = path.resolve(DATA_DIR, "cards");
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, "ncm-daily-" + Date.now() + ".webp");
    try {
      await screenshotHtml(html, fp, { width: 480, format: "webp", quality: 85 });

      if (this.ctxRef) {
        await this.ctxRef.sendImage(target, fp);
        if (result.remaining > 0) {
          await this.ctxRef.sendMessage(target, `💡 今日还可再推荐 ${result.remaining} 次，输入 $ncm-daily 继续获取。`);
        }
      }
    } catch (err) {
      console.error("[NCM-Daily] 发送推荐图片失败:", err);
      let text = `🎵 今日推荐：${result.track.name} - ${result.track.artists}\n💬 ${result.reason}\n🔗 试试 ncm-play ${result.track.id} 试听`;
      if (result.remaining > 0) text += `\n💡 今日还可再推荐 ${result.remaining} 次。`;
      if (this.ctxRef) {
        await this.ctxRef.sendMessage(target, text);
      }
    } finally {
      fs.unlink(fp, () => {});
    }
  }

  private async scanForPendingUsers(): Promise<void> {
    if (!this.deps || !this.onebot) return;

    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const today = todayStr();

    // 找活跃但未收到任何今日推荐的用户（自动推送只用第1次，其余让用户手动 $ncm-daily）
    const pending: string[] = [];
    for (const [userId, lastActive] of this.activeUsers) {
      if (now - lastActive > oneHour) continue; // 只找最近 1 小时活跃的
      if (this.processingUsers.has(userId)) continue;
      const key = `${userId}:${today}`;
      const existing = this.dailyRecs[key];
      if (existing && existing.count > 0) continue; // 已收到至少一次推荐
      pending.push(userId);
    }

    // 一次最多处理 3 个，避免资源耗尽
    const batch = pending.slice(0, 3);
    for (const userId of batch) {
      try {
        const target = { type: "private" as const, id: userId };
        await this.sendRecommendation(userId, target);
        // 每个之间间隔 5 秒，避免 API 限流
        await new Promise(r => setTimeout(r, 5000));
      } catch (err) {
        console.error(`[NCM-Daily] 推送用户 ${userId} 失败:`, err);
      }
    }
  }

  private cleanupOldRecords(): void {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const keys = Object.keys(this.dailyRecs);
    let changed = false;
    for (const key of keys) {
      const entry = this.dailyRecs[key];
      if (entry.recs.length > 0 && entry.recs[entry.recs.length - 1].timestamp < thirtyDaysAgo) {
        delete this.dailyRecs[key];
        changed = true;
      }
    }
    if (changed) saveDailyRecs(this.dailyRecs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ── Plugin ──

type NeteaseMusicPlugin = Plugin & {
  setRecommendDeps: (deps: RecommendDeps) => void;
};

export type { NeteaseMusicPlugin };

export function createNeteaseMusicPlugin(menuPlugin: MenuPlugin, onebot: OneBotClient): NeteaseMusicPlugin {
  let ctxRef: PluginContext | null = null;
  let recommendDeps: RecommendDeps | null = null;
  const engine = new DailyRecommendEngine();

  const plugin: NeteaseMusicPlugin = {
    name: "netease-music",
    description: "网易云音乐：搜索、试听、授权、每日推荐",

    systemPromptAppend: [
      "你已集成网易云音乐插件，用户可用 $ncm <歌曲名> [limit=N] [page=N] 搜索音乐，",
      "用 $ncm-play <编号或网易云歌曲ID> 或 $ncm-pick <编号> 获取播放链接，",
      "用 $ncm-page <页码/next/prev> 翻页查看搜索结果，",
      "用 $ncm-auth 完成网易云授权。",
      "用 $ncm-daily 获取针对你当前状态的每日歌曲推荐。",
    ].join("\n"),

    /** 注入每日推荐所需依赖（MessageStore + LLM 查询能力） */
    setRecommendDeps(deps: RecommendDeps) {
      recommendDeps = deps;
    },

    /** 追踪用户消息活跃度，用于每日推荐 */
    async onMessage(message: BotMessage, _ctx: PluginContext): Promise<boolean | void> {
      if (message.userId) {
        engine.recordActivity(message.userId);
      }
      return; // 不阻断消息
    },

    async onLoad(ctx: PluginContext) {
      ctxRef = ctx;

      if (recommendDeps) {
        engine.init(recommendDeps, onebot, ctx);
        console.log("[NCM-Daily] 每日推荐引擎已启动");
      }

      const prefix = menuPlugin.getPrefix();

      // ── $ncm <query> search ──
      menuPlugin.registerCommand(
        "ncm",
        "搜索网易云音乐：$ncm <歌曲名> [limit=N] [page=N]",
        async (message, args) => {
          const userId = message.userId!;

          let limit = 8;
          let page = 1;
          const queryArgs: string[] = [];
          for (const a of args) {
            const lMatch = a.match(/^limit=(\d+)$/i);
            const pMatch = a.match(/^page=(\d+)$/i);
            if (lMatch) {
              limit = Math.max(1, Math.min(50, parseInt(lMatch[1], 10)));
            } else if (pMatch) {
              page = Math.max(1, parseInt(pMatch[1], 10));
            } else {
              queryArgs.push(a);
            }
          }

          const query = queryArgs.join(" ");
          if (!query) {
            await ctx.replyText(message, "用法：$ncm <歌曲名> [limit=N] [page=N]\n示例：$ncm 周杰伦 晴天 limit=16 page=2");
            return;
          }

          try {
            const offset = (page - 1) * limit;
            const tracks = await searchNetease(query, limit, offset);
            if (tracks.length === 0) {
              await ctx.replyText(message, "未找到相关歌曲。");
              return;
            }

            const cache = loadCache();
            cache[userId] = { query, tracks, page, timestamp: Date.now() };
            saveCache(cache);

            const html = buildSearchCard(query, tracks, page);
            const dir = path.resolve(DATA_DIR, "cards");
            fs.mkdirSync(dir, { recursive: true });
            const fp = path.join(dir, "ncm-" + Date.now() + ".webp");
            await screenshotHtml(html, fp, { width: 480, format: "webp", quality: 85 });

            const target = message.type === "group"
              ? { type: "group" as const, id: message.groupId! }
              : { type: "private" as const, id: userId };
            await ctx.sendImage(target, fp);
            fs.unlink(fp, () => {});
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.replyText(message, "搜索失败：" + msg.slice(0, 200));
          }
        },
      );

      // ── $ncm-page <page> select page ──
      menuPlugin.registerCommand(
        "ncm-page",
        "网易云音乐翻页：$ncm-page <页码/next/prev>",
        async (message, args) => {
          const userId = message.userId!;
          const cache = loadCache();
          const entry = cache[userId];
          if (!entry || !entry.query) {
            await ctx.replyText(message, "请先使用 $ncm <歌曲名> 搜索。");
            return;
          }

          let targetPage = entry.page || 1;
          const action = args[0]?.toLowerCase();
          if (!action) {
            await ctx.replyText(message, "用法：$ncm-page <页码/next/prev>\n示例：$ncm-page 2");
            return;
          }

          if (action === "next") {
            targetPage += 1;
          } else if (action === "prev") {
            targetPage = Math.max(1, targetPage - 1);
          } else {
            const p = parseInt(action, 10);
            if (isNaN(p) || p <= 0) {
              await ctx.replyText(message, "请输入有效的页码（如 1、2 等）或者 next/prev。");
              return;
            }
            targetPage = p;
          }

          await ctx.replyText(message, `正在加载第 ${targetPage} 页...`);

          try {
            const limit = 8;
            const offset = (targetPage - 1) * limit;
            const tracks = await searchNetease(entry.query, limit, offset);
            if (tracks.length === 0) {
              await ctx.replyText(message, `未在第 ${targetPage} 页找到更多歌曲。`);
              return;
            }

            cache[userId] = {
              query: entry.query,
              tracks,
              page: targetPage,
              timestamp: Date.now()
            };
            saveCache(cache);

            const html = buildSearchCard(entry.query, tracks, targetPage);
            const dir = path.resolve(DATA_DIR, "cards");
            fs.mkdirSync(dir, { recursive: true });
            const fp = path.join(dir, "ncm-" + Date.now() + ".webp");
            await screenshotHtml(html, fp, { width: 480, format: "webp", quality: 85 });

            const target = message.type === "group"
              ? { type: "group" as const, id: message.groupId! }
              : { type: "private" as const, id: userId };
            await ctx.sendImage(target, fp);
            fs.unlink(fp, () => {});
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.replyText(message, "翻页失败：" + msg.slice(0, 200));
          }
        },
      );

      // ── $ncm-play <N/ID> / $ncm-pick <N/ID> get stream URL ──
      menuPlugin.registerCommand(
        "ncm-play",
        "获取网易云音乐播放链接：$ncm-play <编号或网易云歌曲ID>",
        async (message, args) => {
          const userId = message.userId!;
          const input = args[0];
          if (!input) {
            await ctx.replyText(message, "用法：$ncm-play <编号或歌曲ID>\n示例：$ncm-play 1\n示例：$ncm-play 186016");
            return;
          }

          const idOrIdx = parseInt(input, 10);
          if (isNaN(idOrIdx) || idOrIdx <= 0) {
            await ctx.replyText(message, "请输入有效的编号或歌曲 ID。");
            return;
          }

          const cache = loadCache();
          const entry = cache[userId];
          let track: NeteaseTrack | null = null;

          const limit = entry?.tracks?.length ?? 8;
          if (idOrIdx <= limit) {
            if (!entry || entry.tracks.length === 0) {
              await ctx.replyText(message, "请先使用 $ncm <歌曲名> 搜索，或直接使用歌曲 ID 点歌。");
              return;
            }
            if (idOrIdx > entry.tracks.length) {
              await ctx.replyText(message, "编号超出范围（1-" + entry.tracks.length + "）。");
              return;
            }
            track = entry.tracks[idOrIdx - 1];
          } else {
            if (entry && entry.tracks) {
              track = entry.tracks.find((t) => t.id === idOrIdx) || null;
            }
            if (!track) {
              track = await getTrackDetail(idOrIdx);
            }
          }

          if (!track) {
            await ctx.replyText(message, "无法找到该歌曲的信息。请检查网易云歌曲 ID 是否正确。");
            return;
          }

          try {
            const target = message.type === "group"
              ? { type: "group" as const, id: message.groupId! }
              : { type: "private" as const, id: userId };

            const apiAction = message.type === "group" ? "send_group_msg" : "send_private_msg";
            const apiParams = message.type === "group"
              ? { group_id: message.groupId! }
              : { user_id: userId };

            // 获取播放链接，用于自定义音乐卡片
            let streamUrl: string | null = null;
            try {
              streamUrl = await getStreamUrl(track.id);
            } catch {
              // getStreamUrl 失败，忽略
            }

            if (streamUrl) {
              // 使用自定义音乐卡片，由 bot 端提供歌曲信息，避免 NapCat 内部调用网易云 API 失败
              try {
                await onebot.sendAction(apiAction, {
                  ...apiParams,
                  message: [
                    {
                      type: "music",
                      data: {
                        type: "custom",
                        url: `https://music.163.com/song?id=${track.id}`,
                        audio: streamUrl,
                        title: track.name,
                        content: track.artists,
                        image: track.picUrl,
                      },
                    },
                  ],
                });
              } catch {
                // 自定义音乐卡片发送失败，降级为下载音频文件发送
                try {
                  const resp = await fetch(streamUrl, {
                    headers: { "User-Agent": UA },
                  });
                  if (!resp.ok) throw new Error(`下载音频失败：HTTP ${resp.status}`);
                  const buffer = Buffer.from(await resp.arrayBuffer());

                  const safeName = `${track.name} - ${track.artists}`
                    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
                    .slice(0, 100);
                  const dir = path.resolve(DATA_DIR, "audio");
                  fs.mkdirSync(dir, { recursive: true });
                  const fp = path.join(dir, `${safeName}.mp3`);
                  fs.writeFileSync(fp, buffer);

                  await ctx.sendFile(target, fp, `${safeName}.mp3`);

                  fs.unlink(fp, () => {});
                } catch {
                  await ctx.sendMessage(target, `🎵 ${track.name} - ${track.artists}\n🔗 网易云歌曲ID: ${track.id}\n💡 播放链接: ${streamUrl}`);
                }
              }
            } else {
              // 无播放链接，可能需要 VIP 或授权
              await ctx.sendMessage(target, `🎵 ${track.name} - ${track.artists}\n🔗 网易云歌曲ID: ${track.id}\n💡 无法获取播放链接，可能需要 VIP 或授权。尝试 $ncm-auth`);
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.replyText(message, "获取链接失败：" + msg.slice(0, 200));
          }
        },
        { aliases: ["ncm-pick"] },
      );

      // ── $ncm-auth QR login ──
      menuPlugin.registerCommand(
        "ncm-auth",
        "扫码登录网易云音乐（获取高音质权限）",
        async (message) => {
          const userId = message.userId!;
          await ctx.replyText(message, "正在获取二维码...");

          try {
            const unikey = await getQrKey();
            if (!unikey) {
              await ctx.replyText(message, "获取二维码失败。");
              return;
            }

            const qrUrl = "https://music.163.com/login?codekey=" + unikey;
            const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 240, margin: 1 });

            const html = buildAuthCard(qrDataUrl, unikey);
            const dir = path.resolve(DATA_DIR, "cards");
            fs.mkdirSync(dir, { recursive: true });
            const fp = path.join(dir, "ncm-auth-" + Date.now() + ".webp");
            await screenshotHtml(html, fp, { width: 340, format: "webp", quality: 85 });

            const target = message.type === "group"
              ? { type: "group" as const, id: message.groupId! }
              : { type: "private" as const, id: userId };
            await ctx.sendImage(target, fp);
            fs.unlink(fp, () => {});

            await ctx.sendMessage(target, "请使用网易云音乐 App 扫描二维码。等待授权中（60 秒超时）...");

            const pollInterval = 2000;
            const maxPolls = 30;
            let loggedIn = false;

            for (let i = 0; i < maxPolls; i++) {
              await new Promise((r) => setTimeout(r, pollInterval));
              const status = await pollQrStatus(unikey);

              if (status.code === 803) {
                loggedIn = true;
                await ctx.sendMessage(target, "网易云音乐授权成功！现在可以获取标准及以上音质的播放链接。");
                break;
              } else if (status.code === 800) {
                await ctx.sendMessage(target, "二维码已过期，请重新执行 $ncm-auth。");
                break;
              } else if (status.code === 802) {
                if (i === 0 || i % 5 === 0) {
                  await ctx.sendMessage(target, "已扫描，请在手机上确认授权...");
                }
              }
            }

            if (!loggedIn) {
              await ctx.sendMessage(target, "授权超时，请重新执行 $ncm-auth。");
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.replyText(message, "授权失败：" + msg.slice(0, 200));
          }
        },
      );

      // ── $ncm-daily 每日推荐 ──
      menuPlugin.registerCommand(
        "ncm-daily",
        "获取今日歌曲推荐：$ncm-daily。基于你的近期发言和记忆，AI 为你推荐一首歌。每天最多使用 3 次。",
        async (message) => {
          const userId = message.userId!;
          const target = message.type === "group"
            ? { type: "group" as const, id: message.groupId! }
            : { type: "private" as const, id: userId };

          if (!recommendDeps) {
            await ctx.replyText(message, "每日推荐功能尚未就绪（缺少 LLM 或消息存储依赖）。");
            return;
          }

          await ctx.replyText(message, "🎵 正在分析你的偏好，为你推荐一首歌...");

          try {
            await engine.sendRecommendation(userId, target);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.replyText(message, "推荐失败：" + msg.slice(0, 200));
          }
        },
      );
    },
  };

  return plugin;
}
