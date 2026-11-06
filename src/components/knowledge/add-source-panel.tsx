"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Globe, HelpCircle, Loader2, Type, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  addFaqAction,
  addTextAction,
  addWebsiteAction,
  type KnowledgeFormState,
} from "@/app/dashboard/[orgSlug]/agents/[agentSlug]/knowledge/actions";
import { Field } from "@/components/agents/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Tab = "website" | "file" | "faq" | "text";
const TABS: Array<{ id: Tab; label: string; icon: typeof Globe }> = [
  { id: "website", label: "Website", icon: Globe },
  { id: "file", label: "File", icon: FileText },
  { id: "faq", label: "FAQ", icon: HelpCircle },
  { id: "text", label: "Text", icon: Type },
];

function useResetOnSuccess(state: KnowledgeFormState) {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) {
      ref.current?.reset();
      toast.success("Source added. Indexing has started.");
    }
  }, [state]);
  return ref;
}

function FormMessage({ state }: { state: KnowledgeFormState }) {
  if (!state?.error) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {state.error}
    </p>
  );
}

export function AddSourcePanel({ orgSlug, agentSlug, crawlingConfigured }: { orgSlug: string; agentSlug: string; crawlingConfigured: boolean }) {
  const [tab, setTab] = useState<Tab>("website");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add knowledge</CardTitle>
        <CardDescription>Everything you add is private to this agent and used to answer customer questions with citations.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div role="tablist" aria-label="Source type" className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                tab === t.id ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <t.icon className="size-3.5" aria-hidden /> {t.label}
            </button>
          ))}
        </div>
        {tab === "website" ? <WebsiteForm orgSlug={orgSlug} agentSlug={agentSlug} configured={crawlingConfigured} /> : null}
        {tab === "file" ? <FileForm orgSlug={orgSlug} agentSlug={agentSlug} /> : null}
        {tab === "faq" ? <FaqForm orgSlug={orgSlug} agentSlug={agentSlug} /> : null}
        {tab === "text" ? <TextForm orgSlug={orgSlug} agentSlug={agentSlug} /> : null}
      </CardContent>
    </Card>
  );
}

function WebsiteForm({ orgSlug, agentSlug, configured }: { orgSlug: string; agentSlug: string; configured: boolean }) {
  const [state, action, pending] = useActionState<KnowledgeFormState, FormData>(addWebsiteAction.bind(null, orgSlug, agentSlug), undefined);
  const ref = useResetOnSuccess(state);
  return (
    <form ref={ref} action={action} className="grid gap-4">
      {!configured ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          Website crawling isn&apos;t configured on this server yet (Firecrawl API key missing). You can add the URL now. It
          will fail to index until crawling is configured, then you can re-index it.
        </p>
      ) : null}
      <Field id="url" label="Website or help-center URL" error={state?.fieldErrors?.url} hint="Pages under this address on the same site are crawled (sitemap included).">
        <Input id="url" name="url" type="url" required placeholder="https://acme.com/help" />
      </Field>
      <Field id="maxPages" label="Maximum pages" hint="Up to 50 pages per source.">
        <Input id="maxPages" name="maxPages" type="number" min={1} max={50} defaultValue={20} className="w-28" />
      </Field>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? <Loader2 className="animate-spin" /> : <Globe />} Add website
      </Button>
    </form>
  );
}

function FileForm({ orgSlug, agentSlug }: { orgSlug: string; agentSlug: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={ref}
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem("file") as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return setError("Choose a file to upload.");
        if (file.size > 4 * 1024 * 1024) return setError("Files can be up to 4 MB.");
        setError(null);
        setPending(true);
        try {
          const body = new FormData();
          body.set("file", file);
          const res = await fetch(`/api/orgs/${orgSlug}/agents/${agentSlug}/knowledge/files`, { method: "POST", body });
          const data = (await res.json().catch(() => null)) as { error?: { message?: string }; queued?: boolean; truncated?: boolean } | null;
          if (!res.ok) throw new Error(data?.error?.message ?? "Upload failed.");
          ref.current?.reset();
          if (data?.truncated) toast.warning("Uploaded. The document was very long, so only the first part was indexed.");
          else if (data?.queued === false) toast.warning("Uploaded, but background processing is unavailable. Use “Re-index” later.");
          else toast.success("File uploaded. Indexing has started.");
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Upload failed.");
        } finally {
          setPending(false);
        }
      }}
    >
      <Field id="file" label="Document" hint="PDF, DOCX, TXT or Markdown, up to 4 MB. Text is extracted and the original file isn't stored.">
        <Input id="file" name="file" type="file" required accept=".pdf,.docx,.txt,.md,.markdown" />
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? <Loader2 className="animate-spin" /> : <Upload />} Upload
      </Button>
    </form>
  );
}

function FaqForm({ orgSlug, agentSlug }: { orgSlug: string; agentSlug: string }) {
  const [state, action, pending] = useActionState<KnowledgeFormState, FormData>(addFaqAction.bind(null, orgSlug, agentSlug), undefined);
  const ref = useResetOnSuccess(state);
  return (
    <form ref={ref} action={action} className="grid gap-4">
      <Field id="question" label="Question" error={state?.fieldErrors?.question}>
        <Input id="question" name="question" required maxLength={500} placeholder="How long do refunds take?" />
      </Field>
      <Field id="answer" label="Answer" error={state?.fieldErrors?.answer}>
        <Textarea id="answer" name="answer" required rows={4} maxLength={5000} />
      </Field>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? <Loader2 className="animate-spin" /> : <HelpCircle />} Add FAQ
      </Button>
    </form>
  );
}

function TextForm({ orgSlug, agentSlug }: { orgSlug: string; agentSlug: string }) {
  const [state, action, pending] = useActionState<KnowledgeFormState, FormData>(addTextAction.bind(null, orgSlug, agentSlug), undefined);
  const ref = useResetOnSuccess(state);
  return (
    <form ref={ref} action={action} className="grid gap-4">
      <Field id="title" label="Title" error={state?.fieldErrors?.title}>
        <Input id="title" name="title" required maxLength={200} placeholder="Shipping policy" />
      </Field>
      <Field id="content" label="Content" error={state?.fieldErrors?.content} hint="Markdown headings are used to organize citations.">
        <Textarea id="content" name="content" required rows={8} maxLength={100000} />
      </Field>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? <Loader2 className="animate-spin" /> : <Type />} Add text
      </Button>
    </form>
  );
}
