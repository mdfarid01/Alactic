/**
 * Answer fingerprints: SHA-256 over a domain-separated string binding the exact displayed answer to its inference.
 * Works in the browser (Web Crypto) and on the server (Node ≥ 20 has globalThis.crypto.subtle), so customers can
 * check an answer against its public receipt locally. The id prefix stops one receipt's hash matching another answer.
 */
export function fingerprintInput(inferenceId: string, answer: string) {
  return `alactic-answer-v1:${inferenceId}:${answer.normalize("NFC")}`;
}

export async function answerFingerprint(inferenceId: string, answer: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintInput(inferenceId, answer)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Answer text carried in the proof link's URL fragment (never sent to any server). base64url of UTF-8. */
export function encodeAnswerFragment(answer: string): string {
  const bytes = new TextEncoder().encode(answer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeAnswerFragment(fragment: string): string | null {
  try {
    const bin = atob(fragment.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}
