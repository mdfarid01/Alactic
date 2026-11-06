import { createHash } from "node:crypto";

/** Rough token estimate (~4 characters per token for English-like text). Used for sizing, not billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Normalize extracted text: Unicode NFC, strip control characters (keep \n and \t), collapse runs of spaces,
 * trim line ends, and collapse 3+ blank lines. Markdown structure (headings, lists) is preserved.
 */
export function normalizeText(input: string): string {
  return input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Clean crawled markdown: drop images, keep link text but not URLs, and remove lines that are pure navigation noise.
 * Link URLs are dropped because they inflate chunks and could carry tracking parameters.
 */
export function cleanMarkdown(md: string): string {
  return normalizeText(
    md
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\((?:[^)(]|\([^)]*\))*\)/g, "$1")
      .replace(/^\s*(?:[-*]\s*)?(?:skip to (?:main )?content|cookie settings|accept all cookies)\s*$/gim, ""),
  );
}
