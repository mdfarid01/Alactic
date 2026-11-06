"use server";

import { requireUser } from "@/server/auth/dal";
import { db } from "@/server/db/client";
import { runtimeDeps } from "@/server/inference/config";
import { KnowledgeError, resolveAgent } from "@/server/knowledge/service";
import { authorizeOrg } from "@/server/orgs/service";
import { runAgent, RunAgentError, type RunAgentResult } from "@/server/runtime/run-agent";

export type PlaygroundResponse = { ok: true; result: RunAgentResult } | { ok: false; error: string };

/** Playground: any org member can test the agent's current draft. Uses the same runtime as every public channel. */
export async function sendPlaygroundMessage(
  orgSlug: string,
  agentSlug: string,
  conversationId: string | null,
  text: string,
): Promise<PlaygroundResponse> {
  const user = await requireUser();
  const scope = await authorizeOrg(db(), user.userId, orgSlug, "member");
  if (!scope) return { ok: false, error: "Agent not found." };
  try {
    const agent = await resolveAgent(db(), scope, agentSlug);
    const result = await runAgent(runtimeDeps(), {
      agent: { orgId: scope.orgId, agentId: agent.id },
      configVersion: "draft",
      channel: "playground",
      conversationId,
      userMessage: String(text ?? ""),
      startedBy: user.userId,
    });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof RunAgentError || error instanceof KnowledgeError) return { ok: false, error: error.message };
    console.error("[playground] unexpected error", error instanceof Error ? error.name : "unknown");
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
