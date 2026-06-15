import type {
  DataStorePlugin,
  InventoryPlugin,
  MenuPlugin,
  PluginContext,
  SocialPlugin,
  WelfareRewardSystemPlugin,
} from "../../../types.js";
import type { MMORPGStateStore } from "../state-store.js";
import type { BattleResult } from "../battle-simulator.js";
import type { ValidationReport } from "../schema.js";

/**
 * 运行时单例容器。
 *
 * framework-plugin.ts 的工厂函数 createMMORPGFrameworkPlugin 在初始化时调用
 * initRuntime() 注入所有共享依赖与状态。之后被抽取到各子模块的函数通过
 * 访问 rt.xxx 读取这些共享状态，从而绕开深闭包耦合——抽取出来的函数不必
 * 再通过参数传递依赖，签名保持简洁。
 *
 * 该容器是模块级单例，对应单个插件实例。Bot 进程通常只创建一个 MMORPG
 * 框架插件实例，因此单例设计是安全的。如果未来需要多实例，可改造为
 * 工厂返回独立容器并通过函数闭包传递。
 */
export type Runtime = {
  // 注入依赖
  store: DataStorePlugin;
  inventory: InventoryPlugin;
  social: SocialPlugin;
  menuPlugin: MenuPlugin;
  welfare: WelfareRewardSystemPlugin | null;

  // 运行时填充
  ctxRef: PluginContext | null;
  stateStore: MMORPGStateStore | null;
  validationReport: ValidationReport;

  // 内存状态（每会话独立的 Map）
  battleLogStore: Map<string, BattleResult>;
  portraitRateLimitMap: Map<string, number>;
  combatLock: Map<string, number>;
  travelLock: Map<string, number>;

  // 常量
  STARTER_AREA_ID: string;
};

export const rt: Runtime = {
  store: null as unknown as DataStorePlugin,
  inventory: null as unknown as InventoryPlugin,
  social: null as unknown as SocialPlugin,
  menuPlugin: null as unknown as MenuPlugin,
  welfare: null,
  ctxRef: null,
  stateStore: null,
  validationReport: { errors: [], warnings: [], stats: {} },
  battleLogStore: new Map<string, BattleResult>(),
  portraitRateLimitMap: new Map<string, number>(),
  combatLock: new Map<string, number>(),
  travelLock: new Map<string, number>(),
  STARTER_AREA_ID: "starter_village",
};

/** Initialize the runtime container with injected dependencies. Called once at plugin onLoad. */
export function initRuntime(
  store: DataStorePlugin,
  inventory: InventoryPlugin,
  social: SocialPlugin,
  menuPlugin: MenuPlugin,
  welfare: WelfareRewardSystemPlugin | null
): void {
  rt.store = store;
  rt.inventory = inventory;
  rt.social = social;
  rt.menuPlugin = menuPlugin;
  rt.welfare = welfare;
}

/** Set the live plugin context (called on each onLoad). */
export function setRuntimeContext(ctx: PluginContext): void {
  rt.ctxRef = ctx;
}

/** Set the initialized state store (called after MMORPGStateStore construction). */
export function setRuntimeStateStore(store: MMORPGStateStore): void {
  rt.stateStore = store;
}

/** Set the content validation report (called after content validation). */
export function setRuntimeValidationReport(report: ValidationReport): void {
  rt.validationReport = report;
}

/** Reset all in-memory maps (used for testing). */
export function resetRuntimeState(): void {
  rt.battleLogStore.clear();
  rt.portraitRateLimitMap.clear();
  rt.combatLock.clear();
  rt.travelLock.clear();
}
