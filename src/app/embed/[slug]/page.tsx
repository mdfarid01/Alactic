import { Suspense } from "react";
import { notFound } from "next/navigation";
import { PublicChat } from "@/components/public/public-chat";
import { db } from "@/server/db/client";
import { getPublishedAgent } from "@/server/public/agents";

/** Rendered inside the website widget's iframe. Which sites may frame it is enforced by CSP (see proxy.ts). */
export default function EmbedPage({ params }: PageProps<"/embed/[slug]">) {
  return (
    <div className="h-dvh">
      <Suspense fallback={null}>
        <Embed params={params} />
      </Suspense>
    </div>
  );
}

async function Embed({ params }: { params: PageProps<"/embed/[slug]">["params"] }) {
  const { slug } = await params;
  const agent = await getPublishedAgent(db(), slug);
  if (!agent) notFound();
  return <PublicChat slug={agent.slug} agentName={agent.name} trustMode={agent.trustMode} channel="widget" compact />;
}
