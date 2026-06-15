import type { MenuPlugin, Plugin, PluginContext, PromptBuildInput } from "../../types.js";
import type { OneBotClient } from "../../onebot.js";

type CachedValue<T> = {
  expiresAt: number;
  value: T;
};

type RuntimeIdentity = {
  bot: {
    userId: string;
    nickname?: string;
  };
  group?: {
    groupId: string;
    groupName?: string;
  };
  admins: Array<{
    userId: string;
    nickname?: string;
    groupCard?: string;
  }>;
};

const CACHE_TTL_MS = 5 * 60 * 1000;

export function createIdentityPlugin(
  onebot: OneBotClient,
  menuPlugin: MenuPlugin,
  adminUserIds: string[]
): Plugin {
  let loginCache: CachedValue<{ userId: string; nickname?: string }> | null = null;
  const groupCache = new Map<string, CachedValue<{ groupId: string; groupName?: string }>>();
  const strangerCache = new Map<string, CachedValue<{ userId: string; nickname?: string }>>();
  const memberCache = new Map<string, CachedValue<{ userId: string; nickname?: string; card?: string; role?: string }>>();

  return {
    name: "identity",
    description: "获取 Bot 自身、当前群与管理员身份信息",
    systemPromptAppend:
      "系统会提供你的登录 QQ 号、当前群信息以及管理员身份信息。涉及身份或群名时请优先使用系统提供的准确信息。",

    async onBuildSystemPrompt(input: PromptBuildInput) {
      const message = input.mode === "single"
        ? input.message
        : input.messages[input.messages.length - 1];

      const identity = await getRuntimeIdentity(onebot, message.groupId, adminUserIds, {
        loginCacheRef: () => loginCache,
        setLoginCache: (value) => { loginCache = value; },
        groupCache,
        strangerCache,
        memberCache,
      });

      const lines = [
        `你的登录身份：${formatIdentityLabel(identity.bot.userId, identity.bot.nickname)}。`,
      ];

      if (identity.group) {
        lines.push(`当前群：${identity.group.groupId}${identity.group.groupName ? `（群名称：${identity.group.groupName}）` : ""}。`);
      }

      if (identity.admins.length > 0) {
        const adminsText = identity.admins
          .map((admin) => formatIdentityLabel(admin.userId, admin.groupCard))
          .join("；");
        lines.push(`管理员信息：${adminsText}。`);
      }

      return lines.join("\n");
    },

    onLoad(ctx: PluginContext) {
      menuPlugin.registerCommand("identity", "查看 Bot、当前群与管理员身份信息", async (message) => {
        const identity = await getRuntimeIdentity(onebot, message.groupId, adminUserIds, {
          loginCacheRef: () => loginCache,
          setLoginCache: (value) => { loginCache = value; },
          groupCache,
          strangerCache,
          memberCache,
        });

        const lines = [
          "身份信息：",
          `- Bot：${formatIdentityLabel(identity.bot.userId, identity.bot.nickname)}`,
        ];

        if (identity.group) {
          lines.push(`- 当前群：${identity.group.groupId}${identity.group.groupName ? `（${identity.group.groupName}）` : ""}`);
        }

        if (identity.admins.length > 0) {
          lines.push(
            `- 管理员：${identity.admins
              .map((admin) => formatIdentityLabel(admin.userId, admin.groupCard))
              .join("；")}`
          );
        } else {
          lines.push("- 管理员：未配置");
        }

        await ctx.replyText(message, lines.join("\n"));
      });
    },
  };
}

async function getRuntimeIdentity(
  onebot: OneBotClient,
  groupId: string | undefined,
  adminUserIds: string[],
  cache: {
    loginCacheRef: () => CachedValue<{ userId: string; nickname?: string }> | null;
    setLoginCache: (value: CachedValue<{ userId: string; nickname?: string }>) => void;
    groupCache: Map<string, CachedValue<{ groupId: string; groupName?: string }>>;
    strangerCache: Map<string, CachedValue<{ userId: string; nickname?: string }>>;
    memberCache: Map<string, CachedValue<{ userId: string; nickname?: string; card?: string; role?: string }>>;
  }
): Promise<RuntimeIdentity> {
  const bot = await getCached(cache.loginCacheRef(), async () => onebot.getLoginInfo(), cache.setLoginCache);

  const group = groupId
    ? await getCachedMap(cache.groupCache, groupId, async () => onebot.getGroupInfo(groupId)).catch(() => undefined)
    : undefined;

  const uniqueAdminUserIds = [...new Set(adminUserIds.filter(Boolean))];
  const admins = await Promise.all(uniqueAdminUserIds.map(async (adminUserId) => {
    const stranger = await getCachedMap(
      cache.strangerCache,
      adminUserId,
      async () => onebot.getStrangerInfo(adminUserId)
    ).catch(() => ({
      userId: adminUserId,
      nickname: undefined,
    }));

    const member = groupId
      ? await getCachedMap(
        cache.memberCache,
        `${groupId}:${adminUserId}`,
        async () => onebot.getGroupMemberInfo(groupId, adminUserId)
      ).catch(() => undefined)
      : undefined;

    return {
      userId: adminUserId,
      nickname: member?.nickname || stranger.nickname,
      groupCard: member?.card?.trim() ? member.card : undefined,
    };
  }));

  return { bot, group, admins };
}

async function getCached<T>(
  current: CachedValue<T> | null,
  loader: () => Promise<T>,
  save: (value: CachedValue<T>) => void
): Promise<T> {
  if (current && current.expiresAt > Date.now()) {
    return current.value;
  }

  const value = await loader();
  save({
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return value;
}

async function getCachedMap<T>(
  cache: Map<string, CachedValue<T>>,
  key: string,
  loader: () => Promise<T>
): Promise<T> {
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) {
    return current.value;
  }

  const value = await loader();
  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return value;
}

function formatIdentityLabel(userId: string, displayName?: string): string {
  const normalized = displayName?.trim();
  return normalized ? `${normalized}(${userId})` : `@${userId}`;
}
