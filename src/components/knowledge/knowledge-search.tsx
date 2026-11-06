"use client";

import { useState, useTransition } from "react";
import { FileText, Globe, HelpCircle, Loader2, Search, Type } from "lucide-react";
import { searchKnowledgeAction, type SearchResult } from "@/app/dashboard/[orgSlug]/agents/[agentSlug]/knowledge/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const ICONS = { website: Globe, file: FileText, faq: HelpCircle, text: Type } as const;

export function KnowledgeSearch({ orgSlug, agentSlug, configured }: { orgSlug: string; agentSlug: string; configured: boolean }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Test retrieval</CardTitle>
        <CardDescription>
          See which passages the agent would use to answer a question. This searches your knowledge only; no AI answer is
          generated.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => setResult(await searchKnowledgeAction(orgSlug, agentSlug, query)));
          }}
        >
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="How long do refunds take?" maxLength={500} aria-label="Question" />
          <Button type="submit" disabled={pending || !configured || query.trim().length < 2}>
            {pending ? <Loader2 className="animate-spin" /> : <Search />} Search
          </Button>
        </form>
        {!configured ? <p className="text-sm text-muted-foreground">Available once embeddings are configured on this server.</p> : null}
        {result?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {result.error}
          </p>
        ) : null}
        {result?.results ? (
          result.results.length === 0 ? (
            <p className="text-sm text-muted-foreground">No indexed passages match yet.</p>
          ) : (
            <ol className="grid gap-3">
              {result.results.map((r, i) => {
                const Icon = ICONS[r.sourceType];
                const location = [r.headingPath, r.pageFrom ? (r.pageFrom === r.pageTo ? `p. ${r.pageFrom}` : `pp. ${r.pageFrom}–${r.pageTo}`) : null]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li key={r.chunkId} className="rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-3 text-sm">
                      <p className="flex min-w-0 items-center gap-1.5 font-medium">
                        <span className="font-mono text-xs text-muted-foreground">[{i + 1}]</span>
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate">{r.documentTitle}</span>
                      </p>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground" title="Cosine similarity">
                        {r.score.toFixed(3)}
                      </span>
                    </div>
                    {location || r.url ? (
                      <p className="mt-1 truncate text-xs text-muted-foreground">{[location, r.url].filter(Boolean).join(" · ")}</p>
                    ) : null}
                    <p className="mt-2 line-clamp-4 text-sm whitespace-pre-line text-muted-foreground">{r.excerpt}</p>
                  </li>
                );
              })}
            </ol>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
