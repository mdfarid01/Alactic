import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { upsertWalletUser } from "@/server/auth/sessions";
import { createAgent } from "@/server/agents/service";
import { knowledgeChunks, knowledgeDocuments, knowledgeSources } from "@/server/db/schema";
import {
  chunkPendingDocuments,
  embedNextBatch,
  finalizeRun,
  loadRun,
  setProgress,
  storeCrawledPages,
} from "@/server/knowledge/pipeline";
import { retrievePassages } from "@/server/knowledge/retrieval";
import {
  addFaqSource,
  addTextSource,
  addWebsiteSource,
  deleteSource,
  listSources,
  reindexSource,
  resolveAgent,
  type IngestTicket,
} from "@/server/knowledge/service";
import { addMemberByWallet, authorizeOrg, createOrganization, type OrgScope } from "@/server/orgs/service";
import { setupTestDb } from "./helpers/db";
import { FakeCrawler, HashingEmbedder } from "./helpers/fakes";

const db = setupTestDb();
const embedder = new HashingEmbedder();

async function newUser() {
  const { address } = privateKeyToAccount(generatePrivateKey());
  return { address, userId: await upsertWalletUser(db, address) };
}

/** Run the non-crawl part of the pipeline synchronously, like the background job does. */
async function ingest(ticket: IngestTicket, e = embedder) {
  const source = (await loadRun(db, ticket.sourceId, ticket.runId))!;
  await setProgress(db, source.id, ticket.runId, "processing", "Indexing");
  await chunkPendingDocuments(db, source, ticket.runId);
  while ((await embedNextBatch(db, source, ticket.runId, e, 8)) > 0);
  await finalizeRun(db, source, ticket.runId);
}

async function search(scope: OrgScope, agentSlug: string, q: string, e = embedder) {
  const agent = await resolveAgent(db, scope, agentSlug);
  return retrievePassages(db, { orgId: scope.orgId, agentId: agent.id }, { embedding: await e.embedQuery(q), model: e.model }, { k: 5 });
}

let acme: OrgScope;
let acmeMember: OrgScope;
let evil: OrgScope;

beforeEach(async () => {
  const alice = await newUser();
  const bob = await newUser();
  const mallory = await newUser();
  await createOrganization(db, alice.userId, { name: "Acme", slug: "acme" });
  await createOrganization(db, mallory.userId, { name: "Evil", slug: "evil" });
  acme = (await authorizeOrg(db, alice.userId, "acme"))!;
  evil = (await authorizeOrg(db, mallory.userId, "evil"))!;
  await addMemberByWallet(db, acme, { address: bob.address, role: "member" });
  acmeMember = (await authorizeOrg(db, bob.userId, "acme"))!;
  const ok = async () => null;
  await createAgent(db, acme, { name: "Acme Support", slug: "acme-support" }, ok);
  await createAgent(db, acme, { name: "Acme Sales", slug: "acme-sales" }, ok);
  await createAgent(db, evil, { name: "Evil Support", slug: "evil-support" }, ok);
});

describe("ingestion & retrieval", () => {
  it("indexes FAQ and text sources and retrieves the relevant passage with citation metadata", async () => {
    await ingest(await addFaqSource(db, acme, "acme-support", { question: "What is your refund policy?", answer: "Refunds are accepted within 45 days of delivery." }));
    await ingest(await addTextSource(db, acme, "acme-support", { title: "Shipping", content: "# Shipping\n\nWe ship worldwide with tracked couriers. Delivery takes 3-5 business days." }));

    const sources = await listSources(db, acme, "acme-support");
    expect(sources.every((s) => s.status === "ready" && s.chunkCount > 0)).toBe(true);

    const results = await search(acme, "acme-support", "How many days do refunds take?");
    expect(results[0]).toMatchObject({ sourceType: "faq", documentTitle: "What is your refund policy?" });
    expect(results[0].content).toContain("45 days");
    expect(results[0].score).toBeGreaterThan(results[results.length - 1].score - 1e-9);
  });

  it("never returns another organization's or another agent's passages", async () => {
    await ingest(await addFaqSource(db, evil, "evil-support", { question: "What is your refund policy?", answer: "EVIL-SECRET refunds within 45 days." }));
    await ingest(await addTextSource(db, acme, "acme-sales", { title: "Sales refunds", content: "SALES-ONLY refund policy is 45 days." }));
    await ingest(await addFaqSource(db, acme, "acme-support", { question: "Opening hours?", answer: "We are open 9 to 5." }));

    const results = await search(acme, "acme-support", "refund policy 45 days");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.content).not.toContain("EVIL-SECRET");
      expect(r.content).not.toContain("SALES-ONLY");
    }
    // Evil can't even resolve Acme's agent.
    await expect(resolveAgent(db, evil, "acme-support")).rejects.toMatchObject({ code: "not_found" });
  });

  it("the database rejects a chunk that claims another tenant's document", async () => {
    await ingest(await addFaqSource(db, acme, "acme-support", { question: "Opening hours?", answer: "We are open 9 to 5." }));
    const [doc] = await db.select().from(knowledgeDocuments);
    const evilAgent = await resolveAgent(db, evil, "evil-support");
    await expect(
      db.insert(knowledgeChunks).values({
        orgId: evil.orgId,
        agentId: evilAgent.id,
        sourceId: doc.sourceId,
        documentId: doc.id,
        chunkIndex: 99,
        content: "injected",
        tokenCount: 1,
        contentSha256: "x",
      }),
    ).rejects.toThrow();
  });

  it("deleting a source removes its documents and chunks, and retrieval stops returning it", async () => {
    const ticket = await addFaqSource(db, acme, "acme-support", { question: "Refund policy?", answer: "Refunds within 45 days." });
    await ingest(ticket);
    expect(await search(acme, "acme-support", "refund")).not.toHaveLength(0);
    await deleteSource(db, acme, "acme-support", ticket.sourceId);
    expect(await db.select().from(knowledgeChunks)).toHaveLength(0);
    expect(await db.select().from(knowledgeDocuments)).toHaveLength(0);
    expect(await search(acme, "acme-support", "refund")).toHaveLength(0);
  });

  it("re-embeds automatically when the embedding model changes", async () => {
    const t = await addFaqSource(db, acme, "acme-support", { question: "Refund policy?", answer: "Refunds within 45 days." });
    await ingest(t);
    const newModel = new HashingEmbedder("new-model");
    await ingest(await reindexSource(db, acme, "acme-support", t.sourceId), newModel);
    expect(await search(acme, "acme-support", "refund", newModel)).not.toHaveLength(0);
  });

  it("a re-index makes the older run stale so it can't write", async () => {
    const first = await addFaqSource(db, acme, "acme-support", { question: "Refund policy?", answer: "Refunds within 45 days." });
    const second = await reindexSource(db, acme, "acme-support", first.sourceId);
    expect(await loadRun(db, first.sourceId, first.runId)).toBeNull();
    expect(await setProgress(db, first.sourceId, first.runId, "ready", "stale")).toBe(false);
    await ingest(second);
    expect((await listSources(db, acme, "acme-support"))[0].status).toBe("ready");
  });

  it("only passages embedded with the active model are searched (model switch requires re-index)", async () => {
    await ingest(await addFaqSource(db, acme, "acme-support", { question: "Refund policy?", answer: "Refunds within 45 days." }));
    const otherModel = new HashingEmbedder("another-model");
    expect(await search(acme, "acme-support", "refund", otherModel)).toHaveLength(0);
  });

  it("website crawl: stores pages, removes vanished pages, and doesn't re-embed unchanged pages on re-crawl", async () => {
    const ticket = await addWebsiteSource(db, acme, "acme-support", { url: "https://acme.com/help", maxPages: 10 });
    const pages = [
      { url: "https://acme.com/help/returns#top", title: "Returns", markdown: "# Returns\n\nYou can return unused items within 45 days of delivery for a full refund." },
      { url: "https://acme.com/help/shipping", title: "Shipping", markdown: "# Shipping\n\nWe ship worldwide. Orders over 50 dollars ship free of charge." },
      { url: "https://acme.com/help/empty", title: "Empty", markdown: "Hi" },
    ];
    const crawler = new FakeCrawler(pages);
    const source = (await loadRun(db, ticket.sourceId, ticket.runId))!;
    const state = await crawler.check();
    expect(await storeCrawledPages(db, source, ticket.runId, state.state === "completed" ? state.pages : [])).toBe(2);
    await ingest(ticket);
    expect((await db.select().from(knowledgeDocuments)).map((d) => d.url).sort()).toEqual([
      "https://acme.com/help/returns",
      "https://acme.com/help/shipping",
    ]);
    const callsBefore = embedder.calls;

    // Re-crawl: shipping page gone, returns unchanged.
    const again = await reindexSource(db, acme, "acme-support", ticket.sourceId);
    const src2 = (await loadRun(db, again.sourceId, again.runId))!;
    await storeCrawledPages(db, src2, again.runId, [pages[0]]);
    await ingest(again);
    const docs = await db.select().from(knowledgeDocuments);
    expect(docs.map((d) => d.url)).toEqual(["https://acme.com/help/returns"]);
    expect(embedder.calls).toBe(callsBefore); // unchanged page: no new embedding calls
    const [row] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, ticket.sourceId));
    expect(row).toMatchObject({ status: "ready", documentCount: 1 });

    const results = await search(acme, "acme-support", "return items refund");
    expect(results[0].url).toBe("https://acme.com/help/returns");
  });

  it("members can't add or delete knowledge; bad URLs are rejected", async () => {
    await expect(addFaqSource(db, acmeMember, "acme-support", { question: "Q?", answer: "A" })).rejects.toMatchObject({ code: "forbidden" });
    const t = await addFaqSource(db, acme, "acme-support", { question: "Refund policy?", answer: "45 days." });
    await expect(deleteSource(db, acmeMember, "acme-support", t.sourceId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteSource(db, evil, "acme-support", t.sourceId)).rejects.toMatchObject({ code: "not_found" });
    await expect(addWebsiteSource(db, acme, "acme-support", { url: "http://169.254.169.254/", maxPages: 5 })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
