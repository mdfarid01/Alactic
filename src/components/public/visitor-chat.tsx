"use client";

import { useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  FileText,
  Globe,
  HelpCircle,
  ImagePlus,
  Loader2,
  Lock,
  Mic,
  Receipt,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Square,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { MarkdownLite } from "@/components/markdown-lite";
import { encodeAnswerFragment } from "@/lib/answer-fingerprint";
import { cn } from "@/lib/utils";
import type { PublicReply } from "@/server/public/reply";

type PreProof = PublicReply["question"]["preInference"];
type UserTurn = { role: "user"; id: string; content: string; attachment?: "voice" | "image" | null; pre?: PreProof; seen?: string | null; previewUrl?: string | null };
type Turn = UserTurn | { role: "assistant"; id: string; reply: PublicReply } | { role: "error"; id: string; content: string } | { role: "info"; id: string; content: string };

const SOURCE_ICONS = { website: Globe, file: FileText, faq: HelpCircle, text: Type } as Record<string, typeof Globe>;
const MAX_CHARS = 4000;
const MAX_RECORD_SECONDS = 60;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const SCREENSHOT_MARKER = "\n\n[Screenshot contents, as read by AI: ";

function safeHref(url: string | null) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Random anonymous visitor token, kept only in this browser. The server stores just its hash. */
function visitorToken(): string {
  const key = "alactic:visitor";
  let token = localStorage.getItem(key);
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    localStorage.setItem(key, token);
  }
  return token;
}

/** Split the stored image question into the visitor's caption and what the AI read from the screenshot. */
function splitScreenshot(content: string): { caption: string; seen: string | null } {
  const i = content.indexOf(SCREENSHOT_MARKER);
  if (i < 0) return { caption: content, seen: null };
  const caption = content.slice(0, i);
  return { caption: caption.startsWith("(The customer sent a screenshot") ? "" : caption, seen: content.slice(i + SCREENSHOT_MARKER.length).replace(/\]$/, "") };
}

type Saved = { conversationId: string | null; turns: Turn[] };

export function VisitorChat({
  slug,
  agentName,
  channel,
  greeting,
  voice = false,
  images = false,
  className,
}: {
  slug: string;
  agentName: string;
  channel: "web" | "widget";
  greeting: string;
  voice?: boolean;
  images?: boolean;
  className?: string;
}) {
  const storageKey = `alactic:chat:${slug}`;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [image, setImage] = useState<{ file: File; url: string } | null>(null);
  const [recording, setRecording] = useState<{ startedAt: number; seconds: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const recorderRef = useRef<{ rec: MediaRecorder; chunks: Blob[]; cancelled: boolean; timer: ReturnType<typeof setInterval> } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Restore this browser's transcript (stored locally only; image previews are not kept).
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Saved | null;
      if (saved && Array.isArray(saved.turns)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from localStorage
        setTurns(saved.turns.slice(-60));
        setConversationId(saved.conversationId);
      }
    } catch {
      // ignore corrupt local state
    }
  }, [storageKey]);

  useEffect(() => {
    if (turns.length) {
      const persistable = turns.slice(-60).map((t) => (t.role === "user" ? { ...t, previewUrl: null } : t));
      localStorage.setItem(storageKey, JSON.stringify({ conversationId, turns: persistable } satisfies Saved));
    }
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, conversationId, storageKey, pending]);

  const reset = () => {
    setTurns([]);
    setConversationId(null);
    localStorage.removeItem(storageKey);
  };

  const pickImage = (file: File | null | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return setNotice("Please choose a PNG, JPEG, WebP or GIF image.");
    if (file.size > MAX_IMAGE_BYTES) return setNotice("Images can be up to 4 MB.");
    setNotice(null);
    setImage((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return { file, url: URL.createObjectURL(file) };
    });
  };

  const post = async (userTurnId: string, body: BodyInit, headers: Record<string, string> = {}) => {
    setPending(true);
    try {
      const res = await fetch(`/api/chat/${encodeURIComponent(slug)}`, { method: "POST", headers: { "x-alactic-visitor": visitorToken(), ...headers }, body });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; reply?: PublicReply; error?: { code: string; message: string } } | null;
      if (res.ok && data?.reply) {
        const reply = data.reply;
        setConversationId(reply.conversationId);
        setTurns((t) => [
          ...t.map((x) => {
            if (x.id !== userTurnId || x.role !== "user") return x;
            if (reply.question.attachment === "voice") return { ...x, content: reply.question.content, pre: reply.question.preInference };
            if (reply.question.attachment === "image") return { ...x, pre: reply.question.preInference, seen: splitScreenshot(reply.question.content).seen };
            return x;
          }),
          { role: "assistant", id: reply.messageId, reply },
        ]);
      } else {
        if (data?.error?.code === "conversation_not_found") setConversationId(null);
        setTurns((t) => [...t, { role: "error", id: crypto.randomUUID(), content: data?.error?.message ?? "Something went wrong. Please try again." }]);
      }
    } catch {
      setTurns((t) => [...t, { role: "error", id: crypto.randomUUID(), content: "Network error. Please try again." }]);
    } finally {
      setPending(false);
    }
  };

  const send = async () => {
    const message = text.trim();
    if ((!message && !image) || pending) return;
    const id = crypto.randomUUID();
    setText("");
    if (image) {
      const current = image;
      setImage(null);
      setTurns((t) => [...t, { role: "user", id, content: message, attachment: "image", previewUrl: current.url }]);
      const form = new FormData();
      form.set("message", message);
      form.set("channel", channel);
      if (conversationId) form.set("conversationId", conversationId);
      form.set("image", current.file);
      await post(id, form);
      return;
    }
    setTurns((t) => [...t, { role: "user", id, content: message }]);
    await post(id, JSON.stringify({ message, conversationId, channel }), { "content-type": "application/json" });
  };

  const startRecording = async () => {
    if (pending || recording) return;
    setNotice(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setNotice("Microphone access was blocked. Allow it in your browser to send a voice note.");
    }
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const state = { rec, chunks: [] as Blob[], cancelled: false, timer: setInterval(() => {}, 1000) };
    clearInterval(state.timer);
    const startedAt = Date.now();
    state.timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setRecording({ startedAt, seconds });
      if (seconds >= MAX_RECORD_SECONDS) rec.stop();
    }, 250);
    rec.ondataavailable = (e) => e.data.size && state.chunks.push(e.data);
    rec.onstop = () => {
      clearInterval(state.timer);
      stream.getTracks().forEach((t) => t.stop());
      setRecording(null);
      recorderRef.current = null;
      if (state.cancelled || state.chunks.length === 0) return;
      const blob = new Blob(state.chunks, { type: rec.mimeType || "audio/webm" });
      const id = crypto.randomUUID();
      setTurns((t) => [...t, { role: "user", id, content: "", attachment: "voice" }]);
      const form = new FormData();
      form.set("channel", channel);
      if (conversationId) form.set("conversationId", conversationId);
      form.set("audio", blob, "voice");
      void post(id, form);
    };
    recorderRef.current = state;
    setRecording({ startedAt, seconds: 0 });
    rec.start();
  };

  const stopRecording = (cancel: boolean) => {
    const r = recorderRef.current;
    if (!r) return;
    r.cancelled = cancel;
    r.rec.stop();
  };

  return (
    <div className={cn("flex min-h-0 flex-col bg-card", className)}>
      <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        <div className="w-fit max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{greeting}</div>
        {turns.map((turn) =>
          turn.role === "user" ? (
            <UserBubble key={turn.id} turn={turn} />
          ) : turn.role === "info" ? (
            <p key={turn.id} className="mx-auto w-fit max-w-[90%] rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-center text-xs">
              {turn.content}
            </p>
          ) : turn.role === "error" ? (
            <p key={turn.id} role="alert" className="w-fit max-w-[85%] rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {turn.content}
            </p>
          ) : (
            <AnswerTurn key={turn.id} reply={turn.reply} />
          ),
        )}
        {pending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {agentName} is answering on 0G…
          </p>
        ) : null}
        <div ref={endRef} />
      </div>

      {conversationId && !recording ? (
        <HandoffBar
          slug={slug}
          conversationId={conversationId}
          disabled={pending}
          onDone={(content) => setTurns((t) => [...t, { role: "info", id: crypto.randomUUID(), content }])}
          suggest={turns.at(-1)?.role === "assistant" && (turns.at(-1) as { reply: PublicReply }).reply.isFallback}
        />
      ) : null}
      {notice ? <p className="border-t px-3 pt-2 text-xs text-destructive">{notice}</p> : null}
      {image ? (
        <div className="flex items-center gap-2 border-t px-3 pt-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
          <img src={image.url} alt="Screenshot to send" className="h-14 w-auto rounded border object-cover" />
          <span className="text-xs text-muted-foreground">Add a note (optional), then send.</span>
          <button type="button" onClick={() => setImage(null)} aria-label="Remove screenshot" className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>
      ) : null}

      {recording ? (
        <div className="flex items-center gap-3 border-t p-3">
          <span className="relative flex size-3">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive opacity-75" />
            <span className="relative inline-flex size-3 rounded-full bg-destructive" />
          </span>
          <span className="text-sm tabular-nums">
            Recording… 0:{String(recording.seconds).padStart(2, "0")} / 1:00
          </span>
          <button type="button" onClick={() => stopRecording(true)} aria-label="Cancel recording" className="ml-auto rounded-md border p-2 text-muted-foreground hover:bg-muted">
            <Trash2 className="size-4" />
          </button>
          <button type="button" onClick={() => stopRecording(false)} aria-label="Stop and send" className="rounded-md bg-primary p-2 text-primary-foreground">
            <Square className="size-4" />
          </button>
        </div>
      ) : (
        <form
          className="flex items-end gap-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            onPaste={(e) => {
              if (!images) return;
              const file = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"))?.getAsFile();
              if (file) {
                e.preventDefault();
                pickImage(file);
              }
            }}
            rows={1}
            maxLength={MAX_CHARS}
            placeholder={image ? "Describe the problem (optional)…" : `Message ${agentName}…`}
            aria-label="Message"
            className="max-h-32 min-h-10 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {images ? (
            <>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => (pickImage(e.target.files?.[0]), (e.target.value = ""))} />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={pending} title="Send a screenshot (or paste one)" aria-label="Attach screenshot" className="rounded-md border p-2 text-muted-foreground hover:bg-muted disabled:opacity-50">
                <ImagePlus className="size-4" />
              </button>
            </>
          ) : null}
          {voice && !text.trim() && !image ? (
            <button type="button" onClick={() => void startRecording()} disabled={pending} title="Send a voice note" aria-label="Record voice note" className="rounded-md border p-2 text-muted-foreground hover:bg-muted disabled:opacity-50">
              <Mic className="size-4" />
            </button>
          ) : null}
          {turns.length ? (
            <button type="button" onClick={reset} disabled={pending} title="New conversation" aria-label="New conversation" className="rounded-md border p-2 text-muted-foreground hover:bg-muted disabled:opacity-50">
              <RotateCcw className="size-4" />
            </button>
          ) : null}
          <button type="submit" disabled={pending || (!text.trim() && !image)} aria-label="Send" className="rounded-md bg-primary p-2 text-primary-foreground disabled:opacity-50">
            <Send className="size-4" />
          </button>
        </form>
      )}
    </div>
  );
}

/** "Talk to a person": hands the conversation to the business's team with an AI summary (generated on 0G). */
function HandoffBar({ slug, conversationId, disabled, onDone, suggest }: { slug: string; conversationId: string; disabled: boolean; onDone: (msg: string) => void; suggest: boolean }) {
  const [open, setOpen] = useState(false);
  const [contact, setContact] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <div className={cn("border-t px-3 py-1.5 text-xs", suggest ? "bg-warning/10" : "")}>
        <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50">
          {suggest ? "Didn't get what you needed? Talk to a person →" : "Talk to a person"}
        </button>
      </div>
    );
  }
  return (
    <form
      className="space-y-2 border-t p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const res = await fetch(`/api/chat/${encodeURIComponent(slug)}/handoff`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-alactic-visitor": visitorToken() },
            body: JSON.stringify({ conversationId, contact: contact.trim() || undefined, note: note.trim() || undefined }),
          });
          const data = (await res.json().catch(() => null)) as { reference?: string; alreadyOpen?: boolean; error?: { message: string } } | null;
          if (!res.ok || !data?.reference) throw new Error(data?.error?.message ?? "Something went wrong. Please try again.");
          setOpen(false);
          onDone(
            data.alreadyOpen
              ? `You've already asked for a person (ref ${data.reference}). The team will follow up.`
              : `Sent to the team with a summary of this chat (ref ${data.reference}).${contact.trim() ? " They'll reach out to you." : ""}`,
          );
        } catch (err) {
          setError(err instanceof Error ? err.message : "Something went wrong.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-xs text-muted-foreground">We&apos;ll pass this conversation to the team with a short AI summary, so you don&apos;t have to repeat yourself.</p>
      <input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={200} placeholder="Email or phone (optional)" className="w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} placeholder="Anything to add? (optional)" className="w-full resize-none rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50">
          {busy ? "Sending…" : "Send to the team"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-md border px-3 py-1.5 text-xs">
          Cancel
        </button>
      </div>
    </form>
  );
}

function PreProofLink({ pre, label }: { pre: NonNullable<PreProof>; label: string }) {
  return (
    <a href={`/proof/${pre.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
      {pre.verification === "verified" ? <ShieldCheck className="size-3" aria-hidden /> : <Receipt className="size-3" aria-hidden />}
      {label} · Proof
    </a>
  );
}

function UserBubble({ turn }: { turn: UserTurn }) {
  return (
    <div className="ml-auto flex w-fit max-w-[85%] flex-col items-end gap-1">
      {turn.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- local object URL preview, never uploaded anywhere but our API
        <img src={turn.previewUrl} alt="Your screenshot" className="max-h-40 rounded-xl border" />
      ) : turn.attachment === "image" ? (
        <span className="rounded-xl border px-3 py-1.5 text-xs text-muted-foreground">📷 Screenshot</span>
      ) : null}
      {turn.attachment === "voice" && !turn.content ? (
        <div className="flex items-center gap-2 rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
          <Mic className="size-4" /> Voice note · transcribing on 0G…
        </div>
      ) : turn.content ? (
        <div className="rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
          {turn.attachment === "voice" ? <Mic className="mr-1 inline size-3.5 align-[-2px]" aria-label="Voice note" /> : null}
          {turn.content}
        </div>
      ) : null}
      {turn.pre ? (
        <span className="text-[11px] text-muted-foreground">
          <PreProofLink pre={turn.pre} label={turn.attachment === "voice" ? `Transcribed by ${turn.pre.modelId}` : `Read by ${turn.pre.modelId}`} />
        </span>
      ) : null}
      {turn.seen ? (
        <details className="max-w-full text-right text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">What the agent saw in your screenshot</summary>
          <p className="mt-1 text-left whitespace-pre-wrap">{turn.seen}</p>
        </details>
      ) : null}
    </div>
  );
}

function AnswerTurn({ reply }: { reply: PublicReply }) {
  const v = reply.verification;
  const VIcon = v?.status === "verified" ? ShieldCheck : v?.status === "failed" ? ShieldAlert : v?.status === "unavailable" ? ShieldQuestion : Lock;
  const vLabel =
    v?.status === "verified"
      ? "TEE-signed"
      : v?.status === "failed"
        ? "Verification failed"
        : v?.status === "unavailable"
          ? "Verification pending"
          : v?.status === "not_requested"
            ? "Standard mode"
            : "No AI response";
  return (
    <div className="max-w-[92%] space-y-1.5">
      <MarkdownLite text={reply.content} className="space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm break-words" />
      {reply.citations.length ? (
        <ul className="space-y-0.5">
          {reply.citations.map((c) => {
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
      {reply.inference ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span className={cn("inline-flex items-center gap-1", v?.status === "verified" && "text-success", v?.status === "failed" && "text-destructive")}>
            <VIcon className="size-3" aria-hidden /> {vLabel}
          </span>
          <span className="font-mono">{reply.inference.modelId}</span>
          {reply.inference.routerRequestId ? <span className="font-mono">req {reply.inference.routerRequestId.slice(0, 8)}</span> : null}
          <a
            href={`/proof/${reply.inference.id}#answer=${encodeAnswerFragment(reply.content)}`}
            target="_blank"
            rel="noopener"
            title="Open the public receipt. The answer travels in the link fragment and is checked in your browser only."
            className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
          >
            <Receipt className="size-3" aria-hidden /> Proof
          </a>
        </div>
      ) : null}
    </div>
  );
}
