import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Brand } from "@/components/layout/brand";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { PublicChat } from "@/components/public/public-chat";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { getPublishedAgent } from "@/server/public/agents";

export const metadata: Metadata = { title: "Chat" };

export default function PublicAgentPage({ params }: PageProps<"/a/[slug]">) {
  return (
    <div className="flex min-h-full flex-col bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <Brand />
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <Suspense fallback={<Skeleton className="h-[480px] w-full" />}>
          <Agent params={params} />
        </Suspense>
      </main>
    </div>
  );
}

async function Agent({ params }: { params: PageProps<"/a/[slug]">["params"] }) {
  const { slug } = await params;
  const agent = await getPublishedAgent(db(), slug);
  if (!agent) notFound();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
        {agent.description ? <p className="mt-1 text-muted-foreground">{agent.description}</p> : null}
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {agent.slug}.{env().ENS_PARENT_NAME} · version {agent.version} · {agent.modelId}
        </p>
      </div>
      <PublicChat slug={agent.slug} agentName={agent.name} trustMode={agent.trustMode} channel="web" />
      <p className="text-xs text-muted-foreground">
        Conversations are stored by the business that operates this assistant. Don&apos;t share passwords, card numbers or other secrets.
      </p>
    </div>
  );
}
