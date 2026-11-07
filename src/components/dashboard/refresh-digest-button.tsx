"use client";

import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { refreshDigestAction } from "@/app/dashboard/actions";
import { Button } from "@/components/ui/button";

export function RefreshDigestButton({ orgSlug, label }: { orgSlug: string; label: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await refreshDigestAction(orgSlug);
          if (r?.error) toast.error(r.error);
        })
      }
    >
      <RefreshCw className={pending ? "animate-spin" : ""} /> {pending ? "Writing on 0G…" : label}
    </Button>
  );
}
