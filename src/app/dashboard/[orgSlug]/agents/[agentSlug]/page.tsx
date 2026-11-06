import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { BookOpen, Fingerprint, Globe, MessageSquare } from "lucide-react";
import { AgentBuilderForm, type BuilderCatalog } from "@/components/agents/agent-builder-form";
import { DeleteAgentDialog } from "@/components/agents/delete-agent-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAgentForEdit } from "@/server/agents/service";
import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { getModelCatalog } from "@/server/inference/catalog";
import { getPageOrgScope } from "@/server/orgs/page-scope";
import { roleAtLeast } from "@/server/orgs/service";

export const metadata: Metadata = { title: "Agent" };

type Params = PageProps<"/dashboard/[orgSlug]/agents/[agentSlug]">["params"];

export default function AgentPage({ params }: PageProps<"/dashboard/[orgSlug]/agents/[agentSlug]">) {
  return (
    <Suspense fallback={<Skeleton className="h-[600px] w-full" />}>
      <AgentBuilder params={params} />
    </Suspense>
  );
}

async function AgentBuilder({ params }: { params: Params }) {
  const { orgSlug, agentSlug } = await params;
  const scope = await getPageOrgScope(orgSlug);
  const [data, catalogResult] = await Promise.all([getAgentForEdit(db(), scope, agentSlug), getModelCatalog()]);
  if (!data) notFound();

  const { agent, config, isDraft, published } = data;
  const canEdit = roleAtLeast(scope.role, "admin");
  const ensParent = env().ENS_PARENT_NAME;
  const catalog: BuilderCatalog = catalogResult.ok
    ? {
        ok: true,
        availability: catalogResult.availability,
        models: catalogResult.models.map(({ id, name, verifiability, contextLength, pricingUsd, trustModes }) => ({
          id,
          name,
          verifiability,
          contextLength,
          pricingUsd,
          trustModes,
        })),
      }
    : catalogResult;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <AgentBuilderForm
          key={config.id}
          orgSlug={scope.orgSlug}
          agentSlug={agent.slug}
          canEdit={canEdit}
          slugLocked={agent.publishedConfigId !== null}
          ensParent={ensParent}
          catalog={catalog}
          config={{
            name: config.name,
            description: config.description,
            instructions: config.instructions,
            persona: config.persona,
            tone: config.tone,
            language: config.language,
            fallbackMessage: config.fallbackMessage,
            modelId: config.modelId,
            trustMode: config.trustMode,
            temperature: config.temperature,
            maxOutputTokens: config.maxOutputTokens,
            retrievalTopK: config.retrievalTopK,
            updatedAt: config.updatedAt.toISOString(),
          }}
        />

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status</CardTitle>
              <CardDescription>
                {isDraft ? `Editing draft · version ${config.version}` : `Showing published version ${config.version}`}
                {published ? ` · v${published.version} published` : " · never published"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                Last saved {config.updatedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Next steps</CardTitle>
              <CardDescription>Items marked “Soon” arrive in upcoming releases.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <NextStep
                icon={BookOpen}
                title="Knowledge"
                available
                body={
                  <Link href={`/dashboard/${scope.orgSlug}/agents/${agent.slug}/knowledge`} className="underline-offset-4 hover:underline">
                    Add website pages, documents and FAQs →
                  </Link>
                }
              />
              <NextStep icon={MessageSquare} title="Playground" body="Test answers with citations and verification status." />
              <NextStep icon={Globe} title="Publish" body="Public chat page and website widget." />
              <NextStep
                icon={Fingerprint}
                title="ENS identity"
                body={
                  <>
                    Planned name <span className="font-mono">{agent.slug}.{ensParent}</span>, managed by Alactic. Not on-chain yet.
                  </>
                }
              />
            </CardContent>
          </Card>

          {canEdit ? (
            <Card className="border-destructive/30">
              <CardHeader>
                <CardTitle className="text-base">Danger zone</CardTitle>
              </CardHeader>
              <CardContent>
                <DeleteAgentDialog orgSlug={scope.orgSlug} agentSlug={agent.slug} />
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function NextStep({ icon: Icon, title, body, available }: { icon: typeof BookOpen; title: string; body: React.ReactNode; available?: boolean }) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div>
        <p className="flex items-center gap-2 font-medium">
          {title} {available ? null : <Badge variant="secondary">Soon</Badge>}
        </p>
        <p className="text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
