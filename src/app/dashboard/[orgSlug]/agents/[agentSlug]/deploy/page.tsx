import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { CopyField, OriginsForm, PublishControls } from "@/components/agents/deploy-controls";
import { AgentStatusBadge } from "@/components/agents/trust-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAgentForEdit } from "@/server/agents/service";
import { db } from "@/server/db/client";
import { appOrigin, env } from "@/server/env";
import { getPageOrgScope } from "@/server/orgs/page-scope";
import { roleAtLeast } from "@/server/orgs/service";

export const metadata: Metadata = { title: "Deploy" };

export default function DeployPage({ params }: PageProps<"/dashboard/[orgSlug]/agents/[agentSlug]/deploy">) {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <Deploy params={params} />
    </Suspense>
  );
}

async function Deploy({ params }: { params: PageProps<"/dashboard/[orgSlug]/agents/[agentSlug]/deploy">["params"] }) {
  const { orgSlug, agentSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  const data = await getAgentForEdit(db(), scope, agentSlug);
  if (!data) notFound();
  const { agent, isDraft, published } = data;
  const canEdit = roleAtLeast(scope.role, "admin");
  const origin = appOrigin().origin;
  const publicUrl = `${origin}/a/${agent.slug}`;
  const snippet = `<script src="${origin}/widget.js" data-agent="${agent.slug}" async></script>`;
  const live = agent.status === "published";

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                Publishing <AgentStatusBadge status={agent.status} hasUnpublishedChanges={agent.status === "published" && isDraft} />
              </CardTitle>
              <CardDescription className="mt-1">
                {published
                  ? `Version ${published.version} is the live version${live ? "" : " (currently offline)"}. Publishing freezes your current draft as a new version.`
                  : "Publishing freezes your current configuration as version 1 and makes the agent available to the public."}
              </CardDescription>
            </div>
            <PublishControls orgSlug={scope.orgSlug} agentSlug={agent.slug} status={agent.status} hasUnpublishedChanges={isDraft} canEdit={canEdit} />
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Public chat page</CardTitle>
          <CardDescription>Share this link. Visitors don&apos;t need a wallet or an account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CopyField value={publicUrl} label="public URL" />
          {live ? (
            <Link href={`/a/${agent.slug}`} target="_blank" className="inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline">
              Open public page <ExternalLink className="size-3.5" />
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">Available after you publish.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Website widget</CardTitle>
          <CardDescription>Paste this before the closing &lt;/body&gt; tag of your website.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CopyField value={snippet} label="widget snippet" multiline />
          {live ? (
            <Link href={`/demo/${agent.slug}`} target="_blank" className="inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline">
              Try it on a demo page <ExternalLink className="size-3.5" />
            </Link>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sites allowed to embed the widget</CardTitle>
          <CardDescription>Stops other websites from showing your agent (and spending your AI budget).</CardDescription>
        </CardHeader>
        <CardContent>
          <OriginsForm orgSlug={scope.orgSlug} agentSlug={agent.slug} origins={agent.allowedOrigins} canEdit={canEdit} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            ENS identity <Badge variant="secondary">Soon</Badge>
          </CardTitle>
          <CardDescription>Planned public name, managed by Alactic. Not on-chain yet.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-sm">
            {agent.slug}.{env().ENS_PARENT_NAME}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
