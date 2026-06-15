import fs from "node:fs";
import path from "node:path";
import type {
  PluginContext,
  BotMessage,
  MenuPlugin,
  CoreCommandPlugin,
  CoreCommandHandler,
  MenuCommandEntry,
  MenuCommandOptions,
} from "../../types.js";
import { screenshotHtml } from "../mmorpg/screenshot.js";

/* ── Menu card HTML template ── */

const MENU_CARD_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0f1117; font-family: "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif; }
.mc { background: #0f1117; color: #c9d1d9; padding: 12px 14px; width: fit-content; }
.mc-hd { display: flex; align-items: center; gap: 8px; padding-bottom: 6px; border-bottom: 2px solid #e3b341; margin-bottom: 12px; }
.mc-hd-icon { display: block; flex-shrink: 0; }
.mc-t { font-size: 15px; font-weight: 700; color: #e3b341; }
.mc-cat { margin-bottom: 10px; }
.mc-cat-hd { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px solid #22272e; margin-bottom: 6px; }
.mc-cat-icon { display: block; flex-shrink: 0; }
.mc-cat-t { font-size: 11.5px; font-weight: 700; color: #8b949e; }
.mc-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; row-gap: 6px; }
.mc-item { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; padding: 3px 0; border-bottom: 1px dashed rgba(255,255,255,0.02); }
.mc-cmd { color: #58a6ff; font-weight: 700; font-family: Consolas, monospace; font-size: 11.5px; white-space: nowrap; }
.mc-desc { color: #c9d1d9; font-size: 10.5px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-tag { font-size: 9px; color: #f0883e; border: 1px solid #f0883e; border-radius: 2px; padding: 0 2px; margin-left: 4px; flex-shrink: 0; scale: 0.9; }
.mc-ft { margin-top: 10px; padding-top: 6px; border-top: 1px solid #22272e; font-size: 10px; color: #484f58; text-align: center; }
`;

function esc(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const CAT_INFO: Record<string, { color: string; icon: string }> = {
  "角色与成长": {
    color: "#bc8cff",
    icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#bc8cff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mc-cat-icon"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`
  },
  "探索与战斗": {
    color: "#f85149",
    icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#f85149" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mc-cat-icon"><path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2"/></svg>`
  },
  "背包与交易": {
    color: "#e3b341",
    icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#e3b341" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mc-cat-icon"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>`
  },
  "组队与社交": {
    color: "#3fb950",
    icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#3fb950" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mc-cat-icon"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`
  },
  "系统与工具": {
    color: "#58a6ff",
    icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#58a6ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mc-cat-icon"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`
  },
};

const MENU_TITLE_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#e3b341" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mc-hd-icon"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>`;

function getCommandCategory(name: string): string {
  const n = name.toLowerCase();
  if (["menu", "identity", "clear", "plugins", "files", "download", "view_file", "send_file"].includes(n) || n.startsWith("todo-")) {
    return "系统与工具";
  }
  if (["mmo-framework", "mmo-validate", "mmo-grant-coins", "mmo-pick", "daily-report"].includes(n)) {
    return "系统与工具";
  }
  if (["mmo-location", "mmo-map", "mmo-back", "mmo-hunt", "mmo-gather", "mmo-fish", "mmo-fish-basket", "mmo-quests", "mmo-battle-log", "mmo-recover"].includes(n)) {
    return "探索与战斗";
  }
  if (["mmo-create-options", "mmo-create", "mmo-create-character", "mmo-profile", "mmo-skills", "mmo-achievements", "mmo-portrait", "mmo-rebirth", "mmo-change-class", "mmo-change-race", "mmo-change-gender", "mmo-change-appearance", "mmo-declaration"].includes(n)) {
    return "角色与成长";
  }
  if (["mmo-bag", "mmo-equip", "mmo-shop", "mmo-mall", "mmo-fish-sell", "mmo-coins"].includes(n)) {
    return "背包与交易";
  }
  if (["mmo-party-create", "mmo-party-join", "mmo-party-leave", "mmo-party", "mmo-marriage", "mmo-propose", "mmo-accept-proposal", "mmo-guild", "mmo-factions"].includes(n)) {
    return "组队与社交";
  }
  return "系统与工具";
}

function buildMenuImageHtml(prefix: string, commands: MenuCommandEntry[]): string {
  const categories: Record<string, MenuCommandEntry[]> = {
    "角色与成长": [],
    "探索与战斗": [],
    "背包与交易": [],
    "组队与社交": [],
    "系统与工具": [],
  };

  for (const cmd of commands) {
    const cat = getCommandCategory(cmd.name);
    categories[cat].push(cmd);
  }

  let categoriesHtml = "";
  for (const [catName, cmdList] of Object.entries(categories)) {
    if (cmdList.length === 0) continue;
    
    cmdList.sort((a, b) => a.name.localeCompare(b.name));
    
    const info = CAT_INFO[catName];
    const headerHtml = `<div class="mc-cat-hd">
      ${info.icon}
      <span class="mc-cat-t">${esc(catName)}</span>
    </div>`;

    const itemsHtml = cmdList.map(cmd => {
      const adminTag = cmd.adminOnly ? '<span class="mc-tag">管理</span>' : "";
      return `<div class="mc-item">
        <span class="mc-cmd">${esc(prefix + cmd.name)}</span>
        <span class="mc-desc">${esc(cmd.description)}${adminTag}</span>
      </div>`;
    }).join("\n");

    categoriesHtml += `<div class="mc-cat">
      ${headerHtml}
      <div class="mc-grid">
        ${itemsHtml}
      </div>
    </div>`;
  }

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Menu</title><style>${MENU_CARD_CSS}</style></head>
<body>
<div class="mc">
<div class="mc-hd">${MENU_TITLE_ICON}<span class="mc-t">可用命令菜单</span></div>
${categoriesHtml}
<div class="mc-ft">输入前缀 ${esc(prefix)} 加上命令名即可使用</div>
</div>
</body></html>`;
}

export function createMenuPlugin(cmdPlugin: CoreCommandPlugin): MenuPlugin {
  const commands: MenuCommandEntry[] = [];

  return {
    name: "menu",
    description: "命令菜单，列出所有可用命令",

    registerCommand(
      name: string,
      description: string,
      handler: CoreCommandHandler,
      options: MenuCommandOptions = {}
    ) {
      const normalizedName = name.toLowerCase();
      cmdPlugin.register(normalizedName, handler, { adminOnly: options.adminOnly });

      if (options.hidden) {
        return;
      }

      const existing = commands.find((command) => command.name === normalizedName);
      if (existing) {
        existing.description = description;
        existing.adminOnly = options.adminOnly === true;
        return;
      }

      commands.push({
        name: normalizedName,
        description,
        adminOnly: options.adminOnly === true,
      });
    },

    getCommands() {
      return [...commands];
    },

    getMenuText(): string {
      const prefix = cmdPlugin.getPrefix();
      const lines = commands.map((command) => {
        const adminTag = command.adminOnly ? " [管理员]" : "";
        return `${prefix}${command.name} - ${command.description}${adminTag}`;
      });
      return "📋 可用命令：\n" + lines.join("\n");
    },

    getPrefix() {
      return cmdPlugin.getPrefix();
    },

    async onLoad(ctx: PluginContext) {
      this.registerCommand("menu", "显示命令菜单", async (message: BotMessage) => {
        const prefix = cmdPlugin.getPrefix();
        const html = buildMenuImageHtml(prefix, commands);

        const tmpDir = path.resolve("data/menu-images");
        fs.mkdirSync(tmpDir, { recursive: true });
        const imagePath = path.join(tmpDir, `menu-${Date.now()}.webp`);

        await screenshotHtml(html, imagePath, { format: "webp", quality: 85 });

        const target = message.type === "group"
          ? { type: "group" as const, id: message.groupId! }
          : { type: "private" as const, id: message.userId! };
        await ctx.sendImage(target, imagePath);

        // 清理临时文件
        fs.unlink(imagePath, () => {});
      });
    },
  };
}
