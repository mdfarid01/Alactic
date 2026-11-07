"use client";

import { useState, useTransition } from "react";
import { BookPlus, Check, Receipt, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { answerGapAction, dismissGapAction, draftGapAnswerAction } from "@/app/dashboard/[orgSlug]/agents/[agentSlug]/inbox/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type GapView = { id: string; question: string; channel: string; askCount: number; lastAskedAt: string };

export function GapItem({ orgSlug, agentSlug, gap, canEdit }: { orgSlug: string; agentSlug: string; gap: GapView; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState(gap.question);
  const [answer, setAnswer] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [pageUrl, setPageUrl] = useState("");
  const [drafting, startDraft] = useTransition();
  const [draftSource, setDraftSource] = useState<{ url: string; title: string; inferenceId: string } | null>(null);

  return (
    <li className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium break-words">&ldquo;{gap.question}&rdquo;</p>
          <p className="text-xs text-muted-foreground">
            Last asked {new Date(gap.lastAskedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · via {gap.channel}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={gap.askCount > 1 ? "default" : "secondary"}>
            Asked {gap.askCount}×
          </Badge>
          {canEdit && !open ? (
            <>
              <Button size="sm" onClick={() => setOpen(true)}>
                <BookPlus /> Answer
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Dismiss"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await dismissGapAction(orgSlug, agentSlug, gap.id);
                    if (r?.error) toast.error(r.error);
                  })
                }
              >
                <X />
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {open ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await answerGapAction(orgSlug, agentSlug, gap.id, question, answer);
              if (r?.error) {
                setErrors(r.fieldErrors ?? {});
                toast.error(r.error);
              } else {
                toast.success(r?.queued ? "Added to knowledge. Indexing now; the agent will use it in a moment." : "Saved, but indexing couldn't be queued. Retry it from Knowledge.");
              }
            });
          }}
        >
          <label className="block space-y-1 text-xs text-muted-foreground">
            Question (edit to make it general)
            <Input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} aria-invalid={!!errors.question} />
            {errors.question ? <span className="text-destructive">{errors.question}</span> : null}
          </label>
          <div className="space-y-1 rounded-md border border-dashed p-2">
            <p className="flex items-center gap-1 text-xs font-medium">
              <Sparkles className="size-3.5" /> Draft from a page on your site
            </p>
            <div className="flex gap-2">
              <Input value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} placeholder="https://yoursite.com/shipping" className="h-8 text-xs" disabled={drafting} />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={drafting || !pageUrl.trim()}
                onClick={() =>
                  startDraft(async () => {
                    const r = await draftGapAnswerAction(orgSlug, agentSlug, gap.id, pageUrl);
                    if (r?.error) toast.error(r.error);
                    else if (r?.draft) {
                      setAnswer(r.draft);
                      setDraftSource({ url: r.sourceUrl!, title: r.sourceTitle!, inferenceId: r.inferenceId! });
                    }
                  })
                }
              >
                {drafting ? "Drafting…" : "Draft"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">Only the page URL goes to the page fetcher. The draft is written on 0G in this agent&apos;s trust mode, from that page only. Review it before saving.</p>
            {draftSource ? (
              <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                Drafted from {draftSource.title}
                <a href={`/proof/${draftSource.inferenceId}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 hover:underline">
                  <Receipt className="size-3" /> proof
                </a>
              </p>
            ) : null}
          </div>
          <label className="block space-y-1 text-xs text-muted-foreground">
            Answer (becomes an FAQ in this agent&apos;s knowledge)
            <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={3} maxLength={4000} aria-invalid={!!errors.answer} autoFocus />
            {errors.answer ? <span className="text-destructive">{errors.answer}</span> : null}
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending || !answer.trim()}>
              <Check /> Teach the agent
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
