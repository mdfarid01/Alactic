"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, Copy, Loader2, Pause, Play, Rocket } from "lucide-react";
import { toast } from "sonner";
import { publishAction, resumeAction, saveOriginsAction, unpublishAction, type DeployState } from "@/app/dashboard/[orgSlug]/agents/[agentSlug]/deploy/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function PublishControls({
  orgSlug,
  agentSlug,
  status,
  hasUnpublishedChanges,
  canEdit,
}: {
  orgSlug: string;
  agentSlug: string;
  status: string;
  hasUnpublishedChanges: boolean;
  canEdit: boolean;
}) {
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<DeployState>) =>
    start(async () => {
      const r = await fn();
      if (r?.error) toast.error(r.error);
      else if (r?.message) toast.success(r.message);
    });
  if (!canEdit) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button disabled={pending || !hasUnpublishedChanges} onClick={() => act(() => publishAction(orgSlug, agentSlug))}>
        {pending ? <Loader2 className="animate-spin" /> : <Rocket />}
        {status === "draft" ? "Publish" : hasUnpublishedChanges ? "Publish changes" : "Up to date"}
      </Button>
      {status === "published" ? (
        <Button variant="outline" disabled={pending} onClick={() => act(() => unpublishAction(orgSlug, agentSlug))}>
          <Pause /> Unpublish
        </Button>
      ) : null}
      {status === "paused" ? (
        <Button variant="outline" disabled={pending} onClick={() => act(() => resumeAction(orgSlug, agentSlug))}>
          <Play /> Resume
        </Button>
      ) : null}
    </div>
  );
}

export function CopyField({ value, label, multiline = false }: { value: string; label: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre className={`min-w-0 flex-1 overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs ${multiline ? "whitespace-pre-wrap" : ""}`} aria-label={label}>
        {value}
      </pre>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

export function OriginsForm({ orgSlug, agentSlug, origins, canEdit }: { orgSlug: string; agentSlug: string; origins: string[]; canEdit: boolean }) {
  const [state, action, pending] = useActionState<DeployState, FormData>(saveOriginsAction.bind(null, orgSlug, agentSlug), undefined);
  return (
    <form action={action} className="grid gap-3">
      <Textarea name="origins" rows={3} defaultValue={origins.join("\n")} disabled={!canEdit} placeholder={"https://www.yourshop.com\nhttps://help.yourshop.com"} className="font-mono text-xs" />
      <p className="text-xs text-muted-foreground">
        One site per line, e.g. <span className="font-mono">https://www.yourshop.com</span>. Browsers will refuse to show the widget on any other
        site. Alactic&apos;s own pages (including the demo page) are always allowed.
      </p>
      {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : state?.message ? <p className="text-sm text-success">{state.message}</p> : null}
      {canEdit ? (
        <Button type="submit" variant="outline" disabled={pending} className="justify-self-start">
          {pending ? <Loader2 className="animate-spin" /> : null} Save sites
        </Button>
      ) : null}
    </form>
  );
}
