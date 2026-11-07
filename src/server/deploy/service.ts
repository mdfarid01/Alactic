import "server-only";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { conversations, inferenceRecords, verificationRecords } from "@/server/db/schema";
import type { OrgScope } from "@/server/orgs/service";

const PUBLIC_CHANNELS = ["web", "widget"] as const;

/** Recent answers on public channels for one agent, with their effective verification status (org-scoped). */
export async function recentPublicAnswers(db: Database, scope: OrgScope, agentId: string, limit = 10) {
  const rows = await db
    .select({
      id: inferenceRecords.id,
      status: inferenceRecords.status,
      modelId: inferenceRecords.modelId,
      trustMode: inferenceRecords.trustModeRequested,
      routerRequestId: inferenceRecords.routerRequestId,
      latencyMs: inferenceRecords.latencyMs,
      requestedAt: inferenceRecords.requestedAt,
      channel: conversations.channel,
    })
    .from(inferenceRecords)
    .innerJoin(conversations, and(eq(conversations.id, inferenceRecords.conversationId), eq(conversations.orgId, inferenceRecords.orgId)))
    .where(and(eq(inferenceRecords.orgId, scope.orgId), eq(inferenceRecords.agentId, agentId), inArray(conversations.channel, [...PUBLIC_CHANNELS])))
    .orderBy(desc(inferenceRecords.requestedAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const checks = await db
    .select({ inferenceId: verificationRecords.inferenceId, status: verificationRecords.status })
    .from(verificationRecords)
    .where(and(eq(verificationRecords.orgId, scope.orgId), inArray(verificationRecords.inferenceId, rows.map((r) => r.id))));
  const rank = { failed: 0, verified: 1, unavailable: 2, not_requested: 3 } as const;
  const effective = new Map<string, keyof typeof rank>();
  for (const c of checks) {
    const cur = effective.get(c.inferenceId);
    if (!cur || rank[c.status] < rank[cur]) effective.set(c.inferenceId, c.status);
  }
  return rows.map((r) => ({ ...r, verification: effective.get(r.id) ?? null }));
}

/** Public-channel usage for the last 7 days (org-scoped). */
export async function publicUsage(db: Database, scope: OrgScope, agentId: string) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [conv] = await db
    .select({ n: count() })
    .from(conversations)
    .where(and(eq(conversations.orgId, scope.orgId), eq(conversations.agentId, agentId), inArray(conversations.channel, [...PUBLIC_CHANNELS]), gte(conversations.startedAt, since)));
  const [answers] = await db
    .select({ n: count(), completed: sql<number>`count(*) filter (where ${inferenceRecords.status} = 'completed')`.mapWith(Number) })
    .from(inferenceRecords)
    .innerJoin(conversations, and(eq(conversations.id, inferenceRecords.conversationId), eq(conversations.orgId, inferenceRecords.orgId)))
    .where(and(eq(inferenceRecords.orgId, scope.orgId), eq(inferenceRecords.agentId, agentId), inArray(conversations.channel, [...PUBLIC_CHANNELS]), gte(inferenceRecords.requestedAt, since)));
  return { conversations: conv?.n ?? 0, answers: answers?.n ?? 0, completed: answers?.completed ?? 0 };
}
