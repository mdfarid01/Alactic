import type { Database } from "@/server/db/client";
import { verificationRecords, type VerificationStatus } from "@/server/db/schema";
import { verificationStatusFrom } from "@/server/inference/router-client";
import type { TeeVerification } from "@/server/inference/tee-verifier";

export type EffectiveVerification = { status: VerificationStatus; method: "router" | "independent"; reason: string | null; signerAddress: string | null };

/**
 * Record the Router's TEE verdict and (when TEE verification was requested) an independent signature check, then return
 * the strongest evidence: any failed check wins; otherwise a verified independent check; otherwise the Router's report.
 * Used for every 0G inference (answers, transcriptions, screenshot reading).
 */
export async function recordVerification(
  deps: { db: Database; verifyTee: (input: { provider: string | null; chatId: string | null }) => Promise<TeeVerification> },
  orgId: string,
  inferenceId: string,
  evidence: { verifyTeeRequested: boolean; teeVerified: boolean | null; provider: string | null; chatId: string | null },
): Promise<EffectiveVerification> {
  const routerStatus = verificationStatusFrom(evidence.verifyTeeRequested, evidence.teeVerified);
  await deps.db.insert(verificationRecords).values({
    orgId,
    inferenceId,
    method: "router",
    status: routerStatus,
    details: { teeVerified: evidence.teeVerified, provider: evidence.provider, verifyTeeRequested: evidence.verifyTeeRequested },
  });

  let effective: EffectiveVerification = { status: routerStatus, method: "router", reason: null, signerAddress: null };
  if (evidence.verifyTeeRequested) {
    const independent = await deps
      .verifyTee({ provider: evidence.provider, chatId: evidence.chatId })
      .catch((): TeeVerification => ({ status: "unavailable", reason: "Independent verification failed to run.", signerAddress: null, details: {} }));
    await deps.db.insert(verificationRecords).values({
      orgId,
      inferenceId,
      method: "independent",
      status: independent.status,
      signerAddress: independent.signerAddress,
      details: { ...independent.details, reason: independent.reason },
    });
    if (independent.status === "failed" || (routerStatus !== "failed" && independent.status === "verified")) {
      effective = { status: independent.status, method: "independent", reason: independent.reason, signerAddress: independent.signerAddress };
    } else if (routerStatus === "unavailable") {
      effective = { status: "unavailable", method: "independent", reason: independent.reason, signerAddress: null };
    }
  }
  return effective;
}
