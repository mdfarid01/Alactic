"use client";

import { useActionState, useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { addMemberAction, type FormState } from "@/app/dashboard/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AddMemberForm({ orgSlug, canAddOwners }: { orgSlug: string; canAddOwners: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(addMemberAction.bind(null, orgSlug), undefined);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="member-address">Wallet address</Label>
        <Input id="member-address" name="address" required placeholder="0x…" className="font-mono" autoComplete="off" spellCheck={false} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="member-role">Role</Label>
        <select
          id="member-role"
          name="role"
          defaultValue="member"
          className="h-8 rounded-lg border bg-background px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="member">Member: view and test agents</option>
          <option value="admin">Admin: manage agents, knowledge and members</option>
          {canAddOwners ? <option value="owner">Owner: full control</option> : null}
        </select>
      </div>
      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">{state.error}</p>
      ) : state?.ok ? (
        <p role="status" className="text-sm text-success">Member added.</p>
      ) : null}
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? <Loader2 className="animate-spin" /> : null}
        Add member
      </Button>
      <p className="text-xs text-muted-foreground">
        The wallet gets access the next time it signs in. No invitation is sent.
      </p>
    </form>
  );
}
