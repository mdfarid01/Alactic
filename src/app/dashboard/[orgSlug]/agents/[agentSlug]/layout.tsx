import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { AgentTabs } from "@/components/agents/agent-tabs";
import { AgentStatusBadge, TrustBadge } from "@/components/agents/trust-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getAgentForEdit } from "@/server/agents/service";
import { db } from "@/server/db/client";
import { getPageOrgScope } from "@/server/orgs/page-scope";

type Props = LayoutProps<"/dashboard/[orgSlug]/agents/[agentSlug]">;

export default function AgentLayout({ children, params }: Props) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<Skeleton className="h-20 w-80" />}>
        <AgentHeader params={params} />
      </Suspense>
      {children}
    </div>
  );
}

async function AgentHeader({ params }: { params: Props["params"] }) {
  const { orgSlug, agentSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  const data = await getAgentForEdit(db(), scope, agentSlug);
  if (!data) notFound();
  const base = `/dashboard/${scope.orgSlug}/agents/${data.agent.slug}`;
  return (
    <div className="space-y-3">
      <Link href={`/dashboard/${scope.orgSlug}/agents`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> Agents
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold tracking-tight">{data.config.name}</h2>
        <AgentStatusBadge status={data.agent.status} hasUnpublishedChanges={data.agent.status === "published" && data.isDraft} />
        <TrustBadge mode={data.config.trustMode} />
      </div>
      <AgentTabs base={base} />
    </div>
  );
}
