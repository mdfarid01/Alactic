import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Lock, ShieldCheck } from "lucide-react";
import { TrustBadge } from "@/components/agents/trust-badge";
import { VisitorChat } from "@/components/public/visitor-chat";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/server/db/client";
import { mediaCapabilities } from "@/server/inference/catalog";
import { getPublicAgent } from "@/server/public/service";

type Params = PageProps<"/a/[slug]">["params"];

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Chat · ${slug}`, robots: { index: false } };
}

export default function PublicAgentPage({ params }: { params: Params }) {
  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col px-4 py-4">
      <Suspense fallback={<Skeleton className="h-full w-full" />}>
        <PublicAgent params={params} />
      </Suspense>
    </main>
  );
}

async function PublicAgent({ params }: { params: Params }) {
  const { slug } = await params;
  const agent = await getPublicAgent(db(), slug);
  if (!agent) notFound();
  const caps = await mediaCapabilities(agent.modelId, agent.trustMode);
  return (
    <>
      <header className="space-y-2 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{agent.name}</h1>
          <TrustBadge mode={agent.trustMode} />
          <Link href={`/a/${agent.slug}/trust`} className="text-xs text-muted-foreground underline-offset-4 hover:underline">
            Trust report →
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          {agent.description || `Support assistant for ${agent.orgName}.`} <span className="whitespace-nowrap">· by {agent.orgName}</span>
        </p>
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          {agent.trustMode === "private" ? <Lock className="mt-0.5 size-3 shrink-0" /> : <ShieldCheck className="mt-0.5 size-3 shrink-0" />}
          <span>
            Answers are generated on 0G Compute ({agent.modelId}){agent.trustMode === "private" ? " inside a hardware TEE" : ""}. Each answer has a public proof
            receipt. Verification shows where and by which model an answer was produced, not that it is correct.
          </span>
        </p>
      </header>
      <VisitorChat
        slug={agent.slug}
        agentName={agent.name}
        channel="web"
        voice={caps.voice}
        images={caps.images}
        greeting={`Hi! I'm ${agent.name}. Ask me anything about ${agent.orgName}.`}
        className="flex-1 rounded-xl border"
      />
      <p className="pt-2 text-center text-[11px] text-muted-foreground">
        Powered by{" "}
        <Link href="/" className="underline-offset-4 hover:underline">
          Alactic
        </Link>{" "}
        · verifiable AI on 0G
      </p>
    </>
  );
}
