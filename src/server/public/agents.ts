import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { agentConfigs, agents, conversations, inferenceRecords, messages, verificationRecords } from "@/server/db/schema";
import { sha256 } from "@/server/knowledge/normalize";

/** Public view of a PUBLISHED agent. Only public fields: never instructions, persona or internal ids beyond what the runtime needs server-side. */
export async function getPublishedAgent(db: Database, slug: string) {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null;
  const [row] = await db
    .select({
      agentId: agents.id,
      orgId: agents.orgId,
      slug: agents.slug,
      allowedOrigins: agents.allowedOrigins,
      name: agentConfigs.name,
      description: agentConfigs.description,
      modelId: agentConfigs.modelId,
      trustMode: agentConfigs.trustMode,
      version: agentConfigs.version,
      publishedAt: agentConfigs.publishedAt,
    })
    .from(agents)
    .innerJoin(agentConfigs, and(eq(agentConfigs.id, agents.publishedConfigId), eq(agentConfigs.agentId, agents.id)))
    .where(and(eq(agents.slug, slug), eq(agents.status, "published")))
    .limit(1);
  return row ?? null;
}

/** History of a public conversation, only for the visitor holding its token. */
export async function publicConversationHistory(db: Database, agent: { orgId: string; agentId: string }, conversationId: string, visitorToken: string) {
  if (!/^[0-9a-f-]{36}$/.test(conversationId) || visitorToken.length < 20 || visitorToken.length > 100) return null;
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.agentId, agent.agentId),
        eq(conversations.orgId, agent.orgId),
        eq(conversations.visitorTokenHash, sha256(visitorToken)),
      ),
    )
    .limit(1);
  if (!conv) return null;
  return db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      citations: messages.citations,
      isFallback: messages.isFallback,
      inferenceId: messages.inferenceId,
      verification: sql<string | null>`(
        select v.status from verification_records v where v.inference_id = ${messages.inferenceId}
        order by case v.status when 'failed' then 0 when 'verified' then 1 when 'unavailable' then 2 else 3 end limit 1)`,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conv.id), eq(messages.orgId, agent.orgId)))
    .orderBy(asc(messages.createdAt))
    .limit(100);
}

/**
 * Public verification evidence for one AI response from a PUBLIC channel. Contains no message content, prompt or
 * visitor data, only the facts behind the badge.
 */
export async function publicInferenceEvidence(db: Database, inferenceId: string) {
  if (!/^[0-9a-f-]{36}$/.test(inferenceId)) return null;
  const [inf] = await db
    .select({
      id: inferenceRecords.id,
      modelId: inferenceRecords.modelId,
      trustMode: inferenceRecords.trustModeRequested,
      status: inferenceRecords.status,
      providerAddress: inferenceRecords.providerAddress,
      chatId: inferenceRecords.chatId,
      routerRequestId: inferenceRecords.routerRequestId,
      latencyMs: inferenceRecords.latencyMs,
      requestedAt: inferenceRecords.requestedAt,
      channel: conversations.channel,
      agentSlug: agents.slug,
      agentStatus: agents.status,
    })
    .from(inferenceRecords)
    .innerJoin(conversations, eq(conversations.id, inferenceRecords.conversationId))
    .innerJoin(agents, eq(agents.id, inferenceRecords.agentId))
    .where(eq(inferenceRecords.id, inferenceId))
    .limit(1);
  if (!inf || (inf.channel !== "web" && inf.channel !== "widget")) return null;
  const checks = await db
    .select({ method: verificationRecords.method, status: verificationRecords.status, signerAddress: verificationRecords.signerAddress, details: verificationRecords.details, checkedAt: verificationRecords.checkedAt })
    .from(verificationRecords)
    .where(eq(verificationRecords.inferenceId, inf.id))
    .orderBy(asc(verificationRecords.checkedAt));
  return { ...inf, checks };
}
