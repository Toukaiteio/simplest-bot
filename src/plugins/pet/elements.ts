import { ElementType } from "./types.js";

export const TYPE_CHART: Record<ElementType, ElementType[]> = {
  fire: ["ice"], ice: ["earth"], earth: ["electric"],
  electric: ["water"], water: ["fire"], dark: ["light"],
  light: ["dark"], wind: [],
};

export const RESIST_CHART: Record<ElementType, ElementType[]> = {
  fire: ["water"], ice: ["fire"], earth: ["ice"],
  electric: ["earth"], water: ["electric"],
  dark: ["wind"], light: ["wind"], wind: [],
};

export const ELEMENT_NAMES: Record<ElementType, string> = {
  fire: "火", ice: "冰", electric: "电", earth: "土",
  water: "水", dark: "暗", light: "光", wind: "风",
};

export function typeEffectiveness(atk: ElementType, def: ElementType): number {
  if (TYPE_CHART[atk]?.includes(def)) return 2.0;
  if (RESIST_CHART[atk]?.includes(def)) return 0.5;
  return 1.0;
}

export function elementName(elem: ElementType): string {
  return ELEMENT_NAMES[elem];
}
