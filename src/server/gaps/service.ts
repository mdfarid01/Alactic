import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/server/db/client";
import { knowledgeGaps, type ConversationChannel, type KnowledgeGapStatus } from "@/server/db/schema";
import { addFaqSource, KnowledgeError, resolveAgent, type IngestTicket } from "@/server/knowledge/service";
import { roleAtLeast, type OrgScope } from "@/server/orgs/service";

/**
 * Cosine similarity at or above which two unanswered questions count as the same gap. Calibrated live on 2026-11-07
 * with qwen3-embedding-0.6b: close rewordings scored 0.86–0.88, loose paraphrases 0.53–0.74, and different questions
 * up to 0.78 ("cancel" vs "pause" a subscription). We prefer not merging distinct questions over catching every paraphrase.
 */
export const GAP_MERGE_SIMILARITY = 0.8;

/**
 * Runtime hook: record that the agent couldn't answer a question. Called with a server-resolved agent ref (never client
 * input). Merges into an existing open gap when the question embedding is close enough; otherwise opens a new gap.
 */
export async function recordGap(
  db: Database,
  agent: { orgId: string; agentId: string },
  input: { question: string; channel: ConversationChannel; messageId: string | null; embedding: number[] | null; embeddingModel: string | null },
  now = new Date(),
) {
  const question = input.question.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!question) return null;
  if (input.embedding && input.embeddingModel) {
    const vec = `[${input.embedding.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
    const [near] = await db
      .select({ id: knowledgeGaps.id, distance: sql<number>`${knowledgeGaps.embedding} <=> ${vec}::vector`.mapWith(Number) })
      .from(knowledgeGaps)
      .where(
        and(
          eq(knowledgeGaps.orgId, agent.orgId),
          eq(knowledgeGaps.agentId, agent.agentId),
          eq(knowledgeGaps.status, "open"),
          eq(knowledgeGaps.embeddingModel, input.embeddingModel),
        ),
      )
      .orderBy(sql`${knowledgeGaps.embedding} <=> ${vec}::vector`)
      .limit(1);
    if (near && 1 - near.distance >= GAP_MERGE_SIMILARITY) {
      await db
        .update(knowledgeGaps)
        .set({ askCount: sql`${knowledgeGaps.askCount} + 1`, lastAskedAt: now })
        .where(and(eq(knowledgeGaps.id, near.id), eq(knowledgeGaps.orgId, agent.orgId)));
      return { id: near.id, merged: true };
    }
    const [row] = await db
      .insert(knowledgeGaps)
      .values({ ...agent, question, channel: input.channel, firstMessageId: input.messageId, embedding: input.embedding, embeddingModel: input.embeddingModel, firstAskedAt: now, lastAskedAt: now })
      .returning({ id: knowledgeGaps.id });
    return { id: row.id, merged: false };
  }
  const [row] = await db
    .insert(knowledgeGaps)
    .values({ ...agent, question, channel: input.channel, firstMessageId: input.messageId, firstAskedAt: now, lastAskedAt: now })
    .returning({ id: knowledgeGaps.id });
  return { id: row.id, merged: false };
}

/** Gaps for one agent, most-asked first (org-scoped). */
export async function listGaps(db: Database, scope: OrgScope, agentSlug: string, status: KnowledgeGapStatus = "open") {
  const agent = await resolveAgent(db, scope, agentSlug);
  return db
    .select({
      id: knowledgeGaps.id,
      question: knowledgeGaps.question,
      channel: knowledgeGaps.channel,
      askCount: knowledgeGaps.askCount,
      status: knowledgeGaps.status,
      firstAskedAt: knowledgeGaps.firstAskedAt,
      lastAskedAt: knowledgeGaps.lastAskedAt,
      resolvedAt: knowledgeGaps.resolvedAt,
    })
    .from(knowledgeGaps)
    .where(and(eq(knowledgeGaps.orgId, scope.orgId), eq(knowledgeGaps.agentId, agent.id), eq(knowledgeGaps.status, status)))
    .orderBy(desc(knowledgeGaps.askCount), desc(knowledgeGaps.lastAskedAt))
    .limit(100);
}

/** Open gap counts per agent for the org overview (org-scoped). */
export async function openGapCounts(db: Database, scope: OrgScope) {
  const rows = await db
    .select({ agentId: knowledgeGaps.agentId, gaps: count(), asks: sql<number>`coalesce(sum(${knowledgeGaps.askCount}), 0)`.mapWith(Number) })
    .from(knowledgeGaps)
    .where(and(eq(knowledgeGaps.orgId, scope.orgId), eq(knowledgeGaps.status, "open")))
    .groupBy(knowledgeGaps.agentId);
  return new Map(rows.map((r) => [r.agentId, { gaps: r.gaps, asks: r.asks }]));
}

export class GapError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid_input", message: string, public readonly fieldErrors?: Record<string, string>) {
    super(message);
  }
}

const answerSchema = z.object({
  question: z.string().trim().min(3, "Enter a question").max(500),
  answer: z.string().trim().min(1, "Enter an answer").max(4000),
});

async function findOpenGap(db: Database, scope: OrgScope, agentSlug: string, gapId: string) {
  if (!roleAtLeast(scope.role, "admin")) throw new GapError("forbidden", "Only admins can resolve questions.");
  if (!z.uuid().safeParse(gapId).success) throw new GapError("not_found", "Question not found.");
  const agent = await resolveAgent(db, scope, agentSlug);
  const [gap] = await db
    .select({ id: knowledgeGaps.id, status: knowledgeGaps.status })
    .from(knowledgeGaps)
    .where(and(eq(knowledgeGaps.id, gapId), eq(knowledgeGaps.orgId, scope.orgId), eq(knowledgeGaps.agentId, agent.id)))
    .limit(1);
  if (!gap || gap.status !== "open") throw new GapError("not_found", "Question not found or already resolved.");
  return gap;
}

/**
 * Answer a gap: the answer becomes an FAQ knowledge source (indexed like any other source), and the gap is closed.
 * Returns the ingest ticket so the caller can queue indexing.
 */
export async function answerGap(
  db: Database,
  scope: OrgScope,
  agentSlug: string,
  gapId: string,
  input: z.input<typeof answerSchema>,
  now = new Date(),
): Promise<IngestTicket> {
  const gap = await findOpenGap(db, scope, agentSlug, gapId);
  const parsed = answerSchema.safeParse(input);
  if (!parsed.success) throw new GapError("invalid_input", "Please fix the highlighted fields", Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
  let ticket: IngestTicket;
  try {
    ticket = await addFaqSource(db, scope, agentSlug, parsed.data);
  } catch (error) {
    if (error instanceof KnowledgeError) throw new GapError(error.code === "forbidden" ? "forbidden" : "invalid_input", error.message);
    throw error;
  }
  await db
    .update(knowledgeGaps)
    .set({ status: "answered", answerSourceId: ticket.sourceId, resolvedAt: now, resolvedBy: scope.userId })
    .where(and(eq(knowledgeGaps.id, gap.id), eq(knowledgeGaps.orgId, scope.orgId)));
  return ticket;
}

export async function dismissGap(db: Database, scope: OrgScope, agentSlug: string, gapId: string, now = new Date()) {
  const gap = await findOpenGap(db, scope, agentSlug, gapId);
  await db
    .update(knowledgeGaps)
    .set({ status: "dismissed", resolvedAt: now, resolvedBy: scope.userId })
    .where(and(eq(knowledgeGaps.id, gap.id), eq(knowledgeGaps.orgId, scope.orgId)));
}
