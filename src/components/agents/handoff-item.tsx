"use client";

import { useTransition } from "react";
import { Check, Receipt, UserRound } from "lucide-react";
import { toast } from "sonner";
import { resolveHandoffAction } from "@/app/dashboard/[orgSlug]/agents/[agentSlug]/inbox/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type HandoffView = {
  id: string;
  channel: string;
  contact: string | null;
  note: string | null;
  summary: string | null;
  summaryInferenceId: string | null;
  createdAt: string;
  transcript: { role: string; content: string; inferenceId: string | null }[];
};

export function HandoffItem({ orgSlug, h }: { orgSlug: string; h: HandoffView }) {
  const [pending, start] = useTransition();
  return (
    <li className="space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <UserRound className="size-4" /> {h.contact ?? "No contact left"}
            <Badge variant="outline">{h.channel}</Badge>
            <span className="text-xs font-normal text-muted-foreground">ref {h.id.slice(0, 8).toUpperCase()}</span>
          </p>
          <p className="text-xs text-muted-foreground">{new Date(h.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</p>
        </div>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await resolveHandoffAction(orgSlug, h.id);
              if (r?.error) toast.error(r.error);
              else toast.success("Marked as resolved.");
            })
          }
        >
          <Check /> Resolve
        </Button>
      </div>
      {h.summary ? (
        <div className="rounded-md bg-muted p-3 text-sm">
          <p className="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            AI summary
            {h.summaryInferenceId ? (
              <a href={`/proof/${h.summaryInferenceId}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 font-normal hover:underline">
                <Receipt className="size-3" /> proof
              </a>
            ) : null}
          </p>
          <p className="whitespace-pre-wrap">{h.summary}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No summary (the AI step was unavailable). Read the transcript below.</p>
      )}
      {h.note ? <p className="text-sm">Customer note: {h.note}</p> : null}
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">Transcript ({h.transcript.length} messages)</summary>
        <ul className="mt-2 space-y-1.5">
          {h.transcript.map((m, i) => (
            <li key={i} className={m.role === "user" ? "text-foreground" : "text-muted-foreground"}>
              <span className="font-medium">{m.role === "user" ? "Customer" : "Agent"}:</span> <span className="whitespace-pre-wrap">{m.content}</span>
              {m.inferenceId ? (
                <a href={`/proof/${m.inferenceId}`} target="_blank" rel="noopener" className="ml-1 text-xs hover:underline">
                  [proof]
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}
