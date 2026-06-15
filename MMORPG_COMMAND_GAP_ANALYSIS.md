## MMORPG 命令接入缺口分析

本报告交叉比对了 schema 定义的全部数据实体、state-store 的状态字段、data/ 下的内容注册表，与 framework-plugin.ts 中已注册的 35 个 `$mmo-*` 命令，列出所有缺少命令接入的交互点。

### 已有命令一览（35 个）

角色：mmo-create, mmo-profile, mmo-create-options, mmo-change-class, mmo-change-race, mmo-change-gender, mmo-change-appearance, mmo-declaration, mmo-coins, mmo-grant-coins

世界：mmo-location, mmo-where, mmo-map, mmo-move

战斗与采集：mmo-hunt, mmo-gather, mmo-fish, mmo-fish-basket, mmo-fish-sell

任务：mmo-quests, mmo-accept-quest, mmo-turn-in

社交：mmo-npc, mmo-talk, mmo-marriage, mmo-propose, mmo-accept-proposal, mmo-party, mmo-party-create, mmo-party-join, mmo-party-leave

背包：mmo-bag

管理：mmo-framework, mmo-validate

---

### 一、完全缺失的大型系统（高优先级）

#### 1. 装备系统
- **现状**：39 件装备（weapon/offhand/head/body/legs/accessory 六个槽位），PlayerState.equipment 字段存在，但无任何命令可装备或卸下物品。
- **缺失命令**：
  - `mmo-equip <itemId>` — 装备背包中指定物品到对应槽位
  - `mmo-unequip <slot>` — 卸下指定槽位装备放回背包
  - `mmo-gear` — 查看当前装备栏
- **影响**：战斗只计算裸属性，装备无实际效果。

#### 2. NPC 商店购买
- **现状**：8+ 个 NPC 拥有 shopItemIds（旅店老板、军需官、港主刘、铁匠希尔达等），但玩家无法购买。
- **缺失命令**：
  - `mmo-buy <npcId> <itemId> [quantity]` — 从 NPC 商店购买物品
  - `mmo-shop [npcId]` — 查看 NPC 可售物品与价格
- **影响**：82 件物品中大量只能通过怪物掉落获取，NPC 商店形同虚设。

#### 3. 副本系统
- **现状**：10 个副本（Lv 8 ~ Lv 1400），schema 中 DungeonDef 完整定义了 areaId、bossMonsterIds、requiredLevel、rewardItemIds、partySize，但无任何命令可进入或完成。
- **缺失命令**：
  - `mmo-dungeon-list [areaId]` — 查看可用副本
  - `mmo-dungeon-enter <dungeonId>` — 进入副本（需组队且满足 partySize）
  - `mmo-dungeon-challenge` — 发起副本战斗
- **影响**：MMORPG 中最核心的组队 PVE 玩法完全不可触达。

#### 4. 公会系统
- **现状**：GuildState 完整定义（leaderUserId, memberUserIds, treasury），state-store 中 guilds 字段存在，rulebook 定义了 maxGuildMembers=50，但零命令接入。
- **缺失命令**：
  - `mmo-guild-create <name>` — 创建公会
  - `mmo-guild-join <guildId>` — 申请加入公会
  - `mmo-guild-leave` — 退出公会
  - `mmo-guild` — 查看公会详情
  - `mmo-guild-donate <currencyId> <amount>` — 公会捐献
  - `mmo-guild-kick <userId>` — 踢人（仅会长）
- **影响**：公会相关阵营代币（guild_token）无获取和使用途径。

#### 5. 消耗品使用
- **现状**：13 种消耗品（绷带、药水、口粮、解毒剂等），但无命令可使用。
- **缺失命令**：
  - `mmo-use <itemId> [quantity]` — 使用消耗品（恢复 HP/专注/耐力等）
- **影响**：resources (hp/focus/stamina) 在战斗中消耗后无法补充。

#### 6. 物品出售
- **现状**：mmo-bag 可查看背包，mmo-fish-sell 可卖鱼，但普通物品（材料、多余装备）无法出售换取金币。
- **缺失命令**：
  - `mmo-sell <itemId> [quantity]` — 以 sellPrice 出售背包物品
- **影响**：玩家经济循环缺少回收通路。

---

### 二、完全缺失的中型系统（中优先级）

#### 7. 成就系统
- **现状**：24 个成就（奖励 10~3000 金币），AchievementDef 有 rewardCoins，但无解锁追踪、无查看命令、无领取奖励逻辑。
- **缺失命令**：
  - `mmo-achievements` — 查看成就列表与完成状态
  - `mmo-achievement-claim <achievementId>` — 领取成就奖励
- **需要在 PlayerState 中新增**：`unlockedAchievementIds: string[]`

#### 8. 技能系统
- **现状**：40 个技能（active/passive/utility），PlayerState.unlockedSkillIds 存在，但玩家无法查看已学技能或技能详情。
- **缺失命令**：
  - `mmo-skills` — 查看已解锁技能列表
  - `mmo-skills [skillId]` — 查看技能详情（描述、消耗、缩放属性）

#### 9. 阵营声望查看
- **现状**：4 个阵营（dawn_alliance/iron_oath/silver_covenant/ash_covenant），PlayerState.factionReputation 通过任务奖励累加，但无查看途径。
- **缺失命令**：
  - `mmo-faction [factionId]` — 查看阵营详情与当前声望等级
  - `mmo-factions` — 查看所有阵营声望一览

#### 10. 邮件系统
- **现状**：MailState 完整定义（fromUserId, toUserId, title, body, attachments），state-store 中 mails 字段存在，rulebook 有 mailRetentionDays=30，但零命令接入。
- **缺失命令**：
  - `mmo-mail` — 查看收件箱
  - `mmo-mail-send <userId> <title> [body]` — 发送邮件
  - `mmo-mail-claim <mailId>` — 领取邮件附件

#### 11. 拍卖行/市场
- **现状**：MarketListing 完整定义（sellerUserId, itemId, quantity, pricePerUnit），state-store 中 marketListings 存在，rulebook 有 marketFeeRate=0.05，但零命令接入。
- **缺失命令**：
  - `mmo-market` — 浏览当前挂单
  - `mmo-market-list <itemId> <quantity> <pricePerUnit>` — 挂售物品
  - `mmo-market-buy <listingId>` — 购买挂单物品
  - `mmo-market-cancel <listingId>` — 取消挂单

#### 12. 特殊货币
- **现状**：5 种货币（gold, honor, guild_token, arena_token, abyss_crystal），但只有 gold 可查看（通过 mmo-coins），其余货币既不可查看也不可消费。
- **缺失命令**：
  - `mmo-currencies` — 查看所有货币余额
  - 各货币对应的消费通路（荣誉商店、公会商店、竞技场商店、深渊兑换）

---

### 三、辅助功能缺失（低优先级）

#### 13. 副职业查看
- **现状**：6 个副职业（mining, herbalism, blacksmithing, alchemy, cooking, fishing），professionLevels 在 mmo-gather/mmo-fish 时内部累加，但无法查看。
- **缺失命令**：
  - `mmo-professions` — 查看各副职业等级

#### 14. 队伍管理增强
- **现状**：mmo-party 仅查看，缺少管理操作。
- **缺失命令**：
  - `mmo-party-kick <userId>` — 踢出队员
  - `mmo-party-promote <userId>` — 转让队长
  - `mmo-party-formation <formation>` — 变更阵型
  - `mmo-party-recruit [on|off]` — 切换招募状态

#### 15. 世界事件与日常 Boss
- **现状**：WorldState 有 dailyBossDefeatedIds 和 eventFlags，但零交互。
- **缺失命令**：
  - `mmo-world` — 查看当前世界事件/日常 Boss 状态
  - `mmo-daily-boss` — 挑战日常 Boss

#### 16. 物品详情查看
- **现状**：mmo-bag 列出物品名称和数量，但无法查看单件物品详细描述。
- **缺失命令**：
  - `mmo-item <itemId>` — 查看物品详情（描述、类别、装备槽、售价）

---

### 四、总结

| 优先级 | 缺失系统 | 影响范围 |
|--------|----------|----------|
| **高** | 装备系统 | 39 件装备无实际效果 |
| **高** | NPC 商店购买 | 8+ NPC 商店不可用 |
| **高** | 副本系统 | 10 个副本不可玩 |
| **高** | 公会系统 | GuildState 完全空置 |
| **高** | 消耗品使用 | 13 种消耗品不可用 |
| **高** | 物品出售 | 经济循环断裂 |
| **中** | 成就系统 | 24 个成就无追踪 |
| **中** | 技能查看 | 40 个技能不可见 |
| **中** | 阵营声望查看 | 4 个阵营声望不可见 |
| **中** | 邮件系统 | MailState 完全空置 |
| **中** | 拍卖行 | MarketListing 完全空置 |
| **中** | 特殊货币 | 4 种货币不可见/不可用 |
| **低** | 副职业查看 | 6 个副职业等级不可见 |
| **低** | 队伍管理 | 缺少踢人/转让/阵型操作 |
| **低** | 世界事件 | WorldState 完全空置 |
| **低** | 物品详情 | 82 件物品描述不可查 |
