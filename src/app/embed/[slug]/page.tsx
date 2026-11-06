import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { VisitorChat } from "@/components/public/visitor-chat";
import { db } from "@/server/db/client";
import { mediaCapabilities } from "@/server/inference/catalog";
import { getPublicAgent } from "@/server/public/service";

type Params = PageProps<"/embed/[slug]">["params"];

export const metadata: Metadata = { title: "Chat", robots: { index: false } };

/** Widget UI, loaded in an iframe by /widget.js. Same-origin with the chat API, so no secrets touch the host page. */
export default function EmbedPage({ params }: { params: Params }) {
  return (
    <main className="flex h-dvh flex-col bg-card">
      <Suspense fallback={<div className="flex-1" />}>
        <Embed params={params} />
      </Suspense>
    </main>
  );
}

async function Embed({ params }: { params: Params }) {
  const { slug } = await params;
  const agent = await getPublicAgent(db(), slug);
  if (!agent) notFound();
  const caps = await mediaCapabilities(agent.modelId, agent.trustMode);
  return (
    <>
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{agent.name}</p>
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <ShieldCheck className="size-3" /> Verifiable answers on 0G
          </p>
        </div>
        <a href={`/a/${agent.slug}`} target="_blank" rel="noopener" className="text-[11px] text-muted-foreground underline-offset-4 hover:underline">
          Open full page
        </a>
      </header>
      <VisitorChat slug={agent.slug} agentName={agent.name} channel="widget"
        voice={caps.voice}
        images={caps.images} greeting={`Hi! I'm ${agent.name}. How can I help?`} className="flex-1" />
    </>
  );
}
