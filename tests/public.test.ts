import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { upsertWalletUser } from "@/server/auth/sessions";
import {
  createAgent,
  getAgentForEdit,
  normalizeOrigin,
  publishDraft,
  resumeAgent,
  saveDraft,
  unpublishAgent,
  updateAllowedOrigins,
} from "@/server/agents/service";
import { frameAncestorsHeader } from "@/server/public/embed-policy";
import { getPublishedAgent, publicConversationHistory, publicInferenceEvidence } from "@/server/public/agents";
import { consumeRateLimit } from "@/server/ratelimit";
import { runAgent, type RunAgentDeps } from "@/server/runtime/run-agent";
import { addMemberByWallet, authorizeOrg, createOrganization, type OrgScope } from "@/server/orgs/service";
import { setupTestDb } from "./helpers/db";
import { FakeChat, HashingEmbedder } from "./helpers/fakes";

const db = setupTestDb();
let acme: OrgScope;
let member: OrgScope;
let evil: OrgScope;
const ok = async () => null;
const TOKEN_A = "visitor-a-token-0123456789abcdef";
const TOKEN_B = "visitor-b-token-0123456789abcdef";

const deps = (): RunAgentDeps => ({
  db,
  chat: new FakeChat(() => ({ content: "Hello from the published agent." })),
  embedder: new HashingEmbedder(),
  dailyOrgLimit: 100,
  modelSupports: async () => true,
  verifyTee: async () => ({ status: "verified", reason: "test", signerAddress: "0xDdaEaac4d8525d72DfD20cc6dE0f28eb3d320Bfb", details: { recoveredAddress: "0xDdaE" } }),
});

beforeEach(async () => {
  const a = await upsertWalletUser(db, privateKeyToAccount(generatePrivateKey()).address);
  const m = await upsertWalletUser(db, privateKeyToAccount(generatePrivateKey()).address);
  const bob = privateKeyToAccount(generatePrivateKey());
  await createOrganization(db, a, { name: "Acme", slug: "acme" });
  await createOrganization(db, m, { name: "Evil", slug: "evil" });
  acme = (await authorizeOrg(db, a, "acme"))!;
  evil = (await authorizeOrg(db, m, "evil"))!;
  await addMemberByWallet(db, acme, { address: bob.address, role: "member" });
  member = (await authorizeOrg(db, await upsertWalletUser(db, bob.address), "acme"))!;
  await createAgent(db, acme, { name: "Acme Support", slug: "acme-support" }, ok);
});

describe("rate limiting", () => {
  it("allows up to the limit per window, then blocks with a retry hint, and resets next window", async () => {
    const t = new Date("2026-11-06T12:00:10Z");
    for (let i = 0; i < 3; i++) expect((await consumeRateLimit(db, "k", 3, 60, t)).ok).toBe(true);
    const blocked = await consumeRateLimit(db, "k", 3, 60, t);
    expect(blocked).toMatchObject({ ok: false, retryAfter: 50 });
    expect((await consumeRateLimit(db, "k", 3, 60, new Date("2026-11-06T12:01:01Z"))).ok).toBe(true);
  });
});

describe("publishing & public lookup", () => {
  it("drafts are never public; publish exposes the frozen version, not later edits", async () => {
    expect(await getPublishedAgent(db, "acme-support")).toBeNull();
    await publishDraft(db, acme, "acme-support");
    const current = (await getAgentForEdit(db, acme, "acme-support"))!;
    await saveDraft(
      db,
      acme,
      "acme-support",
      {
        config: { ...current.config, name: "Renamed in draft", language: current.config.language as "auto" },
        expectedUpdatedAt: current.config.updatedAt.toISOString(),
      },
      ok,
    );
    expect(await getPublishedAgent(db, "acme-support")).toMatchObject({ name: "Acme Support", version: 1 });
    await publishDraft(db, acme, "acme-support");
    expect(await getPublishedAgent(db, "acme-support")).toMatchObject({ name: "Renamed in draft", version: 2 });
  });

  it("unpublish takes it offline; resume brings back the same version; members can't do either", async () => {
    await publishDraft(db, acme, "acme-support");
    await expect(unpublishAgent(db, member, "acme-support")).rejects.toMatchObject({ code: "forbidden" });
    await expect(unpublishAgent(db, evil, "acme-support")).rejects.toMatchObject({ code: "not_found" });
    await unpublishAgent(db, acme, "acme-support");
    expect(await getPublishedAgent(db, "acme-support")).toBeNull();
    await resumeAgent(db, acme, "acme-support");
    expect(await getPublishedAgent(db, "acme-support")).toMatchObject({ version: 1 });
  });
});

describe("widget allowed sites", () => {
  it.each([
    ["https://shop.example.com", "https://shop.example.com"],
    ["https://shop.example.com/", "https://shop.example.com"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://shop.example.com", null],
    ["https://shop.example.com/path", null],
    ["https://evil.com; script-src *", null],
    ["javascript:alert(1)", null],
    ["https://intranet", null],
  ])("normalizeOrigin(%s) → %s", (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it("stores normalized, de-duplicated origins; rejects bad ones; only editors of the org", async () => {
    expect(await updateAllowedOrigins(db, acme, "acme-support", ["https://a.example.com/", "https://a.example.com", "", "https://b.example.com"])).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    await expect(updateAllowedOrigins(db, acme, "acme-support", ["https://x.com; frame-ancestors *"])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(updateAllowedOrigins(db, member, "acme-support", [])).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateAllowedOrigins(db, evil, "acme-support", [])).rejects.toMatchObject({ code: "not_found" });
  });

  it("builds the CSP header", () => {
    expect(frameAncestorsHeader([])).toBe("frame-ancestors 'self'");
    expect(frameAncestorsHeader(["https://a.example.com"])).toBe("frame-ancestors 'self' https://a.example.com");
  });
});

describe("anonymous public chat", () => {
  async function published() {
    await publishDraft(db, acme, "acme-support");
    const a = (await getPublishedAgent(db, "acme-support"))!;
    return { orgId: a.orgId, agentId: a.agentId };
  }

  it("requires a visitor token on public channels", async () => {
    const agent = await published();
    await expect(runAgent(deps(), { agent, configVersion: "published", channel: "web", userMessage: "hi" })).rejects.toMatchObject({ code: "invalid_message" });
  });

  it("a different visitor can't continue or read someone else's conversation", async () => {
    const agent = await published();
    const first = await runAgent(deps(), { agent, configVersion: "published", channel: "web", userMessage: "hi", visitorToken: TOKEN_A });
    await expect(
      runAgent(deps(), { agent, configVersion: "published", channel: "web", userMessage: "hi again", visitorToken: TOKEN_B, conversationId: first.conversationId }),
    ).rejects.toMatchObject({ code: "conversation_not_found" });
    expect(await publicConversationHistory(db, agent, first.conversationId, TOKEN_B)).toBeNull();

    const mine = await publicConversationHistory(db, agent, first.conversationId, TOKEN_A);
    expect(mine?.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(mine?.[1].verification).toEqual({ status: "verified", method: "independent" });
  });

  it("verification evidence is public only for public-channel answers and contains no message content", async () => {
    const agent = await published();
    const web = await runAgent(deps(), { agent, configVersion: "published", channel: "web", userMessage: "secret question", visitorToken: TOKEN_A });
    const ev = await publicInferenceEvidence(db, web.inference!.id);
    expect(ev).toMatchObject({ modelId: "0gm-1.0-35b-a3b", trustMode: "private", channel: "web", agentSlug: "acme-support" });
    expect(JSON.stringify(ev)).not.toContain("secret question");
    expect(JSON.stringify(ev)).not.toContain("Hello from the published agent");

    const play = await runAgent(deps(), { agent, configVersion: "draft", channel: "playground", userMessage: "internal test" });
    expect(await publicInferenceEvidence(db, play.inference!.id)).toBeNull();
  });
});
