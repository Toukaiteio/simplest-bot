import type { AreaDef, PendingMenu } from "../schema.js";

/**
 * Find a shortest path between two areas using BFS.
 * Returns the area IDs including both endpoints, or null if unreachable.
 */
export function findPathBFS(
  startAreaId: string,
  targetAreaId: string,
  areas: Record<string, AreaDef>,
  maxSteps: number
): string[] | null {
  if (startAreaId === targetAreaId) return [startAreaId];

  const prev = new Map<string, string>();
  prev.set(startAreaId, "");
  const queue: string[] = [startAreaId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentArea = areas[currentId];
    if (!currentArea) continue;

    // Enforce max path depth
    let depth = 0;
    let t = currentId;
    while (t !== startAreaId) {
      t = prev.get(t)!;
      depth++;
    }
    if (depth >= maxSteps) continue;

    for (const neighborId of currentArea.connectedAreaIds) {
      if (prev.has(neighborId)) continue;
      prev.set(neighborId, currentId);
      if (neighborId === targetAreaId) {
        const result: string[] = [];
        let cur: string = targetAreaId;
        while (cur !== startAreaId) {
          result.unshift(cur);
          cur = prev.get(cur)!;
        }
        result.unshift(startAreaId);
        return result;
      }
      queue.push(neighborId);
    }
  }
  return null;
}

/**
 * Build a map of areaId → 1-based menu index from the given pending menu.
 * Used to show menu sequence numbers in path / hint messages.
 */
export function buildAreaIndexMap(
  menu: PendingMenu | undefined
): Map<string, number> {
  const map = new Map<string, number>();
  if (!menu) return map;
  let idx = 1;
  for (const group of menu.groups) {
    for (const item of group.items) {
      if (item.action.type === "move" && item.action.targetId) {
        map.set(item.action.targetId, idx);
      }
      idx++;
    }
  }
  return map;
}

/**
 * Format a BFS path as a human-readable string, annotating menu indices
 * when available.  E.g.  "新手村 → 低语森林(序号3) → 铁矿坑(序号7)"
 */
export function formatPathWithIndices(
  path: string[],
  indexMap: Map<string, number>,
  areas: Record<string, AreaDef>
): string {
  return path
    .map((areaId) => {
      const area = areas[areaId];
      const name = area ? area.name : areaId;
      const idx = indexMap.get(areaId);
      return idx !== undefined ? `${name}(序号${idx})` : name;
    })
    .join(" → ");
}
