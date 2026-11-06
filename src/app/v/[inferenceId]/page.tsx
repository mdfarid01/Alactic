import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Brand } from "@/components/layout/brand";
import { TrustBadge } from "@/components/agents/trust-badge";
import { VerificationBadge } from "@/components/agents/verification-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { publicInferenceEvidence } from "@/server/public/agents";

export const metadata: Metadata = { title: "Verification" };

export default function VerificationPage({ params }: PageProps<"/v/[inferenceId]">) {
  return (
    <div className="flex min-h-full flex-col bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-3xl items-center px-4">
          <Brand />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <Evidence params={params} />
        </Suspense>
      </main>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-all">{children}</dd>
    </div>
  );
}

async function Evidence({ params }: { params: PageProps<"/v/[inferenceId]">["params"] }) {
  const { inferenceId } = await params;
  const ev = await publicInferenceEvidence(db(), inferenceId);
  if (!ev) notFound();
  const independent = ev.checks.find((c) => c.method === "independent");
  const router = ev.checks.find((c) => c.method === "router");
  const effective = ev.checks.find((c) => c.status === "failed") ?? (independent?.status === "verified" ? independent : router) ?? null;
  const details = (independent?.details ?? {}) as Record<string, unknown>;
  const e = env();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AI response verification</h1>
        <p className="mt-1 text-muted-foreground">
          Evidence for one response from <span className="font-mono">{ev.agentSlug}</span>. The conversation itself isn&apos;t shown.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <TrustBadge mode={ev.trustMode} />
            <VerificationBadge
              verification={
                effective
                  ? { status: effective.status, method: effective.method, signerAddress: effective.signerAddress, reason: (effective.details as { reason?: string } | null)?.reason ?? null }
                  : { status: "no_inference" }
              }
            />
          </CardTitle>
          <CardDescription>
            Verification shows which TEE-hosted model produced the response. It doesn&apos;t mean the answer is correct.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <Row label="Model">{ev.modelId}</Row>
            <Row label="Trust mode requested">{ev.trustMode}</Row>
            <Row label="Inference status">{ev.status}</Row>
            <Row label="0G provider (on-chain)">{ev.providerAddress ?? "—"}</Row>
            <Row label="Chat ID (ZG-Res-Key)">{ev.chatId ?? "—"}</Row>
            <Row label="0G Router request ID">{ev.routerRequestId ?? "—"}</Row>
            <Row label="Time">{ev.requestedAt.toISOString()}</Row>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Checks</CardTitle>
          <CardDescription>Each check is recorded separately. A failure in any check withholds the response.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <p className="font-medium">0G Router report: {router?.status ?? "—"}</p>
            <p className="text-muted-foreground">
              Whether the Router returned <code>tee_verified</code>. Observed on mainnet: the Router currently omits it, so this is usually “unavailable”.
            </p>
          </div>
          <div>
            <p className="font-medium">Independent check by Alactic: {independent?.status ?? "—"}</p>
            {independent ? (
              <dl className="mt-2 divide-y rounded-lg border px-3">
                <Row label="Expected TEE signer">{independent.signerAddress ?? "—"}</Row>
                <Row label="Recovered signer">{String(details.recoveredAddress ?? "—")}</Row>
                <Row label="Provider verifiability">{String(details.verifiability ?? "—")}</Row>
                <Row label="Signed text format">{String(details.signedTextFormat ?? "—")}</Row>
                <Row label="SHA-256 of signed text">{String(details.signedTextSha256 ?? "—")}</Row>
                <Row label="Result">{String(details.reason ?? "—")}</Row>
                <Row label="Service registry">
                  InferenceServing <span className="font-mono">{e.ZG_INFERENCE_CONTRACT}</span> on 0G Chain {e.ZG_CHAIN_ID}
                </Row>
              </dl>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            How to check it yourself: read <code>getService(provider)</code> from the registry, fetch{" "}
            <code>{"{service.url}/v1/proxy/signature/{chatID}?model={service.model}"}</code>, and recover the EIP-191 signer of
            the returned text. It should equal the registered TEE signer.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
