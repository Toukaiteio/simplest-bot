import type { Plugin, PluginContext, BotMessage, MenuPlugin, DataStorePlugin } from "../../types.js";
import { PetInstance } from "./types.js";
import { PET_SPECIES, getSpecies, getRandomSpeciesByRarity, getRandomEgg, EGG_COST, STARTER_SPECIES, buildEvoChain } from "./species.js";
import { elementName, TYPE_CHART } from "./elements.js";
import { loadData, saveData, markSeen, markCaught, applyMoodDecay, resetDailyCounts, calcBattlePower, moodDescription } from "./data.js";
import { simulateSkillBattle } from "./battle.js";
import { generateWildPet } from "./pve.js";
import { calcExpForLevel, grantExp, calcStats } from "./progression.js";
import { renderCard, buildPetCard, buildDexCard, buildSkillsCard, buildPetListCard, buildRankCard, buildShopCard, buildBattleReportCard, buildPvPCard, buildStarterCard, buildWelcomeCard } from "./cards.js";
import { shortName, extractAtUserId } from "./utils.js";

const MAX_DAILY_FEED = 3;
const MAX_DAILY_PLAY = 3;
const MAX_DAILY_HUNT = 5;
const MAX_PETS_PER_USER = 5;
const PVP_COOLDOWN_MS = 5 * 60 * 1000;
const PVE_COOLDOWN_MS = 30 * 1000;

export function createPetPlugin(store: DataStorePlugin, menuPlugin: MenuPlugin): Plugin {
  let ctxRef: PluginContext | null = null;

  const plugin: Plugin = {
    name: "pet",
    description: "Q宠大乱斗：宠物养成、进化、PVP & PVE",

    systemPromptAppend: [
      "宠物系统已开启！",
      "$pet — 查看宠物（新手三选一）",
      "$pet-dex [物种名] — 图鉴收集进度",
      "$pet-skills — 宠物属性与技能",
      "$pet-hunt — 野外探索（PVE）",
      "$pet-battle <@用户> — PVP",
      "$pet-shop / $pet-buy — 商店",
      "$pet-feed / $pet-play — 喂养和玩耍",
      "$pet-evolve / $pet-name — 进化/改名",
      "$pet-visit <@用户> / $pet-rank — 拜访/排行",
      "$pet-gift <@用户> <名> — 赠送宠物",
    ].join("\n"),

    async onLoad(ctx: PluginContext) {
      ctxRef = ctx;
      const prefix = menuPlugin.getPrefix();
      const reg = (name: string, desc: string, handler: any, opts?: any) =>
        menuPlugin.registerCommand(name, desc, handler, opts);

      menuPlugin.registerCommandGroup("pet", "\uD83D\uDC3E 宠物系统", "Q宠大乱斗：养成、属性克制、PVP & PVE");

      // ── $pet ──
      reg("pet", `查看宠物状态 / 新手三选一：${prefix}pet`, async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        const data = loadData();
        if (!data.hasClaimedStarter[userId]) {
          const arg = (args[0] ?? "").trim();
          if (["1", "2", "3"].includes(arg)) {
            return claimStarter(userId, parseInt(arg,10)-1, data, ctx, message, prefix);
          }
          const starters = STARTER_SPECIES.map(id => getSpecies(id)!);
          const target = message.type === "group" ? { type:"group" as const, id: message.groupId! } : { type:"private" as const, id: userId };
          await renderCard(buildStarterCard(prefix), ctx, message, target,
            "选择你的初始伙伴：\n" + starters.map((s,i) => `${i+1}. ${s.name}(${elementName(s.element)}) ${s.description}`).join("\n")
            + `\n输入 ${prefix}pet 1/2/3 选择`
          );
          return;
        }
        const userPetIds = data.userPets[userId];
        if (!userPetIds?.length) { await ctx.replyText(message, `去 ${prefix}pet-shop 购买宠物蛋孵化吧！`); return; }
        const pet = data.pets[userPetIds[0]];
        if (!pet) { await ctx.replyText(message, "数据异常。"); return; }
        applyMoodDecay(pet);
        const species = getSpecies(pet.speciesId);
        saveData(data);
        const target = message.type === "group" ? { type:"group" as const, id: message.groupId! } : { type:"private" as const, id: userId };
        const html = buildPetCard(pet, species ?? undefined, prefix);
        await renderCard(html, ctx, message, target, `[${pet.name}] ${pet.pveWins+pet.wins}胜${pet.losses}负`);
      });

      // ── $pet-skills ──
      reg("pet-skills", `查看宠物属性与技能：${prefix}pet-skills`, async (message: BotMessage) => {
        const userId = message.userId!;
        const data = loadData();
        const userPetIds = data.userPets[userId];
        if (!userPetIds?.length) { await ctx.replyText(message, "还没有宠物！"); return; }
        const pet = data.pets[userPetIds[0]];
        if (!pet) { await ctx.replyText(message, "数据异常。"); return; }
        const species = getSpecies(pet.speciesId);
        const target = message.type === "group" ? { type:"group" as const, id: message.groupId! } : { type:"private" as const, id: userId };
        await renderCard(buildSkillsCard(pet, species ?? undefined), ctx, message, target, "请使用 $pet 查看宠物状态。");
      });

      // ── $pet-dex ──
      reg("pet-dex", `宠物图鉴：${prefix}pet-dex [物种名]`, async (message: BotMessage, args: string[]) => {
        const userId = message.userId!;
        const data = loadData();
        const query = args.join(" ").trim();
        if (query) {
          const match = PET_SPECIES.find(s => s.name === query || s.id === query || s.name.includes(query));
          if (!match) { await ctx.replyText(message, `未找到 "${query}"`); return; }
          const caught = (data.caughtSpecies[userId] ?? []).includes(match.id);
          const seen = (data.seenSpecies[userId] ?? []).includes(match.id);
          await ctx.replyText(message,
            `${match.name}  #${String(PET_SPECIES.indexOf(match)+1).padStart(2,"0")}\n`
            + `属性：${elementName(match.element)} · ${match.rarity}\n`
            + `进化：${buildEvoChain(match.id)}\n`
            + `技能：${match.skill.name}（${elementName(match.skill.element)}·威力${match.skill.power}）\n`
            + `${match.description}\n`
            + `状态：${caught ? "已捕获" : seen ? "已遭遇" : "未发现"}`
          );
          return;
        }
        const target = message.type === "group" ? { type:"group" as const, id: message.groupId! } : { type:"private" as const, id: userId };
        const html = buildDexCard(data, userId);
        await renderCard(html, ctx, message, target, `图鉴加载失败`);
      });

      // ── $pet-hunt (PVE) ──
      reg("pet-hunt", `野外探索：${prefix}pet-hunt`, async (message: BotMessage) => {
        const userId = message.userId!;
        const data = loadData();
        const userPetIds = data.userPets[userId];
        if (!userPetIds?.length) { await ctx.replyText(message, "还没有宠物！"); return; }
        const petRef = data.pets[userPetIds[0]];
        if (!petRef) { await ctx.replyText(message, "数据异常。"); return; }
        let pet: PetInstance = petRef;
        resetDailyCounts(pet);
        if (pet.dailyHuntCount >= MAX_DAILY_HUNT) { await ctx.replyText(message, `今日已狩猎 ${MAX_DAILY_HUNT} 次，明天再来吧！`); return; }
        if (Date.now() - pet.lastBattleAt < PVE_COOLDOWN_MS && pet.lastBattleAt > 0) {
          const s = Math.ceil((PVE_COOLDOWN_MS - (Date.now() - pet.lastBattleAt)) / 1000);
          await ctx.replyText(message, `宠物需要休息 ${s} 秒。`); return;
        }
        applyMoodDecay(pet);
        pet.lastBattleAt = Date.now();
        const wild = generateWildPet(pet.level);
        const moodBonus = Math.min(1, (pet.mood.happiness + pet.mood.hunger) / 200);
        const wildMood = 0.7 + Math.random() * 0.3;
        const playerSpecies = getSpecies(pet.speciesId);
        const { typeEffectiveness } = await import("./elements.js");
        const playerEff = playerSpecies ? typeEffectiveness(playerSpecies.element, wild.species.element) : 1.0;
        const wildEff = typeEffectiveness(wild.species.element, playerSpecies?.element ?? "wind");
        const logs: string[] = [];
        logs.push(`${pet.name} 在野外遇到了 ${wild.name}！`);
        let turn = 0, maxT = 15, pHp = pet.currentHp, wHp = wild.hp, pTimer = 0, wTimer = 0, pSpd = Math.floor(pet.stats.speed * moodBonus), wSpd = Math.floor(wild.stats.speed * wildMood), skillCD = 0;
        while (turn < maxT && pHp > 0 && wHp > 0) {
          turn++; pTimer += pSpd; wTimer += wSpd;
          if (pTimer >= wTimer) {
            const useSkill = skillCD <= 0 && playerSpecies !== undefined;
            const base = useSkill ? Math.floor(playerSpecies!.skill.power * (0.8 + Math.random() * 0.4)) : Math.floor(pet.stats.power * 1.5 * (0.8 + Math.random() * 0.4));
            const dmg = Math.max(1, Math.floor(base * playerEff * moodBonus));
            wHp = Math.max(0, wHp - dmg);
            logs.push(`${pet.name} ${useSkill?playerSpecies!.skill.name:"普攻"} ${dmg}伤害（${wild.name} ${Math.round(wHp)}/${Math.round(wild.hp)}）`);
            skillCD = useSkill ? playerSpecies!.skill.cooldown : Math.max(0, skillCD - 1);
            pTimer -= 100;
          } else {
            const base = Math.floor(wild.species.skill.power * (0.8 + Math.random() * 0.4));
            const dmg = Math.max(1, Math.floor(base * wildEff * wildMood));
            pHp = Math.max(0, pHp - dmg);
            logs.push(`${wild.name} ${wild.species.skill.name} ${dmg}伤害（${pet.name} ${Math.round(pHp)}/${pet.maxHp}）`);
            wTimer -= 100;
          }
        }
        let result: "win"|"lose"|"draw", expG=0, coinG=0, drop: string|null = null;
        if (wHp <= 0) { result="win"; pet.pveWins++; expG=Math.floor(8+pet.level*2.5+Math.random()*5); coinG=Math.floor(5+pet.level*2+Math.random()*8);
          if (Math.random()<0.1) { drop=Math.random()<0.5?"pet_food":"pet_treat"; const p=store.getUserData(userId); store.saveUserData(userId,{...p,inventory:{...p.inventory,[drop!]:(p.inventory[drop!]??0)+1}}); }
          try { const p=store.getUserData(userId); store.saveUserData(userId,{...p,coins:(p.coins??0)+coinG}); } catch{} }
        else if (pHp<=0) { result="lose"; pet.losses++; expG=Math.floor(2+pet.level); coinG=0; pHp=Math.max(1,Math.round(pet.maxHp*0.3)); }
        else { result="draw"; pet.losses++; expG=Math.floor(4+pet.level); coinG=0; }
        if (expG>0) pet = await grantExp(pet, expG, data as any, ctx, message, userId);
        pet.currentHp = Math.round(pHp);
        pet.dailyHuntCount++;
        data.pets[pet.id] = pet; saveData(data);
        const target = message.type==="group"?{type:"group"as const,id:message.groupId!}:{type:"private"as const,id:userId};
        await renderCard(buildBattleReportCard(pet.name, logs, result, expG, coinG, MAX_DAILY_HUNT-pet.dailyHuntCount, drop), ctx, message, target, result==="win"?"胜利":"战败");
      });

      // ── $pet-list ──
      reg("pet-list", `查看所有宠物：${prefix}pet-list`, async (message: BotMessage) => {
        const userId = message.userId!;
        const data = loadData();
        const userPetIds = data.userPets[userId];
        if (!userPetIds?.length) { await ctx.replyText(message, "还没有宠物！"); return; }
        const pets = userPetIds.map(id => data.pets[id]).filter(Boolean);
        const target = message.type==="group"?{type:"group"as const,id:message.groupId!}:{type:"private"as const,id:userId};
        await renderCard(buildPetListCard(pets, prefix), ctx, message, target, `宠物：${pets.map((p,i)=>`${i===0?">":" "}${p.name} Lv.${p.level}`).join(" | ")}`);
      });

      // ── $pet-shop ──
      reg("pet-shop", `宠物商店：${prefix}pet-shop`, async (message: BotMessage) => {
        const userId = message.userId!;
        const profile = store.getUserData(userId);
        const target = message.type==="group"?{type:"group"as const,id:message.groupId!}:{type:"private"as const,id:userId};
        await renderCard(buildShopCard(profile.coins, prefix), ctx, message, target, "商店数据加载失败");
      });

      // ── $pet-buy ──
      reg("pet-buy", `购买宠物蛋：${prefix}pet-buy <编号>`, async (message: BotMessage, args: string[]) => {
        const userId = message.userId!; const idx = parseInt(args[0]??"",10);
        if (isNaN(idx)||idx<1||idx>5) { await ctx.replyText(message, "编号 1-5"); return; }
        const rarities = ["common","uncommon","rare","epic","legendary"]; const tier = rarities[idx-1]; const cost = Object.values(EGG_COST)[idx-1];
        const profile = store.getUserData(userId);
        if (profile.coins < cost) { await ctx.replyText(message, `金币不足！需要 ${cost}。`); return; }
        store.saveUserData(userId, {...profile, coins: profile.coins - cost});
        let species = getRandomEgg();
        if (tier==="legendary") species=getRandomSpeciesByRarity("legendary")!;
        else if (tier==="epic") species=Math.random()<0.5?getRandomSpeciesByRarity("epic")!:getRandomSpeciesByRarity("rare")!;
        else if (tier==="rare") { const r=Math.random(); species=r<0.3?getRandomSpeciesByRarity("epic")!:r<0.6?getRandomSpeciesByRarity("rare")!:getRandomSpeciesByRarity("uncommon")!; }
        const data = loadData();
        if (!data.ownedEggs[userId]) data.ownedEggs[userId]=[]; data.ownedEggs[userId].push({speciesId:species.id,obtainedAt:Date.now()});
        saveData(data);
        await ctx.replyText(message, `🛒 花费 ${cost} 金币\n🥚 获得 ${species.name}（${species.rarity}）\n💡 ${prefix}pet-hatch 孵化！`);
      });

      // ── $pet-hatch ──
      reg("pet-hatch", `孵化宠物蛋：${prefix}pet-hatch`, async (message: BotMessage) => {
        const userId = message.userId!; const data = loadData(); const eggs = data.ownedEggs[userId];
        if (!eggs?.length) { await ctx.replyText(message, "没有蛋！去 $pet-shop 购买。"); return; }
        const userPets = data.userPets[userId]??[];
        if (userPets.length>=MAX_PETS_PER_USER) { await ctx.replyText(message, `宠物已达上限 ${MAX_PETS_PER_USER} 只。`); return; }
        const eggIndex = Math.floor(Math.random()*eggs.length); const egg = eggs[eggIndex]; eggs.splice(eggIndex,1);
        const species = getSpecies(egg.speciesId); if (!species) { await ctx.replyText(message, "蛋数据异常。"); return; }
        const petId = `pet_${data.nextId++}`;
        const pet: PetInstance = {
          id:petId, ownerId:userId, speciesId:species.id, name:species.name,
          level:1, exp:0, stats:{...species.baseStats}, maxHp:species.baseStats.hp, currentHp:species.baseStats.hp,
          mood:{hunger:100, happiness:100, cleanliness:100}, skillLevel:1,
          wins:0, losses:0, pveWins:0, createdAt:Date.now(),
          lastFedAt:Date.now(), lastPlayedAt:Date.now(), lastBattleAt:0, lastDailyAt:0,
          dailyFeedCount:0, dailyPlayCount:0, dailyHuntCount:0,
        };
        data.pets[petId]=pet; if(!data.userPets[userId]) data.userPets[userId]=[]; data.userPets[userId].unshift(petId);
        markCaught(data, userId, species.id); saveData(data);
        await ctx.replyText(message, `🎉 宠物出生！${pet.name}（${species.rarity}）属性：${elementName(species.element)} 技能：${species.skill.name}`);
      });

      // ── $pet-name ──
      reg("pet-name", `改名：${prefix}pet-name <新名>`, async (message: BotMessage, args: string[]) => {
        const userId = message.userId!; const newName = args.join(" ").trim();
        if (!newName||newName.length>10) { await ctx.replyText(message, "名字 1-10 字符。"); return; }
        const data = loadData(); const userPetIds = data.userPets[userId];
        if (!userPetIds?.length) { await ctx.replyText(message, "还没有宠物！"); return; }
        const pet = data.pets[userPetIds[0]]; if (!pet) { await ctx.replyText(message, "数据异常。"); return; }
        pet.name = newName; saveData(data);
        await ctx.replyText(message, `✅ 已更名为 "${newName}"！`);
      });

      // ── $pet-feed ──
      reg("pet-feed", `喂食：${prefix}pet-feed`, async (message: BotMessage) => {
        const userId = message.userId!; const data = loadData(); const up = data.userPets[userId];
        if(!up?.length){await ctx.replyText(message,"还没有宠物！");return;}
        const petRef=data.pets[up[0]]; if(!petRef){await ctx.replyText(message,"数据异常。");return;} let pet=petRef;
        resetDailyCounts(pet);
        if(pet.dailyFeedCount>=MAX_DAILY_FEED){await ctx.replyText(message,`今日已喂 ${MAX_DAILY_FEED} 次。`);return;}
        const profile=store.getUserData(userId);
        const foodItems=["pet_food","pet_meal","pet_treat"]; let usedFood:string|null=null;
        for(const f of foodItems){if((profile.inventory?.[f]??0)>0){usedFood=f;break;}}
        if(!usedFood&&profile.coins<100){await ctx.replyText(message,"没有食物且金币不足 100。");return;}
        if(usedFood){store.saveUserData(userId,{...profile,inventory:{...profile.inventory,[usedFood]:(profile.inventory[usedFood]??0)-1}});}
        else{store.saveUserData(userId,{...profile,coins:profile.coins-100});}
        applyMoodDecay(pet); pet.mood.hunger=Math.min(100,pet.mood.hunger+40); pet.dailyFeedCount++; pet.lastFedAt=Date.now();
        if(Math.random()<0.3){pet=await grantExp(pet,Math.floor(5+pet.level*2),data as any,ctx,message,userId);}
        saveData(data);
        await ctx.replyText(message,`🍖 喂食成功！饱食度 +40（${pet.mood.hunger}/100）`);
      });

      // ── $pet-play ──
      reg("pet-play", `玩耍：${prefix}pet-play`, async (message: BotMessage) => {
        const userId=message.userId!;const data=loadData();const up=data.userPets[userId];
        if(!up?.length){await ctx.replyText(message,"还没有宠物！");return;}
        const petRef=data.pets[up[0]];if(!petRef){await ctx.replyText(message,"数据异常。");return;}let pet=petRef;
        resetDailyCounts(pet);if(pet.dailyPlayCount>=MAX_DAILY_PLAY){await ctx.replyText(message,`今日已玩 ${MAX_DAILY_PLAY} 次。`);return;}
        applyMoodDecay(pet);
        const events=["你扔出飞盘，宠物一个漂亮叼住！","宠物翻了几个跟头逗你开心","你给宠物挠痒痒，它舒服地眯起眼睛","宠物叼来最爱的玩具球"];
        pet.mood.happiness=Math.min(100,pet.mood.happiness+35);pet.dailyPlayCount++;pet.lastPlayedAt=Date.now();
        let extra="";if(Math.random()<0.25){const e=Math.floor(3+pet.level);const u=await grantExp(pet,e,data as any,ctx,message,userId);if(u)pet=u;extra=`\n🎉 获得 ${e} 经验！`;}
        saveData(data);
        await ctx.replyText(message,`${events[Math.floor(Math.random()*events.length)]}\n心情 +35（${pet.mood.happiness}/100）${extra}`);
      });

      // ── $pet-evolve ──
      reg("pet-evolve", `进化：${prefix}pet-evolve`, async (message: BotMessage) => {
        const userId=message.userId!;const data=loadData();const up=data.userPets[userId];
        if(!up?.length){await ctx.replyText(message,"还没有宠物！");return;}
        const pet=data.pets[up[0]];if(!pet){await ctx.replyText(message,"数据异常。");return;}
        const species=getSpecies(pet.speciesId);
        if(!species||!species.evolvesTo){await ctx.replyText(message,`${pet.name} 已是最终形态！`);return;}
        if(pet.level<species.evolvesAt){await ctx.replyText(message,`需要 Lv.${species.evolvesAt}，当前 Lv.${pet.level}`);return;}
        if(species.evolveItem){const p=store.getUserData(userId);if((p.inventory?.[species.evolveItem]??0)<=0){await ctx.replyText(message,`进化需要 ${species.evolveItem}！`);return;}
          store.saveUserData(userId,{...p,inventory:{...p.inventory,[species.evolveItem]:(p.inventory[species.evolveItem]??0)-1}});}
        const newSpecies=getSpecies(species.evolvesTo);if(!newSpecies){await ctx.replyText(message,"进化目标异常。");return;}
        const hpRatio=pet.currentHp/pet.maxHp;pet.speciesId=newSpecies.id;pet.stats=calcStats(newSpecies,pet.level);pet.maxHp=pet.stats.hp;pet.currentHp=Math.max(1,Math.round(pet.maxHp*hpRatio));
        saveData(data);
        await ctx.replyText(message,`✨✨✨ 进化成功！✨✨✨\n${pet.name} -> ${newSpecies.name}（${newSpecies.rarity}）\n属性：${elementName(newSpecies.element)} | 技能：${newSpecies.skill.name}（威力${newSpecies.skill.power}）`);
      });

      // ── $pet-battle (PVP) ──
      reg("pet-battle", `PVP：${prefix}pet-battle <@用户>`, async (message: BotMessage, args: string[]) => {
        const userId=message.userId!;const targetUserId=extractAtUserId(args,message);
        if(!targetUserId||targetUserId===userId){await ctx.replyText(message,"请 @ 一位好友。");return;}
        const data=loadData();const mIds=data.userPets[userId];if(!mIds?.length){await ctx.replyText(message,"你还没有宠物！");return;}
        const myPet=data.pets[mIds[0]];if(!myPet){await ctx.replyText(message,"数据异常。");return;}
        const tIds=data.userPets[targetUserId];if(!tIds?.length){await ctx.replyText(message,"对方还没有宠物！");return;}
        const tPet=data.pets[tIds[0]];if(!tPet){await ctx.replyText(message,"对方数据异常。");return;}
        if(Date.now()-myPet.lastBattleAt<PVP_COOLDOWN_MS){const s=Math.ceil((PVP_COOLDOWN_MS-(Date.now()-myPet.lastBattleAt))/1000);await ctx.replyText(message,`冷却中，还需 ${s} 秒。`);return;}
        applyMoodDecay(myPet);applyMoodDecay(tPet);
        const mM=Math.min(1,(myPet.mood.happiness+myPet.mood.hunger)/200);const tM=Math.min(1,(tPet.mood.happiness+tPet.mood.hunger)/200);
        const result=simulateSkillBattle(myPet,tPet,mM,tM);
        const winner=result.winner==="attacker"?myPet:tPet;const loser=result.winner==="attacker"?tPet:myPet;
        myPet.lastBattleAt=Date.now();
        if(result.winner==="attacker"){myPet.wins++;tPet.losses++;}else{myPet.losses++;tPet.wins++;}
        myPet.currentHp=Math.max(1,Math.round(myPet.maxHp*0.8));tPet.currentHp=Math.max(1,Math.round(tPet.maxHp*0.8));
        const expG=5+Math.floor(loser.level*1.5);await grantExp(winner,expG,data as any,ctx,message,winner.ownerId);
        let mmo="";try{const p=store.getUserData(winner.ownerId);store.saveUserData(winner.ownerId,{...p,coins:(p.coins??0)+(10+loser.level*3)});mmo=`金币 +${10+loser.level*3}`;}catch{}
        data.pets[myPet.id]=myPet;data.pets[tPet.id]=tPet;
        if(!data.rankings[myPet.id])data.rankings[myPet.id]=0;if(!data.rankings[tPet.id])data.rankings[tPet.id]=0;
        data.rankings[myPet.id]!++;data.rankings[tPet.id]!++;
        markSeen(data,userId,tPet.speciesId);markSeen(data,targetUserId,myPet.speciesId);
        saveData(data);
        const tg=message.type==="group"?{type:"group"as const,id:message.groupId!}:{type:"private"as const,id:userId};
        await renderCard(buildPvPCard(myPet.name,tPet.name,result.log,winner.name,expG,mmo,myPet.wins,myPet.losses),ctx,message,tg,`${winner.name} wins! +${expG}exp`);
      });

      // ── $pet-visit ──
      reg("pet-visit", `拜访：${prefix}pet-visit <@用户>`, async (message: BotMessage, args: string[]) => {
        const userId=message.userId!;const t=extractAtUserId(args,message);if(!t||t===userId){await ctx.replyText(message,"请 @ 好友。");return;}
        const data=loadData();const tp=data.userPets[t];if(!tp?.length){await ctx.replyText(message,"对方还没有宠物！");return;}
        const pet=data.pets[tp[0]];if(!pet){await ctx.replyText(message,"数据异常。");return;}
        const species=getSpecies(pet.speciesId);const bp=calcBattlePower(pet);
        let rw="";try{const p=store.getUserData(userId);store.saveUserData(userId,{...p,coins:(p.coins??0)+5});rw="\n拜访得 5 金币！";}catch{}
        await ctx.replyText(message,`拜访好友的宠物之家\n${pet.name}（${species?elementName(species.element):"?"}）Lv.${pet.level} 战力${bp} ${moodDescription(pet)}${rw}`);
      });

      // ── $pet-rank ──
      reg("pet-rank", `排行榜：${prefix}pet-rank`, async (message: BotMessage) => {
        const userId=message.userId!;
        const data=loadData();
        const rankings=Object.entries(data.pets).filter(([_,p])=>p.wins+p.losses>0)
          .sort((a,b)=>{const r=b[1].wins/Math.max(1,b[1].wins+b[1].losses)-(a[1].wins/Math.max(1,a[1].wins+a[1].losses));return r||(b[1].wins-a[1].wins);}).slice(0,10);
        if(!rankings.length){await ctx.replyText(message,"还没有战斗记录！");return;}
        const tg=message.type==="group"?{type:"group"as const,id:message.groupId!}:{type:"private"as const,id:userId};
        await renderCard(buildRankCard(rankings,prefix),ctx,message,tg,"排行榜数据加载失败");
      });

      // ── $pet-gift ──
      reg("pet-gift", `赠送：${prefix}pet-gift <@用户> <名>`, async (message: BotMessage, args: string[]) => {
        const userId=message.userId!;const t=extractAtUserId(args,message);if(!t||t===userId){await ctx.replyText(message,"请 @ 好友。");return;}
        const n=args.filter(a=>!a.startsWith("[CQ:at")&&!a.startsWith("@")).join(" ").trim();if(!n){await ctx.replyText(message,"请指定宠物名。");return;}
        const data=loadData();const up=data.userPets[userId];if(!up||up.length<=1){await ctx.replyText(message,"需至少 2 只宠物才能赠送。");return;}
        const ge=Object.entries(data.pets).find(([id,p])=>p.ownerId===userId&&p.name===n);if(!ge){await ctx.replyText(message,`找不到 "${n}"`);return;}
        const [gid,gp]=ge;const tp=data.userPets[t]??[];if(tp.length>=MAX_PETS_PER_USER){await ctx.replyText(message,"对方宠物已满。");return;}
        gp.ownerId=t;data.userPets[userId]=data.userPets[userId].filter(id=>id!==gid);if(!data.userPets[t])data.userPets[t]=[];data.userPets[t].push(gid);
        markCaught(data,t,gp.speciesId);saveData(data);
        await ctx.replyText(message,`🎁 赠送成功！${gp.name} 已送给对方。`);
      });
    },
  };
  return plugin;
}

// ── Starter claim ──
async function claimStarter(userId: string, idx: number, data: any, ctx: PluginContext, message: BotMessage, prefix: string) {
  const speciesId = STARTER_SPECIES[idx]; const species = getSpecies(speciesId);
  if (!species) { await ctx.replyText(message, "选择无效。"); return; }
  const userPets = data.userPets[userId] ?? [];
  if (userPets.length >= MAX_PETS_PER_USER) { await ctx.replyText(message, "宠物已达上限。"); return; }
  const petId = `pet_${data.nextId++}`;
  const pet: PetInstance = {
    id:petId, ownerId:userId, speciesId:species.id, name:species.name,
    level:1, exp:0, stats:{...species.baseStats}, maxHp:species.baseStats.hp, currentHp:species.baseStats.hp,
    mood:{hunger:100, happiness:100, cleanliness:100}, skillLevel:1,
    wins:0, losses:0, pveWins:0, createdAt:Date.now(),
    lastFedAt:Date.now(), lastPlayedAt:Date.now(), lastBattleAt:0, lastDailyAt:0,
    dailyFeedCount:0, dailyPlayCount:0, dailyHuntCount:0,
  };
  data.pets[petId]=pet; if(!data.userPets[userId]) data.userPets[userId]=[]; data.userPets[userId].unshift(petId);
  data.hasClaimedStarter[userId]=true; markCaught(data, userId, species.id); saveData(data);
  const target = message.type === "group" ? { type:"group" as const, id: message.groupId! } : { type:"private" as const, id: userId };
  await renderCard(buildWelcomeCard(species, prefix), ctx, message, target,
    `欢迎 ${species.name} 加入你的队伍！属性：${elementName(species.element)}系 技能：${species.skill.name}（威力${species.skill.power}）用 ${prefix}pet-name <新名字> 给它起个名吧！`);
}
