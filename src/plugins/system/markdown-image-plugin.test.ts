import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBrowserManager } from "../../browser/browser-manager.js";
import { closeBrowser } from "../mmorpg/screenshot.js";
import type { ResponseTransform } from "../../types.js";
import {
  createMarkdownImagePlugin,
  buildSheetHtml,
  extractResponseTags,
} from "./markdown-image-plugin.js";

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "simplest-bot-markdown-"));

// 纯 HTML 断言（无需浏览器）：$...$ 公式应以原始 LaTeX 原样保留给 KaTeX auto-render，
// 不应被 * / _ 等 Markdown 强调规则误处理，页面应注入本地 KaTeX 资源与渲染脚本。
{
  const sheet = buildSheetHtml("收益是 $+1$ 点，等价于 $1+2$。");
  assert.ok(sheet.html.includes("$+1$"), "$...$ 应原样保留给 KaTeX auto-render");
  assert.ok(sheet.html.includes("$1+2$"), "多段 $...$ 均应原样保留");
  assert.ok(!sheet.html.includes("<em>+1</em>"), "数学表达式的 * + 不应误判为斜体/加粗标记");

  // 本地 KaTeX 资源注入 + auto-render 调用。
  const latexSheet = buildSheetHtml("极限 $x \\rightarrow y$，$\\alpha \\times \\beta$，$\\frac{1}{2}$，$a^{2}$，$\\sqrt{4}$。");
  assert.ok(latexSheet.html.includes("\\rightarrow"), "\\rightarrow 应原样保留给 KaTeX 渲染（由 auto-render 在浏览器端排版）");
  assert.ok(latexSheet.html.includes("katex.min.css"), "应引入本地 KaTeX CSS");
  assert.ok(latexSheet.html.includes("katex.min.js"), "应引入本地 KaTeX JS");
  assert.ok(latexSheet.html.includes("auto-render.min.js"), "应引入本地 KaTeX auto-render");
  assert.ok(latexSheet.html.includes("renderMathInElement"), "应调用 renderMathInElement");
  assert.ok(latexSheet.html.includes("file:///"), "KaTeX 资源通过本地 file:// URL 引用（本地打包，不依赖 CDN）");
  console.log("✅ $...$ 公式原样保留并注入本地 KaTeX（katex.min.css/js + auto-render）以渲染数学公式");
}

// 纯 HTML 断言（无需浏览器）：表格单元格内的 <br>（含 <br/>、<br /> 变体）应转换为
// 真实换行，而不是被 escapeHtml 转成字面 &lt;br&gt; 文本透出。
{
  const tableText = [
    "| 部位 | 功能 |",
    "| --- | --- |",
    "| 口腔<br/>咀嚼 | 研磨饲料<br />混合唾液 |",
    "| 直肠 | 形成&排出粪便 |",
  ].join("\n");
  const sheet = buildSheetHtml(tableText);
  assert.ok(sheet.html.includes("<td>口腔<br>咀嚼</td>"), "单元格内 <br/> 应转换为换行");
  assert.ok(sheet.html.includes("研磨饲料<br>混合唾液"), "<br /> 变体同样应转换");
  assert.ok(!sheet.html.includes("&lt;br"), "原始 <br> 不应以转义文本透出");
  // 单元格其余内容仍正常转义，不受影响。
  assert.ok(sheet.html.includes("形成&amp;排出粪便"), "非 <br> 内容仍走转义渲染");
  console.log("✅ 表格单元格内 <br> 转换为换行，其余内容保持转义渲染");
}

// 纯 HTML 断言（无需浏览器）：gemini-relay 响应中的 FollowUp / ElicitationsGroup
// 追问建议标签应被解析为建议卡片，正文剥离标签，原始标签不应透出到渲染结果。
{
  // 用户提供的第一种形态：孤立 FollowUp 标签。
  const followUpText =
    '以上就是《BanG Dream!》的名场面了。\n<FollowUp label="要不要顺便把《BanG Dream!》里别的名场面梗也复读一下？" query="给我讲讲BanG Dream!圈子里还有哪些经典的梗和名场面！"/>';
  const solo = extractResponseTags(followUpText);
  assert.equal(solo.body, "以上就是《BanG Dream!》的名场面了。", "FollowUp 标签应从正文中剥离");
  assert.equal(solo.sections.length, 1, "孤立 FollowUp 应归入一个默认分组");
  assert.equal(solo.sections[0].chips.length, 1);
  assert.equal(solo.sections[0].chips[0].label, "要不要顺便把《BanG Dream!》里别的名场面梗也复读一下？");
  assert.equal(solo.sections[0].chips[0].query, "给我讲讲BanG Dream!圈子里还有哪些经典的梗和名场面！");

  // 用户提供的第二种形态：ElicitationsGroup 包含多个 Elicitation。
  const groupText =
    '这一章到这里就先告一段落啦。\n<ElicitationsGroup message="想要怎么继续发展这个轻小说故事?"><Elicitation label="写下一章: 社团联合抓捕二宫晃" query="继续写下一章，讲讲二宫晃被两人抓到后被迫加入神秘社团的搞笑剧情。"/> <Elicitation label="添加新角色: 学生会长加入战局" query="给这个轻小说故事引入一个新角色: 拥有绝对权力的学生会长，让局面变得更混乱。"/> </ElicitationsGroup>';
  const grouped = extractResponseTags(groupText);
  assert.equal(grouped.body, "这一章到这里就先告一段落啦。", "ElicitationsGroup 整块应从正文中剥离");
  assert.equal(grouped.sections.length, 1);
  assert.equal(grouped.sections[0].message, "想要怎么继续发展这个轻小说故事?", "分组标题应取 message 属性");
  assert.equal(grouped.sections[0].chips.length, 2, "组内每个 Elicitation 都应解析为一张卡片");
  assert.equal(grouped.sections[0].chips[1].label, "添加新角色: 学生会长加入战局");
  assert.equal(grouped.sections[0].chips[1].query, "给这个轻小说故事引入一个新角色: 拥有绝对权力的学生会长，让局面变得更混乱。");

  // 混合形态：正文中 Markdown 保留，标签解析后以建议卡片渲染，原始标签不透出。
  const mixed = `${followUpText}\n\n${groupText}`;
  const mixedResult = extractResponseTags(mixed);
  assert.equal(mixedResult.sections.length, 2, "孤立 FollowUp 分组 + ElicitationsGroup 分组");
  const sheet = buildSheetHtml(mixedResult.body, mixedResult.sections);
  assert.ok(sheet.html.includes("md-followups"), "应渲染追问建议分组区块");
  assert.ok(sheet.html.includes("md-chip-label"), "应渲染建议卡片标题");
  assert.ok(sheet.html.includes("想要怎么继续发展这个轻小说故事?"), "分组标题应出现在渲染结果中");
  assert.ok(sheet.html.includes("社团联合抓捕二宫晃"), "卡片 label 应出现在渲染结果中");
  assert.ok(!sheet.html.includes("<FollowUp"), "原始 FollowUp 标签不应透出");
  assert.ok(!sheet.html.includes("<Elicitation"), "原始 Elicitation 标签不应透出");

  // 标签属性值中的 HTML 实体应被解码；缺 query 的残缺标签静默忽略。
  const entityText = '<FollowUp label="A &amp; B" query="C &lt;D&gt;"/>正文。';
  const entityResult = extractResponseTags(entityText);
  assert.equal(entityResult.body, "正文。");
  assert.equal(entityResult.sections[0].chips[0].label, "A & B");
  assert.equal(entityResult.sections[0].chips[0].query, "C <D>");
  const malformed = extractResponseTags("正文。<FollowUp label=\"只有标签\"/>");
  assert.equal(malformed.sections.length, 0, "缺 query 的标签不生成卡片");
  assert.equal(malformed.body, "正文。", "残缺标签仍应从正文剥离");

  console.log("✅ FollowUp / ElicitationsGroup 标签解析为建议卡片，正文剥离且原始标签不透出");
}

// 纯 HTML 断言（无需浏览器）：图片代理标签 <Image alt caption src/>（含终端误读的
// <lmage 拼法与 "...caption 无空格相邻形态）应解析为图片卡片，正文剥离，原始标签不透出。
{
  const imageText =
    '猪的消化道可以分为前段和后段两部分。\n<Image alt="猪的消化道解剖示意图，标出了Rectum(直肠)位置"caption="猪的消化道解剖结构示意"\nsrc="imageagenttag_11537307322398200549"/>';
  const result = extractResponseTags(imageText);
  assert.equal(result.body, "猪的消化道可以分为前段和后段两部分。", "Image 标签应从正文中剥离");
  assert.equal(result.sections.length, 0, "Image 标签不产生追问建议分组");
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].alt, "猪的消化道解剖示意图，标出了Rectum(直肠)位置");
  assert.equal(result.images[0].caption, "猪的消化道解剖结构示意", "无空格相邻的 caption 属性应正常解析");
  assert.equal(result.images[0].src, "imageagenttag_11537307322398200549");

  // 终端误读拼法 <lmage>（大写 I 被看成小写 l）同样识别。
  const lmageText = '正文。<lmage alt="示意图" caption="题注" src="imageagenttag_1"/>';
  const lmageResult = extractResponseTags(lmageText);
  assert.equal(lmageResult.body, "正文。", "<lmage 拼法同样应剥离");
  assert.equal(lmageResult.images.length, 1, "<lmage 拼法同样应解析为图片卡片");
  assert.equal(lmageResult.images[0].src, "imageagenttag_1");

  // 渲染：占位卡片 + 题注/描述 + 工件引用；原始标签不透出。
  const sheet = buildSheetHtml(result.body, [], result.images);
  assert.ok(sheet.html.includes("md-image-card"), "应渲染图片卡片区块");
  assert.ok(sheet.html.includes("md-image-placeholder"), "应渲染占位图框");
  assert.ok(sheet.html.includes("猪的消化道解剖结构示意"), "caption 应作为题注出现在渲染结果中");
  assert.ok(sheet.html.includes("Rectum(直肠)"), "alt 应作为描述出现在渲染结果中");
  assert.ok(sheet.html.includes("imageagenttag_11537307322398200549"), "工件引用应出现在渲染结果中");
  assert.ok(!sheet.html.includes("<Image"), "原始 Image 标签不应透出");
  assert.ok(!sheet.html.includes("<lmage"), "原始 lmage 拼法标签不应透出");

  // 混合形态：Image + FollowUp 同现，正文 Markdown 保留。
  const mixedText =
    '看图说话。\n\n<Image alt="a" caption="c" src="imageagenttag_2"/><FollowUp label="l" query="q"/>';
  const mixedResult = extractResponseTags(mixedText);
  assert.equal(mixedResult.body, "看图说话。");
  assert.equal(mixedResult.images.length, 1);
  assert.equal(mixedResult.sections.length, 1);
  const mixedSheet = buildSheetHtml(mixedResult.body, mixedResult.sections, mixedResult.images);
  assert.ok(mixedSheet.html.includes("md-image-card") && mixedSheet.html.includes("md-followups"), "图片卡片与建议卡片同现");

  // 缺 src 的残缺标签静默忽略但仍从正文剥离。
  const malformed = extractResponseTags('正文。<Image alt="只有 alt"/>');
  assert.equal(malformed.images.length, 0, "缺 src 的标签不生成卡片");
  assert.equal(malformed.body, "正文。", "残缺标签仍应从正文剥离");

  console.log("✅ Image（含 lmage 误读拼法）图片代理标签解析为占位卡片，正文剥离且原始标签不透出");
}

initBrowserManager({
  chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});

try {
  const plugin = createMarkdownImagePlugin({
    outputDir,
    format: "webp",
    cleanupDelayMs: 3_600_000,
  });

  const shortText = await plugin.onTransformResponse!("这是一条短消息。");
  assert.equal(shortText, null, "短文本应保持文本发送");

  const markdown = await plugin.onTransformResponse!("# 工作结果\n\n- 项目已构建\n- 测试已通过");
  assert.ok(markdown, "Markdown 应转换为图片");
  const markdownFile = getImagePath(markdown);
  assert.match(markdownFile, /\.webp$/u);
  assert.equal(fs.existsSync(markdownFile), true);
  assert.equal(fs.readFileSync(markdownFile).subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(fs.readFileSync(markdownFile).subarray(8, 12).toString("ascii"), "WEBP");

  const longText = await plugin.onTransformResponse!("长文本。".repeat(300));
  assert.ok(longText, "超过阈值的纯文本也应转换为图片");
  const longFile = getImagePath(longText);
  assert.match(longFile, /\.webp$/u);
  assert.equal(fs.existsSync(longFile), true);

  // 含 FollowUp / ElicitationsGroup 标签的短消息：即使低于长度阈值、非 Markdown，
  // 也应强制走图片渲染（标签以建议卡片形式呈现）。
  const followUpShort = await plugin.onTransformResponse!(
    '简单说了说邦邦的梗。<FollowUp label="还想听吗？" query="再多讲几个梗吧！"/>',
  );
  assert.ok(followUpShort, "含 FollowUp 标签的短消息应强制转换为图片");
  const followUpFile = getImagePath(followUpShort);
  assert.match(followUpFile, /\.webp$/u);
  assert.equal(fs.existsSync(followUpFile), true);

  const elicitationShort = await plugin.onTransformResponse!(
    '故事先写到这里。<ElicitationsGroup message="接下来呢？"><Elicitation label="继续写" query="写下一章。"/><Elicitation label="换个方向" query="换一个主角。"/></ElicitationsGroup>',
  );
  assert.ok(elicitationShort, "含 ElicitationsGroup 标签的短消息应强制转换为图片");
  const elicitationFile = getImagePath(elicitationShort);
  assert.match(elicitationFile, /\.webp$/u);
  assert.equal(fs.existsSync(elicitationFile), true);

  // 含 Image 图片代理标签的短消息：同样强制走图片渲染（标签以占位卡片形式呈现）。
  const imageShort = await plugin.onTransformResponse!(
    '给你画了一张示意图。<Image alt="猪的消化道解剖示意图，标出了Rectum(直肠)位置" caption="猪的消化道解剖结构示意" src="imageagenttag_11537307322398200549"/>',
  );
  assert.ok(imageShort, "含 Image 标签的短消息应强制转换为图片");
  const imageFile = getImagePath(imageShort);
  assert.match(imageFile, /\.webp$/u);
  assert.equal(fs.existsSync(imageFile), true);

  console.log("✅ 短文本保留文本，Markdown 与长文本均生成 WebP，追问/图片标签强制走图片渲染");
} finally {
  await closeBrowser();
  fs.rmSync(outputDir, { recursive: true, force: true });
}

function getImagePath(result: ResponseTransform | null): string {
  const file = result?.segments[0]?.data.file;
  if (typeof file !== "string") throw new Error("响应没有生成图片文件路径");
  return file;
}
