import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import type { WikiEntry } from "../schema.js";

export type WikiSearchResult = {
  entry: WikiEntry;
  score: number;
};

function normalizeKeyword(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

export function searchWikiEntries(query: string): WikiSearchResult[] {
  const normalized = normalizeKeyword(query);
  if (!normalized) return [];

  const entries = Object.values(DEFAULT_MMORPG_CONTENT.wikiEntries);
  const results: WikiSearchResult[] = [];

  for (const entry of entries) {
    let score = 0;
    const title = normalizeKeyword(entry.title);
    const category = normalizeKeyword(entry.category ?? "");

    if (entry.id === normalized) score += 100;
    if (title === normalized) score += 80;
    if (title.includes(normalized)) score += 40;
    if (category === normalized) score += 30;
    if (category.includes(normalized)) score += 15;

    const keywordHits = entry.keywords.filter((k) =>
      normalizeKeyword(k).includes(normalized)
    ).length;
    score += keywordHits * 20;

    if (normalizeKeyword(entry.content).includes(normalized)) score += 5;

    if (score > 0) results.push({ entry, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

export function formatWikiEntry(entry: WikiEntry): string {
  const category = entry.category ? `【${entry.category}】` : "";
  return `${category}${entry.title}\n\n${entry.content}\n\n相关关键词：${entry.keywords.join("、")}`;
}

export function formatWikiResults(query: string, results: WikiSearchResult[]): string {
  if (results.length === 0) {
    return `未找到与“${query}”相关的百科条目，换个关键词试试？`;
  }

  if (results.length === 1) {
    return formatWikiEntry(results[0].entry);
  }

  const main = results[0];
  const lines = [formatWikiEntry(main.entry), ""];

  const others = results.slice(1, 6);
  if (others.length > 0) {
    lines.push("其他相关条目：");
    for (const r of others) {
      const cat = r.entry.category ? `[${r.entry.category}] ` : "";
      lines.push(`• ${cat}${r.entry.title}（ID: ${r.entry.id}）`);
    }
  }

  return lines.join("\n");
}
