import { Suspense } from "react";
import Link from "next/link";
import { Bot, BookOpen, MessagesSquare, ShieldCheck, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/server/db/client";
import { getPageOrgScope } from "@/server/orgs/page-scope";
import { countMembers, roleAtLeast } from "@/server/orgs/service";
import { listAgents } from "@/server/agents/service";
import { AgentStatusBadge, TrustBadge } from "@/components/agents/trust-badge";

export default function OrgOverviewPage({ params }: PageProps<"/dashboard/[orgSlug]">) {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <Overview params={params} />
    </Suspense>
  );
}

async function Overview({ params }: { params: PageProps<"/dashboard/[orgSlug]">["params"] }) {
  const { orgSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  const [members, agents] = await Promise.all([countMembers(db(), scope), listAgents(db(), scope)]);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="md:col-span-2">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Bot className="size-4 text-brand" aria-hidden /> Agents
            </CardTitle>
            <Link href={`/dashboard/${scope.orgSlug}/agents`} className="text-sm font-medium underline-offset-4 hover:underline">
              View all
            </Link>
          </div>
          <CardDescription>Support agents in this organization and the trust mode each one runs in.</CardDescription>
        </CardHeader>
        <CardContent>
          {agents.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No agents yet.{" "}
              {roleAtLeast(scope.role, "admin") ? (
                <Link href={`/dashboard/${scope.orgSlug}/agents/new`} className="font-medium text-foreground underline-offset-4 hover:underline">
                  Create your first agent
                </Link>
              ) : null}
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {agents.slice(0, 5).map((a) => (
                <li key={a.id}>
                  <Link href={`/dashboard/${scope.orgSlug}/agents/${a.slug}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/40">
                    <span className="font-medium">{a.name}</span>
                    <span className="flex items-center gap-2">
                      <TrustBadge mode={a.trustMode} />
                      <AgentStatusBadge status={a.status} hasUnpublishedChanges={a.hasUnpublishedChanges} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <EmptyStat icon={BookOpen} title="Knowledge" body="Website, document and FAQ sources with indexing status will appear here." />
      <EmptyStat icon={MessagesSquare} title="Conversations" body="Recent conversations across all channels will appear here." />
      <EmptyStat icon={ShieldCheck} title="Verification activity" body="Inference trust modes and TEE verification results will appear here." />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4 text-brand" aria-hidden /> Team
          </CardTitle>
          <CardDescription>
            {members} {members === 1 ? "member" : "members"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={`/dashboard/${scope.orgSlug}/members`} className="text-sm font-medium underline-offset-4 hover:underline">
            Manage members
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyStat({ icon: Icon, title, body }: { icon: typeof Bot; title: string; body: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4 text-muted-foreground" aria-hidden /> {title}
        </CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      </CardContent>
    </Card>
  );
}
