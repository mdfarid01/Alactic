"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, FileCheck2, XCircle } from "lucide-react";
import { answerFingerprint, decodeAnswerFragment } from "@/lib/answer-fingerprint";

type Result = { state: "idle" } | { state: "match"; text: string } | { state: "mismatch" };

/**
 * "Proof of what support told you": the customer's browser hashes the answer it holds (from the link's #answer
 * fragment, or pasted) and compares it with the fingerprint on this public receipt. The text never leaves the browser.
 */
export function AnswerCheck({ inferenceId, expected }: { inferenceId: string; expected: string }) {
  const [result, setResult] = useState<Result>({ state: "idle" });
  const [pasted, setPasted] = useState("");

  const check = async (text: string) => {
    const got = await answerFingerprint(inferenceId, text);
    setResult(got === expected ? { state: "match", text } : { state: "mismatch" });
  };

  useEffect(() => {
    const m = /(?:^|&)answer=([^&]+)/.exec(window.location.hash.slice(1));
    const text = m ? decodeAnswerFragment(m[1]) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time check of the link fragment after hydration
    if (text) void check(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on load
  }, []);

  return (
    <div className="space-y-3">
      {result.state === "match" ? (
        <div className="space-y-2 rounded-lg border border-success/40 bg-success/5 p-3">
          <p className="flex items-center gap-2 text-sm font-medium text-success">
            <CheckCircle2 className="size-4" /> This is exactly the answer the agent gave
          </p>
          <blockquote className="max-h-48 overflow-y-auto border-l-2 pl-3 text-sm whitespace-pre-wrap text-muted-foreground">{result.text}</blockquote>
          <p className="text-xs text-muted-foreground">Checked in your browser against the fingerprint above. Alactic never received this text from this page.</p>
        </div>
      ) : result.state === "mismatch" ? (
        <p className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <XCircle className="size-4" /> This text does not match the answer recorded for this receipt.
        </p>
      ) : null}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (pasted.trim()) void check(pasted);
        }}
      >
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          rows={3}
          placeholder="Paste the answer text you received to check it…"
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button type="submit" disabled={!pasted.trim()} className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50">
          <FileCheck2 className="size-4" /> Check this text
        </button>
      </form>
    </div>
  );
}
