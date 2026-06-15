import type {
  DialogueTree,
  DialogueNode,
  DialogueChoice,
  DialogueEffect,
  PlayerState,
  PendingMenu,
  PendingMenuItem,
  MenuGroup,
} from "./schema.js";

/**
 * Resolve which dialogue tree to start for an NPC.
 * Checks requireFlag conditions in order; returns the first eligible tree, or null.
 */
export function resolveDialogueTree(
  treeIds: string[],
  allTrees: Record<string, DialogueTree>,
  playerFlags: Set<string>,
): DialogueTree | null {
  for (const id of treeIds) {
    const tree = allTrees[id];
    if (!tree) continue;
    if (tree.requireFlag && !playerFlags.has(tree.requireFlag)) continue;
    return tree;
  }
  return null;
}

/**
 * Build a PendingMenu from a dialogue node so the player can pick a choice
 * via the standard $mmo-pick command.
 */
export function buildDialogueMenu(
  tree: DialogueTree,
  nodeId: string,
  npcName: string,
  playerFlags: Set<string>,
): PendingMenu | null {
  const node = tree.nodes[nodeId];
  if (!node) return null;

  // Filter choices by requireFlag
  const availableChoices = node.choices.filter(
    (c) => !c.requireFlag || playerFlags.has(c.requireFlag),
  );

  const items: PendingMenuItem[] = availableChoices.map((choice) => ({
    label: choice.text,
    description: undefined,
    action: {
      type: "dialogue_choice",
      targetId: tree.id,
      extra: {
        nodeId,
        choiceIndex: String(node.choices.indexOf(choice)),
      },
    },
  }));

  const groups: MenuGroup[] = [
    { label: `${node.speaker}`, category: "talk", items },
  ];

  return {
    context: npcName,
    title: `${node.speaker}：${node.text}`,
    groups,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Apply a list of dialogue effects to the player/world state.
 * Returns an array of human-readable result messages.
 */
export function applyDialogueEffects(
  effects: DialogueEffect[],
  player: PlayerState,
  worldFlags: Set<string>,
  /** Callbacks for side-effects that require external systems. */
  callbacks: {
    addItem?: (itemId: string, qty: number) => boolean;
    acceptQuest?: (questId: string) => string | null;
    grantGold?: (amount: number) => void;
  },
): string[] {
  const messages: string[] = [];

  for (const effect of effects) {
    switch (effect.type) {
      case "set_flag":
        worldFlags.add(effect.value);
        break;
      case "require_flag":
        if (!worldFlags.has(effect.value)) {
          messages.push(`（条件未满足：${effect.value}）`);
        }
        break;
      case "grant_item":
        if (callbacks.addItem) {
          const ok = callbacks.addItem(effect.value, 1);
          if (ok) messages.push(`获得了物品。`);
        }
        break;
      case "accept_quest":
        if (callbacks.acceptQuest) {
          const result = callbacks.acceptQuest(effect.value);
          if (result) messages.push(result);
        }
        break;
      case "heal": {
        const amount = parseInt(effect.value, 10);
        if (!isNaN(amount) && amount > 0) {
          player.resources.hp = Math.min(
            player.resources.hp + amount,
            100 + player.stats.life * 16, // simplified maxHp
          );
          messages.push(`恢复了 ${amount} 点 HP。`);
        }
        break;
      }
      case "damage": {
        const amount = parseInt(effect.value, 10);
        if (!isNaN(amount) && amount > 0) {
          player.resources.hp = Math.max(0, player.resources.hp - amount);
          messages.push(`受到了 ${amount} 点伤害。`);
        }
        break;
      }
      case "add_gold": {
        const amount = parseInt(effect.value, 10);
        if (!isNaN(amount) && amount > 0) {
          if (callbacks.grantGold) callbacks.grantGold(amount);
          player.currencies.gold += amount;
          messages.push(`获得了 ${amount} 金币。`);
        }
        break;
      }
    }
  }

  return messages;
}
