import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import type { AreaDef } from "../schema.js";

/**
 * World map tier classification + SVG visualization (BFS radial layout).
 * Pure functions with no closure/state dependencies.
 */

export function getAreaTier(area: { recommendedLevel: [number, number] }): string {
  const avgLevel = (area.recommendedLevel[0] + area.recommendedLevel[1]) / 2;
  if (avgLevel <= 12) return "starter";
  if (avgLevel <= 40) return "kingdom";
  if (avgLevel <= 90) return "frontier";
  if (avgLevel <= 180) return "high";
  if (avgLevel <= 350) return "shadow";
  if (avgLevel <= 700) return "demon";
  if (avgLevel <= 1500) return "abyss";
  return "rebirth";
}

export function buildWorldMapSvg(
  currentAreaId: string,
  areaIndexMap?: Map<string, number>,
  svgWidth = 800,
  svgHeight = 700
): string {
  const areas = DEFAULT_MMORPG_CONTENT.areas;
  const cx = svgWidth / 2;
  const cy = svgHeight / 2;
  const maxRadius = Math.min(cx, cy) - 70;

  const currentArea = areas[currentAreaId];
  const currentTier = currentArea ? getAreaTier(currentArea) : "starter";

  // BFS from current area, restricted to current tier + adjacent leaf gates
  const depths = new Map<string, number>();
  depths.set(currentAreaId, 0);
  const queue = [currentAreaId];
  let maxDepth = 0;

  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depths.get(id)!;
    const area = areas[id];
    if (!area) continue;

    // If this node is in a different tier, we treat it as a leaf node (do not traverse further)
    if (getAreaTier(area) !== currentTier) {
      continue;
    }

    for (const nid of area.connectedAreaIds) {
      if (!depths.has(nid) && areas[nid]) {
        depths.set(nid, d + 1);
        maxDepth = Math.max(maxDepth, d + 1);
        queue.push(nid);
      }
    }
  }

  // Group by depth
  const byDepth = new Map<number, string[]>();
  for (const [id, d] of depths) {
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(id);
  }

  // Radial positioning
  const positions = new Map<string, { x: number; y: number }>();
  positions.set(currentAreaId, { x: cx, y: cy });
  const effectiveMax = Math.max(maxDepth, 1);
  const totalLevels = effectiveMax + (byDepth.has(effectiveMax + 1) ? 1 : 0);

  for (let d = 1; d <= totalLevels; d++) {
    const ids = byDepth.get(d) ?? [];
    if (ids.length === 0) continue;
    // Distribute radii starting at 90px to prevent center overcrowding
    const r = 90 + ((d - 1) / Math.max(totalLevels - 1, 1)) * (maxRadius - 90);
    // Stagger angle based on depth to reduce visual overlap
    const offset = (d % 2) * (Math.PI / ids.length) + d * 0.9;
    for (let i = 0; i < ids.length; i++) {
      const angle = (2 * Math.PI * i) / ids.length - Math.PI / 2 + offset;
      positions.set(ids[i], { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
  }

  function esc(v: string): string {
    return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  // Edges (only draw once per pair, only for nodes in depths)
  const edgeParts: string[] = [];
  const drawn = new Set<string>();
  for (const area of Object.values(areas)) {
    if (!depths.has(area.id)) continue;
    const p1 = positions.get(area.id);
    if (!p1) continue;
    for (const nid of area.connectedAreaIds) {
      if (!depths.has(nid)) continue;
      const pair = [area.id, nid].sort().join("|");
      if (drawn.has(pair)) continue;
      drawn.add(pair);
      const p2 = positions.get(nid);
      if (!p2) continue;

      const isGateway = getAreaTier(area) !== currentTier || getAreaTier(areas[nid]) !== currentTier;
      const strokeColor = isGateway ? "#3d444d" : "#5b6470";
      const strokeWidth = isGateway ? "1.2" : "1.6";
      const dashArray = isGateway ? ' stroke-dasharray="3,3"' : "";
      edgeParts.push(`<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${strokeColor}" stroke-width="${strokeWidth}"${dashArray}/>`);
    }
  }

  // Nodes
  const nodeParts: string[] = [];
  const labelParts: string[] = [];
  for (const area of Object.values(areas)) {
    if (!depths.has(area.id)) continue;
    const p = positions.get(area.id);
    if (!p) continue;

    const isCurrent = area.id === currentAreaId;
    const isSafe = area.isSafe === true || area.id === "starter_village";
    const areaTier = getAreaTier(area);
    const isGateway = areaTier !== currentTier;

    // Choose colors: gateway nodes are grey/faded, current is gold, safe is green, normal is blue
    const nodeColor = isGateway ? "#6e7681" : isCurrent ? "#e3b341" : isSafe ? "#3fb950" : "#58a6ff";
    const r = isCurrent ? 22 : isGateway ? 13 : 17;
    const sw = isCurrent ? 2.5 : 1.5;
    const opacityAttr = isGateway ? ' opacity="0.6"' : "";

    // Draw base node circle
    nodeParts.push(
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="#161b22" stroke="${nodeColor}" stroke-width="${sw}"${opacityAttr}/>`,
    );

    // Sequence index
    const index = areaIndexMap?.get(area.id);

    // Node label under circle (keep clean without redundant index prefix)
    const baseLabel = isGateway ? `[跨区] ${area.name}` : area.name;
    const labelText = baseLabel;
    const label = labelText.length > 10 ? labelText.slice(0, 9) + "…" : labelText;

    const fontSize = isCurrent ? 12 : isGateway ? 10.5 : 11.5;
    const fontWeight = isCurrent ? "bold" : "normal";
    const fillStyle = isGateway ? "#8b949e" : isCurrent ? "#ffea79" : "#e2e8f0";
    const textY = p.y + r + 13;
    labelParts.push(
      `<text x="${p.x.toFixed(1)}" y="${textY.toFixed(1)}" text-anchor="middle" fill="${fillStyle}" font-size="${fontSize}" font-weight="${fontWeight}" font-family="Microsoft YaHei,PingFang SC,sans-serif"${opacityAttr}>${esc(label)}</text>`,
    );

    // Display sequence index directly in the center of the circle node
    if (index !== undefined) {
      const idxTextY = p.y + (isCurrent ? 4 : isGateway ? 3 : 3.5);
      const idxFontSize = isCurrent ? 12 : isGateway ? 8.5 : 10;
      const idxFontColor = isCurrent ? "#ffea79" : "#ffffff";
      labelParts.push(
        `<text x="${p.x.toFixed(1)}" y="${idxTextY.toFixed(1)}" text-anchor="middle" fill="${idxFontColor}" font-size="${idxFontSize}" font-weight="bold" font-family="Consolas,monospace"${opacityAttr}>${index}</text>`
      );
    }
  }

  return [
    `<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">`,
    `<rect width="${svgWidth}" height="${svgHeight}" fill="#0f1117" rx="6"/>`,
    ...edgeParts,
    ...nodeParts,
    ...labelParts,
    `</svg>`,
  ].join("\n");
}
