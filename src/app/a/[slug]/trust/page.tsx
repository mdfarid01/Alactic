import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookOpen, Clock, GitCommitVertical, MessageSquare, Radio, ShieldCheck } from "lucide-react";
import { CopyField } from "@/components/agents/deploy-controls";
import { TrustBadge } from "@/components/agents/trust-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/server/db/client";
import { appOrigin } from "@/server/env";
import { getPublicAgent } from "@/server/public/service";
import { getTrustStats, pct } from "@/server/public/trust";

type Params = PageProps<"/a/[slug]/trust">["params"];

export const metadata: Metadata = { title: "Trust report", robots: { index: false } };

export default function TrustPage({ params }: { params: Params }) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <Suspense fallback={<Skeleton className="h-[600px] w-full" />}>
        <Trust params={params} />
      </Suspense>
    </main>
  );
}

const SOURCE_LABEL: Record<string, string> = { website: "Website pages", file: "Documents", faq: "FAQs", text: "Text notes" };

async function Trust({ params }: { params: Params }) {
  const { slug } = await params;
  const agent = await getPublicAgent(db(), slug);
  if (!agent) notFound();
  const s = await getTrustStats(db(), agent);
  const verifiedPct = pct(s.verified, s.answers);
  const coveragePct = pct(s.answeredFromKnowledge, s.answers);
  const origin = appOrigin().origin;
  const badgeHtml = `<a href="${origin}/a/${agent.slug}/trust"><img src="${origin}/a/${agent.slug}/badge.svg" alt="Verified AI support by Alactic" height="20"></a>`;

  return (
    <>
      <header className="space-y-2">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="size-4" /> Alactic trust report · live
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          <Link href={`/a/${agent.slug}`} className="underline-offset-4 hover:underline">
            {agent.name}
          </Link>
        </h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {agent.orgName} · <span className="font-mono">{agent.modelId}</span> <TrustBadge mode={agent.trustMode} /> · version {agent.version}
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={MessageSquare} label={`Public answers (${s.windowDays} d)`} value={String(s.answers)} />
        <Stat icon={ShieldCheck} label="TEE-verified" value={verifiedPct == null ? "—" : `${verifiedPct}%`} />
        <Stat icon={BookOpen} label="Answered from knowledge" value={coveragePct == null ? "—" : `${coveragePct}%`} />
        <Stat icon={Clock} label="Median response" value={s.medianLatencyMs == null ? "—" : `${(s.medianLatencyMs / 1000).toFixed(1)} s`} />
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 rounded-xl border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <BookOpen className="size-4" /> Knowledge it answers from
          </h2>
          {s.knowledge.length === 0 ? <p className="text-sm text-muted-foreground">No indexed sources.</p> : null}
          <ul className="space-y-1 text-sm">
            {s.knowledge.map((k) => (
              <li key={k.type} className="flex justify-between">
                <span>{SOURCE_LABEL[k.type] ?? k.type}</span>
                <span className="text-muted-foreground tabular-nums">{k.sources}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Source names and contents stay private.</p>
        </div>
        <div className="space-y-2 rounded-xl border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Radio className="size-4" /> Where it answers
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {s.channels.map((c) => (
              <span key={c} className="rounded-full border px-2 py-0.5 text-xs capitalize">
                {c}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-2 rounded-xl border p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <GitCommitVertical className="size-4" /> Published versions
        </h2>
        <p className="text-xs text-muted-foreground">Published versions are immutable. Each answer&apos;s proof receipt records which model and trust mode produced it.</p>
        <ol className="space-y-1 text-sm">
          {[...s.versions].reverse().map((v) => (
            <li key={v.version} className="flex flex-wrap justify-between gap-2">
              <span>
                v{v.version} · <span className="font-mono text-xs">{v.modelId}</span> · {v.trustMode}
              </span>
              <span className="text-muted-foreground">{v.publishedAt.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-2 rounded-xl border p-4">
        <h2 className="text-sm font-semibold">Show this on your website</h2>
        {/* eslint-disable-next-line @next/next/no-img-element -- live SVG badge served by this app */}
        <img src={`/a/${agent.slug}/badge.svg`} alt="Alactic trust badge" height={20} />
        <CopyField value={badgeHtml} label="badge HTML" multiline />
      </section>

      <p className="text-xs text-muted-foreground">
        Figures cover public answers (web, widget and connected channels) in the last {s.windowDays} days, from Alactic&apos;s inference and verification records. TEE
        verification shows where and by which model an answer was produced, not that it is correct.
      </p>
    </>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Clock; label: string; value: string }) {
  return (
    <div className="rounded-xl border p-3">
      <Icon className="size-4 text-muted-foreground" />
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
