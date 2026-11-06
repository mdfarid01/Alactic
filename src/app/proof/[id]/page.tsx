import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, CircleSlash, Info, Receipt, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { TrustBadge } from "@/components/agents/trust-badge";
import { AnswerCheck } from "@/components/public/answer-check";
import { BrowserVerifier } from "@/components/public/browser-verifier";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { getPublicProof, type PublicProof } from "@/server/public/service";

type Params = PageProps<"/proof/[id]">["params"];

export const metadata: Metadata = { title: "Proof receipt", robots: { index: false } };

export default function ProofPage({ params }: { params: Params }) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <Suspense fallback={<Skeleton className="h-[600px] w-full" />}>
        <Proof params={params} />
      </Suspense>
    </main>
  );
}

/** One effective verdict: a failure from any check wins, then a verified check, then the rest (same rule as the runtime). */
function effectiveStatus(p: PublicProof) {
  if (p.status !== "completed") return "no_inference" as const;
  if (p.checks.some((c) => c.status === "failed")) return "failed" as const;
  if (p.checks.some((c) => c.status === "verified")) return "verified" as const;
  if (p.checks.some((c) => c.status === "unavailable")) return "unavailable" as const;
  return "not_requested" as const;
}

const VERDICT = {
  verified: { Icon: ShieldCheck, title: "TEE signature verified", body: "A trusted execution environment registered on 0G Chain signed this answer's exchange.", cls: "border-success/40 bg-success/5 text-success" },
  failed: { Icon: ShieldAlert, title: "Verification failed", body: "The signature did not verify, so the answer was withheld and the agent's fallback was shown instead.", cls: "border-destructive/40 bg-destructive/5 text-destructive" },
  unavailable: { Icon: ShieldQuestion, title: "Verification unavailable", body: "Verification was requested but no verdict could be obtained when the answer was produced.", cls: "border-warning/50 bg-warning/5 text-warning" },
  not_requested: { Icon: CircleSlash, title: "Not verifiable (Standard mode)", body: "This agent runs in Standard mode, which has no attestation.", cls: "text-muted-foreground" },
  no_inference: { Icon: CircleSlash, title: "No AI answer", body: "The AI request didn't complete, so the agent's fallback answer was shown and there is nothing to verify.", cls: "text-muted-foreground" },
} as const;

function formatCost(amount: string | null, unit: string | null) {
  if (!amount) return "—";
  if (unit === "usd_micro") {
    const usd = Number(amount) / 1e6;
    return usd < 0.01 ? `$${usd.toFixed(6)}` : `$${usd.toFixed(4)}`;
  }
  return `${amount} ${unit ?? ""}`.trim();
}

async function Proof({ params }: { params: Params }) {
  const { id } = await params;
  const proof = await getPublicProof(db(), id);
  if (!proof) notFound();
  const e = env();
  const status = effectiveStatus(proof);
  const v = VERDICT[status];
  const canVerifyInBrowser = proof.status === "completed" && proof.verifyTeeRequested && !!proof.providerAddress && !!proof.chatId;

  return (
    <>
      <header className="space-y-2">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Receipt className="size-4" /> Alactic proof receipt
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {proof.agent ? (
            <>
              Answer by{" "}
              <Link href={`/a/${proof.agent.slug}`} className="underline-offset-4 hover:underline">
                {proof.agent.name}
              </Link>
            </>
          ) : (
            "AI answer"
          )}
        </h1>
        <p className="text-sm text-muted-foreground">
          {proof.agent ? `${proof.agent.orgName} · ` : ""}
          {proof.requestedAt.toLocaleString("en-US", { dateStyle: "long", timeStyle: "medium", timeZone: "UTC" })} UTC
          {proof.channel === "internal" ? " · internal test (playground)" : ""}
        </p>
      </header>

      <section className={`flex gap-3 rounded-xl border p-4 ${v.cls}`}>
        <v.Icon className="mt-0.5 size-6 shrink-0" />
        <div>
          <p className="font-semibold">{v.title}</p>
          <p className="text-sm opacity-90">{v.body}</p>
        </div>
      </section>

      <section className="rounded-xl border">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Inference record</h2>
        <dl className="divide-y text-sm">
          <Row label="0G Router request ID" value={proof.routerRequestId} mono />
          <Row label="Chat ID (signature key)" value={proof.chatId} mono />
          <Row label="Model" value={proof.modelId} mono />
          <Row label="Trust mode" value={<TrustBadge mode={proof.trustMode} />} />
          <Row label="Provider (on-chain address)" value={proof.providerAddress} mono />
          <Row label="Tokens in / out" value={proof.inputTokens != null ? `${proof.inputTokens} / ${proof.outputTokens ?? "—"}` : null} />
          <Row label="Cost (reported by 0G)" value={formatCost(proof.costAmount, proof.costUnit)} />
          <Row label="Latency" value={proof.latencyMs != null ? `${(proof.latencyMs / 1000).toFixed(2)} s` : null} />
          <Row label="Answer fingerprint (SHA-256)" value={proof.answerSha256} mono />
          <Row label="Receipt ID" value={proof.inferenceId} mono />
        </dl>
      </section>

      {proof.checks.length ? (
        <section className="rounded-xl border">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Checks Alactic ran</h2>
          <ul className="divide-y text-sm">
            {proof.checks.map((c, i) => (
              <li key={i} className="space-y-1 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{c.method === "independent" ? "Independent signature check (Alactic → 0G Chain + provider)" : "0G Router's own TEE check"}</span>
                  <span className={c.status === "verified" ? "text-success" : c.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                    {c.status.replace("_", " ")}
                  </span>
                </div>
                {c.signerAddress ? <p className="font-mono text-xs break-all text-muted-foreground">TEE signer {c.signerAddress}</p> : null}
                {c.details.recoveredAddress ? <p className="font-mono text-xs break-all text-muted-foreground">Recovered {c.details.recoveredAddress}</p> : null}
                {c.details.signedTextSha256 ? <p className="font-mono text-xs break-all text-muted-foreground">Signed text SHA-256 {c.details.signedTextSha256}</p> : null}
                {c.reason ? <p className="text-xs text-muted-foreground">{c.reason}</p> : null}
                <p className="text-xs text-muted-foreground">{c.checkedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" })} UTC</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {proof.answerSha256 ? (
        <section className="space-y-3 rounded-xl border p-4">
          <div>
            <h2 className="text-sm font-semibold">Proof of what support told you</h2>
            <p className="text-sm text-muted-foreground">
              The fingerprint above commits to the exact answer shown to the customer. Anyone holding the answer can prove it is authentic, and this page never sees
              the text.
            </p>
          </div>
          <AnswerCheck inferenceId={proof.inferenceId} expected={proof.answerSha256} />
        </section>
      ) : null}

      {canVerifyInBrowser ? (
        <section className="space-y-3 rounded-xl border p-4">
          <div>
            <h2 className="text-sm font-semibold">Don&apos;t trust us. Verify it yourself.</h2>
            <p className="text-sm text-muted-foreground">Re-run the full check from your own browser against 0G Chain and the provider.</p>
          </div>
          <BrowserVerifier
            provider={proof.providerAddress!}
            chatId={proof.chatId!}
            chain={{ rpcUrl: e.ZG_CHAIN_RPC_URL, chainId: e.ZG_CHAIN_ID, contract: e.ZG_INFERENCE_CONTRACT }}
          />
        </section>
      ) : null}

      <section className="space-y-2 rounded-xl border bg-muted/40 p-4 text-sm">
        <h2 className="flex items-center gap-2 font-semibold">
          <Info className="size-4" /> What this receipt proves
        </h2>
        <ul className="space-y-1.5 text-muted-foreground">
          <li className="flex gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> Which model and which on-chain provider produced the answer, and when.
          </li>
          <li className="flex gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> When verified: a TEE whose signer is registered on 0G Chain signed this chat&apos;s encrypted exchange.
          </li>
          <li className="flex gap-2">
            <CircleSlash className="mt-0.5 size-4 shrink-0" /> It does not prove the answer is correct, and the signature covers the encrypted exchange, not the exact words shown.
          </li>
          <li className="flex gap-2">
            <CircleSlash className="mt-0.5 size-4 shrink-0" /> This page never shows the question, the answer, or the business&apos;s documents.
          </li>
        </ul>
      </section>
    </>
  );
}

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid gap-1 px-4 py-2.5 sm:grid-cols-[220px_1fr]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-xs break-all sm:text-sm" : ""}>{value ?? "—"}</dd>
    </div>
  );
}
