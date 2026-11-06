import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import {
  agentConfigs,
  agents,
  conversations,
  inferenceRecords,
  messages,
  verificationRecords,
  type Citation,
  type ConversationChannel,
  type VerificationStatus,
} from "@/server/db/schema";
import type { EmbeddingProvider } from "@/server/knowledge/embeddings";
import { EmbeddingError } from "@/server/knowledge/embeddings";
import { retrievePassages, type RetrievedPassage } from "@/server/knowledge/retrieval";
import { InferenceError, verificationStatusFrom, type ChatClient } from "@/server/inference/router-client";
import type { TeeVerification } from "@/server/inference/tee-verifier";
import { extractCitations, isFallbackAnswer } from "./citations";
import { buildMessages } from "./prompt";

export const MAX_USER_MESSAGE_CHARS = 4000;

export type RunAgentDeps = {
  db: Database;
  chat: ChatClient;
  embedder: EmbeddingProvider;
  /** Max inference requests per organization per UTC day (cost guard). */
  dailyOrgLimit: number;
  /** Does the model accept a request parameter (from the live 0G catalog)? */
  modelSupports: (modelId: string, parameter: string) => Promise<boolean>;
  /** Independent TEE signature verification (on-chain signer + provider signature). */
  verifyTee: (input: { provider: string | null; chatId: string | null }) => Promise<TeeVerification>;
};

export type RunAgentInput = {
  /** Resolved server-side (authorized scope or published-agent lookup). Never taken from the client. */
  agent: { orgId: string; agentId: string };
  /** Playground uses the draft; every public channel uses the published version. */
  configVersion: "draft" | "published";
  channel: ConversationChannel;
  conversationId?: string | null;
  userMessage: string;
  startedBy?: string | null;
};

export type RunAgentErrorCode =
  | "invalid_message"
  | "agent_not_found"
  | "not_published"
  | "conversation_not_found"
  | "daily_limit"
  | InferenceError["code"];

export type RunAgentResult = {
  conversationId: string;
  reply: { messageId: string; content: string; citations: Citation[]; isFallback: boolean };
  inference: {
    id: string;
    status: "completed" | "failed";
    modelId: string;
    trustMode: "private" | "verified" | "standard";
    providerAddress: string | null;
    routerRequestId: string | null;
    latencyMs: number | null;
  } | null;
  /** Strongest available evidence: the independent check if it ran, otherwise the Router's report. */
  verification: { status: VerificationStatus; method: "router" | "independent"; reason: string | null; signerAddress: string | null } | null;
  retrieval: { status: "ok" | "unavailable"; passages: number; reason?: string };
  error?: { code: RunAgentErrorCode; message: string };
};

export class RunAgentError extends Error {
  constructor(public readonly code: RunAgentErrorCode, message: string) {
    super(message);
  }
}

async function loadConfig(db: Database, agent: RunAgentInput["agent"], version: RunAgentInput["configVersion"]) {
  const [a] = await db
    .select({ id: agents.id, publishedConfigId: agents.publishedConfigId, status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, agent.agentId), eq(agents.orgId, agent.orgId)))
    .limit(1);
  if (!a) throw new RunAgentError("agent_not_found", "Agent not found.");
  if (version === "published") {
    if (!a.publishedConfigId || a.status !== "published") throw new RunAgentError("not_published", "This agent isn't published.");
    const [c] = await db.select().from(agentConfigs).where(and(eq(agentConfigs.id, a.publishedConfigId), eq(agentConfigs.agentId, a.id))).limit(1);
    return c;
  }
  const [c] = await db
    .select()
    .from(agentConfigs)
    .where(and(eq(agentConfigs.agentId, a.id), eq(agentConfigs.orgId, agent.orgId)))
    .orderBy(sql`${agentConfigs.publishedAt} is null desc`, desc(agentConfigs.version))
    .limit(1);
  return c;
}

/**
 * The shared agent runtime used by every channel:
 * resolve config → validate → conversation → cost guard → retrieve → prompt → 0G inference → verification →
 * citations → persist. Failures still produce a stored, user-visible fallback reply plus a machine-readable error.
 */
export async function runAgent(deps: RunAgentDeps, input: RunAgentInput): Promise<RunAgentResult> {
  const { db } = deps;
  const userMessage = input.userMessage.replace(/\u0000/g, "").trim();
  if (!userMessage || userMessage.length > MAX_USER_MESSAGE_CHARS) {
    throw new RunAgentError("invalid_message", `Messages must be between 1 and ${MAX_USER_MESSAGE_CHARS} characters.`);
  }

  const config = await loadConfig(db, input.agent, input.configVersion);
  if (!config) throw new RunAgentError("agent_not_found", "Agent not found.");

  // Conversation (must belong to this agent, org and channel).
  let conversationId = input.conversationId ?? null;
  if (conversationId) {
    const [c] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.agentId, input.agent.agentId),
          eq(conversations.orgId, input.agent.orgId),
          eq(conversations.channel, input.channel),
        ),
      )
      .limit(1);
    if (!c) throw new RunAgentError("conversation_not_found", "Conversation not found.");
  } else {
    const [c] = await db
      .insert(conversations)
      .values({ orgId: input.agent.orgId, agentId: input.agent.agentId, channel: input.channel, startedBy: input.startedBy ?? null })
      .returning({ id: conversations.id });
    conversationId = c.id;
  }

  // Cost guard: daily inference cap per organization.
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const [{ used }] = await db
    .select({ used: count() })
    .from(inferenceRecords)
    .where(and(eq(inferenceRecords.orgId, input.agent.orgId), gte(inferenceRecords.requestedAt, dayStart)));
  if (used >= deps.dailyOrgLimit) {
    throw new RunAgentError("daily_limit", "This organization has reached today's AI response limit.");
  }

  const history = (
    await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.orgId, input.agent.orgId)))
      .orderBy(desc(messages.createdAt))
      .limit(10)
  ).reverse();

  await db.insert(messages).values({
    orgId: input.agent.orgId,
    agentId: input.agent.agentId,
    conversationId,
    role: "user",
    content: userMessage,
  });

  // Retrieval. If embeddings are unavailable the agent still runs, and the policy makes it use the fallback answer.
  let passages: RetrievedPassage[] = [];
  let retrieval: RunAgentResult["retrieval"] = { status: "ok", passages: 0 };
  try {
    const embedding = await deps.embedder.embedQuery(userMessage);
    passages = await retrievePassages(db, input.agent, { embedding, model: deps.embedder.model }, { k: config.retrievalTopK, minScore: 0.2 });
    retrieval = { status: "ok", passages: passages.length };
  } catch (error) {
    if (!(error instanceof EmbeddingError)) throw error;
    retrieval = { status: "unavailable", passages: 0, reason: error.message };
  }

  const prompt = buildMessages({ agent: config, passages, history, userMessage });
  const verifyTee = config.trustMode !== "standard";
  const [record] = await db
    .insert(inferenceRecords)
    .values({
      orgId: input.agent.orgId,
      agentId: input.agent.agentId,
      conversationId,
      configId: config.id,
      modelId: config.modelId,
      trustModeRequested: config.trustMode,
      verifyTeeRequested: verifyTee,
      status: "requested",
    })
    .returning({ id: inferenceRecords.id });

  const saveReply = async (content: string, citations: Citation[], isFallback: boolean) => {
    const [m] = await db
      .insert(messages)
      .values({ orgId: input.agent.orgId, agentId: input.agent.agentId, conversationId: conversationId!, role: "assistant", content, citations, inferenceId: record.id, isFallback })
      .returning({ id: messages.id });
    await db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, conversationId!));
    return m.id;
  };

  const disableThinking = await deps.modelSupports(config.modelId, "chat_template_kwargs").catch(() => false);
  try {
    const result = await deps.chat.complete({
      model: config.modelId,
      messages: prompt,
      trustMode: config.trustMode,
      temperature: config.temperature,
      maxTokens: config.maxOutputTokens,
      disableThinking,
    });

    await db
      .update(inferenceRecords)
      .set({
        status: "completed",
        routerRequestId: result.trace.requestId,
        chatId: result.chatId,
        providerAddress: result.trace.provider,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costAmount: result.trace.cost?.amount ?? null,
        costUnit: result.trace.cost?.unit ?? null,
        latencyMs: result.latencyMs,
        completedAt: new Date(),
      })
      .where(eq(inferenceRecords.id, record.id));

    const routerStatus = verificationStatusFrom(result.verifyTeeRequested, result.trace.teeVerified);
    await db.insert(verificationRecords).values({
      orgId: input.agent.orgId,
      inferenceId: record.id,
      method: "router",
      status: routerStatus,
      details: { teeVerified: result.trace.teeVerified, provider: result.trace.provider, verifyTeeRequested: result.verifyTeeRequested },
    });

    let effective: NonNullable<RunAgentResult["verification"]> = { status: routerStatus, method: "router", reason: null, signerAddress: null };
    if (result.verifyTeeRequested) {
      const independent = await deps
        .verifyTee({ provider: result.trace.provider, chatId: result.chatId })
        .catch((): TeeVerification => ({ status: "unavailable", reason: "Independent verification failed to run.", signerAddress: null, details: {} }));
      await db.insert(verificationRecords).values({
        orgId: input.agent.orgId,
        inferenceId: record.id,
        method: "independent",
        status: independent.status,
        signerAddress: independent.signerAddress,
        details: { ...independent.details, reason: independent.reason },
      });
      // Any failed check wins (untrusted). Otherwise prefer the independent result when it reached a verdict.
      if (independent.status === "failed" || (routerStatus !== "failed" && independent.status === "verified")) {
        effective = { status: independent.status, method: "independent", reason: independent.reason, signerAddress: independent.signerAddress };
      } else if (routerStatus === "unavailable") {
        effective = { status: "unavailable", method: "independent", reason: independent.reason, signerAddress: null };
      }
    }
    const vStatus = effective.status;

    // A response whose TEE signature failed verification is untrusted: never show it; show the fallback instead.
    let content: string;
    let citations: Citation[] = [];
    let isFallback: boolean;
    let error: RunAgentResult["error"];
    if (vStatus === "failed") {
      content = config.fallbackMessage;
      isFallback = true;
      error = { code: "provider_error", message: "The response failed TEE signature verification, so it was withheld." };
    } else if (!result.content) {
      content = config.fallbackMessage;
      isFallback = true;
    } else {
      const extracted = extractCitations(result.content, passages);
      isFallback = isFallbackAnswer(extracted.text, config.fallbackMessage);
      content = isFallback ? config.fallbackMessage : extracted.text.slice(0, 20_000);
      citations = isFallback ? [] : extracted.citations;
    }
    const messageId = await saveReply(content, citations, isFallback);
    return {
      conversationId,
      reply: { messageId, content, citations, isFallback },
      inference: {
        id: record.id,
        status: "completed",
        modelId: config.modelId,
        trustMode: config.trustMode,
        providerAddress: result.trace.provider,
        routerRequestId: result.trace.requestId,
        latencyMs: result.latencyMs,
      },
      verification: effective,
      retrieval,
      error,
    };
  } catch (error) {
    if (!(error instanceof InferenceError)) {
      await db.update(inferenceRecords).set({ status: "failed", errorCode: "internal", completedAt: new Date() }).where(eq(inferenceRecords.id, record.id));
      throw error;
    }
    await db
      .update(inferenceRecords)
      .set({
        status: "failed",
        errorCode: error.details.routerCode ?? error.code,
        errorType: error.details.routerType ?? null,
        httpStatus: error.details.httpStatus ?? null,
        routerRequestId: error.details.requestId ?? null,
        completedAt: new Date(),
      })
      .where(eq(inferenceRecords.id, record.id));
    const messageId = await saveReply(config.fallbackMessage, [], true);
    return {
      conversationId,
      reply: { messageId, content: config.fallbackMessage, citations: [], isFallback: true },
      inference: {
        id: record.id,
        status: "failed",
        modelId: config.modelId,
        trustMode: config.trustMode,
        providerAddress: null,
        routerRequestId: error.details.requestId ?? null,
        latencyMs: null,
      },
      verification: null,
      retrieval,
      error: { code: error.code, message: error.message },
    };
  }
}

/** Verification activity for the dashboard (last 7 days, real records only). */
export async function verificationSummary(db: Database, orgId: string) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const inference = await db
    .select({ status: inferenceRecords.status, trustMode: inferenceRecords.trustModeRequested, n: count() })
    .from(inferenceRecords)
    .where(and(eq(inferenceRecords.orgId, orgId), gte(inferenceRecords.requestedAt, since)))
    .groupBy(inferenceRecords.status, inferenceRecords.trustModeRequested);
  // One effective status per inference: a failure from any method wins, then a verified result, then the rest.
  const rows = await db.execute<{ status: string; n: number }>(sql`
    select status, count(*)::int as n from (
      select distinct on (v.inference_id) v.status
      from verification_records v
      join inference_records i on i.id = v.inference_id
      where v.org_id = ${orgId} and i.requested_at >= ${since.toISOString()}::timestamptz
      order by v.inference_id,
        case v.status when 'failed' then 0 when 'verified' then 1 when 'unavailable' then 2 else 3 end
    ) t group by status`);
  const verification = [...rows].map((r) => ({ status: r.status, n: Number(r.n) }));
  return { inference, verification };
}

/** Messages of a conversation the caller is allowed to see (scope enforced by orgId + agentId). */
export async function conversationMessages(db: Database, agent: RunAgentInput["agent"], conversationId: string) {
  return db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      citations: messages.citations,
      isFallback: messages.isFallback,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.agentId, agent.agentId), eq(messages.orgId, agent.orgId)))
    .orderBy(asc(messages.createdAt));
}

