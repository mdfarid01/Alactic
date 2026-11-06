"use client";

import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";
import { createAgentAction, type AgentFormState } from "@/app/dashboard/[orgSlug]/agents/actions";
import { Field } from "@/components/agents/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function CreateAgentForm({ orgSlug, ensParent }: { orgSlug: string; ensParent: string }) {
  const [state, action, pending] = useActionState<AgentFormState, FormData>(createAgentAction.bind(null, orgSlug), undefined);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const fe = state?.fieldErrors ?? {};

  return (
    <form action={action} className="grid gap-5">
      <Field id="agent-name" label="Agent name" error={fe.name} hint="Shown to your customers, e.g. “Acme Support”.">
        <Input
          id="agent-name"
          name="name"
          required
          minLength={2}
          maxLength={60}
          value={name}
          aria-invalid={!!fe.name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugEdited) setSlug(slugify(e.target.value));
          }}
        />
      </Field>
      <Field
        id="agent-slug"
        label="Agent URL"
        error={fe.slug}
        hint={
          <>
            Used for the public chat URL and the planned ENS name{" "}
            <span className="font-mono">{slug || "your-agent"}.{ensParent}</span>. It can&apos;t change after the agent is
            first published.
          </>
        }
      >
        <Input
          id="agent-slug"
          name="slug"
          required
          className="font-mono"
          pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
          title="3–40 characters: lowercase letters, numbers and hyphens"
          value={slug}
          aria-invalid={!!fe.slug}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value.toLowerCase());
          }}
        />
      </Field>
      <Field id="agent-description" label="Description" error={fe.description} hint="Optional. Public, one or two sentences.">
        <Textarea id="agent-description" name="description" maxLength={280} rows={2} />
      </Field>
      {state?.error ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          Create agent
        </Button>
        <p className="text-xs text-muted-foreground">Starts as a draft using a Private (TEE) model. You can change this next.</p>
      </div>
    </form>
  );
}
