import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/server/db/client";
import { agentConfigs, agentTestCases, agentTestResults, agentTestRuns } from "@/server/db/schema";
import { resolveAgent } from "@/server/knowledge/service";
import { roleAtLeast, type OrgScope } from "@/server/orgs/service";
import { runAgent, RunAgentError, type RunAgentDeps, type RunAgentResult } from "@/server/runtime/run-agent";

export const MAX_TEST_CASES = 25;

export class TestSuiteError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid_input" | "limit" | "empty", message: string, public readonly fieldErrors?: Record<string, string>) {
    super(message);
  }
}

const caseSchema = z.object({
  question: z.string().trim().min(3, "Enter a question").max(500),
  mustInclude: z.array(z.string().trim().min(1).max(100)).max(10, "At most 10 phrases").default([]),
  expectAnswer: z.boolean().default(true),
});

function requireAdmin(scope: OrgScope) {
  if (!roleAtLeast(scope.role, "admin")) throw new TestSuiteError("forbidden", "Only admins can change tests.");
}

export async function listTestCases(db: Database, scope: OrgScope, agentSlug: string) {
  const agent = await resolveAgent(db, scope, agentSlug);
  return db
    .select({ id: agentTestCases.id, question: agentTestCases.question, mustInclude: agentTestCases.mustInclude, expectAnswer: agentTestCases.expectAnswer, createdAt: agentTestCases.createdAt })
    .from(agentTestCases)
    .where(and(eq(agentTestCases.orgId, scope.orgId), eq(agentTestCases.agentId, agent.id)))
    .orderBy(asc(agentTestCases.createdAt));
}

export async function addTestCase(db: Database, scope: OrgScope, agentSlug: string, input: z.input<typeof caseSchema>) {
  requireAdmin(scope);
  const agent = await resolveAgent(db, scope, agentSlug);
  const parsed = caseSchema.safeParse(input);
  if (!parsed.success) throw new TestSuiteError("invalid_input", parsed.error.issues[0]?.message ?? "Invalid test", Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(agentTestCases).where(and(eq(agentTestCases.orgId, scope.orgId), eq(agentTestCases.agentId, agent.id)));
  if (n >= MAX_TEST_CASES) throw new TestSuiteError("limit", `An agent can have up to ${MAX_TEST_CASES} tests.`);
  const [row] = await db
    .insert(agentTestCases)
    .values({ orgId: scope.orgId, agentId: agent.id, question: parsed.data.question, mustInclude: parsed.data.mustInclude, expectAnswer: parsed.data.expectAnswer, createdBy: scope.userId })
    .returning({ id: agentTestCases.id });
  return row.id;
}

export async function deleteTestCase(db: Database, scope: OrgScope, agentSlug: string, caseId: string) {
  requireAdmin(scope);
  const agent = await resolveAgent(db, scope, agentSlug);
  if (!z.uuid().safeParse(caseId).success) throw new TestSuiteError("not_found", "Test not found.");
  const deleted = await db
    .delete(agentTestCases)
    .where(and(eq(agentTestCases.id, caseId), eq(agentTestCases.orgId, scope.orgId), eq(agentTestCases.agentId, agent.id)))
    .returning({ id: agentTestCases.id });
  if (!deleted.length) throw new TestSuiteError("not_found", "Test not found.");
}

/** Pure scoring: why an answer passes or fails its golden question. */
export function scoreAnswer(test: { mustInclude: string[]; expectAnswer: boolean }, result: Pick<RunAgentResult, "reply" | "verification" | "error">): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (result.verification?.status === "failed") reasons.push("TEE signature verification failed");
  if (test.expectAnswer) {
    if (result.reply.isFallback) reasons.push(result.error ? `No AI answer (${result.error.message})` : "The agent couldn't answer from its knowledge");
    const text = result.reply.content.toLowerCase();
    for (const phrase of test.mustInclude) if (!text.includes(phrase.toLowerCase())) reasons.push(`Missing “${phrase}”`);
  } else if (!result.reply.isFallback) {
    reasons.push("Expected the agent to decline, but it answered");
  }
  return { passed: reasons.length === 0, reasons };
}

/** Create a run for the agent's current draft (or latest) config. The caller queues `executeTestRun`. */
export async function startTestRun(db: Database, scope: OrgScope, agentSlug: string) {
  requireAdmin(scope);
  const agent = await resolveAgent(db, scope, agentSlug);
  const cases = await listTestCases(db, scope, agentSlug);
  if (!cases.length) throw new TestSuiteError("empty", "Add at least one test first.");
  const [config] = await db
    .select({ id: agentConfigs.id, version: agentConfigs.version })
    .from(agentConfigs)
    .where(and(eq(agentConfigs.agentId, agent.id), eq(agentConfigs.orgId, scope.orgId)))
    .orderBy(sql`${agentConfigs.publishedAt} is null desc`, desc(agentConfigs.version))
    .limit(1);
  const [run] = await db
    .insert(agentTestRuns)
    .values({ orgId: scope.orgId, agentId: agent.id, configId: config.id, configVersion: config.version, total: cases.length, startedBy: scope.userId })
    .returning({ id: agentTestRuns.id });
  return { runId: run.id, agentId: agent.id, orgId: scope.orgId, userId: scope.userId };
}

/**
 * Execute a run (job context; the run row was created by an authorized admin). Each golden question goes through the
 * real runtime on 0G against the draft config, without recording knowledge gaps. Every result links to its proof receipt.
 */
export async function executeTestRun(deps: RunAgentDeps, ticket: { runId: string; agentId: string; orgId: string; userId: string }) {
  const { db } = deps;
  const cases = await db
    .select()
    .from(agentTestCases)
    .where(and(eq(agentTestCases.orgId, ticket.orgId), eq(agentTestCases.agentId, ticket.agentId)))
    .orderBy(asc(agentTestCases.createdAt))
    .limit(MAX_TEST_CASES);
  let passed = 0;
  try {
    for (const tc of cases) {
      try {
        const result = await runAgent(deps, {
          agent: { orgId: ticket.orgId, agentId: ticket.agentId },
          configVersion: "draft",
          channel: "playground",
          userMessage: tc.question,
          startedBy: ticket.userId,
          recordGaps: false,
        });
        const score = scoreAnswer(tc, result);
        if (score.passed) passed++;
        await db.insert(agentTestResults).values({
          orgId: ticket.orgId,
          runId: ticket.runId,
          caseId: tc.id,
          question: tc.question,
          passed: score.passed,
          reasons: score.reasons,
          answerExcerpt: result.reply.content.slice(0, 600),
          inferenceId: result.inference?.id ?? null,
        });
      } catch (error) {
        if (!(error instanceof RunAgentError)) throw error;
        await db.insert(agentTestResults).values({ orgId: ticket.orgId, runId: ticket.runId, caseId: tc.id, question: tc.question, passed: false, reasons: [error.message] });
      }
    }
    await db
      .update(agentTestRuns)
      .set({ status: passed === cases.length ? "passed" : "failed", passed, total: cases.length, finishedAt: new Date() })
      .where(and(eq(agentTestRuns.id, ticket.runId), eq(agentTestRuns.orgId, ticket.orgId)));
  } catch (error) {
    await db.update(agentTestRuns).set({ status: "error", passed, finishedAt: new Date() }).where(eq(agentTestRuns.id, ticket.runId));
    throw error;
  }
  return { passed, total: cases.length };
}

/** Recent runs with their results (org-scoped). */
export async function recentTestRuns(db: Database, scope: OrgScope, agentSlug: string, limit = 5) {
  const agent = await resolveAgent(db, scope, agentSlug);
  const runs = await db
    .select()
    .from(agentTestRuns)
    .where(and(eq(agentTestRuns.orgId, scope.orgId), eq(agentTestRuns.agentId, agent.id)))
    .orderBy(desc(agentTestRuns.startedAt))
    .limit(limit);
  const results = runs.length
    ? await db
        .select()
        .from(agentTestResults)
        .where(and(eq(agentTestResults.orgId, scope.orgId), sql`${agentTestResults.runId} in ${runs.map((r) => r.id)}`))
        .orderBy(asc(agentTestResults.createdAt))
    : [];
  return runs.map((r) => ({ ...r, results: results.filter((x) => x.runId === r.id) }));
}

/** Latest finished run for a specific config (for the Deploy tab's publish check). */
export async function latestRunForConfig(db: Database, scope: OrgScope, agentId: string, configId: string) {
  const [run] = await db
    .select({ status: agentTestRuns.status, passed: agentTestRuns.passed, total: agentTestRuns.total, finishedAt: agentTestRuns.finishedAt })
    .from(agentTestRuns)
    .where(and(eq(agentTestRuns.orgId, scope.orgId), eq(agentTestRuns.agentId, agentId), eq(agentTestRuns.configId, configId)))
    .orderBy(desc(agentTestRuns.startedAt))
    .limit(1);
  return run ?? null;
}
