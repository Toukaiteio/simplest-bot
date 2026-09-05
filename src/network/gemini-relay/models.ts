/**
 * gemini-web2api 的 Node.js 移植：模型注册表与解析。
 * 与 python 版 gemini_web2api/models.py 1:1 对齐。
 */

export type GeminiModelConfig = {
  /** 前端 MODE_CATEGORY：1=FAST, 2=THINKING, 3=PRO, 4=AUTO, 5=FAST_DYNAMIC_THINKING, 6=FLASH_LITE。 */
  mode: number;
  /** 默认思考深度（写入 payload inner[17]）。 */
  think: number;
  /** 额外 payload 槽位覆盖（如 enhanced 的 {31:2, 80:3}）。 */
  extra?: Record<number, unknown>;
  desc: string;
};

export const GEMINI_MODELS: Record<string, GeminiModelConfig> = {
  "gemini-3.7-flash": { mode: 1, think: 4, desc: "Latest all-around model (Gemini 3.7 Flash)" },
  "gemini-3.6-flash": { mode: 1, think: 4, desc: "All-around model (Gemini 3.6 Flash)" },
  "gemini-3.5-flash": { mode: 1, think: 4, desc: "Alias for gemini-3.6-flash (backend upgraded)" },
  "gemini-3.5-flash-thinking": { mode: 2, think: 0, desc: "Deep thinking mode, longest output (~20k chars)" },
  "gemini-3.1-pro": { mode: 3, think: 4, desc: "Pro model (requires cookie for real routing)" },
  "gemini-3.1-pro-enhanced": { mode: 3, think: 4, extra: { 31: 2, 80: 3 }, desc: "Pro with enhanced output (experimental)" },
  "gemini-auto": { mode: 4, think: 4, desc: "Auto model selection" },
  "gemini-3.5-flash-thinking-lite": { mode: 5, think: 0, desc: "Dynamic thinking with adaptive depth" },
  "gemini-flash-lite": { mode: 6, think: 4, desc: "Lightweight fast model" },
};

export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

export type ResolvedModel = {
  name: string;
  modeId: number;
  thinkMode: number;
  extra?: Record<number, unknown>;
  /** 非空表示解析失败（对应 HTTP 400）。 */
  error?: string;
};

/**
 * 解析模型名。@think=N 后缀覆盖思考深度；未知模型静默回退默认（与 python 一致，不报错）。
 */
export function resolveModel(modelName: string, defaultModel: string = DEFAULT_GEMINI_MODEL): ResolvedModel {
  let name = modelName;
  let thinkOverride: number | undefined;

  if (name.includes("@think=")) {
    // python: model_name.rsplit("@think=", 1)
    const index = name.lastIndexOf("@think=");
    const base = name.slice(0, index);
    const thinkText = name.slice(index + "@think=".length);
    const think = Number(thinkText);
    if (!Number.isInteger(think) || thinkText.trim() === "") {
      return { name, modeId: 0, thinkMode: 0, error: `Invalid think level: ${thinkText}` };
    }
    name = base;
    thinkOverride = think;
  }

  let config = GEMINI_MODELS[name];
  if (!config) {
    console.warn(`[Relay] Unknown model '${name}', falling back to '${defaultModel}'`);
    name = defaultModel;
    config = GEMINI_MODELS[name];
    if (!config) {
      return { name, modeId: 0, thinkMode: 0, error: `Invalid think level: ${defaultModel}` };
    }
  }

  return {
    name,
    modeId: config.mode,
    thinkMode: thinkOverride ?? config.think,
    extra: config.extra,
  };
}
