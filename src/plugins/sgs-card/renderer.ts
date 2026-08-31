import fs from "node:fs";
import path from "node:path";
import { screenshotHtml } from "../mmorpg/screenshot.js";
import type { SgsCardData } from "./schema.js";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function clip(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function wrapParagraph(text: string, lineChars: number, maxLines: number): string[] {
  const chars = [...text];
  const lines: string[] = [];
  let current = "";

  for (const char of chars) {
    if (char === "\n") {
      if (current) lines.push(current);
      current = "";
      if (lines.length >= maxLines) break;
      continue;
    }

    current += char;
    if (current.length >= lineChars) {
      lines.push(current);
      current = "";
      if (lines.length >= maxLines) break;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    return lines.slice(0, maxLines);
  }

  if (chars.length > 0 && lines.length === maxLines) {
    const consumed = lines.join("").length;
    if (consumed < chars.filter((item) => item !== "\n").length) {
      lines[maxLines - 1] = clip(lines[maxLines - 1], Math.max(1, lineChars - 1));
    }
  }

  return lines.map((line, index) => {
    if (index !== lines.length - 1) return line;
    const consumed = lines.join("").length;
    const total = chars.filter((item) => item !== "\n").length;
    return consumed < total ? clip(line, Math.max(1, lineChars - 1)) : line;
  });
}

function normalizeSkills(skills: SgsCardData["skills"]): Array<{ name: string; type: string; lines: string[] }> {
  const count = Math.max(1, skills.length);
  const lineBudget = count <= 2 ? 5 : count === 3 ? 4 : 3;
  const charBudget = count <= 2 ? 20 : count === 3 ? 18 : 16;

  return skills.map((skill) => {
    const prefix = skill.type && skill.type !== "普通技" ? `【${skill.type}】` : "";
    const text = `${prefix}${skill.desc}`.trim();
    return {
      name: clip(skill.name, 6),
      type: skill.type ?? "普通技",
      lines: wrapParagraph(text, charBudget, lineBudget),
    };
  });
}

function buildCardHtml(data: SgsCardData, imageDataUri: string): string {
  const skillBlocks = normalizeSkills(data.skills)
    .map((skill) => {
      const lines = skill.lines.map((line) => `<div class="sgs-skill-line">${esc(line)}</div>`).join("");
      return `
        <section class="sgs-skill">
          <div class="sgs-skill-name">${esc(skill.name)}</div>
          <div class="sgs-skill-body">${lines}</div>
        </section>
      `;
    })
    .join("");

  const notes = (data.designNotes ?? []).length > 0
    ? `<div class="sgs-notes">${data.designNotes!.map((item) => `<span>${esc(clip(item, 22))}</span>`).join("")}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: transparent;
      font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", "SimSun", serif;
    }
    .sgs {
      width: 440px;
      min-height: 720px;
      color: #f7f2e8;
      background:
        linear-gradient(180deg, rgba(8, 9, 12, 0.05), rgba(8, 9, 12, 0.75)),
        radial-gradient(circle at top, rgba(255, 221, 146, 0.18), transparent 42%),
        #17110e;
      border: 10px solid #9b7442;
      border-radius: 26px;
      overflow: hidden;
      box-shadow: 0 24px 72px rgba(0, 0, 0, 0.45);
      position: relative;
    }
    .sgs-header {
      position: relative;
      height: 360px;
      background: linear-gradient(180deg, #1a1510 0%, #2a1f15 50%, #1a1510 100%);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .sgs-header-inner {
      text-align: center;
      padding: 30px;
    }
    .sgs-badge {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      background: rgba(37, 25, 18, 0.9);
      border: 3px solid rgba(255, 225, 156, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      font-weight: 700;
      margin: 0 auto 16px;
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.4);
    }
    .sgs-identity {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
    }
    .sgs-title {
      writing-mode: vertical-rl;
      text-orientation: mixed;
      font-size: 18px;
      color: #e0ba72;
      text-shadow: 0 2px 10px rgba(0, 0, 0, 0.55);
      max-height: 140px;
      overflow: hidden;
    }
    .sgs-name {
      font-size: 48px;
      font-weight: 800;
      letter-spacing: 8px;
      text-shadow: 0 4px 14px rgba(0, 0, 0, 0.65);
    }
    .sgs-flavor {
      margin-top: 14px;
      font-size: 14px;
      color: rgba(249, 241, 224, 0.85);
      font-style: italic;
    }
    .sgs-stats-row {
      display: flex;
      justify-content: center;
      gap: 16px;
      margin-top: 18px;
    }
    .sgs-hp {
      font-size: 18px;
      font-weight: 700;
      color: #ffdfd0;
      padding: 5px 14px;
      border-radius: 999px;
      background: rgba(58, 15, 15, 0.8);
      border: 1px solid rgba(255, 189, 165, 0.5);
    }
    .sgs-armor {
      font-size: 16px;
      color: #d9ebff;
      padding: 5px 14px;
      border-radius: 999px;
      background: rgba(13, 31, 56, 0.8);
      border: 1px solid rgba(164, 202, 255, 0.4);
    }
    .sgs-body {
      padding: 16px 18px 20px;
      background:
        linear-gradient(180deg, rgba(244, 232, 214, 0.96), rgba(224, 210, 188, 0.96)),
        repeating-linear-gradient(0deg, rgba(82, 57, 35, 0.05), rgba(82, 57, 35, 0.05) 1px, transparent 1px, transparent 28px);
      color: #24170f;
    }
    .sgs-backstory {
      margin-bottom: 16px;
      padding: 12px 14px;
      background: rgba(255, 249, 240, 0.6);
      border: 1px solid rgba(94, 54, 27, 0.2);
      border-radius: 10px;
      font-size: 13px;
      line-height: 1.65;
      color: #3a2a1a;
    }
    .sgs-backstory-label {
      font-size: 11px;
      font-weight: 700;
      color: #8b5e3c;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 2px;
    }
    .sgs-skills {
      display: grid;
      gap: 10px;
    }
    .sgs-skill {
      display: grid;
      grid-template-columns: 78px 1fr;
      gap: 10px;
      align-items: stretch;
      min-height: 54px;
    }
    .sgs-skill-name {
      background: linear-gradient(180deg, #5e231c, #3f1714);
      color: #fce7b8;
      border-radius: 14px;
      padding: 10px 8px;
      font-size: 17px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      word-break: break-all;
      box-shadow: inset 0 0 0 1px rgba(255, 225, 163, 0.28);
    }
    .sgs-skill-body {
      background: rgba(255, 249, 240, 0.72);
      border: 1px solid rgba(94, 54, 27, 0.18);
      border-radius: 14px;
      padding: 10px 12px;
      min-width: 0;
      overflow: hidden;
    }
    .sgs-skill-line {
      font-size: 14px;
      line-height: 1.44;
      word-break: break-word;
    }
    .sgs-foot {
      margin-top: 14px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: end;
    }
    .sgs-notes {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }
    .sgs-notes span {
      font-size: 12px;
      line-height: 1;
      padding: 6px 8px;
      border-radius: 999px;
      background: rgba(101, 59, 31, 0.08);
      color: #6a3e23;
      border: 1px solid rgba(101, 59, 31, 0.14);
      max-width: 180px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sgs-mark {
      font-size: 13px;
      color: rgba(63, 38, 22, 0.7);
      white-space: nowrap;
      padding-bottom: 2px;
    }
  </style>
</head>
<body>
  <article class="sgs">
    <div class="sgs-header">
      <div class="sgs-header-inner">
        <div class="sgs-badge">${esc(data.faction)}</div>
        <div class="sgs-identity">
          <div class="sgs-title">${esc(clip(data.title, 8))}</div>
          <div class="sgs-name">${esc(clip(data.name, 8))}</div>
        </div>
        <div class="sgs-flavor">${esc(clip(data.flavor, 28))}</div>
        <div class="sgs-stats-row">
          <div class="sgs-hp">${data.hp}/${data.maxHp}</div>
          ${data.armor > 0 ? `<div class="sgs-armor">护甲 ${data.armor}</div>` : ""}
        </div>
      </div>
    </div>
    <div class="sgs-body">
      <div class="sgs-backstory">
        <div class="sgs-backstory-label">角色故事</div>
        ${esc(clip(data.backstory, 150))}
      </div>
      <div class="sgs-skills">${skillBlocks}</div>
      <div class="sgs-foot">
        ${notes}
        <div class="sgs-mark">异界武将设计</div>
      </div>
    </div>
  </article>
</body>
</html>`;
}

export async function renderSgsCardImage(params: {
  outputDir: string;
  data: SgsCardData;
  fileStem: string;
}): Promise<string> {
  fs.mkdirSync(params.outputDir, { recursive: true });
  const artDataUri = "";
  const html = buildCardHtml(params.data, artDataUri);
  const filePath = path.join(params.outputDir, `${params.fileStem}.png`);
  await screenshotHtml(html, filePath, { width: 440, format: "png" });
  return filePath;
}
