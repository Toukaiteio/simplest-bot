import type { InventoryPlugin, DataStorePlugin, ItemDef } from "../../types.js";

export function createInventoryPlugin(store: DataStorePlugin): InventoryPlugin {
  return {
    name: "inventory",
    description: "用户物品栏系统",

    addItem(userId: string, itemId: string, quantity: number) {
      const data = store.getUserData(userId);
      data.inventory[itemId] = (data.inventory[itemId] || 0) + quantity;
      store.saveUserData(userId, data);
    },

    removeItem(userId: string, itemId: string, quantity: number): boolean {
      const data = store.getUserData(userId);
      const current = data.inventory[itemId] || 0;
      if (current < quantity) return false;
      data.inventory[itemId] = current - quantity;
      if (data.inventory[itemId] <= 0) delete data.inventory[itemId];
      store.saveUserData(userId, data);
      return true;
    },

    getInventory(userId: string): Record<string, number> {
      return { ...store.getUserData(userId).inventory };
    },

    hasItem(userId: string, itemId: string, quantity: number): boolean {
      return (store.getUserData(userId).inventory[itemId] || 0) >= quantity;
    },

    getItemDef(itemId: string): ItemDef | undefined {
      return store.getItem(itemId);
    },

    getAllItemDefs(): ItemDef[] {
      return store.getAllItems();
    },
  };
}
