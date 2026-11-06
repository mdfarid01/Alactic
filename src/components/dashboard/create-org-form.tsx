"use client";

import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";
import { createOrganizationAction } from "@/app/dashboard/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function CreateOrgForm() {
  const [state, action, pending] = useActionState(createOrganizationAction, undefined);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  return (
    <form action={action} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="org-name">Organization name</Label>
        <Input
          id="org-name"
          name="name"
          required
          minLength={2}
          maxLength={80}
          placeholder="Acme Inc."
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugEdited) setSlug(slugify(e.target.value));
          }}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="org-slug">URL</Label>
        <div className="flex items-center rounded-lg border focus-within:ring-3 focus-within:ring-ring/50">
          <span className="pl-3 text-sm text-muted-foreground">/dashboard/</span>
          <Input
            id="org-slug"
            name="slug"
            required
            pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
            title="3–40 characters: lowercase letters, numbers and hyphens"
            className="border-0 pl-0.5 shadow-none focus-visible:ring-0"
            value={slug}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase());
            }}
          />
        </div>
      </div>
      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? <Loader2 className="animate-spin" /> : null}
        Create organization
      </Button>
    </form>
  );
}
