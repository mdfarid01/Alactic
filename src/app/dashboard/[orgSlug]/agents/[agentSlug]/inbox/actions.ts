"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/server/auth/dal";
import { db } from "@/server/db/client";
import { answerGap, dismissGap, GapError } from "@/server/gaps/service";
import { draftGapAnswer, DraftError } from "@/server/gaps/draft";
import { HandoffError, resolveHandoff } from "@/server/handoff/service";
import { runtimeDeps } from "@/server/inference/config";
import { crawler } from "@/server/knowledge/config";
import { enqueueIngest } from "@/server/jobs/enqueue";
import { KnowledgeError } from "@/server/knowledge/service";
import { authorizeOrg } from "@/server/orgs/service";

export type GapActionState = { ok?: boolean; error?: string; fieldErrors?: Record<string, string>; queued?: boolean } | undefined;

async function adminScope(orgSlug: string) {
  const user = await requireUser();
  return authorizeOrg(db(), user.userId, orgSlug, "admin");
}

/** Turn an unanswered question into an FAQ knowledge source and queue indexing. */
export async function answerGapAction(orgSlug: string, agentSlug: string, gapId: string, question: string, answer: string): Promise<GapActionState> {
  const scope = await adminScope(orgSlug);
  if (!scope) return { error: "You don't have permission to answer questions for this agent." };
  try {
    const ticket = await answerGap(db(), scope, agentSlug, gapId, { question: String(question ?? ""), answer: String(answer ?? "") });
    const queued = await enqueueIngest(ticket);
    refresh();
    return { ok: true, queued };
  } catch (error) {
    if (error instanceof GapError || error instanceof KnowledgeError) return { error: error.message, fieldErrors: error.fieldErrors };
    throw error;
  }
}

export async function dismissGapAction(orgSlug: string, agentSlug: string, gapId: string): Promise<GapActionState> {
  const scope = await adminScope(orgSlug);
  if (!scope) return { error: "You don't have permission to change this agent." };
  try {
    await dismissGap(db(), scope, agentSlug, gapId);
    refresh();
    return { ok: true };
  } catch (error) {
    if (error instanceof GapError || error instanceof KnowledgeError) return { error: error.message };
    throw error;
  }
}

/** Mark a customer's request for a human as handled (any org member). */
export async function resolveHandoffAction(orgSlug: string, handoffId: string): Promise<GapActionState> {
  const user = await requireUser();
  const scope = await authorizeOrg(db(), user.userId, orgSlug, "member");
  if (!scope) return { error: "Not allowed." };
  try {
    await resolveHandoff(db(), scope, handoffId);
    refresh();
    return { ok: true };
  } catch (error) {
    if (error instanceof HandoffError) return { error: error.message };
    throw error;
  }
}

export type DraftState = { ok?: boolean; error?: string; draft?: string; sourceUrl?: string; sourceTitle?: string; inferenceId?: string } | undefined;

/** Draft an answer to an unanswered question from one page of the business's site (0G, agent's trust mode). */
export async function draftGapAnswerAction(orgSlug: string, agentSlug: string, gapId: string, pageUrl: string): Promise<DraftState> {
  const scope = await adminScope(orgSlug);
  if (!scope) return { error: "You don't have permission to answer questions for this agent." };
  try {
    const r = await draftGapAnswer({ ...runtimeDeps(), scrape: (url) => crawler().scrape(url) }, scope, agentSlug, gapId, String(pageUrl ?? ""));
    return { ok: true, ...r };
  } catch (error) {
    if (error instanceof DraftError || error instanceof KnowledgeError) return { error: error.message };
    throw error;
  }
}
