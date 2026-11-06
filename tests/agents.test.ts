import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { upsertWalletUser } from "@/server/auth/sessions";
import {
  createAgent,
  deleteAgent,
  getAgentForEdit,
  listAgents,
  publishDraft,
  saveDraft,
  type AgentConfigInput,
  type ModelValidator,
} from "@/server/agents/service";
import { agentConfigs, agents } from "@/server/db/schema";
import { addMemberByWallet, authorizeOrg, createOrganization, type OrgScope } from "@/server/orgs/service";
import { setupTestDb } from "./helpers/db";

const db = setupTestDb();
const okModel: ModelValidator = async () => null;

async function newUser() {
  const { address } = privateKeyToAccount(generatePrivateKey());
  return { address, userId: await upsertWalletUser(db, address) };
}

let acmeOwner: OrgScope;
let acmeMember: OrgScope;
let evilOwner: OrgScope;

beforeEach(async () => {
  const alice = await newUser();
  const bob = await newUser();
  const mallory = await newUser();
  await createOrganization(db, alice.userId, { name: "Acme", slug: "acme" });
  await createOrganization(db, mallory.userId, { name: "Evil", slug: "evil" });
  acmeOwner = (await authorizeOrg(db, alice.userId, "acme"))!;
  await addMemberByWallet(db, acmeOwner, { address: bob.address, role: "member" });
  acmeMember = (await authorizeOrg(db, bob.userId, "acme"))!;
  evilOwner = (await authorizeOrg(db, mallory.userId, "evil"))!;
});

function configFrom(current: NonNullable<Awaited<ReturnType<typeof getAgentForEdit>>>, patch: Partial<AgentConfigInput> = {}) {
  const c = current.config;
  return {
    config: {
      name: c.name,
      description: c.description,
      instructions: c.instructions,
      persona: c.persona,
      tone: c.tone,
      language: c.language as AgentConfigInput["language"],
      fallbackMessage: c.fallbackMessage,
      modelId: c.modelId,
      trustMode: c.trustMode,
      temperature: c.temperature,
      maxOutputTokens: c.maxOutputTokens,
      retrievalTopK: c.retrievalTopK,
      ...patch,
    },
    expectedUpdatedAt: c.updatedAt.toISOString(),
  };
}

describe("agent creation & defaults", () => {
  it("creates a draft v1 with the private TEE default model", async () => {
    await createAgent(db, acmeOwner, { name: "Acme Support", slug: "acme-support" }, okModel);
    const loaded = await getAgentForEdit(db, acmeOwner, "acme-support");
    expect(loaded?.agent.status).toBe("draft");
    expect(loaded?.isDraft).toBe(true);
    expect(loaded?.config).toMatchObject({ version: 1, modelId: "0gm-1.0-35b-a3b", trustMode: "private" });
  });

  it("refuses to create an agent when the default private model is unavailable (no silent downgrade)", async () => {
    const unavailable: ModelValidator = async () => "not listed";
    await expect(createAgent(db, acmeOwner, { name: "X Agent", slug: "x-agent" }, unavailable)).rejects.toMatchObject({
      code: "invalid_model",
    });
  });

  it("slugs are globally unique (they become ENS labels) and reserved names are rejected", async () => {
    await createAgent(db, acmeOwner, { name: "Shop", slug: "shop" }, okModel);
    await expect(createAgent(db, evilOwner, { name: "Shop", slug: "shop" }, okModel)).rejects.toMatchObject({ code: "slug_taken" });
    await expect(createAgent(db, acmeOwner, { name: "Support", slug: "support" }, okModel)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(createAgent(db, acmeOwner, { name: "Bad", slug: "a--b" }, okModel)).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("role matrix", () => {
  it("members can view but not create, edit or delete", async () => {
    await createAgent(db, acmeOwner, { name: "Acme Support", slug: "acme-support" }, okModel);
    expect(await listAgents(db, acmeMember)).toHaveLength(1);
    const current = (await getAgentForEdit(db, acmeMember, "acme-support"))!;
    await expect(createAgent(db, acmeMember, { name: "Nope", slug: "nope-agent" }, okModel)).rejects.toMatchObject({ code: "forbidden" });
    await expect(saveDraft(db, acmeMember, "acme-support", configFrom(current), okModel)).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteAgent(db, acmeMember, "acme-support")).rejects.toMatchObject({ code: "forbidden" });
    await expect(publishDraft(db, acmeMember, "acme-support")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("tenant isolation", () => {
  it("another org can't list, load, edit, publish or delete an agent, even knowing its slug", async () => {
    await createAgent(db, acmeOwner, { name: "Acme Support", slug: "acme-support" }, okModel);
    const current = (await getAgentForEdit(db, acmeOwner, "acme-support"))!;

    expect(await listAgents(db, evilOwner)).toEqual([]);
    expect(await getAgentForEdit(db, evilOwner, "acme-support")).toBeNull();
    await expect(saveDraft(db, evilOwner, "acme-support", configFrom(current, { name: "Pwned" }), okModel)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(publishDraft(db, evilOwner, "acme-support")).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteAgent(db, evilOwner, "acme-support")).rejects.toMatchObject({ code: "not_found" });
    expect((await getAgentForEdit(db, acmeOwner, "acme-support"))?.config.name).toBe("Acme Support");
  });

  it("the database rejects a config whose org doesn't match its agent (composite FK)", async () => {
    await createAgent(db, acmeOwner, { name: "Acme Support", slug: "acme-support" }, okModel);
    const [agent] = await db.select().from(agents).where(eq(agents.slug, "acme-support"));
    await expect(
      db.insert(agentConfigs).values({
        orgId: evilOwner.orgId,
        agentId: agent.id,
        version: 99,
        name: "Cross tenant",
        fallbackMessage: "This should never be stored.",
        modelId: "glm-5.3",
        trustMode: "private",
        publishedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});

describe("drafts, versions & immutability", () => {
  it("saves a draft and detects concurrent edits", async () => {
    await createAgent(db, acmeOwner, { name: "Acme Support", slug: "acme-support" }, okModel);
    const current = (await getAgentForEdit(db, acmeOwner, "acme-support"))!;
    await saveDraft(db, acmeOwner, "acme-support", configFrom(current, { instructions: "Be helpful." }), okModel);
    // Second editor still holds the old timestamp.
    await expect(
      saveDraft(db, acmeOwner, "acme-support", configFrom(current, { instructions: "Overwrite!" }), okModel),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await getAgentForEdit(db, acmeOwner, "acme-support"))?.config.instructions).toBe("Be helpful.");
  });

  it("validates model/trust only when they change, and blocks unsupported combinations", async () => {
    await createAgent(db, acmeOwner, { name: "Acme Support", slug: "acme-support" }, okModel);
    const validator = vi.fn<ModelValidator>(async (_m, t) => (t === "private" ? null : "standard-only model can't be private"));
    let current = (await getAgentForEdit(db, acmeOwner, "acme-support"))!;
    await saveDraft(db, acmeOwner, "acme-support", configFrom(current, { tone: "friendly" }), validator);
    expect(validator).not.toHaveBeenCalled();

    current = (await getAgentForEdit(db, acmeOwner, "acme-support"))!;
    await expect(
      saveDraft(db, acmeOwner, "acme-support", configFrom(current, { trustMode: "standard" }), validator),
    ).rejects.toMatchObject({ code: "invalid_model" });
    expect((await getAgentForEdit(db, acmeOwner, "acme-support"))?.config.trustMode).toBe("private");
  });

  it("rejects out-of-range values", async () => {
    await createAgent(db, acmeOwner, { name: "Acme Support", slug: "acme-support" }, okModel);
    const current = (await getAgentForEdit(db, acmeOwner, "acme-support"))!;
    await expect(
      saveDraft(db, acmeOwner, "acme-support", configFrom(current, { temperature: 5, fallbackMessage: "hi" }), okModel),
    ).rejects.toMatchObject({ code: "invalid_input", fieldErrors: { temperature: expect.any(String), fallbackMessage: expect.any(String) } });
  });

  it("publishing freezes a version; later edits create a new draft version and never modify the published one", async () => {
    await createAgent(db, acmeOwner, { name: "Acme Support", slug: "acme-support" }, okModel);
    const { version } = await publishDraft(db, acmeOwner, "acme-support");
    expect(version).toBe(1);
    await expect(publishDraft(db, acmeOwner, "acme-support")).rejects.toMatchObject({ code: "nothing_to_publish" });

    const afterPublish = (await getAgentForEdit(db, acmeOwner, "acme-support"))!;
    expect(afterPublish.isDraft).toBe(false);
    expect(afterPublish.agent.status).toBe("published");
    await saveDraft(db, acmeOwner, "acme-support", configFrom(afterPublish, { name: "Acme Help" }), okModel);

    const edited = (await getAgentForEdit(db, acmeOwner, "acme-support"))!;
    expect(edited.config).toMatchObject({ version: 2, name: "Acme Help", publishedAt: null });
    expect(edited.published?.version).toBe(1);
    const [v1] = await db.select().from(agentConfigs).where(eq(agentConfigs.id, afterPublish.config.id));
    expect(v1.name).toBe("Acme Support");
  });

  it("the database refuses to modify a published version, even with raw SQL", async () => {
    await createAgent(db, acmeOwner, { name: "Acme Support", slug: "acme-support" }, okModel);
    const { configId } = await publishDraft(db, acmeOwner, "acme-support");
    await expect(db.update(agentConfigs).set({ instructions: "tampered" }).where(eq(agentConfigs.id, configId))).rejects.toThrow();
    await expect(db.execute(sql`update agent_configs set version = 7 where id = ${configId}`)).rejects.toThrow();
  });

  it("only one draft per agent can exist", async () => {
    await createAgent(db, acmeOwner, { name: "Acme Support", slug: "acme-support" }, okModel);
    const [agent] = await db.select().from(agents).where(eq(agents.slug, "acme-support"));
    await expect(
      db.insert(agentConfigs).values({
        orgId: acmeOwner.orgId,
        agentId: agent.id,
        version: 2,
        name: "Second draft",
        fallbackMessage: "Should be rejected by the unique index.",
        modelId: "glm-5.3",
        trustMode: "private",
      }),
    ).rejects.toThrow();
  });

  it("the slug can change before first publish but is locked afterwards", async () => {
    await createAgent(db, acmeOwner, { name: "Acme Support", slug: "acme-support" }, okModel);
    let current = (await getAgentForEdit(db, acmeOwner, "acme-support"))!;
    const renamed = await saveDraft(db, acmeOwner, "acme-support", { ...configFrom(current), slug: "acme-help" }, okModel);
    expect(renamed.slug).toBe("acme-help");

    await publishDraft(db, acmeOwner, "acme-help");
    current = (await getAgentForEdit(db, acmeOwner, "acme-help"))!;
    await expect(
      saveDraft(db, acmeOwner, "acme-help", { ...configFrom(current), slug: "acme-other" }, okModel),
    ).rejects.toMatchObject({ code: "slug_locked" });
  });

  it("deleting an agent removes all its versions", async () => {
    await createAgent(db, acmeOwner, { name: "Acme Support", slug: "acme-support" }, okModel);
    await publishDraft(db, acmeOwner, "acme-support");
    await deleteAgent(db, acmeOwner, "acme-support");
    expect(await db.select().from(agentConfigs)).toHaveLength(0);
  });
});
