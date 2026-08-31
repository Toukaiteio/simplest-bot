/**
 * Render the test HTML to PNG using puppeteer-core + Chrome.
 * Run: node render-preview.cjs
 */
const puppeteer = require("puppeteer-core");
const path = require("path");
const htmlPath = path.resolve(__dirname, "data/daily-reports-test/2026-06-29/group-123456789.html");
const imgPath = path.resolve(__dirname, "data/daily-reports-test/2026-06-29/group-123456789.png");
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 800 });

  const fileUrl = "file:///" + htmlPath.replace(/\\/g, "/");
  await page.goto(fileUrl, { waitUntil: "networkidle0" });

  const clip = await page.evaluate(() => {
    const el = document.querySelector(".sheet");
    if (!el) return { x: 0, y: 0, width: 1200, height: 1200 };
    const r = el.getBoundingClientRect();
    return {
      x: Math.max(0, el.offsetLeft - 8),
      y: Math.max(0, el.offsetTop - 8),
      width: Math.ceil(r.width + 16),
      height: Math.ceil(r.height + 16)
    };
  });

  await page.screenshot({ path: imgPath, clip });
  await browser.close();
  console.log("Screenshot saved to:", imgPath);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
