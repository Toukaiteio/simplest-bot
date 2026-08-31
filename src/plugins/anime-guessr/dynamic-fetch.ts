/** Bangumi 动态增量：前台补齐用户查询，后台扩充同作品角色。 */
import fs from "node:fs";
import path from "node:path";
import type { AnimeAppearance, AnimeCharacter, AnimeWork } from "./types.js";

const API = "https://api.bgm.tv";
const UA = "simplest-bot-anime-guessr/2.0 (QQ bot; contact: bot administrator)";
const TIMEOUT_MS = 12_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type InfoboxItem = { key: string; value: unknown };
type BgmCharacter = {
  id: number; name: string; type?: number; gender?: string | null; infobox?: InfoboxItem[];
  images?: { medium?: string; large?: string }; stat?: { collects?: number };
};

export type BangumiCharacterCandidate = {
  id: number;
  name: string;
  nameCn: string | null;
  aliases: string[];
  popularity: number;
  image: string;
};
type BgmRelatedSubject = { id: number; name: string; name_cn?: string; type: number; staff?: string };
type BgmRelatedCharacter = { id: number; name: string; type: number; relation?: string; actors?: { name: string }[] };
type BgmSubject = {
  id: number; name: string; name_cn?: string; date?: string; type: number;
  rating?: { score?: number }; infobox?: InfoboxItem[];
  meta_tags?: string[]; tags?: { name: string; count?: number }[]; eps_count?: number | null; platform?: string;
};

let databaseRef: AnimeCharacter[] | null = null;
let dataFilePath = "";
let onIndexRebuild: (() => void) | null = null;
let onWorkDiscovered: ((work: AnimeWork) => void) | null = null;
let proxyUrl: string | null = process.env.BGM_PROXY ?? null;
let accessToken: string | null = process.env.BGM_TOKEN ?? null;
let backgroundLimit = 30;
let persistChain: Promise<void> = Promise.resolve();
const detailRequests = new Map<number, Promise<AnimeCharacter | null>>();
const subjectCache = new Map<number, Promise<BgmSubject | null>>();
const queuedSubjects = new Set<number>();
let localCharacterTags: Map<number, string[]> | null = null;

const HAIR_COLORS = new Set(["黑发", "金发", "银发", "白发", "棕发", "红发", "蓝发", "紫发", "绿发", "粉发", "灰发", "橙发", "黄发"]);
const EYE_COLORS = new Set(["黑瞳", "金瞳", "银瞳", "棕瞳", "红瞳", "蓝瞳", "紫瞳", "绿瞳", "灰瞳", "粉瞳", "橙瞳", "黄瞳", "异色瞳", "赤瞳", "碧瞳", "翠瞳"]);
const WANTED_WORK_TAGS = new Set([
  "原创", "漫画改", "小说改", "游戏改", "动画改", "影视改",
  "TV", "剧场版", "OVA", "OAD", "WEB", "短篇",
  "科幻", "奇幻", "校园", "恋爱", "日常", "冒险", "战斗",
  "悬疑", "推理", "运动", "音乐", "后宫", "穿越", "机战",
  "搞笑", "治愈", "致郁", "热血", "催泪",
]);
const WORK_TAG_ALIASES: Record<string, string> = { "GAL改": "游戏改", "轻小说改": "小说改", "轻改": "小说改", "漫改": "漫画改", "网文改": "小说改", "原创动画": "原创" };

export type DynamicFetchOptions = {
  proxy?: string | null;
  token?: string | null;
  backgroundCharactersPerWork?: number;
  onWorkDiscovered?: (work: AnimeWork) => void;
};

export function initDynamicFetch(database: AnimeCharacter[], filePath: string, rebuildIndex: () => void, options: DynamicFetchOptions = {}): void {
  databaseRef = database;
  dataFilePath = path.resolve(process.cwd(), filePath);
  onIndexRebuild = rebuildIndex;
  onWorkDiscovered = options.onWorkDiscovered ?? null;
  proxyUrl = options.proxy ?? process.env.BGM_PROXY ?? null;
  accessToken = options.token ?? process.env.BGM_TOKEN ?? null;
  backgroundLimit = Math.max(0, options.backgroundCharactersPerWork ?? 30);
}

/** 角色标签来自项目已有的角色标签表；不存在时仍可正常使用 Bangumi 作品标签。 */
function getLocalCharacterTags(id: number): string[] {
  if (!localCharacterTags) {
    localCharacterTags = new Map();
    const candidates = [
      path.resolve(process.cwd(), "scripts/id_tags_raw.js"),
      path.resolve(process.cwd(), "data/anime-character-tags.js"),
    ];
    const sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
    if (sourcePath) {
      try {
        const source = fs.readFileSync(sourcePath, "utf8");
        for (const match of source.matchAll(/^\s*(\d+):(\[[^\r\n]*\]),?$/gm)) {
          const tags = JSON.parse(match[2]) as unknown;
          if (Array.isArray(tags)) localCharacterTags.set(Number(match[1]), tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0));
        }
        console.log(`[AnimeGuessr] 已加载 ${localCharacterTags.size} 个角色的本地标签`);
      } catch (error) {
        console.warn(`[AnimeGuessr] 角色标签文件读取失败 ${sourcePath}:`, error);
      }
    } else {
      console.warn("[AnimeGuessr] 未找到角色标签文件，动态角色将仅使用作品标签");
    }
  }
  return localCharacterTags.get(id) ?? [];
}

function extractWorkTags(subject: BgmSubject): string[] {
  const result = new Set<string>();
  const accept = (raw: string | undefined) => {
    if (!raw) return;
    const normalized = WORK_TAG_ALIASES[raw] ?? raw;
    if (WANTED_WORK_TAGS.has(normalized)) result.add(normalized);
  };
  for (const tag of subject.meta_tags ?? []) accept(tag);
  for (const tag of (subject.tags ?? []).slice(0, 15)) accept(tag.name);
  accept(subject.platform);
  if ((subject.eps_count ?? 0) >= 10 && !subject.platform) result.add("TV");
  return [...result];
}

async function bgmFetchJson<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "User-Agent": UA, "Accept": "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const options: RequestInit & { dispatcher?: unknown } = { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) }, signal: controller.signal };
    if (proxyUrl) {
      const { ProxyAgent } = await import("undici");
      options.dispatcher = new ProxyAgent(proxyUrl);
    }
    const response = await fetch(`${API}${endpoint}`, options);
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 仅调用一次角色搜索，不展开作品、声优或角色详情。 */
export async function searchBangumiCharacterCandidates(keyword: string, limit = 10): Promise<BangumiCharacterCandidate[]> {
  const page = await bgmFetchJson<{ data?: BgmCharacter[] }>(`/v0/search/characters?limit=${Math.max(1, Math.min(20, limit))}&offset=0`, {
    method: "POST", body: JSON.stringify({ keyword: keyword.trim(), filter: { nsfw: false } }),
  });
  return (page.data ?? [])
    .filter((item) => item.type === undefined || item.type === 1)
    .map((item) => ({
      id: item.id,
      name: item.name,
      nameCn: infoboxString(item.infobox, "简体中文名"),
      aliases: parseAliases(item.infobox),
      popularity: item.stat?.collects ?? 0,
      image: item.images?.medium ?? item.images?.large ?? "",
    }));
}

async function searchAnimeSubjects(keyword: string): Promise<BgmSubject[]> {
  const page = await bgmFetchJson<{ data?: BgmSubject[] }>("/v0/search/subjects?limit=10&offset=0", {
    method: "POST", body: JSON.stringify({ keyword, filter: { type: [2], nsfw: false } }),
  });
  return (page.data ?? []).filter((subject) => subject.type === 2);
}

function infoboxString(items: InfoboxItem[] | undefined, key: string): string | null {
  const value = items?.find((item) => item.key === key)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseAliases(items: InfoboxItem[] | undefined): string[] {
  const value = items?.find((item) => item.key === "别名")?.value;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => typeof item === "object" && item && "v" in item ? String((item as { v: unknown }).v).trim() : "").filter((item) => item && item.length < 80))];
}

async function fetchSubject(id: number): Promise<BgmSubject | null> {
  let request = subjectCache.get(id);
  if (!request) {
    request = bgmFetchJson<BgmSubject>(`/v0/subjects/${id}`).catch((error) => {
      console.warn(`[AnimeGuessr] 获取 Bangumi 作品 ${id} 失败:`, error);
      return null;
    });
    subjectCache.set(id, request);
  }
  return request;
}

function subjectToAppearance(subject: BgmSubject, staff: string): AnimeAppearance {
  const year = /^\d{4}/.test(subject.date ?? "") ? Number(subject.date!.slice(0, 4)) : null;
  const studioValue = subject.infobox?.find((item) => item.key === "动画制作")?.value;
  const studio = typeof studioValue === "string" ? studioValue : Array.isArray(studioValue)
    ? studioValue.map((item) => typeof item === "object" && item && "v" in item ? String((item as { v: unknown }).v) : "").filter(Boolean).join("、") || null
    : null;
  return { id: subject.id, name: subject.name, nameCn: subject.name_cn || subject.name, year, rating: subject.rating?.score ?? 0, studio, staff };
}

async function fetchCharacterDetail(id: number, discoverWorks = true): Promise<AnimeCharacter | null> {
  if (discoverWorks) {
    const cached = detailRequests.get(id);
    if (cached) return cached;
  }
  const request: Promise<AnimeCharacter | null> = (async () => {
    try {
      const [detail, relatedSubjects, persons] = await Promise.all([
        bgmFetchJson<BgmCharacter>(`/v0/characters/${id}`),
        bgmFetchJson<BgmRelatedSubject[]>(`/v0/characters/${id}/subjects`),
        bgmFetchJson<{ name: string; subject_type: number }[]>(`/v0/characters/${id}/persons`).catch(() => []),
      ]);
      const animeRelations = relatedSubjects.filter((item) => item.type === 2 && ["主角", "配角", "客串"].includes(item.staff ?? ""));
      if (!animeRelations.length) return null;
      const appearances: AnimeAppearance[] = [];
      const workTags = new Set<string>();
      for (const relation of animeRelations.slice(0, 8)) {
        const subject = await fetchSubject(relation.id);
        if (!subject || (subject.date && new Date(subject.date).getTime() > Date.now())) continue;
        const appearance = subjectToAppearance(subject, relation.staff ?? "出演");
        appearances.push(appearance);
        for (const tag of extractWorkTags(subject)) workTags.add(tag);
        if (discoverWorks) onWorkDiscovered?.({ ...appearance, source: "bangumi" });
        await sleep(80);
      }
      if (!appearances.length) return null;
      const years = appearances.map((item) => item.year).filter((item): item is number => item !== null);
      const ratings = appearances.map((item) => item.rating).filter((item) => item > 0);
      const gender: "male" | "female" | null = detail.gender === "male" || detail.gender === "female" ? detail.gender : null;
      const characterTags = getLocalCharacterTags(detail.id).slice(0, 10);
      const tags = [...new Set([...characterTags, ...workTags])];
      return {
        id: detail.id, name: detail.name, nameCn: infoboxString(detail.infobox, "简体中文名"), aliases: parseAliases(detail.infobox), gender,
        hairColor: tags.find((tag) => HAIR_COLORS.has(tag)) ?? null, eyeColor: tags.find((tag) => EYE_COLORS.has(tag)) ?? null, popularity: detail.stat?.collects ?? 0, worksCount: animeRelations.length,
        highestRating: ratings.length ? Math.max(...ratings) : null, latestYear: years.length ? Math.max(...years) : null,
        earliestYear: years.length ? Math.min(...years) : null,
        voiceActors: [...new Set(persons.filter((item) => item.subject_type === 2).map((item) => item.name))],
        appearances, tags, image: detail.images?.medium ?? detail.images?.large ?? "", tier: "dynamic",
      };
    } catch (error) {
      console.warn(`[AnimeGuessr] 获取 Bangumi 角色 ${id} 失败:`, error);
      return null;
    }
  })();
  if (discoverWorks) detailRequests.set(id, request);
  return request;
}

function addCharacters(characters: AnimeCharacter[], reason: string): AnimeCharacter[] {
  if (!databaseRef) return [];
  const byId = new Map(databaseRef.map((item) => [item.id, item]));
  const added: AnimeCharacter[] = [];
  let updated = 0;
  for (const incoming of characters) {
    const existing = byId.get(incoming.id);
    if (!existing) {
      databaseRef.push(incoming);
      byId.set(incoming.id, incoming);
      added.push(incoming);
      continue;
    }
    // 同 ID 角色也要补齐别名和新作品，否则“库里有角色但缺少这个别名”仍会永远搜不到。
    existing.name = incoming.name || existing.name;
    existing.nameCn = incoming.nameCn || existing.nameCn;
    existing.aliases = [...new Set([...(existing.aliases ?? []), ...incoming.aliases])];
    existing.gender = incoming.gender ?? existing.gender;
    existing.hairColor = incoming.hairColor ?? existing.hairColor;
    existing.eyeColor = incoming.eyeColor ?? existing.eyeColor;
    existing.popularity = incoming.popularity || existing.popularity;
    existing.voiceActors = [...new Set([...(existing.voiceActors ?? []), ...incoming.voiceActors])];
    existing.image = incoming.image || existing.image;
    existing.tags = [...new Set([...(existing.tags ?? []), ...incoming.tags])];
    const appearances = new Map(existing.appearances.map((item) => [item.id, item]));
    for (const appearance of incoming.appearances) appearances.set(appearance.id, { ...appearances.get(appearance.id), ...appearance });
    existing.appearances = [...appearances.values()];
    existing.worksCount = Math.max(incoming.worksCount, existing.appearances.length);
    const years = existing.appearances.map((item) => item.year).filter((item): item is number => item !== null);
    const ratings = existing.appearances.map((item) => item.rating).filter((item) => item > 0);
    existing.earliestYear = years.length ? Math.min(...years) : null;
    existing.latestYear = years.length ? Math.max(...years) : null;
    existing.highestRating = ratings.length ? Math.max(...ratings) : null;
    updated += 1;
  }
  if (!added.length && !updated) return [];
  onIndexRebuild?.();
  persistChain = persistChain.then(async () => {
    try {
      fs.mkdirSync(path.dirname(dataFilePath), { recursive: true });
      const tempPath = `${dataFilePath}.tmp`;
      await fs.promises.writeFile(tempPath, JSON.stringify(databaseRef, null, 2), "utf8");
      await fs.promises.rename(tempPath, dataFilePath);
      console.log(`[AnimeGuessr] ${reason}新增 ${added.length}、补全 ${updated} 个角色，数据库共 ${databaseRef!.length} 个`);
    } catch (error) { console.warn("[AnimeGuessr] 动态数据库持久化失败:", error); }
  });
  return added;
}

function collectWorkInBackground(subjectId: number): void {
  if (!backgroundLimit || queuedSubjects.has(subjectId)) return;
  queuedSubjects.add(subjectId);
  void (async () => {
    try {
      const related = await bgmFetchJson<BgmRelatedCharacter[]>(`/v0/subjects/${subjectId}/characters`);
      const candidates = related.filter((item) => item.type === 1 && ["主角", "配角"].includes(item.relation ?? "")).slice(0, backgroundLimit);
      const fetched: AnimeCharacter[] = [];
      for (const item of candidates) {
        if (databaseRef?.some((existing) => existing.id === item.id)) continue;
        const character = await fetchCharacterDetail(item.id);
        if (character) fetched.push(character);
        await sleep(250);
      }
      addCharacters(fetched, `后台采集作品 ${subjectId}：`);
    } catch (error) { console.warn(`[AnimeGuessr] 后台采集作品 ${subjectId} 失败:`, error); }
    finally { queuedSubjects.delete(subjectId); }
  })();
}

/** 用户已选中候选后才展开完整资料并写入正式动态角色库。 */
export async function fetchCharacterById(id: number): Promise<AnimeCharacter | null> {
  const existing = databaseRef?.find((character) => character.id === id);
  if (existing && existing.appearances.length > 0 && (existing.tags?.length ?? 0) > 0) return existing;
  const fetched = await fetchCharacterDetail(id);
  if (!fetched) return existing ?? null;
  addCharacters([fetched], "用户选定角色：");
  for (const appearance of fetched.appearances.slice(0, 2)) collectWorkInBackground(appearance.id);
  return databaseRef?.find((character) => character.id === id) ?? fetched;
}

export type WorkContributionPreview = {
  work: AnimeWork;
  characters: AnimeCharacter[];
  totalRelatedCharacters: number;
};

/**
 * 按作品名从 Bangumi 生成一份待审核资料快照。
 * 此函数只读取远端数据，不会写入正式作品表或角色数据库。
 */
export async function fetchWorkContribution(keyword: string, maxCharacters = 30): Promise<WorkContributionPreview | null> {
  const query = keyword.trim();
  if (!query) return null;
  const results = await searchAnimeSubjects(query);
  if (!results.length) return null;
  const normalize = (value: string) => value.toLowerCase().replace(/[\s·・._\-—:：!！?？()（）「」『』]/g, "");
  const wanted = normalize(query);
  const matched = results.find((subject) => normalize(subject.name) === wanted || normalize(subject.name_cn ?? "") === wanted) ?? results[0];
  const subject = await fetchSubject(matched.id);
  if (!subject) return null;
  const appearance = subjectToAppearance(subject, "出演");
  const work: AnimeWork = { ...appearance, source: "bangumi" };
  const related = await bgmFetchJson<BgmRelatedCharacter[]>(`/v0/subjects/${subject.id}/characters`);
  const candidates = related
    .filter((character) => character.type === 1 && ["主角", "配角", "客串"].includes(character.relation ?? ""))
    .sort((a, b) => {
      const rank = (relation?: string) => relation === "主角" ? 0 : relation === "配角" ? 1 : 2;
      return rank(a.relation) - rank(b.relation);
    })
    .slice(0, Math.max(1, maxCharacters));
  const characters: AnimeCharacter[] = [];
  for (const candidate of candidates) {
    const character = await fetchCharacterDetail(candidate.id, false);
    if (!character) continue;
    const targetAppearance = character.appearances.find((item) => item.id === subject.id);
    if (targetAppearance) targetAppearance.staff = candidate.relation ?? targetAppearance.staff;
    characters.push(character);
    await sleep(180);
  }
  return { work, characters, totalRelatedCharacters: related.filter((character) => character.type === 1).length };
}
