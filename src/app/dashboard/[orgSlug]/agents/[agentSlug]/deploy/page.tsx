import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Receipt } from "lucide-react";
import { CopyField, OriginsForm, PublishButtons } from "@/components/agents/deploy-controls";
import { TrustBadge } from "@/components/agents/trust-badge";
import { VerificationBadge } from "@/components/agents/verification-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAgentForEdit } from "@/server/agents/service";
import { db } from "@/server/db/client";
import { publicUsage, recentPublicAnswers } from "@/server/deploy/service";
import { appOrigin } from "@/server/env";
import { getPageOrgScope } from "@/server/orgs/page-scope";
import { roleAtLeast } from "@/server/orgs/service";
import { latestRunForConfig } from "@/server/tests/service";

export const metadata: Metadata = { title: "Deploy" };

type Params = PageProps<"/dashboard/[orgSlug]/agents/[agentSlug]/deploy">["params"];

export default function DeployPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<Skeleton className="h-[520px] w-full" />}>
      <Deploy params={params} />
    </Suspense>
  );
}

async function Deploy({ params }: { params: Params }) {
  const { orgSlug, agentSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  const data = await getAgentForEdit(db(), scope, agentSlug);
  if (!data) notFound();
  const { agent, config, isDraft, published } = data;
  const [answers, usage, testRun] = await Promise.all([
    recentPublicAnswers(db(), scope, agent.id),
    publicUsage(db(), scope, agent.id),
    latestRunForConfig(db(), scope, agent.id, config.id),
  ]);
  const origin = appOrigin().origin;
  const publicUrl = `${origin}/a/${agent.slug}`;
  const snippet = `<script src="${origin}/widget.js" data-agent="${agent.slug}" async></script>`;
  const live = agent.status === "published";

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Publishing</CardTitle>
            <CardDescription>
              {published
                ? `Version ${published.version} is ${live ? "live" : "paused"}.${isDraft ? ` Draft version ${config.version} has unpublished changes.` : ""}`
                : "Not published yet. Publishing freezes the current draft as an immutable version that visitors talk to."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {isDraft ? (
              testRun && testRun.status !== "running" ? (
                <p className={`text-sm ${testRun.status === "passed" ? "text-success" : "text-warning"}`}>
                  Tests on this draft: {testRun.passed}/{testRun.total} passed.
                  {testRun.status !== "passed" ? " Review the failures before publishing." : ""}{" "}
                  <Link href={`/dashboard/${scope.orgSlug}/agents/${agent.slug}/tests`} className="underline underline-offset-4">
                    View tests
                  </Link>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  This draft hasn&apos;t been tested.{" "}
                  <Link href={`/dashboard/${scope.orgSlug}/agents/${agent.slug}/tests`} className="underline underline-offset-4">
                    Run your golden questions
                  </Link>{" "}
                  before publishing.
                </p>
              )
            ) : null}
            <PublishButtons
              orgSlug={scope.orgSlug}
              agentSlug={agent.slug}
              canPublish={roleAtLeast(scope.role, "admin")}
              hasUnpublishedChanges={isDraft}
              status={agent.status}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Public chat page</CardTitle>
            <CardDescription>Anyone can chat with the published version here. No wallet or account needed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <CopyField value={publicUrl} label="public chat URL" />
            {live ? (
              <Link href={`/a/${agent.slug}`} target="_blank" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Open public page <ExternalLink />
              </Link>
            ) : (
              <p className="text-sm text-muted-foreground">The page shows &ldquo;not available&rdquo; until the agent is published and live.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Website widget</CardTitle>
            <CardDescription>Paste this before the closing &lt;/body&gt; tag. A chat bubble appears in the bottom-right corner.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <CopyField value={snippet} label="widget snippet" multiline />
            <p className="text-xs text-muted-foreground">The widget runs in an isolated iframe served by Alactic, so no keys or styles leak into your site.</p>
            <Link href={`/demo/${agent.slug}`} target="_blank" className="text-xs underline underline-offset-4">
              Try it on a demo store page
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sites allowed to embed the widget</CardTitle>
            <CardDescription>Leave empty to allow only Alactic&apos;s own pages.</CardDescription>
          </CardHeader>
          <CardContent>
            <OriginsForm orgSlug={scope.orgSlug} agentSlug={agent.slug} origins={agent.allowedOrigins} canEdit={roleAtLeast(scope.role, "admin")} />
          </CardContent>
        </Card>
      </div>

      <aside className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Last 7 days (public)</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm">
            <Stat label="Conversations" value={usage.conversations} />
            <Stat label="AI answers" value={usage.completed} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Receipt className="size-4" /> Proof receipts
            </CardTitle>
            <CardDescription>Every public answer gets a public receipt anyone can check. Receipts never include the conversation.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {answers.length === 0 ? <p className="text-sm text-muted-foreground">No public answers yet.</p> : null}
            {answers.map((a) => (
              <Link key={a.id} href={`/proof/${a.id}`} target="_blank" className="block rounded-md border p-2 text-xs hover:bg-muted">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    {a.requestedAt.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" })} UTC · {a.channel}
                  </span>
                  <TrustBadge mode={a.trustMode} />
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="font-mono">{a.routerRequestId ? `req ${a.routerRequestId.slice(0, 8)}` : a.status}</span>
                  <VerificationBadge verification={{ status: a.verification ?? "no_inference" }} />
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
