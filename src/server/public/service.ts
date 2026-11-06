import "server-only";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { agentConfigs, agents, conversations, inferenceRecords, organizations, verificationRecords } from "@/server/db/schema";

/**
 * Public (unauthenticated) read models. Everything returned here is safe to show to anyone:
 * no instructions, persona, documents, message content, or internal ids beyond what a proof page needs.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export type PublicAgent = {
  agentId: string;
  orgId: string;
  slug: string;
  orgName: string;
  name: string;
  description: string;
  modelId: string;
  trustMode: "private" | "verified" | "standard";
  language: string;
  version: number;
  publishedAt: Date;
};

/** A published, live agent by its public slug. Returns null for drafts, paused or unknown agents. */
export async function getPublicAgent(db: Database, slug: string): Promise<PublicAgent | null> {
  if (!SLUG_RE.test(slug)) return null;
  const [row] = await db
    .select({
      agentId: agents.id,
      orgId: agents.orgId,
      slug: agents.slug,
      orgName: organizations.name,
      name: agentConfigs.name,
      description: agentConfigs.description,
      modelId: agentConfigs.modelId,
      trustMode: agentConfigs.trustMode,
      language: agentConfigs.language,
      version: agentConfigs.version,
      publishedAt: agentConfigs.publishedAt,
    })
    .from(agents)
    .innerJoin(agentConfigs, and(eq(agentConfigs.id, agents.publishedConfigId), eq(agentConfigs.agentId, agents.id)))
    .innerJoin(organizations, eq(organizations.id, agents.orgId))
    .where(and(eq(agents.slug, slug), eq(agents.status, "published")))
    .limit(1);
  if (!row || !row.publishedAt) return null;
  return { ...row, publishedAt: row.publishedAt };
}

export type PublicProof = {
  inferenceId: string;
  status: "requested" | "completed" | "failed";
  channel: "public" | "internal";
  modelId: string;
  trustMode: "private" | "verified" | "standard";
  verifyTeeRequested: boolean;
  routerRequestId: string | null;
  chatId: string | null;
  providerAddress: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costAmount: string | null;
  costUnit: string | null;
  latencyMs: number | null;
  answerSha256: string | null;
  requestedAt: Date;
  completedAt: Date | null;
  agent: { slug: string; name: string; orgName: string } | null;
  checks: {
    method: "router" | "independent";
    status: "not_requested" | "verified" | "failed" | "unavailable";
    signerAddress: string | null;
    reason: string | null;
    details: { recoveredAddress?: string; signedTextSha256?: string; signedTextFormat?: string; verifiability?: string; serviceModel?: string };
    checkedAt: Date;
  }[];
};

/**
 * The public proof receipt for one AI answer. Contains only inference metadata and verification evidence, never
 * the question, the answer, or retrieved documents. The agent is named only if it is currently published.
 */
export async function getPublicProof(db: Database, inferenceId: string): Promise<PublicProof | null> {
  if (!UUID_RE.test(inferenceId)) return null;
  const [rec] = await db.select().from(inferenceRecords).where(eq(inferenceRecords.id, inferenceId)).limit(1);
  if (!rec) return null;

  const [agentRow] = await db
    .select({ slug: agents.slug, status: agents.status, name: agentConfigs.name, orgName: organizations.name })
    .from(agents)
    .innerJoin(organizations, eq(organizations.id, agents.orgId))
    .leftJoin(agentConfigs, and(eq(agentConfigs.id, agents.publishedConfigId), eq(agentConfigs.agentId, agents.id)))
    .where(and(eq(agents.id, rec.agentId), eq(agents.orgId, rec.orgId)))
    .limit(1);

  const checks = await db
    .select()
    .from(verificationRecords)
    .where(and(eq(verificationRecords.inferenceId, rec.id), eq(verificationRecords.orgId, rec.orgId)))
    .orderBy(asc(verificationRecords.checkedAt));

  const [conv] = await db.select({ channel: conversations.channel }).from(conversations).where(eq(conversations.id, rec.conversationId)).limit(1);

  return {
    inferenceId: rec.id,
    status: rec.status,
    channel: conv && conv.channel !== "playground" ? "public" : "internal",
    modelId: rec.modelId,
    trustMode: rec.trustModeRequested,
    verifyTeeRequested: rec.verifyTeeRequested,
    routerRequestId: rec.routerRequestId,
    chatId: rec.chatId,
    providerAddress: rec.providerAddress,
    inputTokens: rec.inputTokens,
    outputTokens: rec.outputTokens,
    costAmount: rec.costAmount,
    costUnit: rec.costUnit,
    latencyMs: rec.latencyMs,
    answerSha256: rec.answerSha256,
    requestedAt: rec.requestedAt,
    completedAt: rec.completedAt,
    agent: agentRow && agentRow.status === "published" && agentRow.name ? { slug: agentRow.slug, name: agentRow.name, orgName: agentRow.orgName } : null,
    checks: checks.map((c) => {
      const d = (c.details ?? {}) as Record<string, unknown>;
      const pick = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : undefined);
      return {
        method: c.method,
        status: c.status,
        signerAddress: c.signerAddress,
        reason: pick("reason") ?? null,
        details: {
          recoveredAddress: pick("recoveredAddress"),
          signedTextSha256: pick("signedTextSha256"),
          signedTextFormat: pick("signedTextFormat"),
          verifiability: pick("verifiability"),
          serviceModel: pick("serviceModel"),
        },
        checkedAt: c.checkedAt,
      };
    }),
  };
}
