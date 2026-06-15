import type { PlayerState } from "../schema.js";

export const REPUTATION_TIERS = [
  { threshold: 0, name: "中立" },
  { threshold: 100, name: "友善" },
  { threshold: 300, name: "尊敬" },
  { threshold: 600, name: "崇敬" },
  { threshold: 1000, name: "崇拜" },
];

export function getReputationTierName(reputation: number): string {
  let name = "中立";
  for (const tier of REPUTATION_TIERS) {
    if (reputation >= tier.threshold) name = tier.name;
  }
  return name;
}

export function getReputationTierIndex(reputation: number): number {
  let idx = 0;
  for (let i = 0; i < REPUTATION_TIERS.length; i++) {
    if (reputation >= REPUTATION_TIERS[i].threshold) idx = i;
  }
  return idx;
}

export function getNextReputationTier(reputation: number): { threshold: number; name: string } | null {
  for (const tier of REPUTATION_TIERS) {
    if (reputation < tier.threshold) return tier;
  }
  return null;
}

export function calculateFactionReward(reputation: number): number {
  const tierIndex = getReputationTierIndex(reputation);
  return (tierIndex + 1) * 50;
}

export function canClaimFactionReward(
  player: PlayerState,
  factionId: string,
  reputation: number
): { canClaim: boolean; reward: number; message: string } {
  if ((player.factionRewardClaimedIds ?? []).includes(factionId)) {
    return { canClaim: false, reward: 0, message: "你已经领取过该阵营的声望奖励。" };
  }
  const tierIndex = getReputationTierIndex(reputation);
  if (tierIndex <= 0) {
    return { canClaim: false, reward: 0, message: "需要达到友善声望才能领取奖励。" };
  }
  const reward = calculateFactionReward(reputation);
  return { canClaim: true, reward, message: `可领取声望奖励：${reward} 金币。` };
}

export function claimFactionReward(
  player: PlayerState,
  factionId: string,
  reputation: number
): { success: boolean; reward: number; message: string } {
  const check = canClaimFactionReward(player, factionId, reputation);
  if (!check.canClaim) return { success: false, reward: 0, message: check.message };
  if (!player.factionRewardClaimedIds) player.factionRewardClaimedIds = [];
  player.factionRewardClaimedIds.push(factionId);
  return { success: true, reward: check.reward, message: `领取成功，获得 ${check.reward} 金币。` };
}
