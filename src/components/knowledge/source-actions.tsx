"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteSourceAction, reindexSourceAction } from "@/app/dashboard/[orgSlug]/agents/[agentSlug]/knowledge/actions";
import { Button } from "@/components/ui/button";

export function SourceActions({ orgSlug, agentSlug, sourceId, title }: { orgSlug: string; agentSlug: string; sourceId: string; title: string }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Re-index ${title}`}
        title="Re-index"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await reindexSourceAction(orgSlug, agentSlug, sourceId);
            if (r?.error) toast.error(r.error);
            else toast.success("Re-indexing started.");
          })
        }
      >
        <RefreshCw className={pending ? "animate-spin" : undefined} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${title}`}
        title="Delete"
        disabled={pending}
        onClick={() => {
          if (!confirm(`Delete “${title}”? Its passages are removed from the agent immediately.`)) return;
          start(async () => {
            const r = await deleteSourceAction(orgSlug, agentSlug, sourceId);
            if (r?.error) toast.error(r.error);
          });
        }}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

/** While anything is indexing, refresh the server-rendered list every few seconds. */
export function AutoRefresh({ active }: { active: boolean }) {
  return active ? <AutoRefreshInner /> : null;
}

function AutoRefreshInner() {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [router]);
  return null;
}
