import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/server/db/client";
import { agents, knowledgeDocuments, knowledgeSources } from "@/server/db/schema";
import { roleAtLeast, type OrgScope } from "@/server/orgs/service";
import type { ExtractedFile } from "./extract";
import { estimateTokens, normalizeText, sha256 } from "./normalize";
import { validateCrawlUrl } from "./url-policy";

export const KNOWLEDGE_LIMITS = {
  sourcesPerAgent: 100,
  maxCrawlPages: 50,
  faqQuestion: 500,
  faqAnswer: 5000,
  textTitle: 200,
  textContent: 100_000,
} as const;

export class KnowledgeError extends Error {
  constructor(
    public readonly code: "forbidden" | "not_found" | "invalid_input" | "limit_reached",
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
  }
}

/** What the background job needs to process a source. */
export type IngestTicket = { sourceId: string; runId: string; agentId: string; orgId: string };

function requireEditor(scope: OrgScope) {
  if (!roleAtLeast(scope.role, "admin")) throw new KnowledgeError("forbidden", "Only owners and admins can change knowledge");
}

/** Resolve an agent inside the caller's org. Never trust an agent id from the client. */
export async function resolveAgent(db: Database, scope: OrgScope, agentSlug: string) {
  const [agent] = await db
    .select({ id: agents.id, orgId: agents.orgId, slug: agents.slug })
    .from(agents)
    .where(and(eq(agents.orgId, scope.orgId), eq(agents.slug, agentSlug.slice(0, 64))))
    .limit(1);
  if (!agent) throw new KnowledgeError("not_found", "Agent not found");
  return agent;
}

async function assertCapacity(db: Database, agentId: string, orgId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.agentId, agentId), eq(knowledgeSources.orgId, orgId)));
  if ((row?.n ?? 0) >= KNOWLEDGE_LIMITS.sourcesPerAgent) {
    throw new KnowledgeError("limit_reached", `An agent can have up to ${KNOWLEDGE_LIMITS.sourcesPerAgent} knowledge sources.`);
  }
}

export async function listSources(db: Database, scope: OrgScope, agentSlug: string) {
  const agent = await resolveAgent(db, scope, agentSlug);
  return db
    .select({
      id: knowledgeSources.id,
      type: knowledgeSources.type,
      title: knowledgeSources.title,
      url: knowledgeSources.url,
      fileName: knowledgeSources.fileName,
      fileSize: knowledgeSources.fileSize,
      status: knowledgeSources.status,
      statusDetail: knowledgeSources.statusDetail,
      documentCount: knowledgeSources.documentCount,
      chunkCount: knowledgeSources.chunkCount,
      lastIndexedAt: knowledgeSources.lastIndexedAt,
      createdAt: knowledgeSources.createdAt,
      updatedAt: knowledgeSources.updatedAt,
      /** Queued/processing with no progress for 15 minutes (the job may have died). */
      stalled: sql<boolean>`${knowledgeSources.status} in ('queued', 'processing') and ${knowledgeSources.updatedAt} < now() - interval '15 minutes'`,
    })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.agentId, agent.id), eq(knowledgeSources.orgId, scope.orgId)))
    .orderBy(desc(knowledgeSources.createdAt));
}

export const websiteSourceSchema = z.object({
  url: z.string().trim().min(1, "Enter a URL").max(2048),
  maxPages: z.coerce.number().int().min(1).max(KNOWLEDGE_LIMITS.maxCrawlPages),
});

export async function addWebsiteSource(db: Database, scope: OrgScope, agentSlug: string, input: z.input<typeof websiteSourceSchema>) {
  requireEditor(scope);
  const parsed = websiteSourceSchema.safeParse(input);
  if (!parsed.success) throw new KnowledgeError("invalid_input", parsed.error.issues[0]?.message ?? "Invalid input");
  const url = validateCrawlUrl(parsed.data.url);
  if (!url.ok) throw new KnowledgeError("invalid_input", url.error, { url: url.error });
  const agent = await resolveAgent(db, scope, agentSlug);
  await assertCapacity(db, agent.id, scope.orgId);
  const runId = randomUUID();
  const [source] = await db
    .insert(knowledgeSources)
    .values({
      orgId: scope.orgId,
      agentId: agent.id,
      type: "website",
      title: url.url.hostname + (url.url.pathname === "/" ? "" : url.url.pathname).slice(0, 150),
      url: url.url.toString(),
      crawlOptions: { maxPages: parsed.data.maxPages },
      statusDetail: "Waiting to crawl",
      ingestRunId: runId,
      createdBy: scope.userId,
    })
    .returning({ id: knowledgeSources.id });
  return { sourceId: source.id, runId, agentId: agent.id, orgId: scope.orgId } satisfies IngestTicket;
}

/** Create a single-document source (file, FAQ or text) with its document in one transaction. */
async function addSingleDocumentSource(
  db: Database,
  scope: OrgScope,
  agentSlug: string,
  source: Pick<typeof knowledgeSources.$inferInsert, "type" | "title" | "fileName" | "fileMime" | "fileSize">,
  doc: { externalKey: string; title: string; content: string; pageOffsets?: number[] | null },
): Promise<IngestTicket> {
  requireEditor(scope);
  const agent = await resolveAgent(db, scope, agentSlug);
  await assertCapacity(db, agent.id, scope.orgId);
  const runId = randomUUID();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(knowledgeSources)
      .values({
        ...source,
        orgId: scope.orgId,
        agentId: agent.id,
        statusDetail: "Waiting to index",
        ingestRunId: runId,
        documentCount: 1,
        createdBy: scope.userId,
      })
      .returning({ id: knowledgeSources.id });
    await tx.insert(knowledgeDocuments).values({
      orgId: scope.orgId,
      agentId: agent.id,
      sourceId: row.id,
      externalKey: doc.externalKey,
      title: doc.title,
      content: doc.content,
      pageOffsets: doc.pageOffsets ?? null,
      contentSha256: sha256(doc.content),
      tokenCount: estimateTokens(doc.content),
    });
    return { sourceId: row.id, runId, agentId: agent.id, orgId: scope.orgId };
  });
}

export async function addFileSource(
  db: Database,
  scope: OrgScope,
  agentSlug: string,
  file: { name: string; mime: string; size: number; extracted: ExtractedFile },
) {
  const name = file.name.replace(/[\u0000-\u001f]/g, "").slice(0, 200) || "Untitled";
  let content = file.extracted.text;
  let pageOffsets: number[] | null = null;
  if (file.extracted.pages) {
    // Rebuild content from pages so offsets are exact; respects the extraction cap.
    pageOffsets = [];
    const parts: string[] = [];
    let offset = 0;
    for (const page of file.extracted.pages) {
      if (offset >= file.extracted.text.length) break;
      pageOffsets.push(offset);
      parts.push(page);
      offset += page.length + 2;
    }
    content = parts.join("\n\n").slice(0, file.extracted.text.length);
  }
  return addSingleDocumentSource(
    db,
    scope,
    agentSlug,
    { type: "file", title: name, fileName: name, fileMime: file.mime.slice(0, 100), fileSize: file.size },
    { externalKey: "file", title: name, content, pageOffsets },
  );
}

export const faqSourceSchema = z.object({
  question: z.string().trim().min(3, "Enter a question").max(KNOWLEDGE_LIMITS.faqQuestion),
  answer: z.string().trim().min(1, "Enter an answer").max(KNOWLEDGE_LIMITS.faqAnswer),
});

export async function addFaqSource(db: Database, scope: OrgScope, agentSlug: string, input: z.input<typeof faqSourceSchema>) {
  requireEditor(scope);
  const parsed = faqSourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new KnowledgeError("invalid_input", "Please fix the highlighted fields", Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
  }
  const question = normalizeText(parsed.data.question);
  const answer = normalizeText(parsed.data.answer);
  return addSingleDocumentSource(
    db,
    scope,
    agentSlug,
    { type: "faq", title: question.slice(0, 200) },
    { externalKey: "entry", title: question.slice(0, 200), content: `Q: ${question}\nA: ${answer}` },
  );
}

export const textSourceSchema = z.object({
  title: z.string().trim().min(1, "Enter a title").max(KNOWLEDGE_LIMITS.textTitle),
  content: z.string().trim().min(1, "Enter some text").max(KNOWLEDGE_LIMITS.textContent),
});

export async function addTextSource(db: Database, scope: OrgScope, agentSlug: string, input: z.input<typeof textSourceSchema>) {
  requireEditor(scope);
  const parsed = textSourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new KnowledgeError("invalid_input", "Please fix the highlighted fields", Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
  }
  const content = normalizeText(parsed.data.content);
  return addSingleDocumentSource(
    db,
    scope,
    agentSlug,
    { type: "text", title: parsed.data.title },
    { externalKey: "entry", title: parsed.data.title, content },
  );
}

async function findSource(db: Database, scope: OrgScope, agentSlug: string, sourceId: string) {
  if (!z.uuid().safeParse(sourceId).success) throw new KnowledgeError("not_found", "Source not found");
  const agent = await resolveAgent(db, scope, agentSlug);
  const [source] = await db
    .select()
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.id, sourceId), eq(knowledgeSources.agentId, agent.id), eq(knowledgeSources.orgId, scope.orgId)))
    .limit(1);
  if (!source) throw new KnowledgeError("not_found", "Source not found");
  return source;
}

/** Start a fresh ingestion run (re-crawls websites). Any run already in flight sees the new run id and stops. */
export async function reindexSource(db: Database, scope: OrgScope, agentSlug: string, sourceId: string): Promise<IngestTicket> {
  requireEditor(scope);
  const source = await findSource(db, scope, agentSlug, sourceId);
  const runId = randomUUID();
  await db.transaction(async (tx) => {
    await tx
      .update(knowledgeSources)
      .set({ status: "queued", statusDetail: source.type === "website" ? "Waiting to crawl" : "Waiting to index", ingestRunId: runId, updatedAt: new Date() })
      .where(eq(knowledgeSources.id, source.id));
    // No forced reset: changed documents are detected by content hash, and chunks embedded with a different model
    // are re-embedded automatically. Unchanged content costs nothing to re-index.
  });
  return { sourceId: source.id, runId, agentId: source.agentId, orgId: scope.orgId };
}

/** Delete a source; documents and chunks are removed by cascading FKs, so retrieval stops immediately. */
export async function deleteSource(db: Database, scope: OrgScope, agentSlug: string, sourceId: string) {
  requireEditor(scope);
  const source = await findSource(db, scope, agentSlug, sourceId);
  await db.delete(knowledgeSources).where(and(eq(knowledgeSources.id, source.id), eq(knowledgeSources.orgId, scope.orgId)));
}

export async function markEnqueueFailed(db: Database, ticket: IngestTicket) {
  await db
    .update(knowledgeSources)
    .set({ status: "failed", statusDetail: "Background processing is unavailable. Try re-indexing in a moment.", updatedAt: new Date() })
    .where(and(eq(knowledgeSources.id, ticket.sourceId), eq(knowledgeSources.ingestRunId, ticket.runId)));
}

export async function knowledgeSummary(db: Database, scope: OrgScope) {
  const rows = await db
    .select({ status: knowledgeSources.status, n: count(), chunks: sql<number>`coalesce(sum(${knowledgeSources.chunkCount}), 0)::int` })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.orgId, scope.orgId))
    .groupBy(knowledgeSources.status)
    .orderBy(asc(knowledgeSources.status));
  return rows;
}
