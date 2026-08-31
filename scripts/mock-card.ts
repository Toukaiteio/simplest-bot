import https from "node:https";
import { initBrowserManager, closeBrowser } from "../src/browser/browser-manager.js";
import { renderSgsCardImage } from "../src/plugins/sgs-card/canvas-renderer.js";
import type { SgsCardData } from "../src/plugins/sgs-card/schema.js";

function fetchUrlAsDataUri(url: string): Promise<string> {
  return new Promise((resolve) => {
    https.get(url, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrlAsDataUri(res.headers.location).then(resolve);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const mime = res.headers["content-type"] || "image/jpeg";
        resolve(`data:${mime};base64,${buf.toString("base64")}`);
      });
      res.on("error", () => resolve(""));
    }).on("timeout", () => resolve("")).on("error", () => resolve(""));
  });
}

initBrowserManager({
  chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});

const card: SgsCardData = {
  name: "雲龍",
  title: "亮剑先锋",
  faction: "蜀",
  hp: 4,
  maxHp: 4,
  armor: 0,
  flavor: "二营长，你他娘的意大利炮呢！",
  backstory:
    "李云龙，晋西北铁血军人，以「亮剑」精神闻名于世。逢敌必亮剑，绝不后退半步。他粗中有细，重情重义，麾下独立团攻无不克。虽屡犯军纪却赤胆忠心，是战场上让敌人闻风丧胆的传奇将领。",
  skills: [
    {
      name: "開炮",
      type: "限定技",
      desc: "出牌阶段，你可以弃置所有手牌并指定一名其他角色，该角色受到2点雷电伤害。若其因此死亡，你回复1点体力并获得其所有牌。",
    },
    {
      name: "亮劍",
      desc: "锁定技。当你成为【杀】的目标时，若你没有手牌，此【杀】对你无效，且你可以对使用者返回一张【杀】。",
    },
    {
      name: "鐵血",
      desc: "觉醒技。当你的体力值首次减少至2或更少时，你将体力上限减1，获得护甲2点，然后获得技能「坚韧」。",
    },
  ],
  designNotes: ["高爆发", "觉醒线", "反击流"],
};

async function main() {
  console.log("Fetching test avatar...");
  card.artImage = await fetchUrlAsDataUri("https://picsum.photos/400/570");
  console.log("Avatar data URI length:", card.artImage.length);

  const outputDir = "data/sgs-card/mock";
  const filePath = await renderSgsCardImage({
    outputDir,
    data: card,
    fileStem: "mock-with-avatar",
  });
  console.log("Done: " + filePath);
  await closeBrowser();
}

main().catch(console.error);
