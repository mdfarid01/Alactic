"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { removeMemberAction } from "@/app/dashboard/actions";
import { Button } from "@/components/ui/button";

export function RemoveMemberButton({ orgSlug, userId, isSelf }: { orgSlug: string; userId: string; isSelf: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() => {
        if (!confirm(isSelf ? "Leave this organization?" : "Remove this member?")) return;
        startTransition(async () => {
          const result = await removeMemberAction(orgSlug, userId);
          if (result?.error) toast.error(result.error);
        });
      }}
    >
      {isSelf ? "Leave" : "Remove"}
    </Button>
  );
}
