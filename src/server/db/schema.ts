import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ─── Identity & auth ──────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name"),
  createdAt: createdAt(),
});

export const walletIdentities = pgTable(
  "wallet_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Lowercase hex address. Display with viem `getAddress()` for checksum casing. */
    address: text("address").notNull().unique(),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check("wallet_identities_address_format", sql`${t.address} ~ '^0x[0-9a-f]{40}$'`),
    index("wallet_identities_user_id_idx").on(t.userId),
  ],
);

/** Single-use SIWE nonces, bound to the pre-session cookie that requested them. */
export const authNonces = pgTable(
  "auth_nonces",
  {
    nonce: text("nonce").primaryKey(),
    preSessionHash: text("pre_session_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("auth_nonces_expires_at_idx").on(t.expiresAt)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** SHA-256 of the session cookie token. The raw token is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    walletAddress: text("wallet_address").notNull(),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

// ─── Organizations ────────────────────────────────────────────────────────────

export const orgRole = pgEnum("org_role", ["owner", "admin", "member"]);
export type OrgRole = (typeof orgRole.enumValues)[number];

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("organizations_slug_format", sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'`),
    check("organizations_name_length", sql`char_length(${t.name}) between 2 and 80`),
  ],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: orgRole("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    index("organization_members_user_id_idx").on(t.userId),
  ],
);

// ─── Agents ───────────────────────────────────────────────────────────────────

export const agentStatus = pgEnum("agent_status", ["draft", "published", "paused", "archived"]);
export type AgentStatus = (typeof agentStatus.enumValues)[number];

export const trustMode = pgEnum("trust_mode", ["private", "verified", "standard"]);
export type TrustMode = (typeof trustMode.enumValues)[number];

export const agentTone = pgEnum("agent_tone", ["professional", "friendly", "concise", "empathetic"]);
export type AgentTone = (typeof agentTone.enumValues)[number];

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Globally unique. Used in public URLs and as the ENS label (<slug>.alactic.eth). */
    slug: text("slug").notNull().unique(),
    status: agentStatus("status").notNull().default("draft"),
    /** Currently published (immutable) config version, if any. Integrity enforced by a composite FK in SQL. */
    publishedConfigId: uuid("published_config_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("agents_id_org_id_unique").on(t.id, t.orgId),
    index("agents_org_id_idx").on(t.orgId),
    check("agents_slug_format", sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'`),
  ],
);

/**
 * Versioned agent configuration.
 * - At most one draft per agent (published_at IS NULL).
 * - Published versions are immutable (enforced by a trigger in the migration).
 * - (agent_id, org_id) must match the agent's org (composite FK), so a config can never point across tenants.
 */
export const agentConfigs = pgTable(
  "agent_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    persona: text("persona").notNull().default(""),
    tone: agentTone("tone").notNull().default("professional"),
    /** "auto" (reply in the visitor's language) or a BCP-47 language tag from the supported list. */
    language: text("language").notNull().default("auto"),
    fallbackMessage: text("fallback_message").notNull(),
    modelId: text("model_id").notNull(),
    trustMode: trustMode("trust_mode").notNull(),
    temperature: real("temperature").notNull().default(0.3),
    maxOutputTokens: integer("max_output_tokens").notNull().default(1024),
    retrievalTopK: integer("retrieval_top_k").notNull().default(8),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "agent_configs_agent_org_fk",
      columns: [t.agentId, t.orgId],
      foreignColumns: [agents.id, agents.orgId],
    }).onDelete("cascade"),
    unique("agent_configs_agent_version_unique").on(t.agentId, t.version),
    unique("agent_configs_id_agent_unique").on(t.id, t.agentId),
    uniqueIndex("agent_configs_one_draft_per_agent").on(t.agentId).where(sql`${t.publishedAt} IS NULL`),
    check("agent_configs_name_length", sql`char_length(${t.name}) between 2 and 60`),
    check("agent_configs_description_length", sql`char_length(${t.description}) <= 280`),
    check("agent_configs_instructions_length", sql`char_length(${t.instructions}) <= 8000`),
    check("agent_configs_persona_length", sql`char_length(${t.persona}) <= 500`),
    check("agent_configs_fallback_length", sql`char_length(${t.fallbackMessage}) between 10 and 500`),
    check("agent_configs_temperature_range", sql`${t.temperature} >= 0 and ${t.temperature} <= 1`),
    check("agent_configs_max_tokens_range", sql`${t.maxOutputTokens} between 128 and 4096`),
    check("agent_configs_top_k_range", sql`${t.retrievalTopK} between 1 and 20`),
    check("agent_configs_version_positive", sql`${t.version} >= 1`),
  ],
);

// ─── Knowledge ────────────────────────────────────────────────────────────────

/** Fixed embedding width for the whole index. Models are configured to emit exactly this many dimensions. */
export const EMBEDDING_DIMENSIONS = 1024;

export const knowledgeSourceType = pgEnum("knowledge_source_type", ["website", "file", "faq", "text"]);
export type KnowledgeSourceType = (typeof knowledgeSourceType.enumValues)[number];

export const knowledgeSourceStatus = pgEnum("knowledge_source_status", ["queued", "processing", "ready", "failed"]);
export type KnowledgeSourceStatus = (typeof knowledgeSourceStatus.enumValues)[number];

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    type: knowledgeSourceType("type").notNull(),
    title: text("title").notNull(),
    /** Website sources: the start URL. */
    url: text("url"),
    /** File sources: original file name, MIME type and size (the file itself is not stored). */
    fileName: text("file_name"),
    fileMime: text("file_mime"),
    fileSize: integer("file_size"),
    /** Website crawl options: { maxPages, includePaths, excludePaths }. */
    crawlOptions: jsonb("crawl_options").$type<{ maxPages: number; includePaths?: string[]; excludePaths?: string[] }>(),
    status: knowledgeSourceStatus("status").notNull().default("queued"),
    /** Human-readable progress or a safe (non-sensitive) error message. */
    statusDetail: text("status_detail"),
    /** Id of the latest ingestion run. Older runs see a mismatch and stop (re-index / delete safety). */
    ingestRunId: uuid("ingest_run_id"),
    documentCount: integer("document_count").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "knowledge_sources_agent_org_fk",
      columns: [t.agentId, t.orgId],
      foreignColumns: [agents.id, agents.orgId],
    }).onDelete("cascade"),
    unique("knowledge_sources_tenant_unique").on(t.id, t.agentId, t.orgId),
    index("knowledge_sources_agent_idx").on(t.agentId, t.orgId),
    check("knowledge_sources_title_length", sql`char_length(${t.title}) between 1 and 200`),
  ],
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    /** Stable key within the source: page URL for crawls, "file", or "entry" for FAQ/text. */
    externalKey: text("external_key").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    /** Normalized extracted text. Kept so the source can be re-chunked and re-embedded without re-uploading. */
    content: text("content").notNull(),
    /** Per-page text for PDFs, used to cite page numbers. Null for other types. */
    pageOffsets: jsonb("page_offsets").$type<number[]>(),
    contentSha256: text("content_sha256").notNull(),
    /** contentSha256 of the version that currently has chunks. Differs ⇒ needs (re)chunking. */
    indexedSha256: text("indexed_sha256"),
    tokenCount: integer("token_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "knowledge_documents_source_tenant_fk",
      columns: [t.sourceId, t.agentId, t.orgId],
      foreignColumns: [knowledgeSources.id, knowledgeSources.agentId, knowledgeSources.orgId],
    }).onDelete("cascade"),
    unique("knowledge_documents_tenant_unique").on(t.id, t.sourceId, t.agentId, t.orgId),
    unique("knowledge_documents_source_key_unique").on(t.sourceId, t.externalKey),
  ],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    documentId: uuid("document_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    headingPath: text("heading_path"),
    pageFrom: integer("page_from"),
    pageTo: integer("page_to"),
    tokenCount: integer("token_count").notNull(),
    contentSha256: text("content_sha256").notNull(),
    /** Null until embedded. */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "knowledge_chunks_document_tenant_fk",
      columns: [t.documentId, t.sourceId, t.agentId, t.orgId],
      foreignColumns: [knowledgeDocuments.id, knowledgeDocuments.sourceId, knowledgeDocuments.agentId, knowledgeDocuments.orgId],
    }).onDelete("cascade"),
    unique("knowledge_chunks_document_index_unique").on(t.documentId, t.chunkIndex),
    index("knowledge_chunks_agent_idx").on(t.agentId, t.orgId),
    index("knowledge_chunks_source_idx").on(t.sourceId),
    index("knowledge_chunks_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

// ─── Conversations & inference ────────────────────────────────────────────────

export const conversationChannel = pgEnum("conversation_channel", ["playground", "web", "widget", "discord", "slack", "zendesk", "telegram", "whatsapp"]);
export type ConversationChannel = (typeof conversationChannel.enumValues)[number];

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    channel: conversationChannel("channel").notNull(),
    /** Channel-specific thread reference (Slack thread ts, Discord channel, Zendesk ticket…). */
    externalRef: text("external_ref"),
    /** Anonymous web visitors: hash of their visitor token. */
    visitorTokenHash: text("visitor_token_hash"),
    /** Playground: the org member who started it. */
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "conversations_agent_org_fk", columns: [t.agentId, t.orgId], foreignColumns: [agents.id, agents.orgId] }).onDelete("cascade"),
    unique("conversations_tenant_unique").on(t.id, t.agentId, t.orgId),
    index("conversations_agent_recent_idx").on(t.agentId, t.lastMessageAt),
    index("conversations_external_ref_idx").on(t.agentId, t.channel, t.externalRef),
  ],
);

export const inferenceStatus = pgEnum("inference_status", ["requested", "completed", "failed"]);

export const inferenceRecords = pgTable(
  "inference_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    configId: uuid("config_id"),
    modelId: text("model_id").notNull(),
    trustModeRequested: trustMode("trust_mode_requested").notNull(),
    verifyTeeRequested: boolean("verify_tee_requested").notNull(),
    status: inferenceStatus("status").notNull().default("requested"),
    routerRequestId: text("router_request_id"),
    /** chatID for independent verification (ZG-Res-Key header, else response id). */
    chatId: text("chat_id"),
    providerAddress: text("provider_address"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** Cost exactly as reported in x_0g_trace.billing, with its unit ("usd_micro" observed live; "neuron" per docs). */
    costAmount: numeric("cost_amount", { precision: 78, scale: 0 }),
    costUnit: text("cost_unit"),
    latencyMs: integer("latency_ms"),
    /**
     * SHA-256 of `alactic-answer-v1:<inference id>:<text shown to the customer>` (see src/lib/answer-fingerprint.ts).
     * Public on the proof receipt, so a customer can prove which exact answer they received without sharing it with us.
     */
    answerSha256: text("answer_sha256"),
    errorType: text("error_type"),
    errorCode: text("error_code"),
    httpStatus: integer("http_status"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "inference_records_conversation_tenant_fk",
      columns: [t.conversationId, t.agentId, t.orgId],
      foreignColumns: [conversations.id, conversations.agentId, conversations.orgId],
    }).onDelete("cascade"),
    index("inference_records_org_time_idx").on(t.orgId, t.requestedAt),
    index("inference_records_agent_time_idx").on(t.agentId, t.requestedAt),
  ],
);

export const verificationMethod = pgEnum("verification_method", ["router", "independent"]);
export const verificationStatus = pgEnum("verification_status", ["not_requested", "verified", "failed", "unavailable"]);
export type VerificationStatus = (typeof verificationStatus.enumValues)[number];

export const verificationRecords = pgTable(
  "verification_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    inferenceId: uuid("inference_id")
      .notNull()
      .references(() => inferenceRecords.id, { onDelete: "cascade" }),
    method: verificationMethod("method").notNull(),
    status: verificationStatus("status").notNull(),
    signerAddress: text("signer_address"),
    /** Non-sensitive evidence (e.g. raw tee_verified value, provider). Never message content. */
    details: jsonb("details").$type<Record<string, unknown>>(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("verification_records_inference_idx").on(t.inferenceId)],
);

// ─── Knowledge gaps ───────────────────────────────────────────────────────────

export const knowledgeGapStatus = pgEnum("knowledge_gap_status", ["open", "answered", "dismissed"]);
export type KnowledgeGapStatus = (typeof knowledgeGapStatus.enumValues)[number];

/**
 * Questions the agent couldn't answer from its knowledge (it gave the fallback). Near-duplicate questions are merged
 * via the query embedding, so the inbox shows "asked N times". The question text lives in `messages`; this row only
 * references the first occurrence.
 */
export const knowledgeGaps = pgTable(
  "knowledge_gaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    firstMessageId: uuid("first_message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Copy of the first question (≤ 500 chars) so the gap survives conversation deletion. Tenant data, org-scoped. */
    question: text("question").notNull(),
    channel: conversationChannel("channel").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    askCount: integer("ask_count").notNull().default(1),
    status: knowledgeGapStatus("status").notNull().default("open"),
    /** FAQ source created when an admin answered this gap. */
    answerSourceId: uuid("answer_source_id"),
    firstAskedAt: timestamp("first_asked_at", { withTimezone: true }).notNull().defaultNow(),
    lastAskedAt: timestamp("last_asked_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    foreignKey({ name: "knowledge_gaps_agent_org_fk", columns: [t.agentId, t.orgId], foreignColumns: [agents.id, agents.orgId] }).onDelete("cascade"),
    index("knowledge_gaps_agent_status_idx").on(t.agentId, t.status, t.lastAskedAt),
    index("knowledge_gaps_org_status_idx").on(t.orgId, t.status),
    check("knowledge_gaps_question_length", sql`char_length(${t.question}) between 1 and 500`),
  ],
);

// ─── Owner digest ─────────────────────────────────────────────────────────────

/** One briefing per organization per UTC day: aggregate stats + a short 0G-written summary (with proof receipt). */
export const orgDigests = pgTable(
  "org_digests",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    content: text("content").notNull(),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull(),
    inferenceId: uuid("inference_id").references(() => inferenceRecords.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day] }), check("org_digests_day_format", sql`${t.day} ~ '^\\d{4}-\\d{2}-\\d{2}$'`)],
);

// ─── Human handoff ────────────────────────────────────────────────────────────

export const handoffStatus = pgEnum("handoff_status", ["open", "resolved"]);

/**
 * A customer asked for a human. Carries a 0G-generated summary of the conversation (with its own proof receipt) so the
 * team can pick up without rereading everything. Contact details are tenant data, visible only to the org.
 */
export const handoffRequests = pgTable(
  "handoff_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    channel: conversationChannel("channel").notNull(),
    contact: text("contact"),
    note: text("note"),
    summary: text("summary"),
    summaryInferenceId: uuid("summary_inference_id").references(() => inferenceRecords.id, { onDelete: "set null" }),
    status: handoffStatus("status").notNull().default("open"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    foreignKey({
      name: "handoff_requests_conversation_tenant_fk",
      columns: [t.conversationId, t.agentId, t.orgId],
      foreignColumns: [conversations.id, conversations.agentId, conversations.orgId],
    }).onDelete("cascade"),
    index("handoff_requests_org_status_idx").on(t.orgId, t.status, t.createdAt),
    check("handoff_requests_contact_length", sql`${t.contact} is null or char_length(${t.contact}) <= 200`),
    check("handoff_requests_note_length", sql`${t.note} is null or char_length(${t.note}) <= 1000`),
  ],
);

// ─── Agent test suite ─────────────────────────────────────────────────────────

/** A "golden question" with what a correct answer must contain (or that the agent must decline). */
export const agentTestCases = pgTable(
  "agent_test_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    question: text("question").notNull(),
    /** Phrases the answer must contain (case-insensitive). Empty = any non-fallback answer passes. */
    mustInclude: jsonb("must_include").$type<string[]>().notNull().default([]),
    /** false = the agent should decline (give its fallback), e.g. off-topic or out-of-scope questions. */
    expectAnswer: boolean("expect_answer").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "agent_test_cases_agent_org_fk", columns: [t.agentId, t.orgId], foreignColumns: [agents.id, agents.orgId] }).onDelete("cascade"),
    index("agent_test_cases_agent_idx").on(t.agentId, t.orgId),
    check("agent_test_cases_question_length", sql`char_length(${t.question}) between 3 and 500`),
  ],
);

export const testRunStatus = pgEnum("test_run_status", ["running", "passed", "failed", "error"]);

export const agentTestRuns = pgTable(
  "agent_test_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    configId: uuid("config_id").notNull(),
    configVersion: integer("config_version").notNull(),
    status: testRunStatus("status").notNull().default("running"),
    total: integer("total").notNull(),
    passed: integer("passed").notNull().default(0),
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({ name: "agent_test_runs_agent_org_fk", columns: [t.agentId, t.orgId], foreignColumns: [agents.id, agents.orgId] }).onDelete("cascade"),
    index("agent_test_runs_agent_idx").on(t.agentId, t.startedAt),
  ],
);

export const agentTestResults = pgTable(
  "agent_test_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentTestRuns.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => agentTestCases.id, { onDelete: "set null" }),
    question: text("question").notNull(),
    passed: boolean("passed").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    answerExcerpt: text("answer_excerpt"),
    inferenceId: uuid("inference_id").references(() => inferenceRecords.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("agent_test_results_run_idx").on(t.runId)],
);

// ─── Channel connectors ───────────────────────────────────────────────────────

export const connectorPlatform = pgEnum("connector_platform", ["telegram", "discord", "slack", "whatsapp", "zendesk"]);
export type ConnectorPlatform = (typeof connectorPlatform.enumValues)[number];
export const connectorStatus = pgEnum("connector_status", ["active", "paused", "error"]);

/**
 * A business's connection of one agent to an external platform (bot, workspace, number, helpdesk).
 * Credentials are AES-256-GCM encrypted with an app-level key and never sent to the browser.
 */
export const channelConnections = pgTable(
  "channel_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    platform: connectorPlatform("platform").notNull(),
    status: connectorStatus("status").notNull().default("active"),
    /** Public, non-secret identity shown in the UI (e.g. "@NimbusBot", workspace name, phone number). */
    label: text("label").notNull(),
    /** Platform-side id used to route inbound events (bot id, guild id, team id, phone number id, subdomain). */
    externalId: text("external_id").notNull(),
    /** "webhook" (production) or "polling" (local development, Telegram only). */
    deliveryMode: text("delivery_mode").notNull().default("webhook"),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    lastError: text("last_error"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "channel_connections_agent_org_fk", columns: [t.agentId, t.orgId], foreignColumns: [agents.id, agents.orgId] }).onDelete("cascade"),
    unique("channel_connections_platform_external_unique").on(t.platform, t.externalId),
    index("channel_connections_agent_idx").on(t.agentId, t.orgId),
    check("channel_connections_label_length", sql`char_length(${t.label}) between 1 and 120`),
    check("channel_connections_delivery_mode", sql`${t.deliveryMode} in ('webhook', 'polling')`),
  ],
);

/** Idempotency for inbound platform events (webhooks are retried). Rows older than a few days can be purged. */
export const connectorEvents = pgTable(
  "connector_events",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => channelConnections.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.eventKey] }), index("connector_events_received_idx").on(t.receivedAt)],
);

// ─── Abuse controls ───────────────────────────────────────────────────────────

/**
 * Fixed-window rate-limit counters for public endpoints. `key` is a namespaced, hashed identifier
 * (e.g. `chat:visitor:<sha256>`); raw IPs or tokens are never stored.
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index("rate_limit_buckets_window_idx").on(t.windowStart)],
);

export const messageRole = pgEnum("message_role", ["user", "assistant"]);

export type Citation = {
  n: number;
  chunkId: string;
  documentId: string;
  title: string;
  url: string | null;
  headingPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  sourceType: string;
};

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations").$type<Citation[]>(),
    inferenceId: uuid("inference_id").references(() => inferenceRecords.id, { onDelete: "set null" }),
    /** True when the agent's fallback answer was shown instead of model output. */
    isFallback: boolean("is_fallback").notNull().default(false),
    /** User messages: how the question arrived. The audio/image itself is never stored. */
    attachmentKind: text("attachment_kind"),
    /** User messages: the 0G inference that turned the attachment into text (transcription or screenshot reading). */
    preInferenceId: uuid("pre_inference_id").references(() => inferenceRecords.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "messages_conversation_tenant_fk",
      columns: [t.conversationId, t.agentId, t.orgId],
      foreignColumns: [conversations.id, conversations.agentId, conversations.orgId],
    }).onDelete("cascade"),
    index("messages_conversation_time_idx").on(t.conversationId, t.createdAt),
    check("messages_content_length", sql`char_length(${t.content}) <= 20000`),
    check("messages_attachment_kind", sql`${t.attachmentKind} is null or ${t.attachmentKind} in ('voice', 'image')`),
  ],
);
