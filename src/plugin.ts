import type { Plugin, PluginContext, BotMessage, OneBotMessageSegment, PromptBuildInput } from "./types.js";

export class PluginManager {
  private plugins: Plugin[] = [];
  private ctx?: PluginContext;

  register(plugin: Plugin) {
    this.plugins.push(plugin);
    console.log(`[Plugin] 已注册: ${plugin.name} - ${plugin.description}`);
  }

  setContext(ctx: PluginContext) {
    this.ctx = ctx;
  }

  async loadAll() {
    if (!this.ctx) throw new Error("PluginManager 未设置上下文");

    for (const plugin of this.plugins) {
      await this.loadOne(plugin);
    }
  }

  async loadOne(plugin: Plugin) {
    if (!this.ctx) throw new Error("PluginManager 未设置上下文");

    try {
      await plugin.onLoad?.(this.ctx);
      console.log(`[Plugin] 已加载: ${plugin.name}`);
    } catch (error) {
      console.error(`[Plugin] 加载失败 ${plugin.name}:`, error);
    }
  }

  async processMessage(message: BotMessage): Promise<boolean> {
    if (!this.ctx) return false;

    for (const plugin of this.plugins) {
      if (!plugin.onMessage) continue;
      try {
        const blocked = await plugin.onMessage(message, this.ctx);
        if (blocked === true) return true;
      } catch (error) {
        console.error(`[Plugin] 处理消息错误 ${plugin.name}:`, error);
      }
    }

    return false;
  }

  listPlugins(): { name: string; description: string }[] {
    return this.plugins.map((p) => ({ name: p.name, description: p.description }));
  }

  async shouldReply(message: BotMessage): Promise<boolean> {
    for (const plugin of this.plugins) {
      if (!plugin.onShouldReply) continue;
      try {
        const reply = await plugin.onShouldReply(message, this.ctx);
        if (!reply) return false;
      } catch (error) {
        console.error(`[Plugin] shouldReply 错误 ${plugin.name}:`, error);
      }
    }
    return true;
  }

  getSystemPromptAppends(): string[] {
    const appends: string[] = [];
    for (const plugin of this.plugins) {
      if (plugin.systemPromptAppend) {
        appends.push(plugin.systemPromptAppend);
      }
    }
    return appends;
  }

  async transformResponse(text: string, context?: { groupId?: string }): Promise<OneBotMessageSegment[] | null> {
    let currentText = text;
    const allSegments: OneBotMessageSegment[] = [];
    let anyMatch = false;

    for (const plugin of this.plugins) {
      if (!plugin.onTransformResponse) continue;
      try {
        const result = await plugin.onTransformResponse(currentText, context);
        if (result === null) continue;
        anyMatch = true;
        allSegments.push(...result.segments);
        currentText = result.remainingText;
      } catch (error) {
        console.error(`[Plugin] transformResponse 错误 ${plugin.name}:`, error);
      }
    }

    if (!anyMatch) return null;

    if (currentText) {
      allSegments.push({ type: "text", data: { text: currentText } });
    }

    return allSegments;
  }

  async splitResponse(text: string): Promise<string[] | null> {
    for (const plugin of this.plugins) {
      if (!plugin.onSplit) continue;
      try {
        const parts = await plugin.onSplit(text);
        if (parts !== null) return parts;
      } catch (error) {
        console.error(`[Plugin] splitResponse 错误 ${plugin.name}:`, error);
      }
    }
    return null;
  }

  async buildDynamicPromptAppends(input: PromptBuildInput): Promise<string[]> {
    const appends: string[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.onBuildSystemPrompt) continue;
      try {
        const result = await plugin.onBuildSystemPrompt(input);
        if (result) appends.push(result);
      } catch (error) {
        console.error(`[Plugin] buildDynamicPromptAppends 错误 ${plugin.name}:`, error);
      }
    }
    return appends;
  }
}
