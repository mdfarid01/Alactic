import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { Bot, Plus } from "lucide-react";
import { AgentStatusBadge, TrustBadge } from "@/components/agents/trust-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { listAgents } from "@/server/agents/service";
import { db } from "@/server/db/client";
import { getPageOrgScope } from "@/server/orgs/page-scope";
import { roleAtLeast } from "@/server/orgs/service";

export const metadata: Metadata = { title: "Agents" };

export default function AgentsPage({ params }: PageProps<"/dashboard/[orgSlug]/agents">) {
  return (
    <Suspense fallback={<Skeleton className="h-48 w-full" />}>
      <Agents params={params} />
    </Suspense>
  );
}

async function Agents({ params }: { params: PageProps<"/dashboard/[orgSlug]/agents">["params"] }) {
  const { orgSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  const agents = await listAgents(db(), scope);
  const canCreate = roleAtLeast(scope.role, "admin");
  const base = `/dashboard/${scope.orgSlug}/agents`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {agents.length} {agents.length === 1 ? "agent" : "agents"}
        </p>
        {canCreate ? (
          <Link href={`${base}/new`} className={buttonVariants({ size: "sm" })}>
            <Plus /> New agent
          </Link>
        ) : null}
      </div>
      {agents.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Bot className="size-8 text-muted-foreground" aria-hidden />
            <p className="font-medium">No agents yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {canCreate ? "Create your first support agent to get started." : "Ask an owner or admin to create one."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {agents.map((a) => (
            <Link
              key={a.id}
              href={`${base}/${a.slug}`}
              className="flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="font-medium">{a.name}</p>
                <p className="truncate text-sm text-muted-foreground">{a.description || <span className="font-mono">/{a.slug}</span>}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{a.modelId}</span>
                <TrustBadge mode={a.trustMode} />
                <AgentStatusBadge status={a.status} hasUnpublishedChanges={a.hasUnpublishedChanges} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
