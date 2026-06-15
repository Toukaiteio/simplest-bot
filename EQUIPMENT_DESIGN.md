# 职业基础装备系列设计文档

## 1. 等级段与属性公式

### 等级段划分

| 段位 | 等级范围 | sellPrice 区间 | baseValue (sellPrice/4) | 主题 |
|------|---------|---------------|------------------------|------|
| T1 | 1-50 | 20-30 | 5-7 | 新手装备 |
| T2 | 50-100 | 35-50 | 8-12 | 王国制式 |
| T3 | 100-150 | 60-75 | 15-18 | 符文/秘法 |
| T4 | 150-300 | 95-130 | 23-32 | 精英装备 |
| T5 | 300-500 | 160-220 | 40-55 | 深渊装备 |
| T6 | 500-800 | 300-400 | 75-100 | 传说装备 |

### 属性公式（`getItemBaseStats`）

| 装备槽位 | 属性分配 |
|---------|---------|
| weapon（物理） | 力量 = baseValue × 0.6，敏捷 = baseValue × 0.4 |
| weapon（魔法） | 口才 = baseValue × 0.6，魅力 = baseValue × 0.4 |
| offhand | 防御 = baseValue × 0.6，耐力 = baseValue × 0.4 |
| head / body / legs | 防御 = baseValue × 0.5，耐力 = baseValue × 0.3，生命 = baseValue × 0.2 |
| accessory | 魅力 = baseValue × 0.5，口才 = baseValue × 0.5 |

**魔法武器判定**：物品 id 包含 staff/rod/wand/focus/robe/crown/pendant/amulet/ring

### 强化倍率（可选扩展）

| 品质 | 倍率 |
|------|------|
| 普通 (common) | ×1.0 |
| 优秀 (uncommon) | ×1.1 |
| 精良 (rare) | ×1.25 |
| 史诗 (epic) | ×1.45 |
| 传说 (legendary) | ×1.7 |

---

## 2. 职业分组

### 职业 archetypes

| 分组 | 职业 | 主属性 | 武器类型 | 防具类型 |
|------|------|--------|---------|---------|
| **物理近战** | 战士、潜行者、武神、龙骑士 | 力量、防御 | 物理武器（剑/斧/匕首/拳套/枪） | 重甲/中甲 |
| **魔法远程** | 法师、术士、圣灵法师 | 口才、魅力 | 魔法武器（法杖/书典/圣印） | 轻甲/法袍 |
| **物理远程** | 游侠 | 敏捷 | 物理远程（弓） | 中甲/皮甲 |
| **魔法辅助** | 牧师 | 魅力、口才 | 魔法武器（圣印/权杖） | 中甲 |
| **坦克** | 圣骑士 | 防御、力量 | 物理武器 + 盾牌 | 重甲 |
| **混合** | 德鲁伊、魔剑士 | 混合 | 混合武器（法杖/剑） | 中甲 |

### 允许职业列表

| 武器类型 | allowedClasses |
|---------|---------------|
| 物理近战武器（剑/斧） | warrior, rogue, dragon_knight, martial_god |
| 物理远程武器（弓） | ranger, rogue |
| 魔法武器（法杖/书典） | mage, warlock, holy_spirit_mage |
| 魔法辅助武器（圣印/权杖） | cleric, paladin, holy_spirit_mage |
| 坦克武器（剑+盾） | warrior, paladin, dragon_knight |
| 混合武器（法杖） | druid, holy_spirit_mage |
| 混合武器（剑） | magic_swordsman, warrior, dragon_knight |
| 通用防具 | （无限制） |

---

## 3. 装备系列设计

### T1 — 新手装备（Lv 1-50, sellPrice 20-30）

#### 武器

| id | 名称 | 槽位 | sellPrice | allowedClasses | 属性 | 描述 |
|----|------|------|-----------|---------------|------|------|
| iron_longsword | 铁制长剑 | weapon | 24 | warrior, dragon_knight, martial_god | 力量+3, 敏捷+2 | 制式铁剑，坚固耐用。 |
| iron_dagger_t1 | 铁刺匕首 | weapon | 22 | rogue | 力量+3, 敏捷+2 | 轻巧的短刃，适合偷袭。 |
| hunting_spear | 狩猎长枪 | weapon | 26 | warrior, dragon_knight | 力量+4, 敏捷+2 | 游骑兵标配的突刺武器。 |
| apprentice_staff | 学徒法杖 | weapon | 24 | mage, warlock, holy_spirit_mage | 口才+3, 魅力+2 | 初学者的入门法杖。 |
| training_bow_t1 | 训练短弓 | weapon | 24 | ranger, rogue | 力量+3, 敏捷+2 | 适合新手练习的短弓。 |
| oak_focus_t1 | 橡木圣印 | weapon | 24 | cleric, paladin, holy_spirit_mage | 口才+3, 魅力+2 | 牧师基础法器。 |
| tower_shield_t1 | 塔盾 | offhand | 24 | warrior, paladin, dragon_knight | 防御+3, 耐力+2 | 沉重的全金属盾牌。 |
| druid_staff_t1 | 藤蔓法杖 | weapon | 24 | druid | 口才+3, 魅力+2 | 藤蔓与活木缠绕而成。 |
| magesword_t1 | 符文短剑 | weapon | 26 | magic_swordsman, warrior | 力量+3, 口才+2, 敏捷+2 | 铭刻符文的短剑，兼顾物理与魔力。 |

#### 防具

| id | 名称 | 槽位 | sellPrice | 属性 | 描述 |
|----|------|------|-----------|------|------|
| cloth_cap | 布帽 | head | 16 | 防御+2, 耐力+1, 生命+1 | 简单的布制帽子。 |
| leather_vest_t1 | 皮甲背心 | body | 22 | 防御+2, 耐力+1, 生命+1 | 轻便的中期护甲。 |
| cloth_pants | 布裤 | legs | 18 | 防御+2, 耐力+1 | 舒适的布制裤子。 |
| iron_ring_t1 | 铁戒 | accessory | 20 | 魅力+2, 口才+2 | 简单的铁制指环。 |

---

### T2 — 王国制式（Lv 50-100, sellPrice 35-50）

#### 武器

| id | 名称 | 槽位 | sellPrice | allowedClasses | 属性 | 描述 |
|----|------|------|-----------|---------------|------|------|
| kingdom_sword_t2 | 王国铁剑 | weapon | 40 | warrior, dragon_knight, martial_god | 力量+5, 敏捷+3 | 曙光同盟制式单手剑。 |
| swift_blade | 疾风短刀 | weapon | 38 | rogue | 力量+4, 敏捷+5 | 轻薄锋利的短刀。 |
| steel_lance_t2 | 精钢长枪 | weapon | 45 | warrior, dragon_knight | 力量+5, 敏捷+3 | 哨站骑兵制式长枪。 |
| crystal_rod | 水晶法杖 | weapon | 42 | mage, warlock, holy_spirit_mage | 口才+5, 魅力+3 | 镶嵌水晶的法杖。 |
| composite_bow | 复合弓 | weapon | 40 | ranger, rogue | 力量+4, 敏捷+5 | 高地游侠常用弓。 |
| silver_mace | 银锤 | weapon | 42 | cleric, paladin, holy_spirit_mage | 口才+5, 魅力+3 | 圣骑士标准武器。 |
| iron_buckler_t2 | 铁圆盾 | offhand | 35 | warrior, paladin, dragon_knight | 防御+4, 耐力+2 | 基础副手盾牌。 |
| yew_staff | 紫杉法杖 | weapon | 40 | druid | 口才+5, 魔力+3 | 紫杉木制成的自然法杖。 |
| runic_sword | 符文长剑 | weapon | 42 | magic_swordsman, warrior | 力量+4, 口才+3, 敏捷+3 | 铭刻攻击符文的长剑。 |

#### 防具

| id | 名称 | 槽位 | sellPrice | 属性 | 描述 |
|----|------|------|-----------|------|------|
| chain_coif | 锁甲头巾 | head | 35 | 防御+4, 耐力+2, 生命+2 | 王国步兵标配锁甲。 |
| chainmail_t2 | 锁甲衫 | body | 40 | 防御+5, 耐力+3, 生命+2 | 王国步兵标配链甲。 |
| garrison_boots_t2 | 驻军长靴 | legs | 28 | 防御+3, 耐力+2, 生命+1 | 铁誓制式军靴。 |
| silver_ring | 银戒 | accessory | 35 | 魅力+4, 口才+4 | 银制指环，附带微弱魔力。 |

---

### T3 — 符文/秘法（Lv 100-150, sellPrice 60-75）

#### 武器

| id | 名称 | 槽位 | sellPrice | allowedClasses | 属性 | 描述 |
|----|------|------|-----------|---------------|------|------|
| rune_blade | 符文阔剑 | weapon | 70 | warrior, dragon_knight, martial_god | 力量+8, 敏捷+5 | 铭刻古老符文的阔剑。 |
| shadow_dagger | 暗影匕首 | weapon | 65 | rogue | 力量+7, 敏捷+8 | 刀刃在暗处几乎隐形。 |
| dragonbone_spear_t3 | 龙骨长枪 | weapon | 72 | warrior, dragon_knight | 力量+9, 敏捷+6 | 以上古龙骨打造的长枪。 |
| arcane_staff | 秘法法杖 | weapon | 68 | mage, warlock, holy_spirit_mage | 口才+8, 魅力+5 | 银白盟约制式法杖。 |
| eagle_eye_bow | 鹰眼长弓 | weapon | 70 | ranger, rogue | 力量+7, 敏捷+8 | 精准度极高的长弓。 |
| holy_mace | 圣光锤 | weapon | 68 | cleric, paladin, holy_spirit_mage | 口才+8, 魅力+5 | 教会赐福的战锤。 |
| runic_shield | 符文盾 | offhand | 60 | warrior, paladin, dragon_knight | 防御+7, 耐力+4 | 刻有防护符文的盾牌。 |
| oakheart_staff | 橡心法杖 | weapon | 65 | druid | 口才+8, 魅力+5 | 以千年橡木心制成。 |
| twin_rune_blade | 双符文剑 | weapon | 70 | magic_swordsman, warrior | 力量+7, 口才+5, 敏捷+5 | 双刃均铭刻符文的双手剑。 |

#### 防具

| id | 名称 | 槽位 | sellPrice | 属性 | 描述 |
|----|------|------|-----------|------|------|
| rune_helm | 符文头盔 | head | 60 | 防御+7, 耐力+4, 生命+3 | 铭刻防护符文的头盔。 |
| flamekeeper_robe_t3 | 焰守长袍 | body | 65 | 防御+7, 耐力+4, 生命+3 | 火焰山守望者的隔热法袍。 |
| highland_treads_t3 | 高地踏步靴 | legs | 50 | 防御+5, 耐力+3, 生命+2 | 适应高原地形的加固长靴。 |
| arcane_amulet | 秘法护符 | accessory | 60 | 魅力+7, 口才+7 | 增强法术集中力的护符。 |

---

### T4 — 精英装备（Lv 150-300, sellPrice 95-130）

#### 武器

| id | 名称 | 槽位 | sellPrice | allowedClasses | 属性 | 描述 |
|----|------|------|-----------|---------------|------|------|
| abyss_cleaver | 深渊斩斧 | weapon | 120 | warrior, dragon_knight, martial_god | 力量+14, 敏捷+9 | 以深渊金属锻造的战斧。 |
| shadow_fang | 暗影之牙 | weapon | 110 | rogue | 力量+13, 敏捷+14 | 刺客组织配发的暗杀短刃。 |
| dragonbone_spear_t4 | 龙骨长枪 | weapon | 130 | warrior, dragon_knight | 力量+16, 敏捷+10 | 以巨龙骨骸打造的长枪。 |
| flame_staff | 焰灵法杖 | weapon | 120 | mage, warlock, holy_spirit_mage | 口才+14, 魅力+9 | 火焰山守望者的法杖。 |
| stormbow | 风暴弓 | weapon | 115 | ranger, rogue | 力量+13, 敏捷+14 | 附带风元素的长弓。 |
| judgement_mace | 审判之锤 | weapon | 120 | cleric, paladin, holy_spirit_mage | 口才+14, 魅力+9 | 教廷审判庭的制式战锤。 |
| ancient_guard_t4 | 古代守卫 | offhand | 110 | warrior, paladin, dragon_knight | 防御+13, 耐力+8 | 上古盾牌，依然散发微弱护盾。 |
| grove_staff | 林地法杖 | weapon | 115 | druid | 口才+14, 魅力+9 | 灵木森林守护者的法杖。 |
| void_edge | 虚空之锋 | weapon | 125 | magic_swordsman, warrior | 力量+13, 口才+9, 敏捷+9 | 刃缘附带虚空能量的长剑。 |

#### 防具

| id | 名称 | 槽位 | sellPrice | 属性 | 描述 |
|----|------|------|-----------|------|------|
| abyssal_helm | 深渊头盔 | head | 100 | 防御+12, 耐力+7, 生命+5 | 深渊金属锻造的重型头盔。 |
| abyss_walker_plate | 深渊行者重甲 | body | 120 | 防御+15, 耐力+9, 生命+6 | 能在深渊气息中保护穿戴者的重甲。 |
| shadow_step_boots | 暗影步靴 | legs | 95 | 防御+11, 耐力+7, 生命+4 | 附带轻微加速效果的轻靴。 |
| soul_ring_t4 | 灵魂之环 | accessory | 100 | 魅力+12, 口才+12 | 灵木森林中自然凝聚的灵魂指环。 |

---

### T5 — 深渊装备（Lv 300-500, sellPrice 160-220）

#### 武器

| id | 名称 | 槽位 | sellPrice | allowedClasses | 属性 | 描述 |
|----|------|------|-----------|---------------|------|------|
| rift_greatsword | 裂谷巨剑 | weapon | 200 | warrior, dragon_knight, martial_god | 力量+24, 敏捷+16 | 深渊裂谷中析出的异界金属锻造。 |
| void_reaver | 虚空收割者 | weapon | 190 | rogue | 力量+22, 敏捷+24 | 刀刃能切割维度的暗杀武器。 |
| abyssal_pike | 深渊长矛 | weapon | 210 | warrior, dragon_knight | 力量+25, 敏捷+17 | 以深渊核心淬火的长矛。 |
| void_staff | 虚空法杖 | weapon | 200 | mage, warlock, holy_spirit_mage | 口才+24, 魅力+16 | 封存虚空之力的法杖。 |
| abyss_bow | 深渊之弓 | weapon | 195 | ranger, rogue | 力量+22, 敏捷+24 | 弓身由虚空木材制成。 |
| judgement_staff | 审判法杖 | weapon | 200 | cleric, paladin, holy_spirit_mage | 口才+24, 魅力+16 | 教廷审判庭的至高法器。 |
| void_aegis | 虚空神盾 | offhand | 180 | warrior, paladin, dragon_knight | 防御+21, 耐力+14 | 附带虚空护盾的神盾。 |
| ancient_grove_staff | 远古林地法杖 | weapon | 190 | druid | 口才+24, 魅力+16 | 远古树人赐予的法杖。 |
| void_edge_t5 | 虚空裂隙剑 | weapon | 200 | magic_swordsman, warrior | 力量+22, 口才+16, 敏捷+16 | 刃缘处空间微微扭曲。 |

#### 防具

| id | 名称 | 槽位 | sellPrice | 属性 | 描述 |
|----|------|------|-----------|------|------|
| void_helm | 虚空头盔 | head | 170 | 防御+20, 耐力+12, 生命+8 | 虚空金属锻造的头盔。 |
| void_plate | 虚空重甲 | body | 200 | 防御+25, 耐力+15, 生命+10 | 虚空维度中锻造的终极重甲。 |
| void_treads | 虚空踏步 | legs | 160 | 防御+18, 耐力+11, 生命+7 | 能在虚空裂隙中行走的战靴。 |
| soul_pendant | 灵魂坠饰 | accessory | 180 | 魅力+22, 口才+22 | 封存灵魂能量的坠饰。 |

---

### T6 — 传说装备（Lv 500-800, sellPrice 300-400）

#### 武器

| id | 名称 | 槽位 | sellPrice | allowedClasses | 属性 | 描述 |
|----|------|------|-----------|---------------|------|------|
| void_blade_t6 | 虚空之刃 | weapon | 350 | warrior, dragon_knight, martial_god | 力量+42, 敏捷+28 | 撕裂维度锻造的终末武器。 |
| shadow_edge | 暗影之锋 | weapon | 330 | rogue | 力量+39, 敏捷+42 | 暗影刺客的终极短刃。 |
| dragonfang_spear | 龙牙长矛 | weapon | 380 | warrior, dragon_knight | 力量+46, 敏捷+30 | 以真龙獠牙打造的长矛。 |
| void_arcane_staff | 虚空奥术法杖 | weapon | 350 | mage, warlock, holy_spirit_mage | 口才+42, 魅力+28 | 虚空与奥术融合的终极法杖。 |
| void_bow | 虚空之弓 | weapon | 340 | ranger, rogue | 力量+39, 敏捷+42 | 弓弦由虚空丝线编织。 |
| divine_staff | 神圣法杖 | weapon | 350 | cleric, paladin, holy_spirit_mage | 口才+42, 魅力+28 | 教廷至圣法器。 |
| void_aegis_t6 | 虚空神盾 | offhand | 320 | warrior, paladin, dragon_knight | 防御+38, 耐力+25 | 虚空维度的终极盾牌。 |
| world_tree_staff | 世界树法杖 | weapon | 340 | druid | 口才+42, 魅力+28 | 世界树之心制成的法杖。 |
| void_edge_t6 | 虚空断罪剑 | weapon | 360 | magic_swordsman, warrior | 力量+39, 口才+28, 敏捷+28 | 能斩断因果的虚空之剑。 |

#### 防具

| id | 名称 | 槽位 | sellPrice | 属性 | 描述 |
|----|------|------|-----------|------|------|
| void_crown | 虚空王冠 | head | 310 | 防御+37, 耐力+22, 生命+15 | 虚空之王的王冠。 |
| void_emperor_scale | 虚空皇帝鳞甲 | body | 380 | 防御+47, 耐力+28, 生命+19 | 以虚空皇帝鳞片打造的终极铠甲。 |
| void_greaves | 虚空护腿 | legs | 300 | 防御+36, 耐力+21, 生命+14 | 虚空金属锻造的护腿。 |
| void_ring | 虚空之戒 | accessory | 340 | 魅力+42, 口才+42 | 封存虚空之力的指环。 |

---

## 4. 命名规范

### 武器命名

| 分组 | T1 | T2 | T3 | T4 | T5 | T6 |
|------|----|----|----|----|----|-----|
| 物理近战 | 铁制XX | 王国XX | 符文XX | 深渊XX | 裂谷XX | 虚空XX |
| 物理远程 | 训练XX | 复合XX | 鹰眼XX | 风暴XX | 深渊XX | 虚空XX |
| 魔法 | 学徒XX | 水晶XX | 秘法XX | 焰灵XX | 虚空XX | 虚空XX |
| 辅助 | 橡木XX | 银XX | 圣光XX | 审判XX | 审判XX | 神圣XX |
| 坦克盾 | 塔盾 | 铁圆盾 | 符文盾 | 古代守卫 | 虚空神盾 | 虚空神盾 |

### 防具命名

| 槽位 | T1 | T2 | T3 | T4 | T5 | T6 |
|------|----|----|----|----|----|-----|
| head | 布帽 | 锁甲头巾 | 符文头盔 | 深渊头盔 | 虚空头盔 | 虚空王冠 |
| body | 皮甲背心 | 锁甲衫 | 焰守长袍 | 深渊行者重甲 | 虚空重甲 | 虚空皇帝鳞甲 |
| legs | 布裤 | 驻军长靴 | 高地踏步靴 | 暗影步靴 | 虚空踏步 | 虚空护腿 |
| accessory | 铁戒 | 银戒 | 秘法护符 | 灵魂之环 | 灵魂坠饰 | 虚空之戒 |

---

## 5. 代码实现要点

### 数据文件结构

```typescript
// data/items.ts 中新增

const tier1_class_weapons: DataRegistry<ItemDef> = {
  iron_longsword: { id: "iron_longsword", name: "铁制长剑", description: "制式铁剑，坚固耐用。", category: "weapon", equipSlot: "weapon", sellPrice: 24, requiredLevel: 1, allowedClasses: ["warrior", "dragon_knight", "martial_god"] },
  // ...
};

const tier1_armor: DataRegistry<ItemDef> = {
  cloth_cap: { id: "cloth_cap", name: "布帽", description: "简单的布制帽子。", category: "armor", equipSlot: "head", sellPrice: 16, requiredLevel: 1 },
  // ...
};
```

### 物品导出

```typescript
export const items: DataRegistry<ItemDef> = {
  ...starter_weapons,
  ...consumables,
  ...materials,
  ...tier1_equipment,
  ...tier1_class_weapons,    // 新增
  ...tier1_armor,            // 新增
  // ... 其他 tier
};
```

### 注意事项

1. **魔法武器判定**：id 必须包含 staff/rod/wand/focus/robe/crown/pendant/amulet/ring 才会被识别为魔法武器
2. **allowedClasses**：只有武器需要设置，防具对所有职业开放
3. **requiredLevel**：设置为等级段的下限
4. **sellPrice**：决定基础属性值，需在对应等级段的区间内

---

## 6. 属性对照表

### T1 (sellPrice 24, baseValue 6)

| 装备类型 | 属性 |
|---------|------|
| 物理武器 | 力量+3, 敏捷+2 |
| 魔法武器 | 口才+3, 魅力+2 |
| 盾牌 | 防御+3, 耐力+2 |
| 头/身/腿 | 防御+2, 耐力+1, 生命+1 |
| 饰品 | 魅力+2, 口才+2 |

### T2 (sellPrice 40, baseValue 10)

| 装备类型 | 属性 |
|---------|------|
| 物理武器 | 力量+6, 敏捷+4 |
| 魔法武器 | 口才+6, 魅力+4 |
| 盾牌 | 防御+6, 耐力+4 |
| 头/身/腿 | 防御+5, 耐力+3, 生命+2 |
| 饰品 | 魅力+5, 口才+5 |

### T3 (sellPrice 68, baseValue 17)

| 装备类型 | 属性 |
|---------|------|
| 物理武器 | 力量+10, 敏捷+7 |
| 魔法武器 | 口才+10, 魅力+7 |
| 盾牌 | 防御+10, 耐力+7 |
| 头/身/腿 | 防御+8, 耐力+5, 生命+3 |
| 饰品 | 魅力+8, 口才+8 |

### T4 (sellPrice 120, baseValue 30)

| 装备类型 | 属性 |
|---------|------|
| 物理武器 | 力量+18, 敏捷+12 |
| 魔法武器 | 口才+18, 魅力+12 |
| 盾牌 | 防御+18, 耐力+12 |
| 头/身/腿 | 防御+15, 耐力+9, 生命+6 |
| 饰品 | 魅力+15, 口才+15 |

### T5 (sellPrice 200, baseValue 50)

| 装备类型 | 属性 |
|---------|------|
| 物理武器 | 力量+30, 敏捷+20 |
| 魔法武器 | 口才+30, 魅力+20 |
| 盾牌 | 防御+30, 耐力+20 |
| 头/身/腿 | 防御+25, 耐力+15, 生命+10 |
| 饰品 | 魅力+25, 口才+25 |

### T6 (sellPrice 350, baseValue 87)

| 装备类型 | 属性 |
|---------|------|
| 物理武器 | 力量+52, 敏捷+35 |
| 魔法武器 | 口才+52, 魅力+35 |
| 盾牌 | 防御+52, 耐力+35 |
| 头/身/腿 | 防御+43, 耐力+26, 生命+17 |
| 饰品 | 魅力+43, 口才+43 |
