"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteAgentAction } from "@/app/dashboard/[orgSlug]/agents/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function DeleteAgentDialog({ orgSlug, agentSlug }: { orgSlug: string; agentSlug: string }) {
  const [confirmText, setConfirmText] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" size="sm" />}>
        <Trash2 /> Delete agent
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this agent?</DialogTitle>
          <DialogDescription>
            This permanently deletes the agent and all of its configuration versions. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="confirm-slug">
            Type <span className="font-mono">{agentSlug}</span> to confirm
          </Label>
          <Input id="confirm-slug" className="font-mono" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            disabled={confirmText !== agentSlug || pending}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteAgentAction(orgSlug, agentSlug);
                if (result?.error) toast.error(result.error);
              })
            }
          >
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
