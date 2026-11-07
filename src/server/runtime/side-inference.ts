import { eq } from "drizzle-orm";
import { answerFingerprint } from "@/lib/answer-fingerprint";
import type { Database } from "@/server/db/client";
import { inferenceRecords } from "@/server/db/schema";
import { InferenceError, type ChatClient, type ChatMessage } from "@/server/inference/router-client";
import type { TeeVerification } from "@/server/inference/tee-verifier";
import { recordVerification, type EffectiveVerification } from "./verification";

export type SideInferenceDeps = {
  db: Database;
  chat: ChatClient;
  verifyTee: (input: { provider: string | null; chatId: string | null }) => Promise<TeeVerification>;
  modelSupports: (modelId: string, parameter: string) => Promise<boolean>;
};

/**
 * A recorded 0G completion that isn't a customer-facing answer (handoff summaries, gap drafts, digests): same trust
 * mode as the agent (never downgraded), inference record + verification + answer fingerprint, so it has a proof receipt.
 * Returns null content if the TEE signature failed verification (the output is withheld).
 */
export async function runSideInference(
  deps: SideInferenceDeps,
  ctx: { orgId: string; agentId: string; conversationId: string; configId: string | null; modelId: string; trustMode: "private" | "verified" | "standard" },
  messages: ChatMessage[],
  opts: { maxTokens: number; temperature?: number },
): Promise<{ content: string | null; inferenceId: string; verification: EffectiveVerification | null }> {
  const [record] = await deps.db
    .insert(inferenceRecords)
    .values({
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      configId: ctx.configId,
      modelId: ctx.modelId,
      trustModeRequested: ctx.trustMode,
      verifyTeeRequested: ctx.trustMode !== "standard",
      status: "requested",
    })
    .returning({ id: inferenceRecords.id });
  try {
    const disableThinking = await deps.modelSupports(ctx.modelId, "chat_template_kwargs").catch(() => false);
    const r = await deps.chat.complete({ model: ctx.modelId, trustMode: ctx.trustMode, messages, temperature: opts.temperature ?? 0.2, maxTokens: opts.maxTokens, disableThinking });
    await deps.db
      .update(inferenceRecords)
      .set({
        status: "completed",
        routerRequestId: r.trace.requestId,
        chatId: r.chatId,
        providerAddress: r.trace.provider,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costAmount: r.trace.cost?.amount ?? null,
        costUnit: r.trace.cost?.unit ?? null,
        latencyMs: r.latencyMs,
        completedAt: new Date(),
      })
      .where(eq(inferenceRecords.id, record.id));
    const verification = await recordVerification(deps, ctx.orgId, record.id, { verifyTeeRequested: r.verifyTeeRequested, teeVerified: r.trace.teeVerified, provider: r.trace.provider, chatId: r.chatId });
    if (verification.status === "failed") return { content: null, inferenceId: record.id, verification };
    const content = r.content.trim();
    await deps.db.update(inferenceRecords).set({ answerSha256: await answerFingerprint(record.id, content) }).where(eq(inferenceRecords.id, record.id));
    return { content, inferenceId: record.id, verification };
  } catch (error) {
    if (!(error instanceof InferenceError)) throw error;
    await deps.db
      .update(inferenceRecords)
      .set({ status: "failed", errorCode: error.details.routerCode ?? error.code, httpStatus: error.details.httpStatus ?? null, routerRequestId: error.details.requestId ?? null, completedAt: new Date() })
      .where(eq(inferenceRecords.id, record.id));
    return { content: null, inferenceId: record.id, verification: null };
  }
}
