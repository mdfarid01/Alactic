import { estimateTokens, sha256 } from "./normalize";

export type Chunk = {
  index: number;
  content: string;
  headingPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  tokenCount: number;
  contentSha256: string;
};

export type ChunkOptions = {
  /** Target chunk size in characters (~600 tokens). */
  targetChars?: number;
  /** Hard maximum chunk size in characters. */
  maxChars?: number;
  /** Characters of trailing context carried into the next chunk within a section. */
  overlapChars?: number;
};

type Block = { text: string; headingPath: string | null; page: number | null };

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Split markdown-ish text into blocks (paragraphs) annotated with their heading path, e.g. "Pricing › Refunds".
 * Headings stay attached to their section's first chunk so the chunk is self-describing.
 */
function toBlocks(text: string, page: number | null, stack: string[]): Block[] {
  const blocks: Block[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const lines = para.split("\n");
    let buffer: string[] = [];
    const flush = () => {
      const t = buffer.join("\n").trim();
      if (t) blocks.push({ text: t, headingPath: stack.length ? stack.join(" › ") : null, page });
      buffer = [];
    };
    for (const line of lines) {
      const m = HEADING.exec(line);
      if (m) {
        flush();
        const level = m[1].length;
        stack.splice(level - 1);
        stack[level - 1] = m[2].trim().slice(0, 120);
        // Remove holes left by skipped heading levels.
        for (let i = 0; i < stack.length; i++) if (stack[i] === undefined) stack.splice(i--, 1);
        buffer.push(line.trim());
      } else {
        buffer.push(line);
      }
    }
    flush();
  }
  return blocks;
}

/** Split an over-long block by sentences, then hard-wrap as a last resort. */
function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?。！？\n]+(?:[.!?。！？]+|\n|$)/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (cur) out.push(cur.trim());
      cur = "";
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars).trim());
      continue;
    }
    if ((cur + s).length > maxChars) {
      out.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/**
 * Chunk a document. `pages` (PDF) lets chunks cite page ranges; otherwise pass the whole text as one page with null.
 */
export function chunkDocument(
  pages: Array<{ text: string; page: number | null }>,
  options: ChunkOptions = {},
): Chunk[] {
  const targetChars = options.targetChars ?? 2400;
  const maxChars = options.maxChars ?? 3200;
  const overlapChars = options.overlapChars ?? 360;

  const stack: string[] = [];
  const blocks = pages.flatMap((p) => toBlocks(p.text, p.page, stack));
  const pieces: Block[] = blocks.flatMap((b) => splitLong(b.text, maxChars).map((text) => ({ ...b, text })));

  const chunks: Chunk[] = [];
  let cur: Block[] = [];
  let curLen = 0;

  const emit = () => {
    if (!cur.length) return;
    const content = cur.map((b) => b.text).join("\n\n").trim();
    const pagesInChunk = cur.map((b) => b.page).filter((p): p is number => p !== null);
    chunks.push({
      index: chunks.length,
      content,
      headingPath: cur.find((b) => b.headingPath)?.headingPath ?? null,
      pageFrom: pagesInChunk.length ? Math.min(...pagesInChunk) : null,
      pageTo: pagesInChunk.length ? Math.max(...pagesInChunk) : null,
      tokenCount: estimateTokens(content),
      contentSha256: sha256(content),
    });
  };

  for (const piece of pieces) {
    const sectionChanged = cur.length > 0 && piece.headingPath !== cur[cur.length - 1].headingPath;
    if (cur.length && (curLen + piece.text.length > targetChars || sectionChanged)) {
      emit();
      // Overlap: carry the tail of the previous chunk only within the same section.
      const last = cur[cur.length - 1];
      cur = [];
      curLen = 0;
      if (!sectionChanged && overlapChars > 0 && last.text.length <= overlapChars * 2) {
        const tail = last.text.slice(-overlapChars);
        cur.push({ ...last, text: tail });
        curLen = tail.length;
      }
    }
    cur.push(piece);
    curLen += piece.text.length + 2;
  }
  emit();
  return chunks;
}
