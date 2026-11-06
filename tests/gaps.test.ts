import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { upsertWalletUser } from "@/server/auth/sessions";
import { createAgent } from "@/server/agents/service";
import { knowledgeGaps, knowledgeSources } from "@/server/db/schema";
import { answerGap, dismissGap, listGaps, openGapCounts, recordGap } from "@/server/gaps/service";
import { InferenceError } from "@/server/inference/router-client";
import { resolveAgent } from "@/server/knowledge/service";
import { addMemberByWallet, authorizeOrg, createOrganization, type OrgScope } from "@/server/orgs/service";
import { runAgent, type RunAgentDeps } from "@/server/runtime/run-agent";
import { setupTestDb } from "./helpers/db";
import { FakeChat, HashingEmbedder } from "./helpers/fakes";

const db = setupTestDb();
const embedder = new HashingEmbedder();
let acme: OrgScope;
let acmeMember: OrgScope;
let evil: OrgScope;
let agentRef: { orgId: string; agentId: string };
let fallback: string;

beforeEach(async () => {
  const alice = await upsertWalletUser(db, privateKeyToAccount(generatePrivateKey()).address);
  const bobAccount = privateKeyToAccount(generatePrivateKey());
  const mallory = await upsertWalletUser(db, privateKeyToAccount(generatePrivateKey()).address);
  await createOrganization(db, alice, { name: "Acme", slug: "acme" });
  await createOrganization(db, mallory, { name: "Evil", slug: "evil" });
  acme = (await authorizeOrg(db, alice, "acme"))!;
  evil = (await authorizeOrg(db, mallory, "evil"))!;
  await addMemberByWallet(db, acme, { address: bobAccount.address, role: "member" });
  const bob = await upsertWalletUser(db, bobAccount.address);
  acmeMember = (await authorizeOrg(db, bob, "acme"))!;
  await createAgent(db, acme, { name: "Acme Support", slug: "acme-support" }, async () => null);
  const agent = await resolveAgent(db, acme, "acme-support");
  agentRef = { orgId: acme.orgId, agentId: agent.id };
  const { agentConfigs } = await import("@/server/db/schema");
  [{ fallback }] = await db.select({ fallback: agentConfigs.fallbackMessage }).from(agentConfigs).where(eq(agentConfigs.agentId, agent.id));
});

const deps = (chat: FakeChat): RunAgentDeps => ({
  db,
  chat,
  embedder,
  dailyOrgLimit: 100,
  modelSupports: async () => true,
  verifyTee: async () => ({ status: "unavailable", reason: "test", signerAddress: null, details: {} }),
});
const ask = (chat: FakeChat, text: string) => runAgent(deps(chat), { agent: agentRef, configVersion: "draft", channel: "playground", userMessage: text });

describe("knowledge gaps: detection", () => {
  it("records a gap when the model answers with the fallback, and merges near-duplicate questions", async () => {
    const chat = new FakeChat(() => ({ content: fallback }));
    await ask(chat, "Do you ship to Canada and how much does shipping cost?");
    await ask(chat, "Do you ship to Canada, and how much does the shipping cost?");
    await ask(chat, "Can I pay with crypto?");
    const gaps = await listGaps(db, acme, "acme-support");
    expect(gaps.map((g) => [g.question, g.askCount])).toEqual([
      ["Do you ship to Canada and how much does shipping cost?", 2],
      ["Can I pay with crypto?", 1],
    ]);
    await expect(openGapCounts(db, acme).then((m) => m.get(agentRef.agentId))).resolves.toEqual({ gaps: 2, asks: 3 });
  });

  it("does not record a gap for real answers or for outages", async () => {
    await ask(new FakeChat(() => ({ content: "Yes, we ship to Canada." })), "Do you ship to Canada?");
    await ask(
      new FakeChat(() => {
        throw new InferenceError("no_available_provider", "No provider", { httpStatus: 503 });
      }),
      "Do you ship to Mexico?",
    );
    expect(await db.select().from(knowledgeGaps)).toHaveLength(0);
  });

  it("records without an embedding (no merge) when embeddings are unavailable", async () => {
    await recordGap(db, agentRef, { question: "  What   are your hours? ", channel: "web", messageId: null, embedding: null, embeddingModel: null });
    await recordGap(db, agentRef, { question: "What are your hours?", channel: "web", messageId: null, embedding: null, embeddingModel: null });
    const gaps = await listGaps(db, acme, "acme-support");
    expect(gaps).toHaveLength(2);
    expect(gaps[0].question).toBe("What are your hours?");
  });
});

describe("knowledge gaps: resolving", () => {
  it("answering creates an FAQ source and closes the gap", async () => {
    await ask(new FakeChat(() => ({ content: fallback })), "Can I pay with crypto?");
    const [gap] = await listGaps(db, acme, "acme-support");
    const ticket = await answerGap(db, acme, "acme-support", gap.id, { question: "Which payment methods do you accept?", answer: "Cards, PayPal and USDC." });
    const [src] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, ticket.sourceId));
    expect(src).toMatchObject({ type: "faq", title: "Which payment methods do you accept?", status: "queued" });
    expect(await listGaps(db, acme, "acme-support")).toHaveLength(0);
    expect((await listGaps(db, acme, "acme-support", "answered"))[0]).toMatchObject({ id: gap.id, status: "answered" });
    await expect(answerGap(db, acme, "acme-support", gap.id, { question: "Again?", answer: "x" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("validates input and lets admins dismiss", async () => {
    await ask(new FakeChat(() => ({ content: fallback })), "Can I pay with crypto?");
    const [gap] = await listGaps(db, acme, "acme-support");
    await expect(answerGap(db, acme, "acme-support", gap.id, { question: "Ok?", answer: "" })).rejects.toMatchObject({ code: "invalid_input" });
    await dismissGap(db, acme, "acme-support", gap.id);
    expect(await listGaps(db, acme, "acme-support", "dismissed")).toHaveLength(1);
  });

  it("members can read but not resolve; other orgs can't see or touch gaps (cross-tenant)", async () => {
    await ask(new FakeChat(() => ({ content: fallback })), "Can I pay with crypto?");
    const [gap] = await listGaps(db, acme, "acme-support");
    expect(await listGaps(db, acmeMember, "acme-support")).toHaveLength(1);
    await expect(answerGap(db, acmeMember, "acme-support", gap.id, { question: "Pay?", answer: "Cards." })).rejects.toMatchObject({ code: "forbidden" });
    await expect(dismissGap(db, acmeMember, "acme-support", gap.id)).rejects.toMatchObject({ code: "forbidden" });

    await expect(listGaps(db, evil, "acme-support")).rejects.toMatchObject({ code: "not_found" });
    await expect(answerGap(db, evil, "acme-support", gap.id, { question: "Pay?", answer: "Cards." })).rejects.toMatchObject({ code: "not_found" });
    expect((await openGapCounts(db, evil)).size).toBe(0);
    await expect(answerGap(db, acme, "acme-support", "not-a-uuid", { question: "Pay?", answer: "Cards." })).rejects.toMatchObject({ code: "not_found" });
  });
});
