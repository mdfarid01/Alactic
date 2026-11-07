"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, Copy, Loader2, Pause, Play, Rocket } from "lucide-react";
import { saveOriginsAction, type DeployState } from "@/app/dashboard/[orgSlug]/agents/[agentSlug]/deploy/actions";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { publishAgentAction, setAgentLiveAction } from "@/app/dashboard/[orgSlug]/agents/actions";
import { Button } from "@/components/ui/button";

export function PublishButtons({
  orgSlug,
  agentSlug,
  canPublish,
  hasUnpublishedChanges,
  status,
}: {
  orgSlug: string;
  agentSlug: string;
  canPublish: boolean;
  hasUnpublishedChanges: boolean;
  status: string;
}) {
  const [pending, start] = useTransition();
  const neverPublished = status === "draft";
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        disabled={!canPublish || pending || !hasUnpublishedChanges}
        onClick={() =>
          start(async () => {
            const r = await publishAgentAction(orgSlug, agentSlug);
            if (r?.error) toast.error(r.error);
            else toast.success(`Version ${r?.version} is live`);
          })
        }
      >
        <Rocket /> {neverPublished ? "Publish agent" : hasUnpublishedChanges ? "Publish changes" : "Up to date"}
      </Button>
      {!neverPublished ? (
        <Button
          variant="outline"
          disabled={!canPublish || pending}
          onClick={() =>
            start(async () => {
              const live = status !== "published";
              const r = await setAgentLiveAction(orgSlug, agentSlug, live);
              if (r?.error) toast.error(r.error);
              else toast.success(live ? "Agent is live again" : "Agent paused. Public chat is offline.");
            })
          }
        >
          {status === "published" ? (
            <>
              <Pause /> Pause
            </>
          ) : (
            <>
              <Play /> Resume
            </>
          )}
        </Button>
      ) : null}
    </div>
  );
}

export function CopyField({ value, label, multiline = false }: { value: string; label: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      {multiline ? (
        <pre className="flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap" aria-label={label}>
          {value}
        </pre>
      ) : (
        <code className="flex-1 truncate rounded-md border bg-muted px-3 py-2 font-mono text-xs" aria-label={label}>
          {value}
        </code>
      )}
      <Button
        variant="outline"
        size="sm"
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

/** Sites allowed to embed the widget (CSP frame-ancestors on /embed/<slug>). From main, by the widget allow-list work. */
export function OriginsForm({ orgSlug, agentSlug, origins, canEdit }: { orgSlug: string; agentSlug: string; origins: string[]; canEdit: boolean }) {
  const [state, action, pending] = useActionState<DeployState, FormData>(saveOriginsAction.bind(null, orgSlug, agentSlug), undefined);
  return (
    <form action={action} className="grid gap-3">
      <Textarea
        name="origins"
        rows={3}
        defaultValue={origins.join("\n")}
        disabled={!canEdit}
        placeholder={"https://www.yourshop.com\nhttps://help.yourshop.com"}
        className="font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground">
        One site per line, e.g. <span className="font-mono">https://www.yourshop.com</span>. Browsers will refuse to show the widget on any other site.
        Alactic&apos;s own pages (including the demo page) are always allowed.
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
