import crypto from "node:crypto";

const EAPI_KEY = Buffer.from("e82ckenh8dichen8", "utf-8");
const EAPI_IV = Buffer.alloc(0);

function pkcs7Pad(data: Buffer): Buffer {
  const pad = 16 - (data.length % 16);
  const buf = Buffer.alloc(data.length + pad);
  data.copy(buf);
  for (let i = 0; i < pad; i++) buf[data.length + i] = pad;
  return buf;
}

export function eapiEncrypt(urlPath: string, data: Record<string, unknown>): string {
  // Replace /eapi/ with /api/ for signature calculation ONLY (the HTTP request still uses /eapi/)
  const sigPath = urlPath.replace("/eapi/", "/api/");
  const jsonStr = JSON.stringify(data);
  const message = "nobody" + sigPath + "use" + jsonStr + "md5forencrypt";
  const digest = crypto.createHash("md5").update(message, "utf-8").digest("hex");
  const text = sigPath + "-36cd479b6b5-" + jsonStr + "-36cd479b6b5-" + digest;
  const cipher = crypto.createCipheriv("aes-128-ecb", EAPI_KEY, EAPI_IV);
  cipher.setAutoPadding(false);
  const padded = pkcs7Pad(Buffer.from(text, "utf-8"));
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString("hex").toUpperCase();
}

export function eapiDecrypt(encryptedHex: string): string {
  const decipher = crypto.createDecipheriv("aes-128-ecb", EAPI_KEY, EAPI_IV);
  decipher.setAutoPadding(false);
  const encrypted = Buffer.from(encryptedHex, "hex");
  let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  // Remove PKCS7 padding
  const padLen = decrypted[decrypted.length - 1];
  if (padLen > 0 && padLen <= 16) {
    decrypted = decrypted.subarray(0, decrypted.length - padLen);
  }
  return decrypted.toString("utf-8");
}