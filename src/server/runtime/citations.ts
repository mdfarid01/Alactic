import type { Citation } from "@/server/db/schema";
import type { RetrievedPassage } from "@/server/knowledge/retrieval";

/**
 * Keep only [n] markers that refer to a passage we actually provided; strip the rest so the UI never shows a
 * citation without a source behind it.
 */
export function extractCitations(text: string, passages: RetrievedPassage[]): { text: string; citations: Citation[] } {
  const used = new Map<number, Citation>();
  const cleaned = text.replace(/\[(\d{1,2})\]/g, (match, num: string) => {
    const n = Number(num);
    const p = passages[n - 1];
    if (!p) return "";
    if (!used.has(n)) {
      used.set(n, {
        n,
        chunkId: p.chunkId,
        documentId: p.documentId,
        title: p.documentTitle,
        url: p.url,
        headingPath: p.headingPath,
        pageFrom: p.pageFrom,
        pageTo: p.pageTo,
        sourceType: p.sourceType,
      });
    }
    return match;
  });
  return {
    text: cleaned.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim(),
    citations: [...used.values()].sort((a, b) => a.n - b.n),
  };
}

/** The model was told to reply with exactly the fallback text when unsure. */
export function isFallbackAnswer(text: string, fallback: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").replace(/^["'“”]+|["'“”]+$/g, "").trim().toLowerCase();
  return norm(text) === norm(fallback);
}
