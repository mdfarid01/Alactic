"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { addTestCaseAction, deleteTestCaseAction, runTestsAction } from "@/app/dashboard/[orgSlug]/agents/[agentSlug]/tests/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AddTestForm({ orgSlug, agentSlug, disabled }: { orgSlug: string; agentSlug: string; disabled: boolean }) {
  const [question, setQuestion] = useState("");
  const [mustInclude, setMustInclude] = useState("");
  const [decline, setDecline] = useState(false);
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await addTestCaseAction(orgSlug, agentSlug, { question, mustInclude: decline ? "" : mustInclude, expectAnswer: !decline });
          if (r?.error) toast.error(r.error);
          else {
            setQuestion("");
            setMustInclude("");
            setDecline(false);
          }
        });
      }}
    >
      <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="A question customers ask, e.g. How long does shipping take?" maxLength={500} disabled={disabled || pending} />
      {!decline ? (
        <Input value={mustInclude} onChange={(e) => setMustInclude(e.target.value)} placeholder="The answer must mention (comma-separated), e.g. 2-4 business days" disabled={disabled || pending} />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={decline} onChange={(e) => setDecline(e.target.checked)} disabled={disabled || pending} />
          The agent should decline this (off-topic or out of scope)
        </label>
        <Button type="submit" size="sm" disabled={disabled || pending || question.trim().length < 3}>
          <Plus /> Add test
        </Button>
      </div>
    </form>
  );
}

export function DeleteTestButton({ orgSlug, agentSlug, caseId, disabled }: { orgSlug: string; agentSlug: string; caseId: string; disabled: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label="Delete test"
      disabled={disabled || pending}
      onClick={() =>
        start(async () => {
          const r = await deleteTestCaseAction(orgSlug, agentSlug, caseId);
          if (r?.error) toast.error(r.error);
        })
      }
    >
      <Trash2 />
    </Button>
  );
}

export function RunTestsButton({ orgSlug, agentSlug, disabled, running }: { orgSlug: string; agentSlug: string; disabled: boolean; running: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      disabled={disabled || pending || running}
      onClick={() =>
        start(async () => {
          const r = await runTestsAction(orgSlug, agentSlug);
          if (r?.error) toast.error(r.error);
          else toast.success("Test run started. Answers are generated on 0G.");
        })
      }
    >
      {running ? <FlaskConical className="animate-pulse" /> : <Play />} {running ? "Running…" : "Run tests on draft"}
    </Button>
  );
}

/** While a run is in progress, refresh the server-rendered results every few seconds. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
