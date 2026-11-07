import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { answerFingerprint, decodeAnswerFragment, encodeAnswerFragment } from "@/lib/answer-fingerprint";
import { upsertWalletUser } from "@/server/auth/sessions";
import { createAgent, getAgentForEdit, publishDraft } from "@/server/agents/service";
import { agentConfigs, inferenceRecords, knowledgeGaps } from "@/server/db/schema";
import { chunkPendingDocuments, embedNextBatch, finalizeRun, loadRun } from "@/server/knowledge/pipeline";
import { addFaqSource, resolveAgent } from "@/server/knowledge/service";
import { addMemberByWallet, authorizeOrg, createOrganization, type OrgScope } from "@/server/orgs/service";
import { getPublicAgent, getPublicProof } from "@/server/public/service";
import { getTrustStats, pct } from "@/server/public/trust";
import { runAgent, type RunAgentDeps } from "@/server/runtime/run-agent";
import { addTestCase, deleteTestCase, executeTestRun, latestRunForConfig, listTestCases, MAX_TEST_CASES, recentTestRuns, scoreAnswer, startTestRun } from "@/server/tests/service";
import { setupTestDb } from "./helpers/db";
import { FakeChat, HashingEmbedder } from "./helpers/fakes";

const db = setupTestDb();
const embedder = new HashingEmbedder();
let acme: OrgScope;
let member: OrgScope;
let evil: OrgScope;
let agentRef: { orgId: string; agentId: string };
let fallback: string;

beforeEach(async () => {
  const alice = await upsertWalletUser(db, privateKeyToAccount(generatePrivateKey()).address);
  const bob = privateKeyToAccount(generatePrivateKey());
  const mallory = await upsertWalletUser(db, privateKeyToAccount(generatePrivateKey()).address);
  await createOrganization(db, alice, { name: "Acme", slug: "acme" });
  await createOrganization(db, mallory, { name: "Evil", slug: "evil" });
  acme = (await authorizeOrg(db, alice, "acme"))!;
  evil = (await authorizeOrg(db, mallory, "evil"))!;
  await addMemberByWallet(db, acme, { address: bob.address, role: "member" });
  member = (await authorizeOrg(db, await upsertWalletUser(db, bob.address), "acme"))!;
  await createAgent(db, acme, { name: "Acme Support", slug: "acme-support" }, async () => null);
  const agent = await resolveAgent(db, acme, "acme-support");
  agentRef = { orgId: acme.orgId, agentId: agent.id };
  [{ fallback }] = await db.select({ fallback: agentConfigs.fallbackMessage }).from(agentConfigs).where(eq(agentConfigs.agentId, agent.id));
  const t = await addFaqSource(db, acme, "acme-support", { question: "What is the refund policy?", answer: "Refunds are accepted within 45 days of delivery." });
  const src = (await loadRun(db, t.sourceId, t.runId))!;
  await chunkPendingDocuments(db, src, t.runId);
  while ((await embedNextBatch(db, src, t.runId, embedder)) > 0);
  await finalizeRun(db, src, t.runId);
});

const deps = (respond: (q: string) => string = () => "Refunds are accepted within 45 days of delivery [1]."): RunAgentDeps => ({
  db,
  chat: new FakeChat((req) => ({ content: respond(String(req.messages.at(-1)!.content)) })),
  embedder,
  dailyOrgLimit: 1000,
  modelSupports: async () => true,
  verifyTee: async () => ({ status: "verified", reason: "t", signerAddress: null, details: {} }),
});

describe("answer fingerprints (proof of what support told you)", () => {
  it("are deterministic, bound to the receipt id, and survive the URL fragment round trip", async () => {
    const a = await answerFingerprint("id-1", "Refunds: 45 days ✅ — café");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await answerFingerprint("id-1", "Refunds: 45 days ✅ — café")).toBe(a);
    expect(await answerFingerprint("id-2", "Refunds: 45 days ✅ — café")).not.toBe(a);
    expect(await answerFingerprint("id-1", "Refunds: 46 days ✅ — café")).not.toBe(a);
    expect(decodeAnswerFragment(encodeAnswerFragment("Refunds: 45 days ✅ — café\nline 2"))).toBe("Refunds: 45 days ✅ — café\nline 2");
    expect(decodeAnswerFragment("%%%")).toBeNull();
  });

  it("the runtime records the fingerprint of exactly what was shown, and the receipt publishes it", async () => {
    const r = await runAgent(deps(), { agent: agentRef, configVersion: "draft", channel: "playground", userMessage: "What is the refund policy after delivery?" });
    const [rec] = await db.select().from(inferenceRecords).where(eq(inferenceRecords.id, r.inference!.id));
    expect(rec.answerSha256).toBe(await answerFingerprint(r.inference!.id, r.reply.content));
    expect((await getPublicProof(db, r.inference!.id))!.answerSha256).toBe(rec.answerSha256);
  });
});

describe("public trust stats", () => {
  it("count only public answers, with verification and knowledge coverage", async () => {
    await publishDraft(db, acme, "acme-support");
    const d = deps((q) => (q.includes("refund") ? "Refunds are accepted within 45 days of delivery [1]." : fallback));
    const ask = (userMessage: string, channel: "web" | "playground") => runAgent(d, { agent: agentRef, configVersion: "published", channel, userMessage, visitorTokenHash: "v" });
    await ask("What is the refund policy after delivery?", "web");
    await ask("What is the refund policy after delivery?", "web");
    await ask("Do you sell gift cards?", "web");
    await ask("What is the refund policy after delivery?", "playground");
    const s = await getTrustStats(db, (await getPublicAgent(db, "acme-support"))!);
    expect(s).toMatchObject({ answers: 3, verified: 3, answeredFromKnowledge: 2, knowledge: [{ type: "faq", sources: 1 }], channels: ["web", "widget"] });
    expect(s.versions.map((v) => v.version)).toEqual([1]);
    expect(pct(2, 3)).toBe(67);
    expect(pct(0, 0)).toBeNull();
  });
});

describe("agent test suite", () => {
  it("scores answers: required phrases, declines, fallbacks and failed verification", () => {
    const reply = (content: string, isFallback = false) => ({ reply: { messageId: "m", content, citations: [], isFallback }, verification: { status: "verified" as const, method: "independent" as const, reason: null, signerAddress: null } });
    expect(scoreAnswer({ mustInclude: ["45 days"], expectAnswer: true }, reply("Refunds within 45 DAYS."))).toEqual({ passed: true, reasons: [] });
    expect(scoreAnswer({ mustInclude: ["45 days", "receipt"], expectAnswer: true }, reply("Refunds within 45 days."))).toEqual({ passed: false, reasons: ["Missing “receipt”"] });
    expect(scoreAnswer({ mustInclude: [], expectAnswer: true }, reply("fallback", true)).passed).toBe(false);
    expect(scoreAnswer({ mustInclude: [], expectAnswer: false }, reply("fallback", true)).passed).toBe(true);
    expect(scoreAnswer({ mustInclude: [], expectAnswer: false }, reply("Sure, here is a poem"))).toEqual({ passed: false, reasons: ["Expected the agent to decline, but it answered"] });
    expect(scoreAnswer({ mustInclude: [], expectAnswer: true }, { ...reply("ok"), verification: { status: "failed", method: "independent", reason: null, signerAddress: null } }).reasons).toContain("TEE signature verification failed");
  });

  it("runs golden questions on the draft, records results with receipts, and doesn't fill the gap inbox", async () => {
    await addTestCase(db, acme, "acme-support", { question: "What is the refund policy after delivery?", mustInclude: ["45 days"] });
    await addTestCase(db, acme, "acme-support", { question: "Write me a poem about the sea", expectAnswer: false });
    await addTestCase(db, acme, "acme-support", { question: "Do you ship to Mars?", mustInclude: ["Mars"] });
    const ticket = await startTestRun(db, acme, "acme-support");
    const d = deps((q) => (q.includes("refund") ? "Refunds are accepted within 45 days of delivery [1]." : fallback));
    expect(await executeTestRun(d, ticket)).toEqual({ passed: 2, total: 3 });
    const [run] = await recentTestRuns(db, acme, "acme-support");
    expect(run).toMatchObject({ status: "failed", passed: 2, total: 3 });
    expect(run.results.map((r) => [r.passed, r.reasons])).toEqual([
      [true, []],
      [true, []],
      [false, ["The agent couldn't answer from its knowledge", "Missing “Mars”"]],
    ]);
    expect(run.results.every((r) => r.inferenceId)).toBe(true);
    expect(await db.select().from(knowledgeGaps)).toHaveLength(0);
    const data = (await getAgentForEdit(db, acme, "acme-support"))!;
    expect(await latestRunForConfig(db, acme, agentRef.agentId, data.config.id)).toMatchObject({ status: "failed", passed: 2, total: 3 });
  });

  it("enforces roles, limits and tenant isolation", async () => {
    await expect(addTestCase(db, member, "acme-support", { question: "Hello there?" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(startTestRun(db, acme, "acme-support")).rejects.toMatchObject({ code: "empty" });
    await expect(addTestCase(db, acme, "acme-support", { question: "x" })).rejects.toMatchObject({ code: "invalid_input" });
    const id = await addTestCase(db, acme, "acme-support", { question: "Refund policy?" });
    expect(await listTestCases(db, member, "acme-support")).toHaveLength(1);
    await expect(listTestCases(db, evil, "acme-support")).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteTestCase(db, evil, "acme-support", id)).rejects.toMatchObject({ code: "not_found" });
    await expect(startTestRun(db, evil, "acme-support")).rejects.toMatchObject({ code: "not_found" });
    for (let i = 1; i < MAX_TEST_CASES; i++) await addTestCase(db, acme, "acme-support", { question: `Question number ${i}?` });
    await expect(addTestCase(db, acme, "acme-support", { question: "One too many?" })).rejects.toMatchObject({ code: "limit" });
    await deleteTestCase(db, acme, "acme-support", id);
    expect(await listTestCases(db, acme, "acme-support")).toHaveLength(MAX_TEST_CASES - 1);
  });
});
