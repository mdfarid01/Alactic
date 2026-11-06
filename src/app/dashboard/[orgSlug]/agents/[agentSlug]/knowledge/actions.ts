"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/server/auth/dal";
import { db } from "@/server/db/client";
import { enqueueIngest } from "@/server/jobs/enqueue";
import { embeddingProvider } from "@/server/knowledge/config";
import { EmbeddingError } from "@/server/knowledge/embeddings";
import { retrievePassages, type RetrievedPassage } from "@/server/knowledge/retrieval";
import {
  addFaqSource,
  addTextSource,
  addWebsiteSource,
  deleteSource,
  KnowledgeError,
  reindexSource,
  resolveAgent,
  type IngestTicket,
} from "@/server/knowledge/service";
import { authorizeOrg } from "@/server/orgs/service";

export type KnowledgeFormState = { ok?: boolean; error?: string; fieldErrors?: Record<string, string> } | undefined;

const str = (f: FormData, k: string) => String(f.get(k) ?? "");

async function scopeFor(orgSlug: string, role: "admin" | "member") {
  const user = await requireUser();
  return authorizeOrg(db(), user.userId, orgSlug, role);
}

async function run(orgSlug: string, create: (scope: NonNullable<Awaited<ReturnType<typeof scopeFor>>>) => Promise<IngestTicket>): Promise<KnowledgeFormState> {
  const scope = await scopeFor(orgSlug, "admin");
  if (!scope) return { error: "You don't have permission to change this agent's knowledge." };
  let ticket: IngestTicket;
  try {
    ticket = await create(scope);
  } catch (error) {
    if (error instanceof KnowledgeError) return { error: error.message, fieldErrors: error.fieldErrors };
    throw error;
  }
  const queued = await enqueueIngest(ticket);
  refresh();
  return queued ? { ok: true } : { error: "Saved, but background processing is unavailable right now. Use “Re-index” to retry." };
}

export async function addWebsiteAction(orgSlug: string, agentSlug: string, _p: KnowledgeFormState, f: FormData) {
  return run(orgSlug, (scope) => addWebsiteSource(db(), scope, agentSlug, { url: str(f, "url"), maxPages: str(f, "maxPages") }));
}

export async function addFaqAction(orgSlug: string, agentSlug: string, _p: KnowledgeFormState, f: FormData) {
  return run(orgSlug, (scope) => addFaqSource(db(), scope, agentSlug, { question: str(f, "question"), answer: str(f, "answer") }));
}

export async function addTextAction(orgSlug: string, agentSlug: string, _p: KnowledgeFormState, f: FormData) {
  return run(orgSlug, (scope) => addTextSource(db(), scope, agentSlug, { title: str(f, "title"), content: str(f, "content") }));
}

export async function reindexSourceAction(orgSlug: string, agentSlug: string, sourceId: string) {
  return run(orgSlug, (scope) => reindexSource(db(), scope, agentSlug, sourceId));
}

export async function deleteSourceAction(orgSlug: string, agentSlug: string, sourceId: string): Promise<KnowledgeFormState> {
  const scope = await scopeFor(orgSlug, "admin");
  if (!scope) return { error: "You don't have permission to change this agent's knowledge." };
  try {
    await deleteSource(db(), scope, agentSlug, sourceId);
  } catch (error) {
    if (error instanceof KnowledgeError) return { error: error.message };
    throw error;
  }
  refresh();
  return { ok: true };
}

export type SearchResult = { results?: Array<Omit<RetrievedPassage, "content"> & { excerpt: string }>; error?: string };

/** Retrieval test for org members: shows which passages an answer would be based on. No LLM involved. */
export async function searchKnowledgeAction(orgSlug: string, agentSlug: string, query: string): Promise<SearchResult> {
  const scope = await scopeFor(orgSlug, "member");
  if (!scope) return { error: "Agent not found." };
  const q = query.trim().slice(0, 500);
  if (q.length < 2) return { error: "Type a question to search." };
  try {
    const agent = await resolveAgent(db(), scope, agentSlug);
    const embedder = embeddingProvider();
    const embedding = await embedder.embedQuery(q);
    const results = await retrievePassages(db(), { orgId: scope.orgId, agentId: agent.id }, { embedding, model: embedder.model }, { k: 5 });
    return { results: results.map(({ content, ...r }) => ({ ...r, excerpt: content.slice(0, 600) })) };
  } catch (error) {
    if (error instanceof EmbeddingError || error instanceof KnowledgeError) return { error: error.message };
    throw error;
  }
}
