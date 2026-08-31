import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContributionStore } from "./contribution-store.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anime-contributions-"));
const file = path.join(tempDir, "store.json");
try {
  const store = new ContributionStore(file);
  const first = store.submit("10001", "小明", "create_character", { nameCn: "测试角色" }, "新建测试角色");
  const second = store.submit("10002", "小红", "create_work", { nameCn: "测试作品" }, "新建测试作品");
  const quick = store.submit("10003", "小刚", "import_work", {
    work: { id: 123, name: "Test", nameCn: "测试动画" },
    characters: [{ id: 456, name: "测试人物" }],
  }, "快速导入测试动画");
  assert.deepEqual(store.listPending({ userId: "10001" }).map((item) => item.id), [first.id]);
  assert.equal(store.listPending({ before: quick.createdAt }).length, 3);
  store.review([first.id], "approved", "admin", null);
  assert.equal(store.listByUser("10001")[0].status, "approved");
  const reloaded = new ContributionStore(file);
  assert.equal(reloaded.listByUser("10002")[0].status, "pending");
  assert.equal((reloaded.listByUser("10003")[0].payload.work as { id: number }).id, 123, "快速投稿快照应完整持久化");
  console.log("✅ 投稿持久化、按用户/时间筛选和审核状态均正常");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
