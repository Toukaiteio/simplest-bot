import puppeteerExtraModule from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer-core";

import PuppeteerCore from "puppeteer-core";

type PuppeteerStealth = typeof PuppeteerCore & {
    use: (plugin: unknown) => unknown;
};

const Puppeteer = puppeteerExtraModule as unknown as PuppeteerStealth;
Puppeteer.use(StealthPlugin());

export type BrowserManagerConfig = {
  chromePath: string;
  headless?: boolean;
  launchArgs?: string[];
  defaultViewport?: { width: number; height: number };
  /** Chrome 用户数据目录，用于持久化登录态/cookies。设置后登录一次即可长期使用 */
  userDataDir?: string;
};

let browserPromise: Promise<Browser> | null = null;
let config: BrowserManagerConfig | null = null;

export function initBrowserManager(cfg: BrowserManagerConfig) {
  config = cfg;
}

export async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const existing = await browserPromise;
    if (existing.connected) return existing;
    browserPromise = null;
  }

  if (!config?.chromePath) {
    throw new Error("浏览器未配置：请在 bot.config.json 的 pluginSettings.browser.chromePath 中设置 Chrome 路径。");
  }

    const launchPromise = Puppeteer.launch({
      executablePath: config.chromePath,
      headless: config.headless ?? true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--allow-file-access-from-files",
        "--disable-blink-features=AutomationControlled",
        ...(config.userDataDir ? [`--user-data-dir=${config.userDataDir}`] : []),
        ...(config.launchArgs ?? []),
      ],
    defaultViewport: config.defaultViewport ?? { width: 1280, height: 800 },
  });

  browserPromise = launchPromise;
  return launchPromise;
}

export async function newPage(): Promise<import("puppeteer-core").Page> {
  const browser = await getBrowser();
  return browser.newPage();
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      if (browser.connected) {
        await browser.close();
      }
    } catch {
      // ignore close errors
    }
    browserPromise = null;
  }
}
