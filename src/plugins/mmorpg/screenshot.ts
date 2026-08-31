import fs from "node:fs";
import { getBrowser, closeBrowser } from "../../browser/browser-manager.js";
export { closeBrowser };

/* ── Public: screenshot HTML ── */

/**
 * Render an HTML string to an image file.
 *
 * The screenshot is clipped to the actual content bounds so there is no
 * extra whitespace below the rendered card.
 *
 * @param options.format  "png" (default) or "webp"
 * @param options.quality WebP quality 0-100 (default 85, ignored for PNG)
 */
export async function screenshotHtml(
  html: string,
  imagePath: string,
  options?: { width?: number; format?: "png" | "webp"; quality?: number },
): Promise<void> {
  const format = options?.format ?? "png";
  const quality = options?.quality ?? 85;

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Use a wide viewport first to let content render at its natural width,
    // then measure the actual content width to determine the final clip size.
    const wideViewportWidth = 1200;
    await page.setViewport({ width: wideViewportWidth, height: 600, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "load" });

    // Measure the real content bounding box so we can clip precisely.
    const contentBox = await page.evaluate(() => {
      const container = document.querySelector(".sheet, .m, .mc, .bl, .tc, .pf, .gc") as HTMLElement | null;
      if (container) {
        const r = container.getBoundingClientRect();
        return { x: Math.ceil(r.left), y: Math.ceil(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
      }
      const firstChild = document.body.firstElementChild as HTMLElement | null;
      if (firstChild) {
        const r = firstChild.getBoundingClientRect();
        return { x: Math.ceil(r.left), y: Math.ceil(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
      }
      return {
        x: 0,
        y: 0,
        width: Math.max(
          document.body.scrollWidth,
          document.body.offsetWidth,
          document.documentElement.clientWidth,
          document.documentElement.scrollWidth,
          document.documentElement.offsetWidth,
        ),
        height: Math.max(
          document.body.scrollHeight,
          document.body.offsetHeight,
          document.documentElement.clientHeight,
          document.documentElement.scrollHeight,
          document.documentElement.offsetHeight,
        ),
      };
    });

    await page.screenshot({
      path: imagePath,
      type: format,
      ...(format === "webp" ? { quality } : {}),
      clip: {
        x: contentBox.x,
        y: contentBox.y,
        width: contentBox.width,
        height: Math.max(contentBox.height, 100),
      },
    });
  } finally {
    await page.close();
  }
}

/* ── Public: convert PNG/JPEG to WebP ── */

/**
 * Convert a PNG/JPEG image file to WebP format using Puppeteer.
 * Returns the path to the new .webp file (original is left untouched).
 */
export async function convertImageToWebp(
  inputPath: string,
  quality?: number,
): Promise<string> {
  const outputPath = inputPath.replace(/\.(png|jpe?g)$/i, ".webp");
  if (outputPath === inputPath) {
    // Already webp or unknown format
    return inputPath;
  }

  const imgData = fs.readFileSync(inputPath);
  const ext = inputPath.split(".").pop()?.toLowerCase() ?? "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  const b64 = imgData.toString("base64");

  const html = `<!DOCTYPE html><html><head><style>*{margin:0;padding:0;}body{display:inline-block;}</style></head><body><img src="data:${mime};base64,${b64}" /></body></html>`;

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(html, { waitUntil: "load" });

    const imgEl = await page.$("img");
    if (!imgEl) throw new Error("Failed to locate img element for conversion.");
    const box = await imgEl.boundingBox();
    if (!box) throw new Error("Failed to measure image dimensions for conversion.");

    await page.screenshot({
      path: outputPath,
      type: "webp",
      quality: quality ?? 85,
      clip: { x: 0, y: 0, width: Math.ceil(box.width), height: Math.ceil(box.height) },
    });
  } finally {
    await page.close();
  }

  return outputPath;
}

/* ── Process exit cleanup ── */

