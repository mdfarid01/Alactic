import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlaygroundChat } from "@/components/agents/playground-chat";
import { Skeleton } from "@/components/ui/skeleton";
import { getAgentForEdit } from "@/server/agents/service";
import { db } from "@/server/db/client";
import { inferenceConfigured } from "@/server/inference/config";
import { getPageOrgScope } from "@/server/orgs/page-scope";

export const metadata: Metadata = { title: "Playground" };

export default function PlaygroundPage({ params }: PageProps<"/dashboard/[orgSlug]/agents/[agentSlug]/playground">) {
  return (
    <Suspense fallback={<Skeleton className="h-[520px] w-full" />}>
      <Playground params={params} />
    </Suspense>
  );
}

async function Playground({ params }: { params: PageProps<"/dashboard/[orgSlug]/agents/[agentSlug]/playground">["params"] }) {
  const { orgSlug, agentSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  const data = await getAgentForEdit(db(), scope, agentSlug);
  if (!data) notFound();
  return (
    <PlaygroundChat orgSlug={scope.orgSlug} agentSlug={data.agent.slug} agentName={data.config.name} inferenceConfigured={inferenceConfigured()} />
  );
}
