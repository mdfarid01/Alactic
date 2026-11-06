import { Suspense } from "react";
import type { Metadata } from "next";
import { CreateAgentForm } from "@/components/agents/create-agent-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { env } from "@/server/env";
import { requirePageOrgRole } from "@/server/orgs/page-scope";

export const metadata: Metadata = { title: "New agent" };

export default function NewAgentPage({ params }: PageProps<"/dashboard/[orgSlug]/agents/new">) {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full max-w-2xl" />}>
      <NewAgent params={params} />
    </Suspense>
  );
}

async function NewAgent({ params }: { params: PageProps<"/dashboard/[orgSlug]/agents/new">["params"] }) {
  const { orgSlug } = await params;
  const scope = await requirePageOrgRole(orgSlug, "admin");
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>New agent</CardTitle>
        <CardDescription>Give your agent a name. You&apos;ll configure its behavior and model next.</CardDescription>
      </CardHeader>
      <CardContent>
        <CreateAgentForm orgSlug={scope.orgSlug} ensParent={env().ENS_PARENT_NAME} />
      </CardContent>
    </Card>
  );
}
