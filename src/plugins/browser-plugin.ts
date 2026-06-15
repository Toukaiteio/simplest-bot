import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import type { Page } from "puppeteer-core";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import type { Plugin, PromptBuildInput, LLMConfig } from "../types.js";
import type { BotToolRegistration } from "../tooling.js";

export type BrowserConfig = {
  host: string;
  port: number;
  connectTimeoutMs: number;
  navigationTimeoutMs: number;
  maxAgentSteps: number;
  viewportWidth: number;
  viewportHeight: number;
  screenshotFormat: "png" | "jpeg";
  /** Chrome 可执行文件路径。设置后插件自行启动 Chrome（headless 取决于 headless 配置），无需外部启动 remote debugger */
  chromePath: string;
  /** 是否无头模式（仅在 chromePath 设置时生效） */
  headless: boolean;
  /** 额外的 Chrome 启动参数 */
  launchArgs: string[];
};

const AGENT_SYSTEM_PROMPT = `你是一个浏览器自动化助手。用户给你一个任务，你需要通过浏览器一步步完成。

核心原则：不直接获取整个页面内容，而是通过 JS 命令逐步分析页面结构。

可用操作（一次只输出一个）：
- navigate: 导航到URL。输出格式: ACTION navigate {"url":"..."}
- evaluate: 执行任意JavaScript并返回结果。输出格式: ACTION evaluate {"code":"..."}
  - 用 document.title 获取标题
  - 用 document.querySelector('选择器')?.textContent 获取具体元素文本
  - 用 document.querySelectorAll('选择器').length 了解元素数量
  - 用 Array.from(document.querySelectorAll('选择器')).map(e => e.textContent) 获取多个元素
  - 用 $$('选择器') 在控制台获取元素列表
  - 用 document.location, document.URL 获取地址信息
- screenshot: 截图保存到当前会话工作区。输出格式: ACTION screenshot
- click: 点击CSS选择器对应的元素。输出格式: ACTION click {"selector":"..."}
- type: 在指定元素输入文本。输出格式: ACTION type {"selector":"...","text":"..."}
- waitForTimeout: 等待指定毫秒数。输出格式: ACTION waitForTimeout {"ms":2000}
- getUrl: 获取当前页面URL。输出格式: ACTION getUrl
- finish: 任务完成，输出最终结论。输出格式: ACTION finish {"result":"..."}

规则：
1. 每次只执行一步，等待结果后再决定下一步。
2. 导航到一个页面后，先通过 evaluate 获取 document.title 和少量关键元素，不要一次性提取大量内容。
3. 通过多个 evaluate 步骤，逐层缩小范围（标题 → 导航链接 → 列表 → 具体条目），渐进式理解页面。
4. 如果遇到登录/验证码等无法处理的情况，直接 finish 并说明原因。`;

export function createBrowserPlugin(): Plugin {
  return {
    name: "browser",
    description: "浏览器自动化（通过 Chrome Remote Debugger 控制浏览器）",
  };
}

export function browserToolRegistration(
  config: BrowserConfig,
  llmConfig: LLMConfig,
  getWorkspaceDir: (input: PromptBuildInput) => string
): BotToolRegistration {
  return {
    definition: {
      type: "function",
      function: {
        name: "browser_agent",
        description:
          "通过 Chrome Remote Debugger 启动一个异步 Agent 控制浏览器完成任务（访问网页、执行JS、截图等）。Agent会将页面截图/文件保存到当前会话的工作区。",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "告诉 Agent 要做什么，例如'打开百度搜索今天天气，截图保存'",
            },
          },
          required: ["prompt"],
        },
      },
    },
    async execute(args: Record<string, unknown>, input: PromptBuildInput) {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) {
        throw new Error("prompt 不能为空。");
      }

      const workspaceDir = getWorkspaceDir(input);
      fs.mkdirSync(workspaceDir, { recursive: true });

      const agent = new BrowserAgent(config, llmConfig, workspaceDir);
      return agent.run(prompt);
    },
  };
}

class BrowserAgent {
  private config: BrowserConfig;
  private llmConfig: LLMConfig;
  private workspaceDir: string;
  private messages: (SystemMessage | HumanMessage | AIMessage)[] = [];

  constructor(config: BrowserConfig, llmConfig: LLMConfig, workspaceDir: string) {
    this.config = config;
    this.llmConfig = llmConfig;
    this.workspaceDir = workspaceDir;
  }

  async run(prompt: string): Promise<string> {
    const chatModel = new ChatOpenAI({
      modelName: this.llmConfig.model,
      configuration: { baseURL: this.llmConfig.baseUrl },
      apiKey: this.llmConfig.apiKey || undefined,
      temperature: 0.1,
    });

    this.messages = [
      new SystemMessage(AGENT_SYSTEM_PROMPT),
      new HumanMessage(`用户任务：${prompt}`),
    ];

    let browser;
    let launched = false;
    try {
      if (this.config.chromePath) {
        browser = await puppeteer.launch({
          executablePath: this.config.chromePath,
          headless: this.config.headless,
          args: [
            `--remote-debugging-port=${this.config.port}`,
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            ...this.config.launchArgs,
          ],
          defaultViewport: {
            width: this.config.viewportWidth,
            height: this.config.viewportHeight,
          },
          protocolTimeout: this.config.connectTimeoutMs,
        });
        launched = true;
      } else {
        browser = await puppeteer.connect({
          browserURL: `http://${this.config.host}:${this.config.port}`,
          defaultViewport: {
            width: this.config.viewportWidth,
            height: this.config.viewportHeight,
          },
          protocolTimeout: this.config.connectTimeoutMs,
        });
      }

      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);

      for (let step = 0; step < this.config.maxAgentSteps; step++) {
        const stepResult = await this.runStep(chatModel, page);
        if (stepResult.finished) {
          return stepResult.result;
        }
      }

      return "Agent 已达到最大步骤数，任务未完成。";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `浏览器 Agent 执行失败：${message}`;
    } finally {
      if (browser) {
        try {
          if (launched) {
            await browser.close();
          } else {
            await browser.disconnect();
          }
        } catch { /* ignore */ }
      }
    }
  }

  private async runStep(
    chatModel: ChatOpenAI,
    page: Page
  ): Promise<{ finished: boolean; result: string }> {
    const response = await chatModel.invoke(this.messages);
    const text = typeof response.content === "string" ? response.content : "";

    if (!text.startsWith("ACTION ")) {
      // LLM 没按格式输出，重试一次
      this.messages.push(response);
      this.messages.push(new HumanMessage(
        "请严格按照格式输出，每行只能有一个 ACTION 指令。"
      ));
      return { finished: false, result: "" };
    }

    const actionLine = text.slice("ACTION ".length).trim();
    const spaceIdx = actionLine.indexOf(" ");
    const action = spaceIdx > 0 ? actionLine.slice(0, spaceIdx) : actionLine;
    const argsRaw = spaceIdx > 0 ? actionLine.slice(spaceIdx + 1).trim() : "{}";
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsRaw) as Record<string, unknown>;
    } catch { /* ignore malformed JSON */ }

    this.messages.push(response);

    try {
      switch (action) {
        case "navigate": {
          const url = String(args.url ?? "");
          if (!url) {
            this.messages.push(new HumanMessage("错误：navigate 必须提供 url 参数。"));
            break;
          }
          await page.goto(url, { waitUntil: "networkidle2" });
          this.messages.push(new HumanMessage(`导航成功：${page.url()}`));
          break;
        }
        case "evaluate": {
          const code = String(args.code ?? "");
          if (!code) {
            this.messages.push(new HumanMessage("错误：evaluate 必须提供 code 参数。"));
            break;
          }
          const result = await page.evaluate(code);
          const resultText = typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2);
          this.messages.push(new HumanMessage(
            `JS 执行结果：\n${resultText.slice(0, 3000)}`
          ));
          break;
        }
        case "screenshot": {
          const fileName = `screenshot-${Date.now()}.${this.config.screenshotFormat}`;
          const filePath = path.join(this.workspaceDir, fileName);
          await page.screenshot({
            path: filePath,
            fullPage: true,
          });
          this.messages.push(new HumanMessage(
            `截图已保存到工作区：${fileName}`
          ));
          break;
        }
        case "click": {
          const selector = String(args.selector ?? "");
          if (!selector) {
            this.messages.push(new HumanMessage("错误：click 必须提供 selector 参数。"));
            break;
          }
          await page.click(selector);
          await page.waitForNetworkIdle({ idleTime: 500 }).catch(() => {});
          this.messages.push(new HumanMessage(`已点击：${selector}`));
          break;
        }
        case "type": {
          const typeSelector = String(args.selector ?? "");
          const typeText = String(args.text ?? "");
          if (!typeSelector) {
            this.messages.push(new HumanMessage("错误：type 必须提供 selector 参数。"));
            break;
          }
          await page.type(typeSelector, typeText);
          this.messages.push(new HumanMessage(`已在 ${typeSelector} 输入文本：${typeText}`));
          break;
        }
        case "waitForTimeout": {
          const ms = Number(args.ms) || 1000;
          await new Promise((r) => setTimeout(r, ms));
          this.messages.push(new HumanMessage(`已等待 ${ms}ms`));
          break;
        }
        case "getUrl": {
          this.messages.push(new HumanMessage(`当前 URL：${page.url()}`));
          break;
        }
        case "finish": {
          const result = String(args.result ?? "任务完成");
          return { finished: true, result };
        }
        default: {
          this.messages.push(new HumanMessage(`未知操作：${action}`));
          break;
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.messages.push(new HumanMessage(`操作执行错误：${errMsg}`));
    }

    return { finished: false, result: "" };
  }
}
