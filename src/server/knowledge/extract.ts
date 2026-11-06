import { normalizeText } from "./normalize";

export const UPLOAD_LIMITS = {
  /** Vercel serverless request bodies are capped at ~4.5 MB; direct-to-storage uploads would lift this later. */
  maxBytes: 4 * 1024 * 1024,
  maxPdfPages: 300,
  /** Max normalized characters kept per document. */
  maxChars: 400_000,
  /** DOCX decompression-bomb guard (sum of uncompressed sizes in the ZIP directory). */
  maxDocxUncompressedBytes: 50 * 1024 * 1024,
} as const;

export type ExtractedFile = {
  kind: "pdf" | "docx" | "text";
  /** Normalized full text. */
  text: string;
  /** For PDFs: per-page normalized text (1-based page = index + 1). */
  pages: string[] | null;
  truncated: boolean;
};

export class ExtractionError extends Error {
  constructor(public readonly code: "unsupported_type" | "too_large" | "empty" | "unreadable" | "too_many_pages", message: string) {
    super(message);
  }
}

const EXT_KIND: Record<string, ExtractedFile["kind"]> = {
  pdf: "pdf",
  docx: "docx",
  txt: "text",
  md: "text",
  markdown: "text",
};

/** Decide the file kind from extension AND content signature; both must agree. */
export function detectKind(fileName: string, bytes: Uint8Array): ExtractedFile["kind"] {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  const kind = EXT_KIND[ext];
  if (!kind) throw new ExtractionError("unsupported_type", "Supported files: PDF, DOCX, TXT and Markdown.");
  const startsWith = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (kind === "pdf" && !startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) {
    throw new ExtractionError("unsupported_type", "This file doesn't look like a valid PDF.");
  }
  if (kind === "docx" && !startsWith([0x50, 0x4b, 0x03, 0x04])) {
    throw new ExtractionError("unsupported_type", "This file doesn't look like a valid DOCX document.");
  }
  if (kind === "text" && bytes.includes(0)) {
    throw new ExtractionError("unsupported_type", "This file doesn't look like plain text.");
  }
  return kind;
}

/**
 * Sum the uncompressed sizes declared in a ZIP central directory (used to refuse DOCX decompression bombs before
 * handing the file to the parser). Returns null if the directory can't be read.
 */
export function zipDeclaredUncompressedSize(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory record: signature 0x06054b50, search backwards (max comment 65535).
  const minEocd = Math.max(0, bytes.length - 22 - 65535);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const uncompressed = view.getUint32(offset + 24, true);
    if (uncompressed === 0xffffffff) return Number.POSITIVE_INFINITY; // ZIP64: refuse
    total += uncompressed;
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return total;
}

function cap(text: string): { text: string; truncated: boolean } {
  return text.length > UPLOAD_LIMITS.maxChars
    ? { text: text.slice(0, UPLOAD_LIMITS.maxChars), truncated: true }
    : { text, truncated: false };
}

export async function extractFile(fileName: string, bytes: Uint8Array): Promise<ExtractedFile> {
  if (bytes.byteLength > UPLOAD_LIMITS.maxBytes) {
    throw new ExtractionError("too_large", "Files can be up to 4 MB.");
  }
  if (bytes.byteLength === 0) throw new ExtractionError("empty", "The file is empty.");
  const kind = detectKind(fileName, bytes);

  if (kind === "text") {
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ExtractionError("unreadable", "Text files must be UTF-8 encoded.");
    }
    const { text, truncated } = cap(normalizeText(decoded));
    if (!text) throw new ExtractionError("empty", "The file has no text.");
    return { kind, text, pages: null, truncated };
  }

  if (kind === "docx") {
    const declared = zipDeclaredUncompressedSize(bytes);
    if (declared === null) throw new ExtractionError("unreadable", "This DOCX file couldn't be read.");
    if (declared > UPLOAD_LIMITS.maxDocxUncompressedBytes) {
      throw new ExtractionError("too_large", "This DOCX file expands to more than 50 MB and can't be processed.");
    }
    const mammoth = await import("mammoth");
    let raw: string;
    try {
      raw = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
    } catch {
      throw new ExtractionError("unreadable", "This DOCX file couldn't be read.");
    }
    const { text, truncated } = cap(normalizeText(raw));
    if (!text) throw new ExtractionError("empty", "No text was found in this document.");
    return { kind, text, pages: null, truncated };
  }

  // PDF
  const { extractText, getDocumentProxy } = await import("unpdf");
  let pageTexts: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > UPLOAD_LIMITS.maxPdfPages) {
      throw new ExtractionError("too_many_pages", `PDFs can have up to ${UPLOAD_LIMITS.maxPdfPages} pages.`);
    }
    pageTexts = (await extractText(pdf, { mergePages: false })).text;
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError("unreadable", "This PDF couldn't be read. It may be encrypted or damaged.");
  }
  const pages = pageTexts.map((p) => normalizeText(p));
  const joined = pages.join("\n\n");
  if (!joined.trim()) {
    throw new ExtractionError("empty", "No extractable text in this PDF (scanned PDFs need OCR, which isn't supported yet).");
  }
  const { text, truncated } = cap(joined);
  return { kind, text, pages, truncated };
}
