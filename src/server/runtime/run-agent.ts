import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import {
  agentConfigs,
  agents,
  conversations,
  inferenceRecords,
  messages,
  type Citation,
  type ConversationChannel,
  type VerificationStatus,
} from "@/server/db/schema";
import type { EmbeddingProvider } from "@/server/knowledge/embeddings";
import { EmbeddingError } from "@/server/knowledge/embeddings";
import { retrievePassages, type RetrievedPassage } from "@/server/knowledge/retrieval";
import { InferenceError, type ChatClient, type Transcriber } from "@/server/inference/router-client";
import type { TeeVerification } from "@/server/inference/tee-verifier";
import { answerFingerprint } from "@/lib/answer-fingerprint";
import { recordGap } from "@/server/gaps/service";
import { AttachmentError, processAttachment, type Attachment, type PreInference } from "./attachments";
import { extractCitations, isFallbackAnswer } from "./citations";
import { recordVerification } from "./verification";
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
  /** Speech-to-text for voice questions (optional; voice is rejected without it). */
  transcriber?: Transcriber;
  transcriptionModel?: string;
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
  /** Public channels: SHA-256 of the anonymous visitor token. A conversation can only be continued by its visitor. */
  visitorTokenHash?: string | null;
  /** Voice note or screenshot. With a voice note the transcript is the question; with an image, userMessage is an optional caption. */
  attachment?: Attachment | null;
  /** Connector channels: stable external thread key (e.g. "<connectionId>:<chatId>"). Continues that thread's conversation. */
  externalRef?: string | null;
  /** Record unanswered questions in the knowledge-gap inbox (default true; test runs turn it off). */
  recordGaps?: boolean;
};

export type RunAgentErrorCode =
  | "invalid_message"
  | "agent_not_found"
  | "not_published"
  | "conversation_not_found"
  | "daily_limit"
  | AttachmentError["code"]
  | InferenceError["code"];

export type RunAgentResult = {
  conversationId: string;
  /** The question as stored (a voice transcript, or caption + screenshot reading) and the inference that produced it. */
  userTurn: { messageId: string; content: string; attachment: Attachment["kind"] | null; preInference: PreInference | null };
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
  const typed = input.userMessage.replace(/\u0000/g, "").trim();
  const attachment = input.attachment ?? null;
  if (typed.length > MAX_USER_MESSAGE_CHARS || (!typed && !attachment)) {
    throw new RunAgentError("invalid_message", `Messages must be between 1 and ${MAX_USER_MESSAGE_CHARS} characters.`);
  }
  if (attachment?.kind === "voice" && typed) throw new RunAgentError("invalid_message", "Send a voice note or text, not both.");

  const config = await loadConfig(db, input.agent, input.configVersion);
  if (!config) throw new RunAgentError("agent_not_found", "Agent not found.");

  // Public web/widget chats always belong to an anonymous visitor (also enforced by a DB check constraint).
  const isPublic = input.channel === "web" || input.channel === "widget";
  if (isPublic && !input.visitorTokenHash) throw new RunAgentError("invalid_message", "Missing visitor session. Reload the page.");

  // Conversation (must belong to this agent, org and channel, and for public channels to this visitor).
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
          input.visitorTokenHash ? eq(conversations.visitorTokenHash, input.visitorTokenHash) : undefined,
        ),
      )
      .limit(1);
    if (!c) throw new RunAgentError("conversation_not_found", "Conversation not found.");
  } else {
    // Connector threads continue their existing conversation (same agent, org, channel and external thread key).
    const existing = input.externalRef
      ? (
          await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.agentId, input.agent.agentId),
                eq(conversations.orgId, input.agent.orgId),
                eq(conversations.channel, input.channel),
                eq(conversations.externalRef, input.externalRef),
              ),
            )
            .orderBy(desc(conversations.lastMessageAt))
            .limit(1)
        )[0]
      : undefined;
    if (existing) {
      conversationId = existing.id;
    } else {
      const [c] = await db
        .insert(conversations)
        .values({
          orgId: input.agent.orgId,
          agentId: input.agent.agentId,
          channel: input.channel,
          externalRef: input.externalRef ?? null,
          startedBy: input.startedBy ?? null,
          visitorTokenHash: input.visitorTokenHash ?? null,
        })
        .returning({ id: conversations.id });
      conversationId = c.id;
    }
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

  const disableThinking = await deps.modelSupports(config.modelId, "chat_template_kwargs").catch(() => false);

  // Voice note / screenshot → text, via one recorded 0G inference in the agent's trust mode.
  let userMessage = typed;
  let pre: PreInference | null = null;
  if (attachment) {
    try {
      const processed = await processAttachment(
        deps,
        { orgId: input.agent.orgId, agentId: input.agent.agentId, conversationId, configId: config.id, chatModel: config.modelId, trustMode: config.trustMode, disableThinking },
        attachment,
        typed,
      );
      pre = processed.pre;
      userMessage =
        attachment.kind === "voice"
          ? processed.text.slice(0, MAX_USER_MESSAGE_CHARS)
          : `${typed || "(The customer sent a screenshot without text.)"}\n\n[Screenshot contents, as read by AI: ${processed.text}]`;
    } catch (error) {
      if (error instanceof AttachmentError) throw new RunAgentError(error.code, error.message);
      throw error;
    }
  }

  const [userRow] = await db
    .insert(messages)
    .values({
      orgId: input.agent.orgId,
      agentId: input.agent.agentId,
      conversationId,
      role: "user",
      content: userMessage,
      attachmentKind: attachment?.kind ?? null,
      preInferenceId: pre?.id ?? null,
    })
    .returning({ id: messages.id });
  const userTurn: RunAgentResult["userTurn"] = { messageId: userRow.id, content: userMessage, attachment: attachment?.kind ?? null, preInference: pre };

  // Retrieval. If embeddings are unavailable the agent still runs, and the policy makes it use the fallback answer.
  let passages: RetrievedPassage[] = [];
  let retrieval: RunAgentResult["retrieval"] = { status: "ok", passages: 0 };
  let queryEmbedding: number[] | null = null;
  try {
    const embedding = await deps.embedder.embedQuery(userMessage);
    queryEmbedding = embedding;
    passages = await retrievePassages(db, input.agent, { embedding, model: deps.embedder.model }, { k: config.retrievalTopK, minScore: 0.2 });
    retrieval = { status: "ok", passages: passages.length };
  } catch (error) {
    if (!(error instanceof EmbeddingError)) throw error;
    retrieval = { status: "unavailable", passages: 0, reason: error.message };
  }

  const prompt = buildMessages({ agent: config, passages, history, userMessage, inputKind: attachment?.kind ?? "text" });
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
    // Fingerprint of exactly what the customer sees, published on the proof receipt.
    await db.update(inferenceRecords).set({ answerSha256: await answerFingerprint(record.id, content) }).where(eq(inferenceRecords.id, record.id));
    return m.id;
  };

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

    const effective = await recordVerification(deps, input.agent.orgId, record.id, {
      verifyTeeRequested: result.verifyTeeRequested,
      teeVerified: result.trace.teeVerified,
      provider: result.trace.provider,
      chatId: result.chatId,
    });
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
    // The model itself said it couldn't answer from the knowledge: record a knowledge gap for the owner's inbox.
    // (Failed inference or withheld responses are outages, not gaps.) Never let this break the reply.
    if (input.recordGaps !== false && isFallback && vStatus !== "failed" && result.content) {
      await recordGap(db, input.agent, {
        question: userMessage,
        channel: input.channel,
        messageId: userRow.id,
        embedding: queryEmbedding,
        embeddingModel: queryEmbedding ? deps.embedder.model : null,
      }).catch(() => console.error("[runtime] failed to record knowledge gap"));
    }
    return {
      conversationId,
      userTurn,
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
      userTurn,
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

