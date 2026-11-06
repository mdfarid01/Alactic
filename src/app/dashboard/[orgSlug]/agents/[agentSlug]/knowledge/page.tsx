import { Suspense } from "react";
import type { Metadata } from "next";
import { AlertTriangle, FileText, Globe, HelpCircle, Type } from "lucide-react";
import { AddSourcePanel } from "@/components/knowledge/add-source-panel";
import { KnowledgeSearch } from "@/components/knowledge/knowledge-search";
import { AutoRefresh, SourceActions } from "@/components/knowledge/source-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TRUST_MODE_INFO } from "@/lib/agent-options";
import { db } from "@/server/db/client";
import { knowledgeConfigStatus } from "@/server/knowledge/config";
import { KnowledgeError, listSources } from "@/server/knowledge/service";
import { getPageOrgScope } from "@/server/orgs/page-scope";
import { roleAtLeast } from "@/server/orgs/service";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Knowledge" };

type Params = PageProps<"/dashboard/[orgSlug]/agents/[agentSlug]/knowledge">["params"];

const TYPE_ICONS = { website: Globe, file: FileText, faq: HelpCircle, text: Type } as const;

export default function KnowledgePage({ params }: PageProps<"/dashboard/[orgSlug]/agents/[agentSlug]/knowledge">) {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <Knowledge params={params} />
    </Suspense>
  );
}

function formatSize(bytes: number | null) {
  if (!bytes) return null;
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

async function Knowledge({ params }: { params: Params }) {
  const { orgSlug, agentSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  let sources: Awaited<ReturnType<typeof listSources>>;
  try {
    sources = await listSources(db(), scope, agentSlug);
  } catch (error) {
    if (error instanceof KnowledgeError) notFound();
    throw error;
  }
  const config = knowledgeConfigStatus();
  const canEdit = roleAtLeast(scope.role, "admin");
  const busy = sources.some((s) => s.status === "queued" || s.status === "processing");

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <AutoRefresh active={busy} />
      <div className="grid content-start gap-6">
        {!config.embeddingsConfigured ? (
          <p className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            Embeddings aren&apos;t configured on this server yet (0G Router API key missing). Sources are saved and split into
            passages, but they can&apos;t be searched until embeddings are configured and the sources are re-indexed.
          </p>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Sources</CardTitle>
            <CardDescription>
              {sources.length} {sources.length === 1 ? "source" : "sources"} · embeddings by <span className="font-mono">{config.embeddingModel}</span> on 0G (
              {TRUST_MODE_INFO[config.embeddingTrustMode].label})
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {sources.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">No knowledge yet. Add a website, a document or FAQ entries.</p>
            ) : (
              <ul className="divide-y border-t">
                {sources.map((s) => {
                  const Icon = TYPE_ICONS[s.type];
                  const subtitle = [s.url ?? null, formatSize(s.fileSize), s.status === "ready" ? `${s.documentCount} ${s.documentCount === 1 ? "document" : "documents"} · ${s.chunkCount} passages` : null]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <li key={s.id} className="flex items-start justify-between gap-3 px-6 py-3">
                      <div className="flex min-w-0 gap-3">
                        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{s.title}</p>
                          {subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}
                          {s.statusDetail && s.status !== "ready" ? (
                            <p className={`mt-1 text-xs ${s.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{s.statusDetail}</p>
                          ) : null}
                          {s.stalled ? <p className="mt-1 text-xs text-warning">No progress for a while. Re-index to retry.</p> : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <StatusBadge status={s.status} />
                        {canEdit ? <SourceActions orgSlug={scope.orgSlug} agentSlug={agentSlug} sourceId={s.id} title={s.title} /> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <KnowledgeSearch orgSlug={scope.orgSlug} agentSlug={agentSlug} configured={config.embeddingsConfigured} />
      </div>

      <div className="lg:sticky lg:top-20 lg:self-start">
        {canEdit ? (
          <AddSourcePanel orgSlug={scope.orgSlug} agentSlug={agentSlug} crawlingConfigured={config.crawlingConfigured} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Add knowledge</CardTitle>
              <CardDescription>Only owners and admins can add or remove knowledge.</CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: "queued" | "processing" | "ready" | "failed" }) {
  if (status === "ready") return <Badge variant="outline" className="border-success/40 text-success">Ready</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="secondary" className="capitalize">{status === "queued" ? "Queued" : "Indexing"}</Badge>;
}
