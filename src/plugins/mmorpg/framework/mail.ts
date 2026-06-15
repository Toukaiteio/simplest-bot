import { DEFAULT_MMORPG_CONTENT } from "../default-content.js";
import type { MailState } from "../schema.js";

function describeAttachmentItem(itemId: string): string {
  const item = DEFAULT_MMORPG_CONTENT.items[itemId];
  return item ? item.name : itemId;
}

export function formatMailList(mails: MailState[]): string {
  if (mails.length === 0) return "收件箱为空。";
  const lines = mails.map((mail) => {
    const status = mail.claimedAt ? "[已读]" : "[未读]";
    const attachments = mail.attachments.length > 0 ? ` 📎x${mail.attachments.length}` : "";
    return `${status} [${mail.id}] ${mail.title}（来自 ${mail.fromUserId}）${attachments}`;
  });
  lines.push("", "使用 $mmo-mail-claim <邮件ID> 领取/标记已读。");
  return lines.join("\n");
}

export function formatMailDetail(mail: MailState): string {
  const status = mail.claimedAt ? "已读" : "未读";
  const attachmentText =
    mail.attachments.length > 0
      ? `附件：${mail.attachments.map((a) => `${describeAttachmentItem(a.itemId)} x${a.quantity}`).join("、")}`
      : "附件：无";
  return [
    `主题：${mail.title}`,
    `发件人：${mail.fromUserId}`,
    `状态：${status}`,
    `时间：${mail.createdAt}`,
    `正文：${mail.body || "（空）"}`,
    attachmentText,
  ].join("\n");
}

export function formatMailSent(mail: MailState): string {
  const attachmentText =
    mail.attachments.length > 0
      ? `\n附件：${mail.attachments.map((a) => `${describeAttachmentItem(a.itemId)} x${a.quantity}`).join("、")}`
      : "";
  return `✉️ 邮件已发送给 ${mail.toUserId}：${mail.title}${attachmentText}`;
}
