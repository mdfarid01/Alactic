"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/server/auth/dal";
import { db } from "@/server/db/client";
import { agentTestsRequested, inngest } from "@/server/jobs/client";
import { KnowledgeError } from "@/server/knowledge/service";
import { authorizeOrg } from "@/server/orgs/service";
import { addTestCase, deleteTestCase, startTestRun, TestSuiteError } from "@/server/tests/service";

export type TestActionState = { ok?: boolean; error?: string; fieldErrors?: Record<string, string> } | undefined;

async function adminScope(orgSlug: string) {
  const user = await requireUser();
  return authorizeOrg(db(), user.userId, orgSlug, "admin");
}

function toState(error: unknown): TestActionState {
  if (error instanceof TestSuiteError) return { error: error.message, fieldErrors: error.fieldErrors };
  if (error instanceof KnowledgeError) return { error: error.message };
  throw error;
}

export async function addTestCaseAction(orgSlug: string, agentSlug: string, input: { question: string; mustInclude: string; expectAnswer: boolean }): Promise<TestActionState> {
  const scope = await adminScope(orgSlug);
  if (!scope) return { error: "You don't have permission to change this agent's tests." };
  try {
    const phrases = String(input.mustInclude ?? "")
      .split(/[,\n]/)
      .map((p) => p.trim())
      .filter(Boolean);
    await addTestCase(db(), scope, agentSlug, { question: String(input.question ?? ""), mustInclude: phrases, expectAnswer: input.expectAnswer !== false });
    refresh();
    return { ok: true };
  } catch (error) {
    return toState(error);
  }
}

export async function deleteTestCaseAction(orgSlug: string, agentSlug: string, caseId: string): Promise<TestActionState> {
  const scope = await adminScope(orgSlug);
  if (!scope) return { error: "You don't have permission to change this agent's tests." };
  try {
    await deleteTestCase(db(), scope, agentSlug, caseId);
    refresh();
    return { ok: true };
  } catch (error) {
    return toState(error);
  }
}

/** Start a run against the current draft; the questions are answered on 0G by a background job. */
export async function runTestsAction(orgSlug: string, agentSlug: string): Promise<TestActionState> {
  const scope = await adminScope(orgSlug);
  if (!scope) return { error: "You don't have permission to run this agent's tests." };
  try {
    const ticket = await startTestRun(db(), scope, agentSlug);
    try {
      await inngest.send(agentTestsRequested.create(ticket));
    } catch {
      return { error: "Couldn't start the test run (job queue unreachable). Is the Inngest dev server running?" };
    }
    refresh();
    return { ok: true };
  } catch (error) {
    return toState(error);
  }
}
