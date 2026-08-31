import path from "node:path";
import { initBrowserManager, getBrowser, closeBrowser } from "../src/browser/browser-manager.js";

initBrowserManager({
  chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});

async function main() {
  const browser = await getBrowser();
  const page = await browser.newPage();

  page.on("pageerror", (err) => console.log("ERR:", err.message));

  await page.setViewport({ width: 500, height: 700, deviceScaleFactor: 1 });

  const fs = await import("node:fs");
  const xkBuf = fs.readFileSync("src/plugins/sgs-card/static/fonts/xingkai.woff2");
  const xkUri = `data:font/woff2;base64,${xkBuf.toString("base64")}`;
  const hcBuf = fs.readFileSync("src/plugins/sgs-card/static/fonts/huangcao.woff2");
  const hcUri = `data:font/woff2;base64,${hcBuf.toString("base64")}`;
  const xzBuf = fs.readFileSync("src/plugins/sgs-card/static/fonts/xiaozhuan.woff2");
  const xzUri = `data:font/woff2;base64,${xzBuf.toString("base64")}`;
  const ssBuf = fs.readFileSync("src/plugins/sgs-card/static/fonts/shousha.woff2");
  const ssUri = `data:font/woff2;base64,${ssBuf.toString("base64")}`;

  // Use JS FontFace API (same as the renderer now)
  const result = await page.evaluate(async (fonts) => {
    const results: Record<string, number> = {};

    // Load all fonts via JS API
    for (const [name, uri] of Object.entries(fonts)) {
      const font = new FontFace(name, 'url(' + uri + ')');
      await font.load();
      document.fonts.add(font);
    }
    await new Promise(r => setTimeout(r, 300));

    // Check availability
    const checks: Record<string, boolean> = {};
    for (const name of Object.keys(fonts)) {
      checks[name] = document.fonts.check('12px "' + name + '"');
    }
    results['__checks'] = checks as any;

    // Render each font individually and store pixel signature
    const signatures: Record<string, number[]> = {};

    for (const name of Object.keys(fonts)) {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 200;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 400, 200);
      ctx.fillStyle = 'black';
      ctx.font = '40px "' + name + '"';
      ctx.fillText('測試', 50, 100);
      // Sample center row pixels
      const data = ctx.getImageData(0, 80, 400, 1).data;
      const grays = [];
      for (let i = 0; i < data.length; i += 4) {
        grays.push(data[i]); // R channel (grayscale since bg is white)
      }
      signatures[name] = grays;
    }

    // Compare each font's signature against XingKai
    const base = signatures['XingKai'];
    for (const [name, sig] of Object.entries(signatures)) {
      if (name === 'XingKai') continue;
      let diff = 0;
      for (let i = 0; i < base.length; i++) {
        if (Math.abs(base[i] - sig[i]) > 5) diff++;
      }
      results[name + '_vs_XingKai'] = diff;
    }

    return results;
  }, { XingKai: xkUri, HuangCao: hcUri, XiaoZhuan: xzUri, ShouSha: ssUri });

  console.log("Font availability:", JSON.stringify((result as any).__checks, null, 2));
  console.log("\nPixel differences vs XingKai:");
  for (const [key, val] of Object.entries(result)) {
    if (key.startsWith("__")) continue;
    console.log(`  ${key}: ${val}`);
  }

  await page.close();
  await closeBrowser();
}

main().catch(console.error);
