import type { ContextManagementConfig } from "../types.js";

export interface TokenCounter {
  countTokens(text: string): number;
}

export function createTokenCounter(config: ContextManagementConfig): TokenCounter {
  if (config.tokenizer === "auto" || config.tokenizer === "character") {
    return new CharacterRatioTokenizer();
  }
  return new CharacterRatioTokenizer();
}

/**
 * 基于字符比例的轻量 tokenizer。
 * 中文按约 1.5 字符/token 估算，英文按约 4 字符/token 估算，
 * 对混合文本取加权平均。精度不如 tiktoken，但不引入原生依赖。
 */
class CharacterRatioTokenizer implements TokenCounter {
  countTokens(text: string): number {
    if (!text) return 0;

    let cjkCount = 0;
    let nonCjkCount = 0;

    for (const char of text) {
      if (isCjk(char)) {
        cjkCount += 1;
      } else if (!isWhitespace(char)) {
        nonCjkCount += 1;
      }
    }

    const cjkTokens = cjkCount / 1.5;
    const nonCjkTokens = nonCjkCount / 4;
    return Math.ceil(cjkTokens + nonCjkTokens);
  }
}

function isCjk(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) return false;

  // CJK Unified Ideographs
  if (code >= 0x4e00 && code <= 0x9fff) return true;
  // CJK Unified Ideographs Extension A
  if (code >= 0x3400 && code <= 0x4dbf) return true;
  // Hangul Syllables
  if (code >= 0xac00 && code <= 0xd7af) return true;
  // Hiragana
  if (code >= 0x3040 && code <= 0x309f) return true;
  // Katakana
  if (code >= 0x30a0 && code <= 0x30ff) return true;

  return false;
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}
