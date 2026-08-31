import type {
  MenuPlugin,
  Plugin,
  PluginContext,
  PromptBuildInput,
} from "../../types.js";
import type { MessageStore } from "../../message-store.js";
import type { PersonaStore } from "../../persona/profile-store.js";
import type { EvolutionEngine } from "../../persona/evolution-engine.js";
import {
  blendRapports,
  renderGroupBlock,
  renderRapportBlock,
  type PresentUser,
} from "../../persona/render.js";
import type { SoftCoreField } from "../../persona/types.js";
import { SOFT_CORE_FIELDS } from "../../persona/types.js";

/**
 * 人格自进化插件。
 *
 * 职责：
 *   1. onBuildSystemPrompt：动态注入群画像 + 在场用户 rapport（去偏闸③融合）。
 *      软核心 + 全局风格不在这里注入——它们是 immutable，启动时已拼进
 *      ContextManager.personaContent。
 *   2. 管理员命令：$persona show / diff / lock / unlock / rollback / evolve-now。
 *
 * 不重复注入好感度行为提示——那部分仍由 social-plugin 负责，本插件只补充
 * 跨场景一致的"语言风格"与 per-user 的"相处调音"。
 */
export function createPersonaPlugin(
  personaStore: PersonaStore,
  evolutionEngine: EvolutionEngine,
  messageStore: MessageStore,
  menuPlugin: MenuPlugin
): Plugin {
  return {
    name: "persona",
    description: "人格自进化：跨场景一致的语言风格与 per-user 相处调音",
    systemPromptAppend: [
      "[人格自进化]",
      "你有一套跨所有群聊和私聊保持一致的「语言风格规范」（见系统提示开头）。",
      "系统还会动态提供「与在场用户的相处方式」和「当前群的相处氛围」。",
      "请始终保持核心性格一致；不同群、不同用户的差异只体现在相处方式上，不要改变你是谁。",
    ].join("\n"),

    async onBuildSystemPrompt(input: PromptBuildInput) {
      const message = input.mode === "single"
        ? input.message
        : input.messages[input.messages.length - 1];

      const lines: string[] = [];

      // ── 群画像 ────────────────────────────────────────────────────────────
      if (message.type === "group" && message.groupId) {
        const group = personaStore.getGroupPersona(message.groupId);
        if (group && (group.vibe || group.myRole || group.topicHints.length || group.notes)) {
          lines.push(renderGroupBlock(group));
        }
      }

      // ── Rapport：收集在场用户 ──────────────────────────────────────────────
      // 在场用户 = 当前消息的发言者 + surrounding 里的其他发言者
      const userIds = new Set<string>();
      if (message.userId) userIds.add(message.userId);
      if (input.mode === "batch") {
        for (const m of input.messages) {
          if (m.userId && m.userId !== message.selfId) userIds.add(m.userId);
        }
      }

      const presentUsers: PresentUser[] = [];
      const presentNotes: string[] = [];
      for (const userId of userIds) {
        const rapport = personaStore.getRapport(userId);
        if (!rapport) continue;
        const strength = evolutionEngine.rapportStrength(userId);
        presentUsers.push({ userId, strength, rapport });
        if (rapport.notes.trim()) {
          presentNotes.push(`关于 ${userId}：${rapport.notes.trim()}`);
        }
      }

      const blended = blendRapports(presentUsers);
      const rapportBlock = renderRapportBlock(blended, presentNotes);
      if (rapportBlock) lines.push(rapportBlock);

      return lines.length > 0 ? lines.join("\n\n") : "";
    },

    onLoad(ctx: PluginContext) {
      const prefix = menuPlugin.getPrefix();

      // ── $persona show：查看当前人格状态 ──────────────────────────────────
      menuPlugin.registerCommand("persona", `人格管理：${prefix}persona show|diff|lock|unlock|rollback|evolve-now`, async (message, args) => {
        const sub = args[0] ?? "show";

        if (sub === "show") {
          await ctx.replyText(message, formatPersonaShow(personaStore));
          return;
        }

        if (sub === "diff") {
          await ctx.replyText(message, formatPersonaDiff(personaStore));
          return;
        }

        if (sub === "lock" || sub === "unlock") {
          const field = args[1] as SoftCoreField | undefined;
          if (!field || !SOFT_CORE_FIELDS.includes(field)) {
            await ctx.replyText(message, `用法：${prefix}persona ${sub} <字段>\n可选字段：${SOFT_CORE_FIELDS.join(", ")}`);
            return;
          }
          personaStore.setSoftCoreLocked(field, sub === "lock");
          await ctx.replyText(message, `软核心字段 ${field} 已${sub === "lock" ? "锁定" : "解锁"}。`);
          return;
        }

        if (sub === "rollback") {
          const ok = personaStore.rollback();
          await ctx.replyText(message, ok ? "已回滚到上一个版本。" : "没有可回滚的历史快照。");
          return;
        }

        if (sub === "evolve-now") {
          await ctx.replyText(message, "正在触发一次进化评估，请稍候...");
          try {
            const result = await evolutionEngine.runCycleNow();
            await ctx.replyText(
              message,
              `进化评估完成。软核心${result.softCoreChanged ? "已更新" : "未变化"}，全局风格${result.globalStyleChanged ? "已更新" : "未变化"}。`
            );
          } catch (error) {
            await ctx.replyText(message, `进化评估失败：${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        }

        await ctx.replyText(message, `用法：${prefix}persona show|diff|lock|unlock|rollback|evolve-now`);
      }, { adminOnly: true });
    },
  };
}

// ── 格式化辅助 ────────────────────────────────────────────────────────────────

function formatPersonaShow(store: PersonaStore): string {
  const profile = store.getProfile();
  const sc = profile.softCore;
  const gs = profile.globalStyle;

  const softLines = SOFT_CORE_FIELDS.map((f) => {
    const v = sc.values[f];
    const bar = renderBar(v);
    const lock = sc.locked[f] ? "🔒" : "  ";
    const pending = sc.pendingStreak[f] ? ` (累积${sc.pendingStreak[f]})` : "";
    return `${lock} ${f.padEnd(14)} ${bar} ${v.toFixed(2)}${pending}`;
  });

  const lines = [
    "=== 人格状态 ===",
    "",
    "[软核心 · 性格程度]",
    ...softLines,
    `累计漂移: ${sc.cumulativeDrift.toFixed(2)} / ${0.3}  版本: v${sc.version}`,
    "",
    "[全局语言风格]",
    `  正式度: ${gs.formality.toFixed(2)}  热情度: ${gs.warmth.toFixed(2)}  句长: ${gs.avgLength}`,
    `  语气词: [${gs.fillerWords.join(", ")}]`,
    `  口头习惯: [${gs.signatures.join(", ")}]`,
    `  补充: ${gs.notes || "(无)"}`,
    `  版本: v${gs.version}`,
    "",
    `[rapport 共 ${Object.keys(profile.rapports).length} 人，群画像共 ${Object.keys(profile.groups).length} 群]`,
    `历史快照: ${profile.history.length} 个`,
  ];
  return lines.join("\n");
}

function formatPersonaDiff(store: PersonaStore): string {
  const history = store.getHistory();
  const profile = store.getProfile();
  if (history.length === 0) {
    return "暂无历史快照，无法对比。";
  }
  const last = history[history.length - 1];
  const lines = [`对比上一版本 (v${last.version} → v${profile.softCore.version})：`, ""];

  // 软核心
  lines.push("[软核心变化]");
  let anyChange = false;
  for (const f of SOFT_CORE_FIELDS) {
    const oldV = last.softCore.values[f];
    const newV = profile.softCore.values[f];
    const delta = newV - oldV;
    if (Math.abs(delta) > 0.001) {
      lines.push(`  ${f}: ${oldV.toFixed(3)} → ${newV.toFixed(3)} (Δ${delta > 0 ? "+" : ""}${delta.toFixed(3)})`);
      anyChange = true;
    }
  }
  if (!anyChange) lines.push("  (无变化)");

  // 全局风格
  lines.push("[全局风格变化]");
  const gs = profile.globalStyle;
  const oldGs = last.globalStyle;
  const gsChanges: string[] = [];
  if (Math.abs(gs.formality - oldGs.formality) > 0.001) gsChanges.push(`formality: ${oldGs.formality.toFixed(2)}→${gs.formality.toFixed(2)}`);
  if (Math.abs(gs.warmth - oldGs.warmth) > 0.001) gsChanges.push(`warmth: ${oldGs.warmth.toFixed(2)}→${gs.warmth.toFixed(2)}`);
  if (gs.avgLength !== oldGs.avgLength) gsChanges.push(`avgLength: ${oldGs.avgLength}→${gs.avgLength}`);
  lines.push(gsChanges.length > 0 ? "  " + gsChanges.join("，") : "  (无变化)");

  return lines.join("\n");
}

function renderBar(v: number): string {
  const filled = Math.round(v * 10);
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}]`;
}
