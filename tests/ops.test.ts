import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { upsertWalletUser } from "@/server/auth/sessions";
import { createAgent, publishDraft } from "@/server/agents/service";
import { agentConfigs, inferenceRecords, orgDigests } from "@/server/db/schema";
import { computeDigestStats, generateDigest, latestDigest, orgsForDigest } from "@/server/digest/service";
import { draftGapAnswer } from "@/server/gaps/draft";
import { listGaps } from "@/server/gaps/service";
import { listHandoffs, requestHandoff, resolveHandoff } from "@/server/handoff/service";
import { chunkPendingDocuments, embedNextBatch, finalizeRun, loadRun } from "@/server/knowledge/pipeline";
import { addFaqSource, resolveAgent } from "@/server/knowledge/service";
import { addMemberByWallet, authorizeOrg, createOrganization, type OrgScope } from "@/server/orgs/service";
import { runAgent, type RunAgentDeps } from "@/server/runtime/run-agent";
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
  await publishDraft(db, acme, "acme-support");
});

const deps = (respond: (req: { system: string; user: string }) => string): RunAgentDeps => ({
  db,
  chat: new FakeChat((req) => ({ content: respond({ system: String(req.messages[0].content), user: String(req.messages.at(-1)!.content) }) })),
  embedder,
  dailyOrgLimit: 1000,
  modelSupports: async () => true,
  verifyTee: async () => ({ status: "verified", reason: "t", signerAddress: null, details: {} }),
});
const support = (req: { system: string; user: string }) =>
  req.system.includes("handoff notes") ? "Customer wants a refund for a damaged bag; agent explained the 45-day policy; open: replacement." : req.user.includes("refund") ? "Refunds are accepted within 45 days of delivery [1]." : fallback;
const visit = (d: RunAgentDeps, userMessage: string, visitorTokenHash = "visitor-a", conversationId: string | null = null) =>
  runAgent(d, { agent: agentRef, configVersion: "published", channel: "web", userMessage, visitorTokenHash, conversationId });

describe("human handoff", () => {
  it("creates one open request per conversation with a recorded 0G summary, for the owning visitor only", async () => {
    const d = deps(support);
    const r = await visit(d, "What is the refund policy after delivery?");
    await expect(requestHandoff(d, agentRef, { conversationId: r.conversationId, visitorTokenHash: "visitor-b" })).rejects.toMatchObject({ code: "not_found" });
    const h = await requestHandoff(d, agentRef, { conversationId: r.conversationId, visitorTokenHash: "visitor-a", contact: "jane@example.com", note: "Bag arrived torn" });
    expect(h.alreadyOpen).toBe(false);
    expect((await requestHandoff(d, agentRef, { conversationId: r.conversationId, visitorTokenHash: "visitor-a" })).alreadyOpen).toBe(true);

    const [item] = await listHandoffs(db, acme);
    expect(item).toMatchObject({ contact: "jane@example.com", note: "Bag arrived torn", status: "open", channel: "web" });
    expect(item.summary).toContain("refund");
    expect(item.transcript.map((m) => m.role)).toEqual(["user", "assistant"]);
    const [rec] = await db.select().from(inferenceRecords).where(eq(inferenceRecords.id, item.summaryInferenceId!));
    expect(rec).toMatchObject({ status: "completed", trustModeRequested: "private" });
    expect(rec.answerSha256).toMatch(/^[0-9a-f]{64}$/);

    expect(await listHandoffs(db, evil)).toHaveLength(0);
    await expect(resolveHandoff(db, evil, item.id)).rejects.toMatchObject({ code: "not_found" });
    await resolveHandoff(db, member, item.id);
    expect(await listHandoffs(db, acme)).toHaveLength(0);
    expect(await listHandoffs(db, acme, { status: "resolved" })).toHaveLength(1);
  });

  it("rejects invalid ids and overlong input", async () => {
    const d = deps(support);
    await expect(requestHandoff(d, agentRef, { conversationId: "nope", visitorTokenHash: "v" })).rejects.toMatchObject({ code: "not_found" });
    const r = await visit(d, "What is the refund policy after delivery?");
    await expect(requestHandoff(d, agentRef, { conversationId: r.conversationId, visitorTokenHash: "visitor-a", note: "x".repeat(1001) })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("gap drafts from a page", () => {
  it("draft from the page only, on 0G, and refuse when the page doesn't answer", async () => {
    await visit(deps(support), "Do you ship to Canada?");
    const [gap] = await listGaps(db, acme, "acme-support");
    let sentToModel = "";
    const d = {
      ...deps((req) => {
        sentToModel = req.user;
        return req.user.includes("Canada: yes") ? "Yes, we ship to Canada in 5-8 business days." : "NOT_FOUND";
      }),
      scrape: async (url: string) => ({ url, title: "Shipping", markdown: url.includes("shipping") ? "International: Canada: yes, 5-8 business days." : "About us" }),
    };
    const r = await draftGapAnswer(d, acme, "acme-support", gap.id, "https://acme-coffee.com/shipping");
    expect(r).toMatchObject({ draft: "Yes, we ship to Canada in 5-8 business days.", sourceUrl: "https://acme-coffee.com/shipping", sourceTitle: "Shipping" });
    expect(sentToModel).toContain("<page");
    expect(sentToModel).toContain("Customer question: Do you ship to Canada?");
    await expect(draftGapAnswer(d, acme, "acme-support", gap.id, "https://acme-coffee.com/about")).rejects.toMatchObject({ code: "not_found_on_page" });
    await expect(draftGapAnswer(d, acme, "acme-support", gap.id, "http://127.0.0.1/admin")).rejects.toMatchObject({ code: "invalid_url" });
    await expect(draftGapAnswer(d, member, "acme-support", gap.id, "https://acme-coffee.com/shipping")).rejects.toMatchObject({ code: "forbidden" });
    await expect(draftGapAnswer(d, evil, "acme-support", gap.id, "https://acme-coffee.com/shipping")).rejects.toMatchObject({ code: "not_found" });
    expect((await listGaps(db, acme, "acme-support"))[0].status).toBe("open");
  });
});

describe("daily digest", () => {
  it("quiet days need no AI call", async () => {
    const chat = deps(() => "should not be called");
    const r = await generateDigest(chat, acme.orgId);
    expect(r.inferenceId).toBeNull();
    expect(r.content).toContain("quiet day");
    expect((chat.chat as FakeChat).requests).toHaveLength(0);
  });

  it("summarises the last 24h on 0G and stores one digest per day", async () => {
    const d = deps((req) => (req.system.includes("morning briefing") ? "- 1 customer waiting for a person.\n- 2 public answers." : support(req)));
    const r1 = await visit(d, "What is the refund policy after delivery?");
    await visit(d, "Do you ship to Canada?", "visitor-b");
    await requestHandoff(d, agentRef, { conversationId: r1.conversationId, visitorTokenHash: "visitor-a" });
    const stats = await computeDigestStats(db, acme.orgId);
    expect(stats).toMatchObject({ answers: 2, verified: 2, fallbacks: 1, openHandoffs: 1, newGaps: [{ question: "Do you ship to Canada?", asks: 1, agent: "Acme Support" }] });
    const r = await generateDigest(d, acme.orgId);
    expect(r.content).toContain("waiting for a person");
    expect(r.inferenceId).not.toBeNull();
    await generateDigest(d, acme.orgId);
    expect(await db.select().from(orgDigests)).toHaveLength(1);
    expect((await latestDigest(db, acme.orgId))!.content).toContain("public answers");
    expect(await latestDigest(db, evil.orgId)).toBeNull();
    expect((await orgsForDigest(db)).map((o) => o.id)).toEqual([acme.orgId]);
  });
});
