import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for connector credentials. Format: "v1:" + base64(iv[12] | tag[16] | ciphertext).
 * The key comes from CONNECTOR_ENCRYPTION_KEY (32 bytes, base64). The connection id is bound as associated data,
 * so a ciphertext copied onto another row fails to decrypt.
 */
export function parseKey(base64: string | undefined): Buffer {
  const key = base64 ? Buffer.from(base64, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new Error("CONNECTOR_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function encryptJson(key: Buffer, value: unknown, associatedData: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function decryptJson<T>(key: Buffer, payload: string, associatedData: string): T {
  if (!payload.startsWith("v1:")) throw new Error("Unknown credential format");
  const raw = Buffer.from(payload.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as T;
}
