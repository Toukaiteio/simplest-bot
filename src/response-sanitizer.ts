const ROUTING_PREFIX = /^(?:\[(?:REPLY:\d+|AT:[^\]\r\n]+)\]\s*)+/i;

/**
 * 清理模型偶发输出的角色标签和开头空白，同时保留 [REPLY]/[AT] 路由标记。
 * 这里是纯函数，LLM 入库前和实际发送前都会调用，形成双层防线。
 */
export function sanitizeAssistantOutput(raw: string): string {
  let text = raw.replace(/^\uFEFF/, "").trimStart();
  const routing = text.match(ROUTING_PREFIX)?.[0].trim() ?? "";
  if (routing) text = text.slice(text.match(ROUTING_PREFIX)![0].length).trimStart();

  // 某些兼容端会重复附加标签，因此循环移除。
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text.replace(/^(?:\[ASSISTANT\]|ASSISTANT\])(?:[\s：:]*)/i, "").trimStart();
  }

  return routing ? `${routing}${text}` : text;
}
