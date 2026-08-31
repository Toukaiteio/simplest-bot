import { PetSpecies } from "./types.js";

export function shortName(name: string): string {
  if (name.length <= 5) return name;
  return name.length < 7 ? name : name.slice(0, 5) + "\u2026";
}

export function extractAtUserId(args: string[], message: { text: string }): string | null {
  for (const arg of args) {
    const cqMatch = arg.match(/\[CQ:at,qq=(\d+)\]/);
    if (cqMatch) return cqMatch[1];
  }
  const rawMatch = message.text.match(/\[CQ:at,qq=(\d+)\]/);
  if (rawMatch) return rawMatch[1];
  return null;
}
