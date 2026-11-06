import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
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
