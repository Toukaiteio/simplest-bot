import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getBrowser } from "../../browser/browser-manager.js";
import type { SgsCardData } from "./schema.js";

const W = 400;
const H = 570;
const SCALE = 3;

const FACTION_THEMES: Record<string, { primary: string; border: string; tagText: string; skillBoxBorder: string }> = {
  "神": { primary: "#dcb35c", border: "#dcb35c", tagText: "#ffd700", skillBoxBorder: "#4a3b2a" },
  "魏": { primary: "#2b4c85", border: "#2b4c85", tagText: "#a4c2f4", skillBoxBorder: "#1f3a60" },
  "蜀": { primary: "#a82e2e", border: "#a82e2e", tagText: "#f4a4f4", skillBoxBorder: "#5e1b1b" },
  "吴": { primary: "#2ea84e", border: "#2ea84e", tagText: "#a4f4bd", skillBoxBorder: "#1e5e30" },
  "群": { primary: "#8c8c8c", border: "#8c8c8c", tagText: "#eeeeee", skillBoxBorder: "#555555" },
  "晋": { primary: "#9d4dbb", border: "#9d4dbb", tagText: "#d8b4e8", skillBoxBorder: "#4a2558" },
};

const BORDER_KEY: Record<string, string> = { "神": "shen", "魏": "wei", "蜀": "shu", "吴": "wu", "群": "qun", "晋": "jin" };

function fileToDataUri(filePath: string, mime: string): string {
  try {
    const buf = fs.readFileSync(filePath);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}

export function buildHtml(basePath: string, cardData: SgsCardData): string {
  const theme = FACTION_THEMES[cardData.faction] || FACTION_THEMES["神"];
  const borderKey = BORDER_KEY[cardData.faction] || "shen";
  const json = JSON.stringify(cardData).replace(/</g, "\\u003c");

  // Avatar / art image as base64 data URI (or empty string)
  const artBase64 = cardData.artImage || "";

  // Embed fonts as data URIs
  const fontDefs = [
    { name: "HuangCao", file: "huangcao.woff2" },
    { name: "XingKai", file: "xingkai.woff2" },
    { name: "XiaoZhuan", file: "xiaozhuan.woff2" },
    { name: "ShouSha", file: "shousha.woff2" },
    { name: "MotoyaMaru", file: "motoyamaru.woff2" },
  ];

  const fontLoaders = fontDefs
    .map((f) => {
      const base64 = (() => {
        try {
          return fs.readFileSync(path.join(basePath, "fonts", f.file)).toString("base64");
        } catch {
          return "";
        }
      })();
      if (!base64) return "";
      return `fontsToLoad.push((async () => { const font = new FontFace('${f.name}', 'url(data:font/woff2;base64,${base64})'); await font.load(); document.fonts.add(font); })());`;
    })
    .filter(Boolean)
    .join("\n");

  // Embed images as data URIs
  const borders = ["shen", "wei", "shu", "wu", "qun", "jin"];
  const imageMap: Record<string, string> = {};

  for (const k of borders) {
    imageMap[`border_${k}`] = fileToDataUri(path.join(basePath, "assets", "border", `${k}.png`), "image/png");
    imageMap[`skill_${k}`] = fileToDataUri(path.join(basePath, "assets", "skill", `${k}.png`), "image/png");
    for (const t of ["", "_empty", "_armor"]) {
      imageMap[`heart_${k}${t}`] = fileToDataUri(path.join(basePath, "assets", "heart", `${k}${t}.png`), "image/png");
    }
  }
  imageMap["bottom"] = fileToDataUri(path.join(basePath, "assets", "bottom", "bottom.png"), "image/png");

  const imageDataJson = JSON.stringify(imageMap);

  // Font family list for later use
  const fontNames = fontDefs.map((f) => `"${f.name}"`).join(", ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; overflow: hidden; }
  canvas { display: block; }
</style>
</head>
<body>
<canvas id="c" width="${W * SCALE}" height="${H * SCALE}"></canvas>
<script>
(async () => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  ctx.scale(${SCALE}, ${SCALE});

  const W = ${W}, H = ${H};
  const data = ${json};
  const theme = ${JSON.stringify(theme)};
  const borderKey = '${borderKey}';
  const imageDataUris = ${imageDataJson};

  const artDataUri = ${JSON.stringify(artBase64)};

  // Load all images (including avatar) before drawing
  const images = {};
  function loadImage(src) {
    return new Promise((resolve) => {
      if (!src) { resolve(null); return; }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  // Load avatar first if present
  const artImg = await loadImage(artDataUri);

  // Load fonts via JS FontFace API (CSS @font-face doesn't work in Canvas)
  const fontsToLoad = [];
  ${fontLoaders}
  await Promise.all(fontsToLoad);
  await new Promise(r => setTimeout(r, 300));

  // Verify font availability
  const fontCheck = {};
  [${fontNames}].forEach(name => { fontCheck[name] = document.fonts.check('12px ' + name); });
  window.__fontCheck = fontCheck;

  await Promise.all(Object.keys(imageDataUris).map(async (key) => {
    images[key] = await loadImage(imageDataUris[key]);
  }));

  function parseRichText(text) {
    const regex = /\\[(\\w+)\\](.*?)\\[\\/\\1\\]/g;
    let lastIndex = 0, match, result = [];
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) result.push({ text: text.substring(lastIndex, match.index), color: '#1a1a1a', bold: false });
      const color = match[1] === 'red' ? '#b00' : '#1a1a1a';
      const bold = match[1] === 'b';
      result.push({ text: match[2], color, bold });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) result.push({ text: text.substring(lastIndex), color: '#1a1a1a', bold: false });
    return result;
  }

  function wrapText(tokens, maxWidth) {
    const lines = [];
    let currentLine = [], currentW = 0;
    tokens.forEach(token => {
      const chars = [...token.text];
      let buf = '', bufW = 0;
      chars.forEach(ch => {
        const cw = ctx.measureText(ch).width;
        if (currentW + bufW + cw > maxWidth) {
          currentLine.push({ text: buf, color: token.color, bold: token.bold });
          lines.push(currentLine);
          currentLine = []; currentW = 0; buf = ch; bufW = cw;
        } else { buf += ch; bufW += cw; }
      });
      if (buf) { currentLine.push({ text: buf, color: token.color, bold: token.bold }); currentW += bufW; }
    });
    if (currentLine.length > 0) lines.push(currentLine);
    return lines;
  }

  function normalizeSkillName(name) {
    const hanChars = [...String(name || '')].filter(ch => /[\\u3400-\\u9fff\\uf900-\\ufaff]/u.test(ch));
    if (hanChars.length >= 2) return hanChars.slice(0, 2).join('');
    if (hanChars.length === 1) return hanChars[0] + '技';
    return '未名';
  }

  function calculateSkillLayout() {
    const skillTagW = 70;
    const skillTagH = 30;
    const textLeftOffset = 17 + skillTagW + 2;
    const boxRightMargin = 0;
    const boxWidth = W - 62 - boxRightMargin;

    const fontSize = 12, lineHeight = 16;
    ctx.font = '500 ' + fontSize + 'px "MotoyaMaru"';

    let totalH = 0;
    const skillBlocks = data.skills.map(skill => {
      let desc = skill.desc;
      if (skill.type && skill.type !== '普通技') desc = '[b]' + skill.type + '[/b]，' + desc;
      const tokens = parseRichText(desc);
      const lines = wrapText(tokens, boxWidth - textLeftOffset + 17 - 8);
      const textHeight = lines.length * lineHeight;
      const blockHeight = Math.max(textHeight, skillTagH) + 4;
      totalH += blockHeight + 8;
      return { skill, lines, height: blockHeight };
    });
    // Reserve space for flavor text + bottom decoration at bottom
    const bottomPad = data.flavor ? 40 : 0;
    const requiredHeight = totalH + bottomPad;
    return { boxWidth, totalHeight: requiredHeight, skillBlocks, fontSize, lineHeight, textLeftOffset, skillTagW, skillTagH, bottomPad };
  }

  function fitIdentityLayout(skillBoxY) {
    const titleChars = [...String(data.title || '')];
    const nameChars = [...String(data.name || '')];
    const titleLen = Math.max(1, titleChars.length);
    const nameLen = Math.max(1, nameChars.length);
    const topY = 120;
    const bottomY = Math.max(topY + 120, skillBoxY - 14);
    const available = Math.max(120, bottomY - topY);

    let titleFont = 24;
    let titleStep = 26;
    let nameFont = 42;
    let nameStep = 46;
    let gap = 30;

    function totalHeight() {
      return titleLen * titleStep + gap + nameLen * nameStep;
    }

    const naturalHeight = totalHeight();
    if (naturalHeight > available) {
      const ratio = Math.max(0.58, Math.min(1, available / naturalHeight));
      titleFont = Math.max(15, Math.floor(titleFont * ratio));
      titleStep = Math.max(titleFont + 2, Math.floor(titleStep * ratio));
      nameFont = Math.max(24, Math.floor(nameFont * ratio));
      nameStep = Math.max(nameFont + 2, Math.floor(nameStep * ratio));
      gap = Math.max(8, Math.floor(gap * ratio));
    }

    while (totalHeight() > available && (nameStep > 18 || titleStep > 13 || gap > 6)) {
      if (nameStep > 18) {
        nameStep -= 1;
        if (nameFont > Math.max(16, nameStep - 2)) nameFont -= 1;
      }
      if (totalHeight() <= available) break;
      if (titleStep > 13) {
        titleStep -= 1;
        if (titleFont > Math.max(12, titleStep - 2)) titleFont -= 1;
      }
      if (totalHeight() <= available) break;
      if (gap > 6) gap -= 1;
    }

    const used = totalHeight();
    const titleTopY = topY + Math.max(0, Math.min(22, Math.floor((available - used) * 0.18)));
    const nameTopY = titleTopY + titleLen * titleStep + gap;

    return { titleChars, nameChars, titleTopY, nameTopY, titleFont, titleStep, nameFont, nameStep };
  }

  // --- Draw ---
  ctx.clearRect(0, 0, W, H);
  ctx.save();

  // Background: avatar image (cover-fit) or fallback gradient
  if (artImg) {
    const imgRatio = artImg.width / artImg.height;
    const cardRatio = W / H;
    let dw, dh, dx, dy;
    if (imgRatio > cardRatio) { dh = H; dw = H * imgRatio; dx = (W - dw) / 2; dy = 0; }
    else { dw = W; dh = W / imgRatio; dx = 0; dy = (H - dh) / 2; }
    ctx.drawImage(artImg, dx, dy, dw, dh);
  } else {
    const grad = ctx.createRadialGradient(W/2, H*0.4, 50, W/2, H/2, 400);
    grad.addColorStop(0, '#552222');
    grad.addColorStop(1, '#110505');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // Border frame
  const borderImg = images['border_'+borderKey];
  if (borderImg) ctx.drawImage(borderImg, 0, 0, W, H);

  // Faction
  ctx.save();
  ctx.shadowBlur = 4;
  ctx.shadowColor = 'black';
  ctx.fillStyle = 'white';
  ctx.font = '80px "HuangCao"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(45, 60);
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'black';
  ctx.lineJoin = 'round';
  ctx.strokeText(data.faction, 0, 0);
  ctx.fillText(data.faction, 0, 0);
  ctx.restore();

  // HP
  const startX = 80, startY = 25, hpSize = 30;
  ctx.save();
  for (let i = 0; i < data.maxHp; i++) {
    const x = startX + i * (hpSize * 0.65);
    const key = 'heart_' + borderKey + (i >= data.hp ? '_empty' : '');
    const img = images[key];
    if (img) ctx.drawImage(img, x, startY, hpSize, hpSize);
  }
  for (let i = 0; i < data.armor; i++) {
    const x = startX + (data.maxHp + i) * (hpSize * 0.65);
    const img = images['heart_' + borderKey + '_armor'];
    if (img) ctx.drawImage(img, x, startY, hpSize, hpSize);
  }
  ctx.restore();

  const layout = calculateSkillLayout();
  const boxH = layout.totalHeight;
  const boxY = H - boxH;
  const boxX = 62;

  // Title + Name (vertical, left side)
  const textX = 45;
  const identityLayout = fitIdentityLayout(boxY);
  ctx.save();
  ctx.fillStyle = theme.primary;
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.font = identityLayout.titleFont + 'px "XiaoZhuan"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < identityLayout.titleChars.length; i++) {
    const y = identityLayout.titleTopY + i * identityLayout.titleStep;
    ctx.strokeText(identityLayout.titleChars[i], textX, y);
    ctx.fillText(identityLayout.titleChars[i], textX, y);
  }

  ctx.font = identityLayout.nameFont + 'px "XingKai"';
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 3;
  ctx.shadowColor = 'black';
  ctx.shadowBlur = 4;
  ctx.fillStyle = 'white';
  for (let i = 0; i < identityLayout.nameChars.length; i++) {
    const y = identityLayout.nameTopY + i * identityLayout.nameStep;
    ctx.strokeText(identityLayout.nameChars[i], textX, y);
    ctx.fillText(identityLayout.nameChars[i], textX, y);
  }
  ctx.restore();

  // Skill section box
  ctx.save();
  ctx.fillStyle = 'rgba(235, 235, 235, 0.75)';
  ctx.fillRect(boxX, boxY, layout.boxWidth, boxH);
  ctx.restore();

  let currY = boxY + 15;
  layout.skillBlocks.forEach(block => {
    const tagImg = images['skill_'+borderKey];
    ctx.save();
    if (tagImg) ctx.drawImage(tagImg, 17, currY, layout.skillTagW, layout.skillTagH);
    ctx.font = '600 18px "ShouSha"';
    ctx.fillStyle = 'black';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.scale(1.15, 1);
    ctx.letterSpacing = '1.5px';
    ctx.fillText(normalizeSkillName(block.skill.name), (17 + layout.skillTagW * 0.44) / 1.15, currY + layout.skillTagH / 2);
    ctx.restore();
    ctx.restore();

    const textX2 = layout.textLeftOffset;
    const firstLineY = currY + layout.skillTagH / 2;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    block.lines.forEach((line, li) => {
      const y = firstLineY + li * layout.lineHeight;
      let cursor = textX2;
      line.forEach(chunk => {
        ctx.font = chunk.bold ? '600 ' + layout.fontSize + 'px "MotoyaMaru"' : '500 ' + layout.fontSize + 'px "MotoyaMaru"';
        ctx.fillStyle = chunk.color;
        ctx.fillText(chunk.text, cursor, y);
        cursor += ctx.measureText(chunk.text).width;
      });
    });
    ctx.restore();

    currY += block.height + 8;
  });

  // Flavor text + bottom decoration (in reserved area below skills)
  // Order: flavor text ABOVE, decoration BELOW
  const flavorAreaY = boxY + boxH - layout.bottomPad;
  const bh = 14;
  if (data.flavor) {
    ctx.save();
    ctx.font = 'italic 8px sans-serif';
    ctx.fillStyle = '#444';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(data.flavor, boxX + layout.boxWidth - 10, flavorAreaY + layout.bottomPad - bh - 6);
    ctx.restore();
  }
  if (images.bottom) {
    const bw = images.bottom.width * (bh / images.bottom.height);
    ctx.drawImage(images.bottom, boxX + (layout.boxWidth - bw) / 2, flavorAreaY + layout.bottomPad - bh, bw, bh);
  }

  ctx.restore();
  window.__cardDrawn = true;
})();
</script>
</body>
</html>`;
}

export function buildStoryHtml(basePath: string, cardData: SgsCardData): string {
  const theme = FACTION_THEMES[cardData.faction] || FACTION_THEMES["神"];
  const borderKey = BORDER_KEY[cardData.faction] || "shen";
  const json = JSON.stringify(cardData).replace(/</g, "\\u003c");
  const artBase64 = cardData.artImage || "";

  const fontDefs = [
    { name: "HuangCao", file: "huangcao.woff2" },
    { name: "XingKai", file: "xingkai.woff2" },
    { name: "XiaoZhuan", file: "xiaozhuan.woff2" },
    { name: "ShouSha", file: "shousha.woff2" },
    { name: "MotoyaMaru", file: "motoyamaru.woff2" },
  ];

  const fontLoaders = fontDefs
    .map((f) => {
      const base64 = (() => {
        try {
          return fs.readFileSync(path.join(basePath, "fonts", f.file)).toString("base64");
        } catch {
          return "";
        }
      })();
      if (!base64) return "";
      return `fontsToLoad.push((async () => { const font = new FontFace('${f.name}', 'url(data:font/woff2;base64,${base64})'); await font.load(); document.fonts.add(font); })());`;
    })
    .filter(Boolean)
    .join("\n");

  const borders = ["shen", "wei", "shu", "wu", "qun", "jin"];
  const imageMap: Record<string, string> = {};
  for (const k of borders) {
    imageMap[`border_${k}`] = fileToDataUri(path.join(basePath, "assets", "border", `${k}.png`), "image/png");
    imageMap[`skill_${k}`] = fileToDataUri(path.join(basePath, "assets", "skill", `${k}.png`), "image/png");
  }
  imageMap["bottom"] = fileToDataUri(path.join(basePath, "assets", "bottom", "bottom.png"), "image/png");

  const imageDataJson = JSON.stringify(imageMap);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; overflow: hidden; }
  canvas { display: block; }
</style>
</head>
<body>
<canvas id="c" width="${W * SCALE}" height="${H * SCALE}"></canvas>
<script>
(async () => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  ctx.scale(${SCALE}, ${SCALE});

  const W = ${W}, H = ${H};
  const data = ${json};
  const theme = ${JSON.stringify(theme)};
  const borderKey = '${borderKey}';
  const imageDataUris = ${imageDataJson};
  const artDataUri = ${JSON.stringify(artBase64)};
  const images = {};

  function loadImage(src) {
    return new Promise((resolve) => {
      if (!src) { resolve(null); return; }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  const fontsToLoad = [];
  ${fontLoaders}
  await Promise.all(fontsToLoad);
  await new Promise(r => setTimeout(r, 300));
  const artImg = await loadImage(artDataUri);
  await Promise.all(Object.keys(imageDataUris).map(async (key) => {
    images[key] = await loadImage(imageDataUris[key]);
  }));

  function wrapPlainText(text, maxWidth, font) {
    ctx.font = font;
    const lines = [];
    let line = '';
    for (const ch of [...String(text || '')]) {
      if (ch === '\\n') {
        if (line) lines.push(line);
        line = '';
        continue;
      }
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function normalizeSkillName(name) {
    const hanChars = [...String(name || '')].filter(ch => /[\\u3400-\\u9fff\\uf900-\\ufaff]/u.test(ch));
    if (hanChars.length >= 2) return hanChars.slice(0, 2).join('');
    if (hanChars.length === 1) return hanChars[0] + '技';
    return '未名';
  }

  function drawStoryTag(text, x, y, width, height) {
    const tagImg = images['skill_' + borderKey];
    ctx.save();
    if (tagImg) ctx.drawImage(tagImg, x, y, width, height);
    ctx.font = '600 18px "ShouSha"';
    ctx.fillStyle = 'black';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.scale(1.15, 1);
    ctx.letterSpacing = '1.5px';
    ctx.fillText(text, (x + width * 0.44) / 1.15, y + height / 2);
    ctx.restore();
    ctx.restore();
  }

  ctx.clearRect(0, 0, W, H);

  if (artImg) {
    const imgRatio = artImg.width / artImg.height;
    const cardRatio = W / H;
    let dw, dh, dx, dy;
    if (imgRatio > cardRatio) { dh = H; dw = H * imgRatio; dx = (W - dw) / 2; dy = 0; }
    else { dw = W; dh = W / imgRatio; dx = 0; dy = (H - dh) / 2; }
    ctx.drawImage(artImg, dx, dy, dw, dh);
  } else {
    const bg = ctx.createRadialGradient(W/2, H*0.4, 50, W/2, H/2, 400);
    bg.addColorStop(0, '#552222');
    bg.addColorStop(1, '#110505');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = '#000';
  for (let i = 0; i < 9; i++) {
    ctx.fillRect(72 + i * 34, 76, 1, 414);
  }
  for (let i = 0; i < 13; i++) {
    ctx.fillRect(64, 90 + i * 30, 314, 1);
  }
  ctx.restore();

  const borderImg = images['border_' + borderKey];
  if (borderImg) ctx.drawImage(borderImg, 0, 0, W, H);

  ctx.save();
  ctx.shadowBlur = 4;
  ctx.shadowColor = 'black';
  ctx.fillStyle = 'white';
  ctx.font = '80px "HuangCao"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(45, 60);
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'black';
  ctx.lineJoin = 'round';
  ctx.strokeText(data.faction, 0, 0);
  ctx.fillText(data.faction, 0, 0);
  ctx.restore();

  const boxX = 62;
  const boxY = 118;
  const boxW = W - boxX;
  const boxH = H - boxY;
  ctx.save();
  ctx.fillStyle = 'rgba(235, 235, 235, 0.75)';
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.restore();

  drawStoryTag('列传', 17, boxY + 22, 70, 30);
  const storyFont = '500 14px "MotoyaMaru"';
  const storyLines = wrapPlainText(data.backstory || '暂无武将故事。', boxW - 112, storyFont).slice(0, 10);
  ctx.save();
  ctx.font = storyFont;
  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let y = boxY + 22;
  for (const line of storyLines) {
    ctx.fillText(line, 92, y);
    y += 22;
  }
  ctx.restore();

  const skillNames = (data.skills || []).map(s => normalizeSkillName(s.name)).join('、') || '无';
  const noteText = '技略：' + skillNames + '。' + (data.designNotes && data.designNotes.length ? '设计抓手：' + data.designNotes.join('；') : '');
  const noteLines = wrapPlainText(noteText, boxW - 112, '500 12px "MotoyaMaru"').slice(0, 4);
  const strategyY = Math.max(boxY + 270, y + 20);
  drawStoryTag('计略', 17, strategyY, 70, 30);
  ctx.save();
  ctx.font = '500 12px "MotoyaMaru"';
  ctx.fillStyle = '#333';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  y = strategyY + 2;
  for (const line of noteLines) {
    ctx.fillText(line, 92, y);
    y += 18;
  }
  ctx.restore();

  if (data.flavor) {
    ctx.save();
    ctx.font = 'italic 9px sans-serif';
    ctx.fillStyle = '#444';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(data.flavor, boxX + boxW - 12, H - 28);
    ctx.restore();
  }
  if (images.bottom) {
    const bh = 14;
    const bw = images.bottom.width * (bh / images.bottom.height);
    ctx.drawImage(images.bottom, boxX + (boxW - bw) / 2, H - 20, bw, bh);
  }

  window.__cardDrawn = true;
})();
</script>
</body>
</html>`;
}

export async function renderSgsCardImage(params: {
  outputDir: string;
  data: SgsCardData;
  fileStem: string;
  assetBasePath?: string;
}): Promise<string> {
  fs.mkdirSync(params.outputDir, { recursive: true });

  const basePath = params.assetBasePath ?? path.resolve(import.meta.dirname ?? process.cwd(), "static");
  const html = buildHtml(basePath, params.data);

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: W + 40, height: H + 40, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load", timeout: 30000 });

    await page.waitForFunction("window.__cardDrawn === true", { timeout: 30000 });

    const dataUrl = await page.evaluate(() => {
      const canvas = document.getElementById("c") as HTMLCanvasElement;
      return canvas.toDataURL("image/png");
    });

    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    const filePath = path.join(params.outputDir, `${params.fileStem}.png`);
    fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    return filePath;
  } finally {
    await page.close();
  }
}

export async function renderSgsStoryImage(params: {
  outputDir: string;
  data: SgsCardData;
  fileStem: string;
  assetBasePath?: string;
}): Promise<string> {
  fs.mkdirSync(params.outputDir, { recursive: true });

  const basePath = params.assetBasePath ?? path.resolve(import.meta.dirname ?? process.cwd(), "static");
  const html = buildStoryHtml(basePath, params.data);

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: W + 40, height: H + 40, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction("window.__cardDrawn === true", { timeout: 30000 });

    const dataUrl = await page.evaluate(() => {
      const canvas = document.getElementById("c") as HTMLCanvasElement;
      return canvas.toDataURL("image/png");
    });

    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    const filePath = path.join(params.outputDir, `${params.fileStem}.png`);
    fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    return filePath;
  } finally {
    await page.close();
  }
}
