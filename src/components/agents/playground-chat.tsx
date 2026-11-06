"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, ExternalLink, FileText, Globe, HelpCircle, Loader2, RotateCcw, Send, Type } from "lucide-react";
import { sendPlaygroundMessage } from "@/app/dashboard/[orgSlug]/agents/[agentSlug]/playground/actions";
import { TrustBadge } from "@/components/agents/trust-badge";
import { VerificationBadge } from "@/components/agents/verification-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RunAgentResult } from "@/server/runtime/run-agent";

type Turn =
  | { role: "user"; id: string; content: string }
  | { role: "assistant"; id: string; result: RunAgentResult }
  | { role: "error"; id: string; content: string };

const SOURCE_ICONS = { website: Globe, file: FileText, faq: HelpCircle, text: Type } as Record<string, typeof Globe>;

function safeHref(url: string | null) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function PlaygroundChat({ orgSlug, agentSlug, agentName, inferenceConfigured }: { orgSlug: string; agentSlug: string; agentName: string; inferenceConfigured: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Block body on purpose: newer browsers return a Promise from scrollIntoView, and an effect must not return one.
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, pending]);

  const send = () => {
    const message = text.trim();
    if (!message || pending) return;
    setText("");
    setTurns((t) => [...t, { role: "user", id: crypto.randomUUID(), content: message }]);
    start(async () => {
      const res = await sendPlaygroundMessage(orgSlug, agentSlug, conversationId, message);
      if (res.ok) {
        setConversationId(res.result.conversationId);
        setTurns((t) => [...t, { role: "assistant", id: res.result.reply.messageId, result: res.result }]);
      } else {
        setTurns((t) => [...t, { role: "error", id: crypto.randomUUID(), content: res.error }]);
      }
    });
  };

  return (
    <div className="flex h-[calc(100vh-18rem)] min-h-[520px] flex-col rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <p className="text-sm text-muted-foreground">Testing the current draft. Conversations are saved to this organization.</p>
        <Button variant="ghost" size="sm" disabled={pending || turns.length === 0} onClick={() => { setTurns([]); setConversationId(null); }}>
          <RotateCcw /> New conversation
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {!inferenceConfigured ? (
          <p className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            AI inference isn&apos;t configured on this server yet (0G Router API key missing). Messages will be answered with the
            agent&apos;s fallback, and the reason is shown under each reply.
          </p>
        ) : null}
        {turns.length === 0 ? (
          <p className="pt-10 text-center text-sm text-muted-foreground">Ask {agentName} a question your customers might ask.</p>
        ) : null}
        {turns.map((turn) =>
          turn.role === "user" ? (
            <div key={turn.id} className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
              {turn.content}
            </div>
          ) : turn.role === "error" ? (
            <p key={turn.id} role="alert" className="w-fit max-w-[85%] rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {turn.content}
            </p>
          ) : (
            <AssistantTurn key={turn.id} result={turn.result} />
          ),
        )}
        {pending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Generating on 0G Compute…
          </p>
        ) : null}
        <div ref={endRef} />
      </div>

      <form
        className="flex gap-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder="Type a customer question… (Enter to send, Shift+Enter for a new line)"
          aria-label="Message"
          className="min-h-0 resize-none"
        />
        <Button type="submit" disabled={pending || !text.trim()} className="self-end">
          <Send /> Send
        </Button>
      </form>
    </div>
  );
}

function AssistantTurn({ result }: { result: RunAgentResult }) {
  const { reply, inference, verification, retrieval, error } = result;
  const vView = verification ?? { status: "no_inference" as const };
  return (
    <div className="max-w-[90%] space-y-2">
      <div className="rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{reply.content}</div>
      {reply.citations.length ? (
        <ul className="space-y-1">
          {reply.citations.map((c) => {
            const Icon = SOURCE_ICONS[c.sourceType] ?? FileText;
            const href = safeHref(c.url);
            const loc = [c.headingPath, c.pageFrom ? (c.pageFrom === c.pageTo ? `p. ${c.pageFrom}` : `pp. ${c.pageFrom}–${c.pageTo}`) : null].filter(Boolean).join(" · ");
            return (
              <li key={c.n} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-mono">[{c.n}]</span>
                <Icon className="size-3.5 shrink-0" aria-hidden />
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 truncate underline-offset-4 hover:underline">
                    {c.title} <ExternalLink className="size-3" aria-hidden />
                  </a>
                ) : (
                  <span className="truncate">{c.title}</span>
                )}
                {loc ? <span className="truncate">· {loc}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {inference ? <TrustBadge mode={inference.trustMode} /> : null}
        <VerificationBadge verification={vView} />
        {inference ? <span className="font-mono">{inference.modelId}</span> : null}
        {inference?.latencyMs ? <span>{(inference.latencyMs / 1000).toFixed(1)}s</span> : null}
        {reply.isFallback ? <span>Fallback answer</span> : null}
        {inference?.routerRequestId ? (
          <span className="font-mono" title="0G Router request ID">
            req {inference.routerRequestId.slice(0, 8)}
          </span>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error.message}</p> : null}
      {verification?.method === "independent" && verification.status !== "verified" && verification.reason ? (
        <p className="text-xs text-muted-foreground">Verification: {verification.reason}</p>
      ) : null}
      {retrieval.status === "unavailable" ? (
        <p className="text-xs text-warning">Knowledge search unavailable: {retrieval.reason}</p>
      ) : retrieval.passages === 0 && !error ? (
        <p className="text-xs text-muted-foreground">No matching knowledge passages were found for this question.</p>
      ) : null}
    </div>
  );
}
