import { and, count, eq, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { knowledgeChunks, knowledgeDocuments, knowledgeSources } from "@/server/db/schema";
import { chunkDocument } from "./chunker";
import type { CrawledPage } from "./firecrawl";
import type { EmbeddingProvider } from "./embeddings";
import { cleanMarkdown, estimateTokens, sha256 } from "./normalize";

/**
 * Ingestion stages. Each function is idempotent and checks that `runId` is still the source's current run, so a
 * re-index or delete makes older runs stop instead of writing stale data.
 */

export type RunSource = {
  id: string;
  orgId: string;
  agentId: string;
  type: "website" | "file" | "faq" | "text";
  url: string | null;
  maxPages: number;
};

const MAX_CHUNKS_PER_AGENT = 20_000;

function current(sourceId: string, runId: string) {
  return and(eq(knowledgeSources.id, sourceId), eq(knowledgeSources.ingestRunId, runId));
}

export async function loadRun(db: Database, sourceId: string, runId: string): Promise<RunSource | null> {
  const [s] = await db.select().from(knowledgeSources).where(current(sourceId, runId)).limit(1);
  if (!s) return null;
  return { id: s.id, orgId: s.orgId, agentId: s.agentId, type: s.type, url: s.url, maxPages: s.crawlOptions?.maxPages ?? 10 };
}

/** Returns false if the run is stale (source deleted or re-indexed). */
export async function setProgress(
  db: Database,
  sourceId: string,
  runId: string,
  status: "processing" | "failed" | "ready",
  detail: string,
): Promise<boolean> {
  const rows = await db
    .update(knowledgeSources)
    .set({ status, statusDetail: detail.slice(0, 300), updatedAt: new Date() })
    .where(current(sourceId, runId))
    .returning({ id: knowledgeSources.id });
  return rows.length > 0;
}

/** Upsert crawled pages as documents and remove pages that disappeared. Returns the stored page count. */
export async function storeCrawledPages(db: Database, source: RunSource, runId: string, pages: CrawledPage[]) {
  const seen = new Map<string, CrawledPage>();
  for (const p of pages) {
    let key: string;
    try {
      const u = new URL(p.url);
      u.hash = "";
      key = u.toString();
    } catch {
      continue;
    }
    const content = cleanMarkdown(p.markdown);
    if (content.length < 50) continue; // skip empty/near-empty pages
    if (!seen.has(key)) seen.set(key, { ...p, url: key, markdown: content });
    if (seen.size >= source.maxPages) break;
  }

  return db.transaction(async (tx) => {
    const [live] = await tx.select({ id: knowledgeSources.id }).from(knowledgeSources).where(current(source.id, runId)).for("update");
    if (!live) return 0;
    const keys = [...seen.keys()];
    await tx
      .delete(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.sourceId, source.id),
          keys.length ? notInArray(knowledgeDocuments.externalKey, keys) : sql`true`,
        ),
      );
    for (const page of seen.values()) {
      const content = page.markdown.slice(0, 400_000);
      const hash = sha256(content);
      await tx
        .insert(knowledgeDocuments)
        .values({
          orgId: source.orgId,
          agentId: source.agentId,
          sourceId: source.id,
          externalKey: page.url,
          title: page.title,
          url: page.url,
          content,
          contentSha256: hash,
          tokenCount: estimateTokens(content),
        })
        .onConflictDoUpdate({
          target: [knowledgeDocuments.sourceId, knowledgeDocuments.externalKey],
          set: { title: page.title, content, contentSha256: hash, tokenCount: estimateTokens(content), updatedAt: new Date() },
        });
    }
    return seen.size;
  });
}

/** (Re)chunk documents whose content changed since they were last chunked. Returns the number of documents chunked. */
export async function chunkPendingDocuments(db: Database, source: RunSource, runId: string) {
  const docs = await db
    .select()
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.sourceId, source.id),
        or(isNull(knowledgeDocuments.indexedSha256), ne(knowledgeDocuments.indexedSha256, knowledgeDocuments.contentSha256)),
      ),
    );
  let processed = 0;
  for (const doc of docs) {
    const pages = doc.pageOffsets?.length
      ? doc.pageOffsets.map((start, i) => ({
          text: doc.content.slice(start, i + 1 < doc.pageOffsets!.length ? doc.pageOffsets![i + 1] : undefined).trim(),
          page: i + 1,
        }))
      : [{ text: doc.content, page: null }];
    const chunks = chunkDocument(pages);
    const ok = await db.transaction(async (tx) => {
      const [live] = await tx.select({ id: knowledgeSources.id }).from(knowledgeSources).where(current(source.id, runId)).for("update");
      if (!live) return false;
      const [{ n }] = await tx
        .select({ n: count() })
        .from(knowledgeChunks)
        .where(and(eq(knowledgeChunks.agentId, source.agentId), ne(knowledgeChunks.documentId, doc.id)));
      if (n + chunks.length > MAX_CHUNKS_PER_AGENT) {
        throw new PipelineError(`This agent's knowledge is over the ${MAX_CHUNKS_PER_AGENT.toLocaleString()}-passage limit.`, false);
      }
      await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, doc.id));
      if (chunks.length) {
        await tx.insert(knowledgeChunks).values(
          chunks.map((c) => ({
            orgId: source.orgId,
            agentId: source.agentId,
            sourceId: source.id,
            documentId: doc.id,
            chunkIndex: c.index,
            content: c.content,
            headingPath: c.headingPath,
            pageFrom: c.pageFrom,
            pageTo: c.pageTo,
            tokenCount: c.tokenCount,
            contentSha256: c.contentSha256,
          })),
        );
      }
      await tx.update(knowledgeDocuments).set({ indexedSha256: doc.contentSha256 }).where(eq(knowledgeDocuments.id, doc.id));
      return true;
    });
    if (!ok) return processed;
    processed++;
  }
  return processed;
}

export class PipelineError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
  }
}

/** Embed up to `batchSize` chunks that lack an embedding from the current model. Returns how many were embedded. */
export async function embedNextBatch(db: Database, source: RunSource, runId: string, embedder: EmbeddingProvider, batchSize = 32) {
  const pending = await db
    .select({ id: knowledgeChunks.id, content: knowledgeChunks.content, headingPath: knowledgeChunks.headingPath })
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.sourceId, source.id),
        or(isNull(knowledgeChunks.embedding), sql`${knowledgeChunks.embeddingModel} is distinct from ${embedder.model}`),
      ),
    )
    .limit(batchSize);
  if (!pending.length) return 0;
  // Heading context improves retrieval for short passages.
  const vectors = await embedder.embedDocuments(pending.map((c) => (c.headingPath ? `${c.headingPath}\n\n${c.content}` : c.content)));
  await db.transaction(async (tx) => {
    const [live] = await tx.select({ id: knowledgeSources.id }).from(knowledgeSources).where(current(source.id, runId)).for("update");
    if (!live) return;
    for (let i = 0; i < pending.length; i++) {
      await tx
        .update(knowledgeChunks)
        .set({ embedding: vectors[i], embeddingModel: embedder.model })
        .where(and(eq(knowledgeChunks.id, pending[i].id), eq(knowledgeChunks.sourceId, source.id)));
    }
  });
  return pending.length;
}

export async function finalizeRun(db: Database, source: RunSource, runId: string) {
  const [{ docs }] = await db.select({ docs: count() }).from(knowledgeDocuments).where(eq(knowledgeDocuments.sourceId, source.id));
  const [{ chunks }] = await db.select({ chunks: count() }).from(knowledgeChunks).where(eq(knowledgeChunks.sourceId, source.id));
  const now = new Date();
  await db
    .update(knowledgeSources)
    .set({
      status: docs === 0 ? "failed" : "ready",
      statusDetail: docs === 0 ? "No readable content was found." : null,
      documentCount: docs,
      chunkCount: chunks,
      lastIndexedAt: docs === 0 ? undefined : now,
      updatedAt: now,
    })
    .where(current(source.id, runId));
}
