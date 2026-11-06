"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, FileText, Globe, HelpCircle, Loader2, RotateCcw, Send, Type } from "lucide-react";
import { TrustBadge } from "@/components/agents/trust-badge";
import { VerificationBadge, type VerificationView } from "@/components/agents/verification-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Citation } from "@/server/db/schema";
import type { RunAgentResult } from "@/server/runtime/run-agent";
import { cn } from "@/lib/utils";

type Msg = {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  citations?: Citation[] | null;
  inferenceId?: string | null;
  verification?: VerificationView;
  trustMode?: "private" | "verified" | "standard";
  isFallback?: boolean;
};

const SOURCE_ICONS = { website: Globe, file: FileText, faq: HelpCircle, text: Type } as Record<string, typeof Globe>;

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeHref(url: string | null | undefined) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

type Session = { conversationId: string | null; visitorToken: string };

export function PublicChat({
  slug,
  agentName,
  trustMode,
  channel,
  compact = false,
}: {
  slug: string;
  agentName: string;
  trustMode: "private" | "verified" | "standard";
  channel: "web" | "widget";
  compact?: boolean;
}) {
  const storageKey = `alactic:${slug}:${channel}`;
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Restore (or create) the anonymous visitor session and its history.
  useEffect(() => {
    let stored: Session | null = null;
    try {
      stored = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    } catch {
      stored = null;
    }
    const s: Session = stored?.visitorToken ? stored : { conversationId: null, visitorToken: newToken() };
    localStorage.setItem(storageKey, JSON.stringify(s));
    setSession(s);
    if (s.conversationId) {
      fetch(`/api/public/agents/${slug}/history`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: s.conversationId, visitorToken: s.visitorToken }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { messages?: Array<{ id: string; role: "user" | "assistant"; content: string; citations: Citation[] | null; inferenceId: string | null; verification: { status: "verified" | "failed" | "unavailable" | "not_requested"; method: "router" | "independent" } | null; isFallback: boolean }> } | null) => {
          if (data?.messages) {
            setMessages(
              data.messages.map((m) => ({
                ...m,
                verification: m.role === "assistant" ? (m.verification ?? { status: "no_inference" }) : undefined,
              })),
            );
          }
        })
        .catch(() => {});
    }
  }, [slug, storageKey]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  function reset() {
    const s = { conversationId: null, visitorToken: newToken() };
    localStorage.setItem(storageKey, JSON.stringify(s));
    setSession(s);
    setMessages([]);
  }

  async function send() {
    const message = text.trim();
    if (!message || pending || !session) return;
    setText("");
    setPending(true);
    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", content: message }]);
    try {
      const res = await fetch(`/api/public/agents/${slug}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, conversationId: session.conversationId, visitorToken: session.visitorToken, channel }),
      });
      const data = (await res.json().catch(() => null)) as { result?: RunAgentResult; error?: { message?: string } } | null;
      if (!res.ok || !data?.result) {
        if (res.status === 404 && session.conversationId) reset();
        throw new Error(data?.error?.message ?? "Something went wrong. Please try again.");
      }
      const r = data.result;
      const next = { ...session, conversationId: r.conversationId };
      localStorage.setItem(storageKey, JSON.stringify(next));
      setSession(next);
      setMessages((m) => [
        ...m,
        {
          id: r.reply.messageId,
          role: "assistant",
          content: r.reply.content,
          citations: r.reply.citations,
          inferenceId: r.inference?.id ?? null,
          verification: r.verification ?? { status: "no_inference" },
          trustMode: r.inference?.trustMode,
          isFallback: r.reply.isFallback,
        },
      ]);
    } catch (e) {
      setMessages((m) => [...m, { id: crypto.randomUUID(), role: "error", content: e instanceof Error ? e.message : "Something went wrong." }]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={cn("flex flex-col bg-card", compact ? "h-full" : "h-[calc(100vh-14rem)] min-h-[480px] rounded-xl border")}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{agentName}</p>
          <p className="text-[11px] text-muted-foreground">AI assistant · answers may be inaccurate</p>
        </div>
        <div className="flex items-center gap-1">
          <TrustBadge mode={trustMode} />
          <Button variant="ghost" size="icon-sm" aria-label="Start a new conversation" title="New conversation" onClick={reset} disabled={pending}>
            <RotateCcw />
          </Button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 ? <p className="pt-8 text-center text-sm text-muted-foreground">Hi! Ask {agentName} a question.</p> : null}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
              {m.content}
            </div>
          ) : m.role === "error" ? (
            <p key={m.id} role="alert" className="w-fit max-w-[90%] rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {m.content}
            </p>
          ) : (
            <div key={m.id} className="max-w-[92%] space-y-1.5">
              <div className="rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{m.content}</div>
              {m.citations?.length ? (
                <ul className="space-y-0.5">
                  {m.citations.map((c) => {
                    const Icon = SOURCE_ICONS[c.sourceType] ?? FileText;
                    const href = safeHref(c.url);
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
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {m.verification ? <VerificationBadge verification={m.verification} /> : null}
                {m.inferenceId ? (
                  <a href={`/v/${m.inferenceId}`} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
                    Verification details
                  </a>
                ) : null}
              </div>
            </div>
          ),
        )}
        {pending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Thinking…
          </p>
        ) : null}
        <div ref={endRef} />
      </div>

      <form
        className="flex gap-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={compact ? 1 : 2}
          maxLength={4000}
          placeholder="Type your question…"
          aria-label="Message"
          className="min-h-0 resize-none"
        />
        <Button type="submit" disabled={pending || !text.trim() || !session} className="self-end" aria-label="Send">
          <Send />
          {compact ? null : "Send"}
        </Button>
      </form>
      <p className="border-t px-3 py-1.5 text-center text-[10px] text-muted-foreground">
        Powered by Alactic · inference on 0G Compute
      </p>
    </div>
  );
}
