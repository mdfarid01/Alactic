import type { Citation } from "@/server/db/schema";
import type { RunAgentResult } from "@/server/runtime/run-agent";

/** What a public visitor receives for one answer. No internal reasons, retrieval diagnostics or config. */
export type PublicReply = {
  conversationId: string;
  /** How the question was understood (voice transcript / screenshot reading), with the proof for that step. */
  question: {
    content: string;
    attachment: "voice" | "image" | null;
    preInference: { id: string; modelId: string; routerRequestId: string | null; verification: "verified" | "failed" | "unavailable" | "not_requested" } | null;
  };
  messageId: string;
  content: string;
  citations: Pick<Citation, "n" | "title" | "url" | "headingPath" | "pageFrom" | "pageTo" | "sourceType">[];
  isFallback: boolean;
  inference: {
    id: string;
    status: "completed" | "failed";
    modelId: string;
    trustMode: "private" | "verified" | "standard";
    routerRequestId: string | null;
    providerAddress: string | null;
    latencyMs: number | null;
  } | null;
  verification: { status: "verified" | "failed" | "unavailable" | "not_requested"; method: "router" | "independent"; signerAddress: string | null } | null;
};

export function toPublicReply(result: RunAgentResult): PublicReply {
  return {
    conversationId: result.conversationId,
    question: {
      content: result.userTurn.content,
      attachment: result.userTurn.attachment,
      preInference: result.userTurn.preInference
        ? {
            id: result.userTurn.preInference.id,
            modelId: result.userTurn.preInference.modelId,
            routerRequestId: result.userTurn.preInference.routerRequestId,
            verification: result.userTurn.preInference.verification.status,
          }
        : null,
    },
    messageId: result.reply.messageId,
    content: result.reply.content,
    citations: result.reply.citations.map(({ n, title, url, headingPath, pageFrom, pageTo, sourceType }) => ({ n, title, url, headingPath, pageFrom, pageTo, sourceType })),
    isFallback: result.reply.isFallback,
    inference: result.inference
      ? {
          id: result.inference.id,
          status: result.inference.status,
          modelId: result.inference.modelId,
          trustMode: result.inference.trustMode,
          routerRequestId: result.inference.routerRequestId,
          providerAddress: result.inference.providerAddress,
          latencyMs: result.inference.latencyMs,
        }
      : null,
    verification: result.verification
      ? { status: result.verification.status, method: result.verification.method, signerAddress: result.verification.signerAddress }
      : null,
  };
}
