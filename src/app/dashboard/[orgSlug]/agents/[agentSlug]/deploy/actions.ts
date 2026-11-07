"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/server/auth/dal";
import { AgentError, publishDraft, resumeAgent, unpublishAgent, updateAllowedOrigins } from "@/server/agents/service";
import { db } from "@/server/db/client";
import { authorizeOrg } from "@/server/orgs/service";

export type DeployState = { ok?: boolean; error?: string; message?: string } | undefined;

async function editor(orgSlug: string) {
  const user = await requireUser();
  return authorizeOrg(db(), user.userId, orgSlug, "admin");
}

async function run(orgSlug: string, fn: (scope: NonNullable<Awaited<ReturnType<typeof editor>>>) => Promise<string>): Promise<DeployState> {
  const scope = await editor(orgSlug);
  if (!scope) return { error: "You don't have permission to deploy this agent." };
  try {
    const message = await fn(scope);
    refresh();
    return { ok: true, message };
  } catch (error) {
    if (error instanceof AgentError) return { error: error.message };
    throw error;
  }
}

export async function publishAction(orgSlug: string, agentSlug: string) {
  return run(orgSlug, async (scope) => `Published version ${(await publishDraft(db(), scope, agentSlug)).version}.`);
}
export async function unpublishAction(orgSlug: string, agentSlug: string) {
  return run(orgSlug, async (scope) => (await unpublishAgent(db(), scope, agentSlug), "Agent unpublished. Public chat and widget are offline."));
}
export async function resumeAction(orgSlug: string, agentSlug: string) {
  return run(orgSlug, async (scope) => (await resumeAgent(db(), scope, agentSlug), "Agent is live again."));
}
export async function saveOriginsAction(orgSlug: string, agentSlug: string, _prev: DeployState, formData: FormData) {
  const origins = String(formData.get("origins") ?? "").split(/[\s,]+/);
  return run(orgSlug, async (scope) => {
    const saved = await updateAllowedOrigins(db(), scope, agentSlug, origins);
    return saved.length ? `Widget allowed on ${saved.length} ${saved.length === 1 ? "site" : "sites"}.` : "Widget restricted to Alactic pages only.";
  });
}
