import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { upsertWalletUser } from "@/server/auth/sessions";
import { createAgent, publishDraft, setAgentLive } from "@/server/agents/service";
import { decryptJson, encryptJson, parseKey } from "@/server/connectors/crypto";
import { CONNECTOR_USER_LIMIT, formatReply, handleInbound } from "@/server/connectors/handle";
import { claimEvent, createConnection, deleteConnection, listConnections, loadConnection, setConnectionStatus } from "@/server/connectors/service";
import { parseTelegramUpdate, type TelegramCredentials } from "@/server/connectors/telegram";
import type { ConnectorAdapter, InboundMessage } from "@/server/connectors/types";
import { channelConnections, conversations } from "@/server/db/schema";
import type { TranscribeRequest, TranscribeResult } from "@/server/inference/router-client";
import { chunkPendingDocuments, embedNextBatch, finalizeRun, loadRun } from "@/server/knowledge/pipeline";
import { addFaqSource, resolveAgent } from "@/server/knowledge/service";
import { addMemberByWallet, authorizeOrg, createOrganization, type OrgScope } from "@/server/orgs/service";
import type { RunAgentDeps } from "@/server/runtime/run-agent";
import { setupTestDb } from "./helpers/db";
import { FakeChat, HashingEmbedder } from "./helpers/fakes";

const db = setupTestDb();
const embedder = new HashingEmbedder();
const key = randomBytes(32);
let acme: OrgScope;
let acmeMember: OrgScope;
let evil: OrgScope;


const creds: TelegramCredentials = { botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", secretToken: "s3cret", botId: 999, botUsername: "AcmeBot" };

beforeEach(async () => {
  const alice = await upsertWalletUser(db, privateKeyToAccount(generatePrivateKey()).address);
  const bob = privateKeyToAccount(generatePrivateKey());
  const mallory = await upsertWalletUser(db, privateKeyToAccount(generatePrivateKey()).address);
  await createOrganization(db, alice, { name: "Acme", slug: "acme" });
  await createOrganization(db, mallory, { name: "Evil", slug: "evil" });
  acme = (await authorizeOrg(db, alice, "acme"))!;
  evil = (await authorizeOrg(db, mallory, "evil"))!;
  await addMemberByWallet(db, acme, { address: bob.address, role: "member" });
  acmeMember = (await authorizeOrg(db, await upsertWalletUser(db, bob.address), "acme"))!;
  await createAgent(db, acme, { name: "Acme Support", slug: "acme-support" }, async () => null);
  await resolveAgent(db, acme, "acme-support");
  const t = await addFaqSource(db, acme, "acme-support", { question: "What is the refund policy?", answer: "Refunds are accepted within 45 days of delivery." });
  const src = (await loadRun(db, t.sourceId, t.runId))!;
  await chunkPendingDocuments(db, src, t.runId);
  while ((await embedNextBatch(db, src, t.runId, embedder)) > 0);
  await finalizeRun(db, src, t.runId);
});

const connect = (scope = acme, externalId = "999") =>
  createConnection(db, scope, "acme-support", { platform: "telegram", label: "@AcmeBot", externalId, credentials: creds, deliveryMode: "webhook" }, key);

describe("credential encryption", () => {
  it("round-trips, binds the row id, and detects tampering", () => {
    const enc = encryptJson(key, { botToken: "t" }, "row-1");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("botToken");
    expect(decryptJson(key, enc, "row-1")).toEqual({ botToken: "t" });
    expect(() => decryptJson(key, enc, "row-2")).toThrow();
    expect(() => decryptJson(randomBytes(32), enc, "row-1")).toThrow();
    const raw = Buffer.from(enc.slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptJson(key, `v1:${raw.toString("base64")}`, "row-1")).toThrow();
    expect(() => parseKey("short")).toThrow();
  });
});

describe("Telegram update parsing", () => {
  const msg = (m: Record<string, unknown>, id = 1) => ({ update_id: id, message: { message_id: 10, from: { id: 42 }, chat: { id: 42, type: "private" }, ...m } });
  const bot = { botId: 999, botUsername: "AcmeBot" };

  it("answers every private message and keeps the reply target", () => {
    expect(parseTelegramUpdate(msg({ text: "Hi there" }), bot)).toEqual({
      kind: "message",
      message: { eventKey: "tg:1", externalChatId: "42", externalUserId: "42", text: "Hi there", media: null, replyTarget: { chatId: 42, replyTo: 10 } },
    });
    expect(parseTelegramUpdate(msg({ text: "/start" }), bot)).toEqual({ kind: "start", chatId: 42 });
  });

  it("in groups, answers only /ask, mentions and replies to the bot", () => {
    const group = { id: -100, type: "supergroup" };
    expect(parseTelegramUpdate(msg({ chat: group, text: "lunch?" }), bot).kind).toBe("ignore");
    const asked = parseTelegramUpdate(msg({ chat: group, text: "/ask@AcmeBot refund policy?" }), bot);
    expect(asked.kind === "message" && asked.message.text).toBe("refund policy?");
    const mentioned = parseTelegramUpdate(msg({ chat: group, text: "hey @acmebot where is my order" }), bot);
    expect(mentioned.kind === "message" && mentioned.message.text).toBe("hey  where is my order");
    expect(parseTelegramUpdate(msg({ chat: group, text: "thanks", reply_to_message: { from: { id: 999 } } }), bot).kind).toBe("message");
    expect(parseTelegramUpdate(msg({ chat: group, text: "/start" }), bot).kind).toBe("ignore");
  });

  it("extracts voice notes and the largest photo under the limit; ignores bots and junk", () => {
    const v = parseTelegramUpdate(msg({ voice: { file_id: "voice-1", duration: 3 } }), bot);
    expect(v.kind === "message" && v.message.media).toEqual({ kind: "voice", ref: "voice-1" });
    const p = parseTelegramUpdate(
      msg({ caption: "see this", photo: [{ file_id: "s", width: 90, height: 90, file_size: 1000 }, { file_id: "m", width: 800, height: 800, file_size: 90_000 }, { file_id: "xl", width: 4000, height: 4000, file_size: 9_000_000 }] }),
      bot,
    );
    expect(p.kind === "message" && p.message).toMatchObject({ text: "see this", media: { kind: "image", ref: "m" } });
    expect(parseTelegramUpdate(msg({ from: { id: 7, is_bot: true }, text: "hi" }), bot).kind).toBe("ignore");
    expect(parseTelegramUpdate({ update_id: 3 }, bot).kind).toBe("ignore");
    expect(parseTelegramUpdate("garbage", bot).kind).toBe("ignore");
  });
});

describe("connections service", () => {
  it("stores credentials encrypted and never lists them", async () => {
    const c = await connect();
    expect(Object.keys(c)).not.toContain("credentialsEncrypted");
    const [row] = await db.select().from(channelConnections);
    expect(row.credentialsEncrypted).not.toContain(creds.botToken);
    const listed = await listConnections(db, acme, "acme-support");
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(creds.botToken);
    expect((await loadConnection<TelegramCredentials>(db, c.id, key, "telegram"))!.credentials).toEqual(creds);
    expect(await loadConnection(db, c.id, key, "slack")).toBeNull();
    expect(await loadConnection(db, c.id, randomBytes(32))).toBeNull();
  });

  it("one platform account maps to one agent", async () => {
    await connect();
    await expect(connect()).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("members can't manage; other orgs can't see or touch connections (cross-tenant)", async () => {
    const c = await connect();
    await expect(connect(acmeMember, "1000")).rejects.toMatchObject({ code: "forbidden" });
    await expect(listConnections(db, evil, "acme-support")).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteConnection(db, evil, "acme-support", c.id, key)).rejects.toMatchObject({ code: "not_found" });
    await expect(setConnectionStatus(db, evil, "acme-support", c.id, "paused")).rejects.toMatchObject({ code: "not_found" });
    const removed = await deleteConnection<TelegramCredentials>(db, acme, "acme-support", c.id, key);
    expect(removed.credentials?.botToken).toBe(creds.botToken);
    expect(await db.select().from(channelConnections)).toHaveLength(0);
  });

  it("dedupes inbound events per connection", async () => {
    const c = await connect();
    expect(await claimEvent(db, c.id, "tg:1")).toBe(true);
    expect(await claimEvent(db, c.id, "tg:1")).toBe(false);
    expect(await claimEvent(db, c.id, "tg:2")).toBe(true);
  });
});

class FakeAdapter implements ConnectorAdapter<TelegramCredentials> {
  platform = "telegram" as const;
  maxReplyChars = 3900;
  sent: { target: InboundMessage["replyTarget"]; text: string }[] = [];
  typing = 0;
  constructor(private media: Uint8Array = new Uint8Array()) {}
  async downloadMedia() {
    return { bytes: this.media };
  }
  async sendReply(_c: TelegramCredentials, target: InboundMessage["replyTarget"], text: string) {
    this.sent.push({ target, text });
  }
  async sendTyping() {
    this.typing++;
  }
}

class FakeTranscriber {
  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    return { text: "What is the refund policy after delivery?", chatId: "c", trace: { requestId: "stt", provider: null, cost: null, teeVerified: true }, verifyTeeRequested: req.trustMode !== "standard", latencyMs: 1, durationSeconds: 2 };
  }
}

const runtime = (): RunAgentDeps => ({
  db,
  chat: new FakeChat(() => ({ content: "Refunds are accepted within 45 days of delivery [1]." })),
  embedder,
  dailyOrgLimit: 100,
  modelSupports: async () => true,
  verifyTee: async () => ({ status: "verified", reason: "t", signerAddress: null, details: {} }),
  transcriber: new FakeTranscriber(),
  transcriptionModel: "whisper-large-v3",
});
const inbound = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  eventKey: "tg:1",
  externalChatId: "42",
  externalUserId: "42",
  text: "What is the refund policy after delivery?",
  media: null,
  replyTarget: { chatId: 42, replyTo: 10 },
  ...over,
});

describe("handleInbound", () => {
  it("answers with the published agent, adds proof links, and keeps one conversation per chat", async () => {
    await publishDraft(db, acme, "acme-support");
    const c = (await loadConnection<TelegramCredentials>(db, (await connect()).id, key))!;
    const adapter = new FakeAdapter();
    const deps = { db, runtime: runtime(), appOrigin: "https://alactic.example" };
    expect(await handleInbound(deps, c, adapter, inbound(), "telegram")).toBe("replied");
    await handleInbound(deps, c, adapter, inbound({ eventKey: "tg:2" }), "telegram");
    expect(adapter.typing).toBe(2);
    expect(adapter.sent[0].target).toEqual({ chatId: 42, replyTo: 10 });
    expect(adapter.sent[0].text).toMatch(/^Refunds are accepted within 45 days of delivery \[1\]\.\n\n🔒 TEE-verified on 0G · proof: https:\/\/alactic\.example\/proof\/[0-9a-f-]{36}$/);
    const convs = await db.select().from(conversations);
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ channel: "telegram", externalRef: `${c.id}:42` });
  });

  it("voice notes go through transcription and get a second proof link", async () => {
    await publishDraft(db, acme, "acme-support");
    const c = (await loadConnection<TelegramCredentials>(db, (await connect()).id, key))!;
    const ogg = new Uint8Array([..."OggS"].map((x) => x.charCodeAt(0)).concat([0, 2, 0, 0]));
    const adapter = new FakeAdapter(ogg);
    await handleInbound({ db, runtime: runtime(), appOrigin: "https://a.example" }, c, adapter, inbound({ text: "", media: { kind: "voice", ref: "f1" } }), "telegram");
    expect(adapter.sent[0].text).toContain("🎙 Transcription proof: https://a.example/proof/");
  });

  it("rejects bad media, unpublished agents, paused connections, and rate-limits per user", async () => {
    const conn = await connect();
    const c = (await loadConnection<TelegramCredentials>(db, conn.id, key))!;
    const deps = { db, runtime: runtime(), appOrigin: "https://a.example" };
    const a1 = new FakeAdapter();
    expect(await handleInbound(deps, c, a1, inbound(), "telegram")).toBe("failed");
    expect(a1.sent[0].text).toBe("This assistant isn't available right now.");

    await publishDraft(db, acme, "acme-support");
    const a2 = new FakeAdapter(new Uint8Array([1, 2, 3, 4]));
    expect(await handleInbound(deps, c, a2, inbound({ media: { kind: "image", ref: "x" } }), "telegram")).toBe("failed");
    expect(a2.sent[0].text).toContain("PNG, JPEG, WebP or GIF");

    await setConnectionStatus(db, acme, "acme-support", conn.id, "paused");
    const paused = (await loadConnection<TelegramCredentials>(db, conn.id, key))!;
    expect(await handleInbound(deps, paused, new FakeAdapter(), inbound(), "telegram")).toBe("skipped");

    await setConnectionStatus(db, acme, "acme-support", conn.id, "active");
    const active = (await loadConnection<TelegramCredentials>(db, conn.id, key))!;
    const a3 = new FakeAdapter();
    for (let i = 0; i < CONNECTOR_USER_LIMIT.limit; i++) await handleInbound(deps, active, a3, inbound({ externalUserId: "spammer" }), "telegram");
    expect(await handleInbound(deps, active, a3, inbound({ externalUserId: "spammer" }), "telegram")).toBe("limited");
    await setAgentLive(db, acme, "acme-support", false);
  });

  it("formatReply truncates long answers but keeps the proof footer", () => {
    const long = "x".repeat(5000);
    const r = formatReply(
      { conversationId: "c", userTurn: { messageId: "m", content: "q", attachment: null, preInference: null }, reply: { messageId: "m", content: long, citations: [], isFallback: false }, inference: { id: "abc", status: "completed", modelId: "m", trustMode: "private", providerAddress: null, routerRequestId: null, latencyMs: 1 }, verification: { status: "verified", method: "independent", reason: null, signerAddress: null }, retrieval: { status: "ok", passages: 1 } },
      "https://a.example",
      3900,
    );
    expect(r.length).toBeLessThanOrEqual(3900);
    expect(r.endsWith("proof: https://a.example/proof/abc")).toBe(true);
  });
});
