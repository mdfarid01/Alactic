"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/dal";
import { catalogModelValidator } from "@/server/agents/model-validator";
import { AgentError, createAgent, deleteAgent, publishDraft, saveDraft, setAgentLive } from "@/server/agents/service";
import { db } from "@/server/db/client";
import { authorizeOrg } from "@/server/orgs/service";

export type AgentFormState =
  | { ok?: boolean; error?: string; fieldErrors?: Record<string, string>; updatedAt?: string }
  | undefined;

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");

async function editorScope(orgSlug: string) {
  const user = await requireUser();
  return authorizeOrg(db(), user.userId, orgSlug, "admin");
}

function toState(error: unknown): AgentFormState {
  if (error instanceof AgentError) return { error: error.message, fieldErrors: error.fieldErrors };
  throw error;
}

export async function createAgentAction(orgSlug: string, _prev: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const scope = await editorScope(orgSlug);
  if (!scope) return { error: "You don't have permission to create agents in this organization." };
  let slug: string;
  try {
    const agent = await createAgent(
      db(),
      scope,
      { name: str(formData, "name"), slug: str(formData, "slug"), description: str(formData, "description") },
      catalogModelValidator,
    );
    slug = agent.slug;
  } catch (error) {
    return toState(error);
  }
  redirect(`/dashboard/${scope.orgSlug}/agents/${slug}`);
}

export async function saveAgentAction(
  orgSlug: string,
  agentSlug: string,
  _prev: AgentFormState,
  formData: FormData,
): Promise<AgentFormState> {
  const scope = await editorScope(orgSlug);
  if (!scope) return { error: "You don't have permission to edit this agent." };
  const slugField = formData.get("slug");
  let result: Awaited<ReturnType<typeof saveDraft>>;
  try {
    result = await saveDraft(
      db(),
      scope,
      agentSlug,
      {
        config: {
          name: str(formData, "name"),
          description: str(formData, "description"),
          instructions: str(formData, "instructions"),
          persona: str(formData, "persona"),
          tone: str(formData, "tone") as "professional",
          language: str(formData, "language") as "auto",
          fallbackMessage: str(formData, "fallbackMessage"),
          modelId: str(formData, "modelId"),
          trustMode: str(formData, "trustMode") as "private",
          temperature: str(formData, "temperature"),
          maxOutputTokens: str(formData, "maxOutputTokens"),
          retrievalTopK: str(formData, "retrievalTopK"),
        },
        slug: slugField === null ? undefined : String(slugField),
        expectedUpdatedAt: str(formData, "expectedUpdatedAt"),
      },
      catalogModelValidator,
    );
  } catch (error) {
    return toState(error);
  }
  if (result.slug !== agentSlug) redirect(`/dashboard/${scope.orgSlug}/agents/${result.slug}`);
  refresh();
  return { ok: true, updatedAt: result.updatedAt };
}

export async function deleteAgentAction(orgSlug: string, agentSlug: string): Promise<AgentFormState> {
  const scope = await editorScope(orgSlug);
  if (!scope) return { error: "You don't have permission to delete this agent." };
  try {
    await deleteAgent(db(), scope, agentSlug);
  } catch (error) {
    return toState(error);
  }
  redirect(`/dashboard/${scope.orgSlug}/agents`);
}

export type PublishState = { ok?: boolean; error?: string; version?: number } | undefined;

/** Freeze the current draft as a new immutable version and make it live on the public page and widget. */
export async function publishAgentAction(orgSlug: string, agentSlug: string): Promise<PublishState> {
  const scope = await editorScope(orgSlug);
  if (!scope) return { error: "You don't have permission to publish this agent." };
  try {
    const { version } = await publishDraft(db(), scope, agentSlug);
    refresh();
    return { ok: true, version };
  } catch (error) {
    if (error instanceof AgentError) return { error: error.message };
    throw error;
  }
}

/** Pause (take offline) or resume a published agent. The published version is kept. */
export async function setAgentLiveAction(orgSlug: string, agentSlug: string, live: boolean): Promise<PublishState> {
  const scope = await editorScope(orgSlug);
  if (!scope) return { error: "You don't have permission to change this agent." };
  try {
    await setAgentLive(db(), scope, agentSlug, live);
    refresh();
    return { ok: true };
  } catch (error) {
    if (error instanceof AgentError) return { error: error.message };
    throw error;
  }
}
