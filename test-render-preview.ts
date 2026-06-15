import path from "node:path";
import { renderMenuToImage, renderDetailMenuToImage } from "./src/plugins/mmorpg/menu-renderer.js";
import type { PendingMenu } from "./src/plugins/mmorpg/schema.js";

async function main() {
  const baseDir = "C:\\Users\\abc123\\.qoderworkcn\\workspace\\mqagap1dgqkr2xbe\\outputs";

  // Area menu
  const areaMenu: PendingMenu = {
    context: "起始村庄 · Lv.1-10",
    title: "起始村庄",
    items: [
      { label: "前往 翠风草原", description: "Lv.5-15", action: { type: "move", targetId: "emerald_grassland" } },
      { label: "前往 矿洞入口", description: "Lv.8-18", action: { type: "move", targetId: "mine_entrance" } },
      { label: "狩猎 史莱姆", description: "Lv.3", action: { type: "hunt", targetId: "slime" } },
      { label: "狩猎 野狼", description: "Lv.6", action: { type: "hunt", targetId: "wolf" } },
      { label: "村长老约翰", description: "quest", action: { type: "talk", targetId: "elder_john" } },
      { label: "杂货商人玛莎", description: "merchant", action: { type: "talk", targetId: "merchant_martha" } },
      { label: "采集 药草丛", description: "草药学", action: { type: "gather", targetId: "herb_patch" } },
      { label: "钓鱼", description: "抛下鱼线", action: { type: "fish" } },
      { label: "接受任务：新手试炼", description: "Lv.1", action: { type: "accept_quest", targetId: "q1" } },
      { label: "接受任务：药草收集", description: "Lv.3", action: { type: "accept_quest", targetId: "q2" } },
    ],
    createdAt: new Date().toISOString(),
  };
  const p1 = await renderMenuToImage(areaMenu, baseDir);
  console.log("Area menu:", p1);

  // Detail menu
  const detailMenu: PendingMenu = {
    context: "Lv.40-60",
    title: "暗影峡谷",
    items: [
      { label: "前往 幽暗密林", description: "Lv.35-50", action: { type: "move", targetId: "dark_forest" } },
      { label: "前往 亡灵墓地", description: "Lv.50-70", action: { type: "move", targetId: "undead_graveyard" } },
      { label: "狩猎 暗影骑士", description: "Lv.48", action: { type: "hunt", targetId: "shadow_knight" } },
      { label: "进入 深渊裂隙副本", description: "Lv.55+", action: { type: "enter_dungeon", targetId: "abyss_rift" } },
      { label: "接受任务：暗影净化", description: "Lv.45", action: { type: "accept_quest", targetId: "q_shadow" } },
    ],
    createdAt: new Date().toISOString(),
  };
  const p2 = await renderDetailMenuToImage({
    title: "暗影峡谷",
    context: "Lv.40-60",
    details: [
      { label: "描述", value: "终年被黑雾笼罩的深邃峡谷，亡灵生物在此徘徊。" },
      { label: "阵营", value: "暗影议会" },
      { label: "可前往", value: "幽暗密林、亡灵墓地、地下城入口" },
    ],
    menu: detailMenu,
  }, baseDir);
  console.log("Detail menu:", p2);
}

main().catch(e => { console.error(e); process.exit(1); });
