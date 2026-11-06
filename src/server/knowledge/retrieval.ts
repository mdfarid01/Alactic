import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { knowledgeChunks, knowledgeDocuments, knowledgeSources } from "@/server/db/schema";

export type RetrievedPassage = {
  chunkId: string;
  content: string;
  score: number;
  headingPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  documentId: string;
  documentTitle: string;
  url: string | null;
  sourceId: string;
  sourceType: "website" | "file" | "faq" | "text";
  sourceTitle: string;
};

/**
 * Tenant-scoped vector search.
 * `agent` must come from server-side resolution (an authorized OrgScope or a published agent lookup), never from
 * client input. Every query filters on BOTH org_id and agent_id, and only matches vectors from the active model.
 */
export async function retrievePassages(
  db: Database,
  agent: { orgId: string; agentId: string },
  query: { embedding: number[]; model: string },
  options: { k?: number; minScore?: number } = {},
): Promise<RetrievedPassage[]> {
  const k = Math.min(Math.max(options.k ?? 8, 1), 20);
  const vec = `[${query.embedding.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
  const distance = sql<number>`${knowledgeChunks.embedding} <=> ${vec}::vector`;

  return db.transaction(async (tx) => {
    // pgvector ≥ 0.8: keep scanning the HNSW index until enough rows pass the tenant filter.
    await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
    const rows = await tx
      .select({
        chunkId: knowledgeChunks.id,
        content: knowledgeChunks.content,
        distance,
        headingPath: knowledgeChunks.headingPath,
        pageFrom: knowledgeChunks.pageFrom,
        pageTo: knowledgeChunks.pageTo,
        documentId: knowledgeDocuments.id,
        documentTitle: knowledgeDocuments.title,
        url: knowledgeDocuments.url,
        sourceId: knowledgeSources.id,
        sourceType: knowledgeSources.type,
        sourceTitle: knowledgeSources.title,
      })
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
      .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeChunks.sourceId))
      .where(
        and(
          eq(knowledgeChunks.orgId, agent.orgId),
          eq(knowledgeChunks.agentId, agent.agentId),
          isNotNull(knowledgeChunks.embedding),
          eq(knowledgeChunks.embeddingModel, query.model),
        ),
      )
      .orderBy(distance)
      .limit(k);
    return rows
      .map(({ distance: d, ...r }) => ({ ...r, score: 1 - Number(d) }))
      .filter((r) => r.score >= (options.minScore ?? 0));
  });
}
