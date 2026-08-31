import fs from "node:fs";
import path from "node:path";
import type {
  PluginContext,
  BotMessage,
  MenuPlugin,
  CoreCommandPlugin,
  CoreCommandHandler,
  MenuCommandEntry,
  MenuCommandGroup,
  MenuCommandOptions,
} from "../../types.js";
import { screenshotHtml } from "../mmorpg/screenshot.js";

/* ── Group colour palette (deterministic via hash) ── */

const GROUP_COLORS = [
  "#e3b341", "#58a6ff", "#f47067", "#3fb950",
  "#bc8cff", "#f78166", "#79c0ff", "#d2a8ff",
  "#f0883e", "#7ee787",
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function colorFor(groupId: string): string {
  return GROUP_COLORS[hashStr(groupId) % GROUP_COLORS.length];
}

/* ── Collapse threshold ── */

const COLLAPSE_THRESHOLD = 6;

/* ── CSS ── */

const MENU_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0f1117; font-family: "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif; }
.mc { background: #0f1117; color: #c9d1d9; padding: 14px 16px; width: fit-content; min-width: 520px; }
.mc-hd { display: flex; align-items: center; gap: 8px; padding-bottom: 8px; border-bottom: 2px solid #e3b341; margin-bottom: 14px; }
.mc-t { font-size: 15px; font-weight: 700; color: #e3b341; }
.mc-grp { margin-bottom: 14px; padding-left: 10px; border-left: 3px solid #58a6ff; }
.mc-grp-hd { margin-bottom: 6px; }
.mc-grp-label { font-size: 12px; font-weight: 700; color: #8b949e; letter-spacing: 0.5px; }
.mc-grp-desc { font-size: 10px; color: #484f58; margin-top: 1px; }
.mc-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; row-gap: 4px; }
.mc-item { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; padding: 2px 0; }
.mc-cmd { color: #58a6ff; font-weight: 700; font-family: Consolas, "Courier New", monospace; font-size: 11.5px; white-space: nowrap; }
.mc-desc { color: #c9d1d9; font-size: 10.5px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-tag { font-size: 9px; color: #f0883e; border: 1px solid #f0883e; border-radius: 2px; padding: 0 2px; margin-left: 4px; flex-shrink: 0; scale: 0.9; }
.mc-more { margin-top: 6px; font-size: 10.5px; color: #8b949e; padding: 4px 0; border-top: 1px dashed #22272e; }
.mc-more-cmd { color: #58a6ff; font-family: Consolas, monospace; font-weight: 700; }
.mc-back { margin-top: 14px; padding-top: 8px; border-top: 1px solid #22272e; font-size: 10.5px; color: #8b949e; }
.mc-back-cmd { color: #58a6ff; font-family: Consolas, monospace; font-weight: 700; }
.mc-ft { margin-top: 12px; padding-top: 8px; border-top: 1px solid #22272e; font-size: 10px; color: #484f58; text-align: center; }
`;

function esc(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function extractShortDescription(description: string): string {
  const m = description.match(/^(.+?)[：:]/);
  if (m) return m[1].trim();
  return description;
}

/* ── Resolved group with commands ── */

type ResolvedGroup = {
  id: string;
  label: string;
  description?: string;
  color: string;
  commands: MenuCommandEntry[];
};

function resolveGroups(
  commands: MenuCommandEntry[],
  groups: Map<string, MenuCommandGroup>,
  groupAssignments: Map<string, string>,
): ResolvedGroup[] {
  // Build command lists per group
  const buckets = new Map<string, MenuCommandEntry[]>();

  for (const cmd of commands) {
    let groupId: string | undefined = groupAssignments.get(cmd.name);

    // Auto-detect from prefix
    if (!groupId) {
      const prefix = cmd.name.split("-")[0];
      if (prefix && groups.has(prefix)) {
        groupId = prefix;
      }
    }

    if (!groupId) groupId = "_misc";

    if (!buckets.has(groupId)) buckets.set(groupId, []);
    buckets.get(groupId)!.push(cmd);
  }

  // Build resolved groups in registration order, then misc last
  const result: ResolvedGroup[] = [];
  const seen = new Set<string>();

  for (const [id, grp] of groups) {
    if (!buckets.has(id)) continue;
    const cmds = buckets.get(id)!;
    cmds.sort((a, b) => a.name.localeCompare(b.name));
    result.push({ id, label: grp.label, description: grp.description, color: colorFor(id), commands: cmds });
    seen.add(id);
  }

  // Misc group
  const miscCmds = buckets.get("_misc");
  if (miscCmds && miscCmds.length > 0) {
    miscCmds.sort((a, b) => a.name.localeCompare(b.name));
    result.push({ id: "_misc", label: "其他", color: "#484f58", commands: miscCmds });
  }

  return result;
}

/* ── HTML builders ── */

function buildCommandItemsHtml(prefix: string, cmds: MenuCommandEntry[]): string {
  return cmds.map(cmd => {
    const adminTag = cmd.adminOnly ? '<span class="mc-tag">管理</span>' : "";
    const text = (cmd.shortDescription || cmd.description);
    const displayText = text.length > 40 ? text.slice(0, 38) + "…" : text;
    return `<div class="mc-item">
      <span class="mc-cmd">${esc(prefix + cmd.name)}</span>
      <span class="mc-desc">${esc(displayText)}${adminTag}</span>
    </div>`;
  }).join("\n");
}

function buildGroupSectionHtml(prefix: string, group: ResolvedGroup, collapsed: boolean): string {
  const visibleCmds = collapsed ? group.commands.slice(0, 4) : group.commands;
  const itemsHtml = buildCommandItemsHtml(prefix, visibleCmds);
  const descHtml = group.description ? `<div class="mc-grp-desc">${esc(group.description)}</div>` : "";

  let moreHtml = "";
  if (collapsed && group.commands.length > 4) {
    const remaining = group.commands.length - 4;
    moreHtml = `<div class="mc-more">还有 ${remaining} 个命令 → <span class="mc-more-cmd">${esc(prefix)}menu ${esc(group.id)}</span></div>`;
  }

  return `<div class="mc-grp" style="border-left-color:${group.color}">
    <div class="mc-grp-hd">
      <div class="mc-grp-label">${esc(group.label)}</div>
      ${descHtml}
    </div>
    <div class="mc-grid">${itemsHtml}</div>
    ${moreHtml}
  </div>`;
}

function buildMainMenuHtml(
  prefix: string,
  resolvedGroups: ResolvedGroup[],
): string {
  let groupsHtml = "";
  for (const group of resolvedGroups) {
    const collapsed = group.commands.length > COLLAPSE_THRESHOLD;
    groupsHtml += buildGroupSectionHtml(prefix, group, collapsed);
  }

  const totalCount = resolvedGroups.reduce((sum, g) => sum + g.commands.length, 0);

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Menu</title><style>${MENU_CSS}</style></head>
<body>
<div class="mc">
<div class="mc-hd"><span class="mc-t">可用命令菜单</span></div>
${groupsHtml}
<div class="mc-ft">共 ${totalCount} 个命令 | 输入 ${esc(prefix)}help &lt;命令名&gt; 查看完整说明 | ${esc(prefix)}menu &lt;分组名&gt; 查看分组详情</div>
</div>
</body></html>`;
}

function buildSubPageHtml(
  prefix: string,
  group: ResolvedGroup,
): string {
  const itemsHtml = buildCommandItemsHtml(prefix, group.commands);
  const descHtml = group.description ? `<div class="mc-grp-desc">${esc(group.description)}</div>` : "";

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Menu</title><style>${MENU_CSS}</style></head>
<body>
<div class="mc">
<div class="mc-hd" style="border-bottom-color:${group.color}"><span class="mc-t">${esc(group.label)}</span></div>
<div class="mc-grp" style="border-left-color:${group.color}">
  <div class="mc-grp-hd">
    <div class="mc-grp-label">${esc(group.label)} (${group.commands.length})</div>
    ${descHtml}
  </div>
  <div class="mc-grid">${itemsHtml}</div>
</div>
<div class="mc-back">← 返回主菜单：<span class="mc-back-cmd">${esc(prefix)}menu</span></div>
</div>
</body></html>`;
}

/* ── Plugin ── */

export function createMenuPlugin(cmdPlugin: CoreCommandPlugin): MenuPlugin {
  const commands: MenuCommandEntry[] = [];
  const commandGroups = new Map<string, MenuCommandGroup>();
  const groupAssignments = new Map<string, string>();

  return {
    name: "menu",
    description: "命令菜单，按插件分组显示所有可用命令",

    registerCommand(
      name: string,
      description: string,
      handler: CoreCommandHandler,
      options: MenuCommandOptions = {}
    ) {
      const normalizedName = name.toLowerCase();
      cmdPlugin.register(normalizedName, handler, { adminOnly: options.adminOnly });

      if (options.hidden) return;

      const short = extractShortDescription(description);

      const existing = commands.find((command) => command.name === normalizedName);
      if (existing) {
        existing.description = description;
        existing.shortDescription = short;
        existing.adminOnly = options.adminOnly === true;
      } else {
        commands.push({
          name: normalizedName,
          description,
          shortDescription: short,
          adminOnly: options.adminOnly === true,
        });
      }

      if (options.group) {
        groupAssignments.set(normalizedName, options.group);
      }

      // Register aliases
      if (options.aliases) {
        const p = cmdPlugin.getPrefix();
        for (const alias of options.aliases) {
          const normalizedAlias = alias.toLowerCase();
          cmdPlugin.register(normalizedAlias, handler, { adminOnly: options.adminOnly });
          commands.push({
            name: normalizedAlias,
            description: `别名：${p}${normalizedName}`,
            shortDescription: short,
            adminOnly: options.adminOnly === true,
          });
          if (options.group) {
            groupAssignments.set(normalizedAlias, options.group);
          }
        }
      }
    },

    registerCommandGroup(id: string, label: string, description?: string) {
      commandGroups.set(id.toLowerCase(), { id: id.toLowerCase(), label, description });
    },

    getCommands() {
      return [...commands];
    },

    getGroups() {
      return [...commandGroups.values()];
    },

    getMenuText(): string {
      const prefix = cmdPlugin.getPrefix();
      const resolved = resolveGroups(commands, commandGroups, groupAssignments);
      const lines: string[] = ["可用命令："];
      for (const group of resolved) {
        lines.push(`\n[${group.label}]`);
        for (const cmd of group.commands) {
          const adminTag = cmd.adminOnly ? " [管理员]" : "";
          const desc = cmd.shortDescription || cmd.description;
          lines.push(`  ${prefix}${cmd.name} - ${desc}${adminTag}`);
        }
      }
      return lines.join("\n");
    },

    getPrefix() {
      return cmdPlugin.getPrefix();
    },

    async onLoad(ctx: PluginContext) {
      const prefix = cmdPlugin.getPrefix();

      this.registerCommand("menu", "显示命令菜单（支持 $menu <分组名> 查看子页面）", async (message: BotMessage, args: string[]) => {
        const resolved = resolveGroups(commands, commandGroups, groupAssignments);

        // Sub-page: $menu <groupId>
        if (args[0]) {
          const target = args[0].toLowerCase();
          const group = resolved.find(g => g.id === target);
          if (group) {
            const html = buildSubPageHtml(prefix, group);
            const tmpDir = path.resolve("data/menu-images");
            fs.mkdirSync(tmpDir, { recursive: true });
            const imagePath = path.join(tmpDir, `menu-${group.id}-${Date.now()}.webp`);
            await screenshotHtml(html, imagePath, { format: "webp", quality: 85 });
            const sendTarget = message.type === "group"
              ? { type: "group" as const, id: message.groupId! }
              : { type: "private" as const, id: message.userId! };
            await ctx.sendImage(sendTarget, imagePath);
            fs.unlink(imagePath, () => {});
            return;
          }
          await ctx.replyText(message, `未找到分组 "${args[0]}"。使用 ${prefix}menu 查看所有分组。`);
          return;
        }

        // Main page
        const html = buildMainMenuHtml(prefix, resolved);
        const tmpDir = path.resolve("data/menu-images");
        fs.mkdirSync(tmpDir, { recursive: true });
        const imagePath = path.join(tmpDir, `menu-${Date.now()}.webp`);
        await screenshotHtml(html, imagePath, { format: "webp", quality: 85 });
        const sendTarget = message.type === "group"
          ? { type: "group" as const, id: message.groupId! }
          : { type: "private" as const, id: message.userId! };
        await ctx.sendImage(sendTarget, imagePath);
        fs.unlink(imagePath, () => {});
      });

      this.registerCommand("help", `查看命令或分组说明：${prefix}help <命令名|分组名>`, async (message: BotMessage, args: string[]) => {
        if (!args[0]) {
          await ctx.replyText(message, `用法：${prefix}help <命令名>\n例如：${prefix}help affinity\n也可查看分组：${prefix}help mmo`);
          return;
        }
        const key = args[0].toLowerCase();

        // Check if it's a group
        const resolved = resolveGroups(commands, commandGroups, groupAssignments);
        const group = resolved.find(g => g.id === key);
        if (group) {
          const descLine = group.description ? `\n说明：${group.description}` : "";
          await ctx.replyText(message, [
            `📂 分组：${group.label} (${group.commands.length} 个命令)${descLine}`,
            `使用 ${prefix}menu ${group.id} 查看该分组全部命令。`,
          ].join("\n"));
          return;
        }

        // Check if it's a command
        const cmd = commands.find(c => c.name === key);
        if (!cmd) {
          await ctx.replyText(message, `未找到命令或分组 "${args[0]}"。使用 ${prefix}menu 查看所有。`);
          return;
        }

        // Find which group this command belongs to
        const cmdGroup = resolved.find(g => g.commands.some(c => c.name === cmd.name));
        const groupLabel = cmdGroup ? cmdGroup.label : "未分组";

        await ctx.replyText(message, [
          `📖 命令详情：${prefix}${cmd.name}` + (cmd.adminOnly ? " [管理员]" : ""),
          `分组：${groupLabel}`,
          `说明：${cmd.description}`,
        ].join("\n"));
      });
    },
  };
}
