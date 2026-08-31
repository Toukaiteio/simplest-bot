import fs from "node:fs";
import path from "node:path";
import type { AnimeWork, Contribution, ContributionType } from "./types.js";

type StoreData = { nextId: number; contributions: Contribution[]; works: AnimeWork[] };

const emptyStore = (): StoreData => ({ nextId: 1, contributions: [], works: [] });

export class ContributionStore {
  private readonly filePath: string;
  private data: StoreData;

  constructor(filePath: string, initialWorks: AnimeWork[] = []) {
    this.filePath = path.resolve(process.cwd(), filePath);
    this.data = this.load();
    if (initialWorks.length) {
      const merged = new Map(this.data.works.map((work) => [work.id, work]));
      for (const work of initialWorks) merged.set(work.id, { ...merged.get(work.id), ...work });
      this.data.works = [...merged.values()];
      this.save();
    }
  }

  private load(): StoreData {
    try {
      if (!fs.existsSync(this.filePath)) return emptyStore();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoreData>;
      return {
        nextId: Math.max(1, Number(parsed.nextId) || 1),
        contributions: Array.isArray(parsed.contributions) ? parsed.contributions : [],
        works: Array.isArray(parsed.works) ? parsed.works : [],
      };
    } catch (error) {
      console.warn("[AnimeGuessr] 投稿数据读取失败，将使用空数据:", error);
      return emptyStore();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  submit(userId: string, userName: string, type: ContributionType, payload: Record<string, unknown>, summary: string): Contribution {
    const item: Contribution = {
      id: this.data.nextId++, userId, userName, type, payload, summary, status: "pending",
      createdAt: Date.now(), reviewedAt: null, reviewedBy: null, reviewNote: null,
    };
    this.data.contributions.push(item);
    this.save();
    return item;
  }

  listPending(filter?: { userId?: string; before?: number }, limit = 20): Contribution[] {
    return this.data.contributions
      .filter((item) => item.status === "pending")
      .filter((item) => !filter?.userId || item.userId === filter.userId)
      .filter((item) => !filter?.before || item.createdAt <= filter.before)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }

  listByUser(userId: string, limit = 20): Contribution[] {
    return this.data.contributions.filter((item) => item.userId === userId).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  review(ids: number[], status: "approved" | "rejected", adminId: string, note: string | null): Contribution[] {
    const wanted = new Set(ids);
    const changed: Contribution[] = [];
    for (const item of this.data.contributions) {
      if (item.status !== "pending" || !wanted.has(item.id)) continue;
      item.status = status;
      item.reviewedAt = Date.now();
      item.reviewedBy = adminId;
      item.reviewNote = note;
      changed.push(item);
    }
    if (changed.length) this.save();
    return changed;
  }

  getWorks(): AnimeWork[] { return this.data.works; }

  findWork(query: string): AnimeWork | undefined {
    const q = query.trim().toLowerCase();
    const id = Number(q);
    return this.data.works.find((work) => (Number.isInteger(id) && work.id === id) || work.name.toLowerCase() === q || work.nameCn.toLowerCase() === q);
  }

  upsertWork(work: AnimeWork, persist = true): void {
    const index = this.data.works.findIndex((item) => item.id === work.id);
    if (index >= 0) this.data.works[index] = { ...this.data.works[index], ...work };
    else this.data.works.push(work);
    if (persist) this.save();
  }
}
