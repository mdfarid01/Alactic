import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, FlaskConical, Receipt, XCircle } from "lucide-react";
import { AddTestForm, AutoRefresh, DeleteTestButton, RunTestsButton } from "@/components/agents/test-suite-controls";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/server/db/client";
import { KnowledgeError } from "@/server/knowledge/service";
import { getPageOrgScope } from "@/server/orgs/page-scope";
import { roleAtLeast } from "@/server/orgs/service";
import { listTestCases, MAX_TEST_CASES, recentTestRuns } from "@/server/tests/service";

export const metadata: Metadata = { title: "Tests" };

type Params = PageProps<"/dashboard/[orgSlug]/agents/[agentSlug]/tests">["params"];

export default function TestsPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<Skeleton className="h-[480px] w-full" />}>
      <Tests params={params} />
    </Suspense>
  );
}

async function Tests({ params }: { params: Params }) {
  const { orgSlug, agentSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  let cases, runs;
  try {
    [cases, runs] = await Promise.all([listTestCases(db(), scope, agentSlug), recentTestRuns(db(), scope, agentSlug)]);
  } catch (error) {
    if (error instanceof KnowledgeError) notFound();
    throw error;
  }
  const canEdit = roleAtLeast(scope.role, "admin");
  const running = runs[0]?.status === "running";

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <AutoRefresh active={running} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="size-4" /> Golden questions ({cases.length}/{MAX_TEST_CASES})
          </CardTitle>
          <CardDescription>
            Questions your agent must get right. Before publishing, run them against the draft: each one is answered on 0G, scored, and gets a proof receipt.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canEdit ? <AddTestForm orgSlug={scope.orgSlug} agentSlug={agentSlug} disabled={cases.length >= MAX_TEST_CASES} /> : null}
          <ul className="divide-y rounded-lg border">
            {cases.length === 0 ? <li className="p-4 text-sm text-muted-foreground">No tests yet.</li> : null}
            {cases.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-2 p-3 text-sm">
                <div className="min-w-0 space-y-1">
                  <p className="break-words">{c.question}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.expectAnswer ? (c.mustInclude.length ? `Must mention: ${c.mustInclude.map((p) => `“${p}”`).join(", ")}` : "Must answer from knowledge") : "Must decline"}
                  </p>
                </div>
                {canEdit ? <DeleteTestButton orgSlug={scope.orgSlug} agentSlug={agentSlug} caseId={c.id} disabled={running} /> : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Runs</CardTitle>
            {canEdit ? <RunTestsButton orgSlug={scope.orgSlug} agentSlug={agentSlug} disabled={cases.length === 0} running={running} /> : null}
          </div>
          <CardDescription>Runs use the current draft. Test answers don&apos;t appear in the unanswered-questions inbox.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {runs.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : null}
          {runs.map((r) => (
            <div key={r.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <Badge variant={r.status === "passed" ? "default" : r.status === "running" ? "secondary" : "destructive"}>{r.status}</Badge>
                  <span className="tabular-nums">
                    {r.status === "running" ? `${r.results.length}/${r.total} done` : `${r.passed}/${r.total} passed`}
                  </span>
                  <span className="text-muted-foreground">· draft v{r.configVersion}</span>
                </span>
                <span className="text-xs text-muted-foreground">{r.startedAt.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" })} UTC</span>
              </div>
              <ul className="space-y-1.5">
                {r.results.map((x) => (
                  <li key={x.id} className="text-xs">
                    <div className="flex items-start gap-1.5">
                      {x.passed ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
                      <span className="min-w-0 flex-1 break-words">{x.question}</span>
                      {x.inferenceId ? (
                        <Link href={`/proof/${x.inferenceId}`} target="_blank" className="inline-flex shrink-0 items-center gap-1 text-muted-foreground hover:underline">
                          <Receipt className="size-3" /> proof
                        </Link>
                      ) : null}
                    </div>
                    {x.reasons.length ? <p className="ml-5 text-destructive">{x.reasons.join(" · ")}</p> : null}
                    {x.answerExcerpt && !x.passed ? <p className="ml-5 line-clamp-2 text-muted-foreground">{x.answerExcerpt}</p> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
