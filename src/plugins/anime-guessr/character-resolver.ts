import fs from "node:fs";
import path from "node:path";
import type { AnimeCharacter } from "./types.js";
import type { SearchMatch } from "./search-index.js";
import type { BangumiCharacterCandidate } from "./dynamic-fetch.js";

export type ResolvedCharacterCandidate = {
  id: number;
  name: string;
  nameCn: string | null;
  aliases: string[];
  popularity: number;
  image: string;
  character?: AnimeCharacter;
  matchedField: string;
  source: "local" | "bangumi-cache" | "bangumi-live";
};

export type CharacterResolution = {
  candidates: ResolvedCharacterCandidate[];
  source: "local" | "bangumi-cache" | "bangumi-stale" | "bangumi-live" | "negative-cache" | "unavailable";
  ambiguous: boolean;
};

type CachedCandidate = Omit<ResolvedCharacterCandidate, "character" | "matchedField" | "source">;
type CacheEntry = { candidates: CachedCandidate[]; fetchedAt: number; expiresAt: number };
type CacheData = {
  version: 1;
  queries: Record<string, CacheEntry>;
  quota: { date: string; count: number };
};

export type CharacterResolverOptions = {
  cacheFile: string;
  positiveTtlDays: number;
  negativeTtlDays: number;
  minRemoteIntervalMs: number;
  dailyRemoteLimit: number;
  searchLocal(query: string, limit: number): SearchMatch[];
  findLocalById(id: number): AnimeCharacter | undefined;
  searchRemote(query: string, limit: number): Promise<BangumiCharacterCandidate[]>;
  fetchDetail(id: number): Promise<AnimeCharacter | null>;
  now?: () => number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 10_000;

function cacheKey(query: string): string {
  return query.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function candidateKeys(candidate: CachedCandidate): string[] {
  const raw = [candidate.name, candidate.nameCn, ...candidate.aliases].filter((value): value is string => Boolean(value));
  return [...new Set(raw.flatMap((value) => [value, ...value.split(/\s*[\/／|｜]\s*/)]).map(cacheKey).filter(Boolean))];
}

function emptyCache(date: string): CacheData {
  return { version: 1, queries: {}, quota: { date, count: 0 } };
}

function localAmbiguous(matches: SearchMatch[]): boolean {
  if (matches.length < 2) return false;
  const top = matches[0].score;
  const second = matches[1].score;
  return second === top || (top < 100 && second >= top - 10);
}

export class CharacterResolver {
  private readonly cachePath: string;
  private readonly now: () => number;
  private data: CacheData;
  private readonly inFlight = new Map<string, Promise<BangumiCharacterCandidate[]>>();
  private gate: Promise<void> = Promise.resolve();
  private nextRemoteAt = 0;

  constructor(private readonly options: CharacterResolverOptions) {
    this.cachePath = path.resolve(process.cwd(), options.cacheFile);
    this.now = options.now ?? Date.now;
    this.data = this.load();
  }

  async resolve(query: string, limit = 10): Promise<CharacterResolution> {
    const normalized = cacheKey(query);
    if (!normalized) return { candidates: [], source: "unavailable", ambiguous: false };

    const local = this.options.searchLocal(query, limit);
    if (local[0]?.score >= 90) {
      return {
        candidates: local.map((match) => this.fromLocal(match)),
        source: "local",
        ambiguous: localAmbiguous(local),
      };
    }

    const cached = this.data.queries[normalized];
    const now = this.now();
    if (cached && cached.expiresAt > now) return this.fromCache(cached, false);
    const learnedAliases = this.findByLearnedAlias(normalized, now, limit);
    if (learnedAliases.length) {
      return {
        candidates: learnedAliases,
        source: "bangumi-cache",
        ambiguous: learnedAliases.length > 1,
      };
    }
    if (cached?.candidates.length) {
      void this.refresh(normalized, query, limit).catch((error) =>
        console.warn(`[AnimeGuessr] 后台刷新搜索缓存「${query}」失败:`, error));
      return this.fromCache(cached, true);
    }

    try {
      const remote = await this.refresh(normalized, query, limit);
      return this.fromRemote(remote, "bangumi-live");
    } catch (error) {
      console.warn(`[AnimeGuessr] Bangumi 轻量搜索「${query}」不可用:`, error);
      if (local.length) {
        return { candidates: local.map((match) => this.fromLocal(match)), source: "unavailable", ambiguous: localAmbiguous(local) };
      }
      return { candidates: [], source: "unavailable", ambiguous: false };
    }
  }

  async materialize(candidate: ResolvedCharacterCandidate): Promise<AnimeCharacter | null> {
    const existing = candidate.character ?? this.options.findLocalById(candidate.id);
    if (existing && (existing.tier !== "dynamic" || (existing.tags?.length ?? 0) > 0)) return existing;
    return await this.options.fetchDetail(candidate.id) ?? existing ?? null;
  }

  private async refresh(key: string, query: string, limit: number): Promise<BangumiCharacterCandidate[]> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const request = this.runRemote(query, limit).then((results) => {
      const now = this.now();
      const ttlDays = results.length ? this.options.positiveTtlDays : this.options.negativeTtlDays;
      this.data.queries[key] = {
        candidates: results.map(({ id, name, nameCn, aliases, popularity, image }) => ({ id, name, nameCn, aliases, popularity, image })),
        fetchedAt: now,
        expiresAt: now + ttlDays * DAY_MS,
      };
      this.save();
      return results;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async runRemote(query: string, limit: number): Promise<BangumiCharacterCandidate[]> {
    let release!: () => void;
    const previous = this.gate;
    this.gate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      this.resetQuotaIfNeeded();
      if (this.data.quota.count >= this.options.dailyRemoteLimit) throw new Error("已达到 Bangumi 每日搜索预算");
      const waitMs = Math.max(0, this.nextRemoteAt - this.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.nextRemoteAt = this.now() + this.options.minRemoteIntervalMs;
      this.data.quota.count += 1;
      this.save();
      return await this.options.searchRemote(query, limit);
    } finally {
      release();
    }
  }

  private fromLocal(match: SearchMatch): ResolvedCharacterCandidate {
    return {
      id: match.char.id, name: match.char.name, nameCn: match.char.nameCn,
      aliases: match.char.aliases, popularity: match.char.popularity, image: match.char.image,
      character: match.char, matchedField: match.matchedField, source: "local",
    };
  }

  private fromCache(entry: CacheEntry, stale: boolean): CharacterResolution {
    const candidates = entry.candidates.map((candidate) => ({
      ...candidate,
      character: this.options.findLocalById(candidate.id),
      matchedField: stale ? "Bangumi 缓存（后台刷新中）" : "Bangumi 缓存",
      source: "bangumi-cache" as const,
    }));
    return {
      candidates,
      source: candidates.length ? (stale ? "bangumi-stale" : "bangumi-cache") : "negative-cache",
      ambiguous: candidates.length > 1,
    };
  }

  private fromRemote(results: BangumiCharacterCandidate[], source: "bangumi-live"): CharacterResolution {
    const candidates = results.map((candidate) => ({
      ...candidate,
      character: this.options.findLocalById(candidate.id),
      matchedField: "Bangumi 搜索",
      source,
    }));
    return { candidates, source: candidates.length ? source : "negative-cache", ambiguous: candidates.length > 1 };
  }

  private findByLearnedAlias(normalized: string, now: number, limit: number): ResolvedCharacterCandidate[] {
    const byId = new Map<number, CachedCandidate>();
    for (const entry of Object.values(this.data.queries)) {
      if (entry.expiresAt <= now) continue;
      for (const candidate of entry.candidates) {
        if (candidateKeys(candidate).includes(normalized)) byId.set(candidate.id, candidate);
      }
    }
    return [...byId.values()]
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, limit)
      .map((candidate) => ({
        ...candidate,
        character: this.options.findLocalById(candidate.id),
        matchedField: "Bangumi 已学习别名",
        source: "bangumi-cache" as const,
      }));
  }

  private resetQuotaIfNeeded(): void {
    const date = new Date(this.now()).toISOString().slice(0, 10);
    if (this.data.quota.date !== date) this.data.quota = { date, count: 0 };
  }

  private load(): CacheData {
    const date = new Date(this.now()).toISOString().slice(0, 10);
    try {
      if (!fs.existsSync(this.cachePath)) return emptyCache(date);
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, "utf8")) as Partial<CacheData>;
      if (parsed.version !== 1 || !parsed.queries || !parsed.quota) return emptyCache(date);
      return parsed as CacheData;
    } catch (error) {
      console.warn("[AnimeGuessr] 搜索缓存读取失败，将重建:", error);
      return emptyCache(date);
    }
  }

  private save(): void {
    const entries = Object.entries(this.data.queries);
    if (entries.length > MAX_CACHE_ENTRIES) {
      entries.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
      this.data.queries = Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES));
    }
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const temp = `${this.cachePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(temp, this.cachePath);
  }
}
