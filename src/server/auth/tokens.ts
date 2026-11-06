import { createHash, randomBytes } from "node:crypto";

/** 256-bit random token, base64url encoded. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
