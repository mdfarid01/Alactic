import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Inbox, Sparkles, UserRound } from "lucide-react";
import { GapItem } from "@/components/agents/gap-item";
import { HandoffItem } from "@/components/agents/handoff-item";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/server/db/client";
import { listGaps } from "@/server/gaps/service";
import { listHandoffs } from "@/server/handoff/service";
import { resolveAgent } from "@/server/knowledge/service";
import { KnowledgeError } from "@/server/knowledge/service";
import { getPageOrgScope } from "@/server/orgs/page-scope";
import { roleAtLeast } from "@/server/orgs/service";

export const metadata: Metadata = { title: "Inbox" };

type Params = PageProps<"/dashboard/[orgSlug]/agents/[agentSlug]/inbox">["params"];

export default function InboxPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
      <InboxView params={params} />
    </Suspense>
  );
}

async function InboxView({ params }: { params: Params }) {
  const { orgSlug, agentSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  let open, answered, handoffs;
  try {
    const agent = await resolveAgent(db(), scope, agentSlug);
    [open, answered, handoffs] = await Promise.all([
      listGaps(db(), scope, agentSlug, "open"),
      listGaps(db(), scope, agentSlug, "answered"),
      listHandoffs(db(), scope, { agentId: agent.id }),
    ]);
  } catch (error) {
    if (error instanceof KnowledgeError) notFound();
    throw error;
  }
  const canEdit = roleAtLeast(scope.role, "admin");
  const totalAsks = open.reduce((n, g) => n + g.askCount, 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRound className="size-4" /> Customers waiting for a person ({handoffs.length})
          </CardTitle>
          <CardDescription>Requests from the chat&apos;s &ldquo;Talk to a person&rdquo; option. Each one includes an AI summary generated on 0G, with its own proof receipt.</CardDescription>
        </CardHeader>
        <CardContent>
          {handoffs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Nobody is waiting.</p>
          ) : (
            <ul className="space-y-3">
              {handoffs.map((h) => (
                <HandoffItem
                  key={h.id}
                  orgSlug={scope.orgSlug}
                  h={{
                    id: h.id,
                    channel: h.channel,
                    contact: h.contact,
                    note: h.note,
                    summary: h.summary,
                    summaryInferenceId: h.summaryInferenceId,
                    createdAt: h.createdAt.toISOString(),
                    transcript: h.transcript.map((m) => ({ role: m.role, content: m.content, inferenceId: m.inferenceId })),
                  }}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Inbox className="size-4" /> Unanswered questions
          </CardTitle>
          <CardDescription>
            Questions your agent couldn&apos;t answer from its knowledge, merged when they mean the same thing and sorted by how often customers asked. Answer one
            and it becomes an FAQ the agent uses from then on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {open.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No unanswered questions. When customers ask something the knowledge doesn&apos;t cover, it shows up here.</p>
          ) : (
            <ul className="space-y-3">
              {open.map((g) => (
                <GapItem
                  key={g.id}
                  orgSlug={scope.orgSlug}
                  agentSlug={agentSlug}
                  canEdit={canEdit}
                  gap={{ id: g.id, question: g.question, channel: g.channel, askCount: g.askCount, lastAskedAt: g.lastAskedAt.toISOString() }}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      </div>
      <aside className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Coverage</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border p-3">
              <p className="text-2xl font-semibold tabular-nums">{open.length}</p>
              <p className="text-xs text-muted-foreground">Open gaps ({totalAsks} asks)</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-2xl font-semibold tabular-nums">{answered.length}</p>
              <p className="text-xs text-muted-foreground">Taught</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4" /> How it works
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>A question lands here when the agent replied with its fallback answer because nothing in its knowledge covered it.</p>
            <p>Questions worded almost the same way (for example &ldquo;when are you open?&rdquo; and &ldquo;what are your opening hours?&rdquo;) are grouped using their embeddings. Looser paraphrases may appear separately.</p>
            <p>Questions are visible only to members of your organization.</p>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
