export function mediaPlaceholder(type: string, id: string | undefined): string {
  const safeId = id ? encodeMediaId(id) : undefined;
  return safeId ? `[${type} file=${safeId}]` : `[${type}]`;
}

export function encodeMediaId(id: string): string {
  // 保留基本可读性，避免分隔符和空白造成占位符解析歧义
  return id
    .replace(/\\/g, "\\\\")
    .replace(/\]/g, "\\]")
    .replace(/\s+/g, "_");
}

export function decodeMediaId(encoded: string): string {
  return encoded
    .replace(/\\\]/g, "]")
    .replace(/\\\\/g, "\\")
    .replace(/_/g, " ");
}

const mediaPlaceholderRegex = /\[([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+file=([^\]]+)\]/g;

export function findMediaPlaceholders(text: string): Array<{ type: string; fileId: string }> {
  const results: Array<{ type: string; fileId: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = mediaPlaceholderRegex.exec(text)) !== null) {
    results.push({ type: match[1], fileId: decodeMediaId(match[2]) });
  }
  return results;
}
