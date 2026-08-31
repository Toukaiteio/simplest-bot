import type { Plugin, PromptBuildInput } from "../../types.js";

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export function createTimePlugin(): Plugin {
  return {
    name: "time",
    description: "为 AI 提供当前时间感知，追加到用户消息 chunk 尾部",

    onBuildSystemPrompt(_input: PromptBuildInput): string {
      const now = new Date();
      // Format in Asia/Shanghai (UTC+8)
      const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
      const cstMs = utcMs + 8 * 3600_000;
      const d = new Date(cstMs);
      const pad = (n: number) => String(n).padStart(2, "0");
      const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const weekday = WEEKDAYS[d.getDay()];

      return `[当前时间] ${dateStr} ${timeStr} ${weekday}`;
    },
  };
}
