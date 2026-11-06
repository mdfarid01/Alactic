import { describe, expect, it } from "vitest";
import { chunkDocument } from "@/server/knowledge/chunker";
import { detectKind, extractFile, ExtractionError, zipDeclaredUncompressedSize } from "@/server/knowledge/extract";
import { cleanMarkdown, normalizeText } from "@/server/knowledge/normalize";
import { validateCrawlUrl } from "@/server/knowledge/url-policy";

describe("normalization", () => {
  it("normalizes whitespace, control characters and blank lines", () => {
    expect(normalizeText("a\u0000b  \t c\r\n\n\n\nd​")).toBe("ab c\n\nd");
  });
  it("drops images and link URLs from crawled markdown", () => {
    expect(cleanMarkdown("See ![logo](x.png) [our policy](https://a.com/p?utm=1) now")).toBe("See our policy now");
  });
});

describe("chunking", () => {
  it("tracks heading paths and keeps sections apart", () => {
    const md = "# Help\n\nIntro text.\n\n## Refunds\n\nRefunds take 5 days.\n\n## Shipping\n\nWe ship worldwide.";
    const chunks = chunkDocument([{ text: md, page: null }]);
    expect(chunks.map((c) => c.headingPath)).toEqual(["Help", "Help › Refunds", "Help › Shipping"]);
    expect(chunks[1].content).toContain("Refunds take 5 days.");
  });

  it("respects the maximum size and splits long text by sentences", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} about returns.`).join(" ");
    const chunks = chunkDocument([{ text: long, page: null }], { targetChars: 1000, maxChars: 1200, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(5);
    expect(Math.max(...chunks.map((c) => c.content.length))).toBeLessThanOrEqual(1200);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("records PDF page ranges", () => {
    const pages = [1, 2, 3].map((p) => ({ text: `Page ${p} content about warranty terms.`, page: p }));
    const chunks = chunkDocument(pages);
    expect(chunks[0]).toMatchObject({ pageFrom: 1, pageTo: 3 });
  });

  it("returns no chunks for empty input", () => {
    expect(chunkDocument([{ text: "", page: null }])).toEqual([]);
  });
});

describe("file extraction", () => {
  const enc = new TextEncoder();
  it("extracts UTF-8 text and markdown", async () => {
    const out = await extractFile("faq.md", enc.encode("# FAQ\n\nWe are open 9–5."));
    expect(out).toMatchObject({ kind: "text", text: "# FAQ\n\nWe are open 9–5." });
  });
  it("rejects invalid UTF-8, binary data, unknown types and mismatched signatures", async () => {
    await expect(extractFile("a.txt", new Uint8Array([0xff, 0xfe, 0x41]))).rejects.toBeInstanceOf(ExtractionError);
    await expect(extractFile("a.txt", new Uint8Array([0x41, 0x00, 0x42]))).rejects.toMatchObject({ code: "unsupported_type" });
    await expect(extractFile("a.exe", enc.encode("MZ"))).rejects.toMatchObject({ code: "unsupported_type" });
    expect(() => detectKind("report.pdf", enc.encode("<html>not a pdf"))).toThrow(ExtractionError);
    expect(() => detectKind("doc.docx", enc.encode("%PDF-1.4"))).toThrow(ExtractionError);
  });
  it("rejects files over the size limit", async () => {
    await expect(extractFile("a.txt", new Uint8Array(4 * 1024 * 1024 + 1).fill(65))).rejects.toMatchObject({ code: "too_large" });
  });

  it("extracts text per page from a real PDF", async () => {
    const pdf = minimalPdf(["Refunds are accepted within 45 days.", "Shipping is free over 50 dollars."]);
    const out = await extractFile("policy.pdf", pdf);
    expect(out.kind).toBe("pdf");
    expect(out.pages).toHaveLength(2);
    expect(out.pages![0]).toContain("Refunds are accepted within 45 days.");
    expect(out.pages![1]).toContain("Shipping is free");
  });

  it("refuses DOCX files whose ZIP directory declares a huge uncompressed size (zip bomb)", async () => {
    const bomb = zipWithDeclaredSize(200 * 1024 * 1024);
    expect(zipDeclaredUncompressedSize(bomb)).toBe(200 * 1024 * 1024);
    await expect(extractFile("bomb.docx", bomb)).rejects.toMatchObject({ code: "too_large" });
  });
});

describe("crawl URL policy", () => {
  it.each([
    ["https://acme.com/help", true],
    ["http://docs.acme.co.uk", true],
    ["ftp://acme.com", false],
    ["https://localhost/admin", false],
    ["https://127.0.0.1", false],
    ["https://[::1]/", false],
    ["https://169.254.169.254/latest/meta-data", false],
    ["https://user:pw@acme.com", false],
    ["https://acme.com:8080", false],
    ["https://printer.local", false],
    ["https://intranet", false],
    ["not a url", false],
  ])("%s → %s", (url, ok) => {
    expect(validateCrawlUrl(url).ok).toBe(ok);
  });
});

/** Build a small but valid multi-page PDF with one line of text per page. */
function minimalPdf(lines: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = lines.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${lines.length} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  lines.forEach((line, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

/** A ZIP whose single central-directory entry claims `size` uncompressed bytes. */
function zipWithDeclaredSize(size: number): Uint8Array {
  const name = new TextEncoder().encode("word/document.xml");
  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  local.set(name, 30);
  lv.setUint16(26, name.length, true);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint32(24, size, true);
  cv.setUint16(28, name.length, true);
  central.set(name, 46);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);
  const all = new Uint8Array(local.length + central.length + eocd.length);
  all.set(local, 0);
  all.set(central, local.length);
  all.set(eocd, local.length + central.length);
  return all;
}
