import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { upsertWalletUser } from "@/server/auth/sessions";
import { createAgent, publishDraft, setAgentLive } from "@/server/agents/service";
import { recentPublicAnswers } from "@/server/deploy/service";
import { chunkPendingDocuments, embedNextBatch, finalizeRun, loadRun } from "@/server/knowledge/pipeline";
import { addFaqSource, resolveAgent } from "@/server/knowledge/service";
import { authorizeOrg, createOrganization, type OrgScope } from "@/server/orgs/service";
import { toPublicReply } from "@/server/public/reply";
import { getPublicAgent, getPublicProof } from "@/server/public/service";
import { consumeRateLimits } from "@/server/ratelimit/limiter";
import { runAgent, RunAgentError, type RunAgentDeps } from "@/server/runtime/run-agent";
import { setupTestDb } from "./helpers/db";
import { FakeChat, HashingEmbedder } from "./helpers/fakes";

const db = setupTestDb();
const embedder = new HashingEmbedder();
let acme: OrgScope;
let evil: OrgScope;
let agentRef: { orgId: string; agentId: string };

beforeEach(async () => {
  const alice = await upsertWalletUser(db, privateKeyToAccount(generatePrivateKey()).address);
  const mallory = await upsertWalletUser(db, privateKeyToAccount(generatePrivateKey()).address);
  await createOrganization(db, alice, { name: "Acme", slug: "acme" });
  await createOrganization(db, mallory, { name: "Evil", slug: "evil" });
  acme = (await authorizeOrg(db, alice, "acme"))!;
  evil = (await authorizeOrg(db, mallory, "evil"))!;
  await createAgent(db, acme, { name: "Acme Support", slug: "acme-support" }, async () => null);
  agentRef = { orgId: acme.orgId, agentId: (await resolveAgent(db, acme, "acme-support")).id };
  const t = await addFaqSource(db, acme, "acme-support", { question: "What is the refund policy?", answer: "Refunds are accepted within 45 days of delivery." });
  const src = (await loadRun(db, t.sourceId, t.runId))!;
  await chunkPendingDocuments(db, src, t.runId);
  while ((await embedNextBatch(db, src, t.runId, embedder)) > 0);
  await finalizeRun(db, src, t.runId);
});

const SIGNER = "0x83df4B8EbA7c0B3B740019b8f9a8B6E8f2F1a1b1";
const deps = (chat: FakeChat): RunAgentDeps => ({
  db,
  chat,
  embedder,
  dailyOrgLimit: 100,
  modelSupports: async () => true,
  verifyTee: async () => ({ status: "verified", reason: "test", signerAddress: SIGNER, details: { recoveredAddress: SIGNER } }),
});
const chat = () => new FakeChat(() => ({ content: "Refunds are accepted within 45 days of delivery [1]." }));
const askPublic = (visitorTokenHash: string, conversationId: string | null = null) =>
  runAgent(deps(chat()), {
    agent: agentRef,
    configVersion: "published",
    channel: "web",
    userMessage: "What is the refund policy after delivery?",
    conversationId,
    visitorTokenHash,
  });

describe("public agent visibility", () => {
  it("only published, live agents are public; pausing takes them offline", async () => {
    expect(await getPublicAgent(db, "acme-support")).toBeNull();
    await expect(askPublic("v1")).rejects.toMatchObject({ code: "not_published" });

    await publishDraft(db, acme, "acme-support");
    const pub = await getPublicAgent(db, "acme-support");
    expect(pub).toMatchObject({ slug: "acme-support", name: "Acme Support", orgName: "Acme", version: 1 });
    expect(Object.keys(pub!)).not.toContain("instructions");
    expect(Object.keys(pub!)).not.toContain("persona");

    await setAgentLive(db, acme, "acme-support", false);
    expect(await getPublicAgent(db, "acme-support")).toBeNull();
    await expect(askPublic("v1")).rejects.toMatchObject({ code: "not_published" });
    await setAgentLive(db, acme, "acme-support", true);
    expect(await getPublicAgent(db, "acme-support")).not.toBeNull();
  });

  it("another org can't pause or publish this agent (cross-tenant)", async () => {
    await publishDraft(db, acme, "acme-support");
    await expect(setAgentLive(db, evil, "acme-support", false)).rejects.toMatchObject({ code: "not_found" });
    await expect(publishDraft(db, evil, "acme-support")).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects malformed slugs", async () => {
    expect(await getPublicAgent(db, "../etc")).toBeNull();
    expect(await getPublicAgent(db, "A")).toBeNull();
  });
});

describe("public chat: visitor isolation", () => {
  it("a conversation can only be continued by the visitor who started it", async () => {
    await publishDraft(db, acme, "acme-support");
    const first = await askPublic("visitor-a");
    const again = await askPublic("visitor-a", first.conversationId);
    expect(again.conversationId).toBe(first.conversationId);
    await expect(askPublic("visitor-b", first.conversationId)).rejects.toBeInstanceOf(RunAgentError);
    await expect(askPublic("visitor-b", first.conversationId)).rejects.toMatchObject({ code: "conversation_not_found" });
  });

  it("the public reply has no retrieval diagnostics or internal reasons", async () => {
    await publishDraft(db, acme, "acme-support");
    const reply = toPublicReply(await askPublic("visitor-a"));
    expect(reply).toMatchObject({ isFallback: false, verification: { status: "verified", method: "independent" } });
    expect(Object.keys(reply)).toEqual(["conversationId", "question", "messageId", "content", "citations", "isFallback", "inference", "verification"]);
    expect(Object.keys(reply.citations[0]).sort()).toEqual(["headingPath", "n", "pageFrom", "pageTo", "sourceType", "title", "url"]);
  });
});

describe("proof receipts", () => {
  it("expose inference metadata and checks, never message content", async () => {
    await publishDraft(db, acme, "acme-support");
    const r = await askPublic("visitor-a");
    const proof = await getPublicProof(db, r.inference!.id);
    expect(proof).toMatchObject({
      status: "completed",
      channel: "public",
      modelId: "0gm-1.0-35b-a3b",
      trustMode: "private",
      routerRequestId: "req-1",
      chatId: "chat-1",
      agent: { slug: "acme-support", name: "Acme Support", orgName: "Acme" },
    });
    expect(proof!.checks.map((c) => [c.method, c.status])).toEqual([
      ["router", "verified"],
      ["independent", "verified"],
    ]);
    const json = JSON.stringify(proof);
    expect(json).not.toContain("efund");
    expect(json).not.toContain("45 days");
  });

  it("don't name an agent that isn't published, and reject bad ids", async () => {
    const r = await runAgent(deps(chat()), { agent: agentRef, configVersion: "draft", channel: "playground", userMessage: "What is the refund policy after delivery?" });
    const proof = await getPublicProof(db, r.inference!.id);
    expect(proof).toMatchObject({ channel: "internal", agent: null });
    expect(await getPublicProof(db, "not-a-uuid")).toBeNull();
    expect(await getPublicProof(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("recent public answers are org-scoped (cross-tenant)", async () => {
    await publishDraft(db, acme, "acme-support");
    await askPublic("visitor-a");
    expect(await recentPublicAnswers(db, acme, agentRef.agentId)).toHaveLength(1);
    expect(await recentPublicAnswers(db, evil, agentRef.agentId)).toHaveLength(0);
  });
});

describe("rate limiter", () => {
  it("allows up to the limit per window, then rejects with a retry time; windows reset", async () => {
    const t0 = new Date("2026-11-07T10:00:05Z");
    const rule = { key: "test:a", limit: 2, windowSeconds: 60 };
    expect(await consumeRateLimits(db, [rule], t0)).toEqual({ ok: true });
    expect(await consumeRateLimits(db, [rule], t0)).toEqual({ ok: true });
    expect(await consumeRateLimits(db, [rule], t0)).toEqual({ ok: false, key: "test:a", retryAfterSeconds: 55 });
    expect(await consumeRateLimits(db, [rule], new Date("2026-11-07T10:01:00Z"))).toEqual({ ok: true });
  });

  it("rejects when any one rule is exceeded; keys are independent", async () => {
    const t0 = new Date("2026-11-07T10:00:00Z");
    await consumeRateLimits(db, [{ key: "test:ip", limit: 1, windowSeconds: 60 }], t0);
    const d = await consumeRateLimits(
      db,
      [
        { key: "test:visitor", limit: 5, windowSeconds: 60 },
        { key: "test:ip", limit: 1, windowSeconds: 60 },
      ],
      t0,
    );
    expect(d).toMatchObject({ ok: false, key: "test:ip" });
    expect(await consumeRateLimits(db, [{ key: "test:other", limit: 1, windowSeconds: 60 }], t0)).toEqual({ ok: true });
  });
});
