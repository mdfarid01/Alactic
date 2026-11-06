import "server-only";
import { and, asc, count, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { agentConfigs, channelConnections, knowledgeSources } from "@/server/db/schema";
import type { PublicAgent } from "./service";

export type TrustStats = {
  windowDays: number;
  answers: number;
  verified: number;
  /** Share of answers given from the knowledge base (not the fallback). */
  answeredFromKnowledge: number;
  medianLatencyMs: number | null;
  knowledge: { type: string; sources: number }[];
  versions: { version: number; publishedAt: Date; modelId: string; trustMode: string }[];
  channels: string[];
};

/**
 * Public, aggregate-only trust statistics for a published agent (last 30 days of public-channel answers).
 * Counts come only from inference/verification records and never include message content or instructions.
 */
export async function getTrustStats(db: Database, agent: PublicAgent, windowDays = 30): Promise<TrustStats> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const [row] = await db.execute<{ answers: number; verified: number; from_knowledge: number; median_latency: number | null }>(sql`
    with answers as (
      select i.id, i.latency_ms, m.is_fallback
      from inference_records i
      join conversations c on c.id = i.conversation_id and c.org_id = i.org_id
      join messages m on m.inference_id = i.id and m.role = 'assistant'
      where i.org_id = ${agent.orgId} and i.agent_id = ${agent.agentId} and i.status = 'completed'
        and c.channel <> 'playground' and i.requested_at >= ${since}::timestamptz
    ),
    effective as (
      select distinct on (v.inference_id) v.inference_id, v.status
      from verification_records v join answers a on a.id = v.inference_id
      order by v.inference_id, case v.status when 'failed' then 0 when 'verified' then 1 when 'unavailable' then 2 else 3 end
    )
    select
      (select count(*)::int from answers) as answers,
      (select count(*)::int from effective where status = 'verified') as verified,
      (select count(*)::int from answers where not is_fallback) as from_knowledge,
      (select percentile_cont(0.5) within group (order by latency_ms) from answers where latency_ms is not null) as median_latency`);

  const knowledge = await db
    .select({ type: knowledgeSources.type, sources: count() })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.orgId, agent.orgId), eq(knowledgeSources.agentId, agent.agentId), eq(knowledgeSources.status, "ready")))
    .groupBy(knowledgeSources.type);

  const versions = await db
    .select({ version: agentConfigs.version, publishedAt: agentConfigs.publishedAt, modelId: agentConfigs.modelId, trustMode: agentConfigs.trustMode })
    .from(agentConfigs)
    .where(and(eq(agentConfigs.orgId, agent.orgId), eq(agentConfigs.agentId, agent.agentId), isNotNull(agentConfigs.publishedAt)))
    .orderBy(asc(agentConfigs.version));

  const channels = await db
    .selectDistinct({ platform: channelConnections.platform })
    .from(channelConnections)
    .where(and(eq(channelConnections.orgId, agent.orgId), eq(channelConnections.agentId, agent.agentId), eq(channelConnections.status, "active")));

  return {
    windowDays,
    answers: Number(row?.answers ?? 0),
    verified: Number(row?.verified ?? 0),
    answeredFromKnowledge: Number(row?.from_knowledge ?? 0),
    medianLatencyMs: row?.median_latency != null ? Math.round(Number(row.median_latency)) : null,
    knowledge: knowledge.map((k) => ({ type: k.type, sources: k.sources })),
    versions: versions.map((v) => ({ ...v, publishedAt: v.publishedAt! })),
    channels: ["web", "widget", ...channels.map((c) => c.platform)],
  };
}

export const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 100));
