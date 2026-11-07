import { and, desc, eq, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import {
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_MODEL_ID,
  DEFAULT_TRUST_MODE,
  LANGUAGES,
  LIMITS,
  TRUST_MODES,
  type LanguageOption,
} from "@/lib/agent-options";
import type { Database } from "@/server/db/client";
import { agentConfigs, agents, agentTone } from "@/server/db/schema";
import { roleAtLeast, type OrgScope } from "@/server/orgs/service";

/**
 * Labels that can never be agent slugs. Slugs become ENS labels (<slug>.alactic.eth) and public URLs,
 * so platform and impersonation-prone names are reserved (see docs/ENS_INTEGRATION.md §4).
 */
export const RESERVED_AGENT_SLUGS = new Set([
  "www", "app", "api", "admin", "support", "help", "docs", "status", "mail", "alactic", "ens", "wallet",
  "team", "security", "billing", "login", "signin", "sign-in", "dashboard", "embed", "widget", "public",
  "static", "new", "agents", "official", "verify", "verification", "root", "system", "test",
]);

export const agentSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "3–40 characters: lowercase letters, numbers and hyphens")
  .refine((s) => !s.includes("--"), "Use single hyphens only")
  .refine((s) => !RESERVED_AGENT_SLUGS.has(s), "This name is reserved");

const trimmed = (maxLen: number) => z.string().trim().max(maxLen);

export const agentConfigSchema = z.object({
  name: z.string().trim().min(LIMITS.name.min, "At least 2 characters").max(LIMITS.name.max),
  description: trimmed(LIMITS.description.max),
  instructions: trimmed(LIMITS.instructions.max),
  persona: trimmed(LIMITS.persona.max),
  tone: z.enum(agentTone.enumValues),
  language: z.enum(LANGUAGES.map((l) => l.value) as [LanguageOption, ...LanguageOption[]]),
  fallbackMessage: z
    .string()
    .trim()
    .min(LIMITS.fallback.min, "At least 10 characters")
    .max(LIMITS.fallback.max),
  modelId: z.string().trim().min(1).max(200),
  trustMode: z.enum(TRUST_MODES),
  temperature: z.coerce.number().min(LIMITS.temperature.min).max(LIMITS.temperature.max),
  maxOutputTokens: z.coerce.number().int().min(LIMITS.maxOutputTokens.min).max(LIMITS.maxOutputTokens.max),
  retrievalTopK: z.coerce.number().int().min(LIMITS.retrievalTopK.min).max(LIMITS.retrievalTopK.max),
});
export type AgentConfigInput = z.infer<typeof agentConfigSchema>;

export const createAgentSchema = z.object({
  name: agentConfigSchema.shape.name,
  slug: agentSlugSchema,
  description: agentConfigSchema.shape.description.default(""),
});

export class AgentError extends Error {
  constructor(
    public readonly code:
      | "forbidden"
      | "not_found"
      | "invalid_input"
      | "slug_taken"
      | "slug_locked"
      | "conflict"
      | "invalid_model"
      | "nothing_to_publish",
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Checks the model/trust pair against the live 0G catalog. Injected so tests don't call the network. */
export type ModelValidator = (modelId: string, trustMode: AgentConfigInput["trustMode"]) => Promise<string | null>;

function requireEditor(scope: OrgScope) {
  if (!roleAtLeast(scope.role, "admin")) throw new AgentError("forbidden", "Only owners and admins can change agents");
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}

export async function createAgent(
  db: Database,
  scope: OrgScope,
  input: z.input<typeof createAgentSchema>,
  validateModel: ModelValidator,
) {
  requireEditor(scope);
  const parsed = createAgentSchema.safeParse(input);
  if (!parsed.success) throw new AgentError("invalid_input", "Please fix the highlighted fields", fieldErrors(parsed.error));
  const modelError = await validateModel(DEFAULT_MODEL_ID, DEFAULT_TRUST_MODE);
  if (modelError) {
    // The default (TEE) model isn't currently listed. Don't silently pick something less private: tell the user.
    throw new AgentError("invalid_model", `The default model (${DEFAULT_MODEL_ID}, Private) isn't available: ${modelError}`);
  }

  try {
    return await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(agents)
        .values({ orgId: scope.orgId, slug: parsed.data.slug, createdBy: scope.userId })
        .returning({ id: agents.id, slug: agents.slug });
      await tx.insert(agentConfigs).values({
        orgId: scope.orgId,
        agentId: agent.id,
        version: 1,
        name: parsed.data.name,
        description: parsed.data.description,
        fallbackMessage: DEFAULT_FALLBACK_MESSAGE,
        modelId: DEFAULT_MODEL_ID,
        trustMode: DEFAULT_TRUST_MODE,
        createdBy: scope.userId,
        updatedBy: scope.userId,
      });
      return agent;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AgentError("slug_taken", "That agent URL is already taken", { slug: "That agent URL is already taken" });
    }
    throw error;
  }
}

/** Latest config per agent: the draft if one exists, otherwise the newest published version. */
function latestConfigSubquery(db: Database, orgId: string) {
  return db
    .selectDistinctOn([agentConfigs.agentId], {
      agentId: agentConfigs.agentId,
      configId: agentConfigs.id,
      version: agentConfigs.version,
      name: agentConfigs.name,
      description: agentConfigs.description,
      modelId: agentConfigs.modelId,
      trustMode: agentConfigs.trustMode,
      isDraft: sql<boolean>`${agentConfigs.publishedAt} is null`.as("is_draft"),
      updatedAt: agentConfigs.updatedAt,
    })
    .from(agentConfigs)
    .where(eq(agentConfigs.orgId, orgId))
    .orderBy(agentConfigs.agentId, sql`${agentConfigs.publishedAt} is null desc`, desc(agentConfigs.version))
    .as("latest");
}

export async function listAgents(db: Database, scope: OrgScope) {
  const latest = latestConfigSubquery(db, scope.orgId);
  return db
    .select({
      id: agents.id,
      slug: agents.slug,
      status: agents.status,
      name: latest.name,
      description: latest.description,
      modelId: latest.modelId,
      trustMode: latest.trustMode,
      hasUnpublishedChanges: latest.isDraft,
      updatedAt: latest.updatedAt,
    })
    .from(agents)
    .innerJoin(latest, eq(latest.agentId, agents.id))
    .where(eq(agents.orgId, scope.orgId))
    .orderBy(desc(latest.updatedAt));
}

export async function countAgents(db: Database, scope: OrgScope) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(agents).where(eq(agents.orgId, scope.orgId));
  return row?.n ?? 0;
}

async function findAgent(db: Database, scope: OrgScope, slug: string) {
  const parsed = z.string().max(64).safeParse(slug);
  if (!parsed.success) return null;
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, scope.orgId), eq(agents.slug, parsed.data)))
    .limit(1);
  return rows[0] ?? null;
}

/** Agent + the config to edit (draft, or latest published if no draft) + published version number. */
export async function getAgentForEdit(db: Database, scope: OrgScope, slug: string) {
  const agent = await findAgent(db, scope, slug);
  if (!agent) return null;
  const configs = await db
    .select()
    .from(agentConfigs)
    .where(and(eq(agentConfigs.agentId, agent.id), eq(agentConfigs.orgId, scope.orgId)))
    .orderBy(sql`${agentConfigs.publishedAt} is null desc`, desc(agentConfigs.version))
    .limit(1);
  const config = configs[0];
  if (!config) return null;
  const published = agent.publishedConfigId
    ? (
        await db
          .select({ version: agentConfigs.version, publishedAt: agentConfigs.publishedAt })
          .from(agentConfigs)
          .where(and(eq(agentConfigs.id, agent.publishedConfigId), eq(agentConfigs.orgId, scope.orgId)))
          .limit(1)
      )[0] ?? null
    : null;
  return { agent, config, isDraft: config.publishedAt === null, published };
}

/**
 * Save the agent's draft configuration.
 * - Optimistic concurrency: `expectedUpdatedAt` must match the config the editor loaded, so two admins can't
 *   silently overwrite each other.
 * - If the latest config is published (immutable), a new draft version is created instead of modifying it.
 * - Model and trust mode are validated against the live 0G catalog when they change.
 * - The slug can only change before the agent is first published (it becomes the ENS label and public URL).
 */
export async function saveDraft(
  db: Database,
  scope: OrgScope,
  slug: string,
  input: { config: z.input<typeof agentConfigSchema>; slug?: string; expectedUpdatedAt: string },
  validateModel: ModelValidator,
) {
  requireEditor(scope);
  const parsed = agentConfigSchema.safeParse(input.config);
  const newSlug = input.slug === undefined ? undefined : agentSlugSchema.safeParse(input.slug);
  const errors = {
    ...(parsed.success ? {} : fieldErrors(parsed.error)),
    ...(newSlug && !newSlug.success ? { slug: newSlug.error.issues[0]?.message ?? "Invalid URL" } : {}),
  };
  if (!parsed.success || (newSlug && !newSlug.success)) {
    throw new AgentError("invalid_input", "Please fix the highlighted fields", errors);
  }
  const values = parsed.data;

  const current = await getAgentForEdit(db, scope, slug);
  if (!current) throw new AgentError("not_found", "Agent not found");

  if (values.modelId !== current.config.modelId || values.trustMode !== current.config.trustMode) {
    const modelError = await validateModel(values.modelId, values.trustMode);
    if (modelError) throw new AgentError("invalid_model", modelError, { modelId: modelError });
  }

  try {
    return await db.transaction(async (tx) => {
      // Serialize writers for this agent.
      const [agent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, current.agent.id), eq(agents.orgId, scope.orgId)))
        .for("update");
      if (!agent) throw new AgentError("not_found", "Agent not found");

      const [latest] = await tx
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.agentId, agent.id))
        .orderBy(sql`${agentConfigs.publishedAt} is null desc`, desc(agentConfigs.version))
        .limit(1);
      if (!latest || latest.updatedAt.toISOString() !== input.expectedUpdatedAt) {
        throw new AgentError("conflict", "This agent was changed by someone else. Reload to see the latest version.");
      }

      const now = new Date();
      let configId: string;
      if (latest.publishedAt === null) {
        const [row] = await tx
          .update(agentConfigs)
          .set({ ...values, updatedBy: scope.userId, updatedAt: now })
          .where(and(eq(agentConfigs.id, latest.id), isNull(agentConfigs.publishedAt)))
          .returning({ id: agentConfigs.id });
        configId = row.id;
      } else {
        const [{ maxVersion }] = await tx
          .select({ maxVersion: max(agentConfigs.version) })
          .from(agentConfigs)
          .where(eq(agentConfigs.agentId, agent.id));
        const [row] = await tx
          .insert(agentConfigs)
          .values({
            ...values,
            orgId: scope.orgId,
            agentId: agent.id,
            version: (maxVersion ?? 0) + 1,
            createdBy: scope.userId,
            updatedBy: scope.userId,
            updatedAt: now,
          })
          .returning({ id: agentConfigs.id });
        configId = row.id;
      }

      let finalSlug = agent.slug;
      if (newSlug?.success && newSlug.data !== agent.slug) {
        if (agent.publishedConfigId) {
          throw new AgentError("slug_locked", "The URL can't change after the agent has been published", {
            slug: "Locked after first publish (it is the agent's public URL and ENS name)",
          });
        }
        await tx.update(agents).set({ slug: newSlug.data, updatedAt: now }).where(eq(agents.id, agent.id));
        finalSlug = newSlug.data;
      } else {
        await tx.update(agents).set({ updatedAt: now }).where(eq(agents.id, agent.id));
      }
      return { configId, slug: finalSlug, updatedAt: now.toISOString() };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AgentError("slug_taken", "That agent URL is already taken", { slug: "That agent URL is already taken" });
    }
    throw error;
  }
}

/**
 * Freeze the current draft as an immutable published version.
 * (Used by the publishing workflow in Phase 6; exposed now so versioning is enforced and tested from the start.)
 */
export async function publishDraft(db: Database, scope: OrgScope, slug: string) {
  requireEditor(scope);
  const agent = await findAgent(db, scope, slug);
  if (!agent) throw new AgentError("not_found", "Agent not found");
  return db.transaction(async (tx) => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agent.id)).for("update");
    const [draft] = await tx
      .select()
      .from(agentConfigs)
      .where(and(eq(agentConfigs.agentId, agent.id), isNull(agentConfigs.publishedAt)))
      .limit(1);
    if (!draft) throw new AgentError("nothing_to_publish", "There are no unpublished changes");
    const now = new Date();
    await tx.update(agentConfigs).set({ publishedAt: now }).where(eq(agentConfigs.id, draft.id));
    await tx
      .update(agents)
      .set({ publishedConfigId: draft.id, status: "published", updatedAt: now })
      .where(eq(agents.id, agent.id));
    return { version: draft.version, configId: draft.id };
  });
}

/** Take a published agent offline ("paused") or bring it back. Requires a published version. */
export async function setAgentLive(db: Database, scope: OrgScope, slug: string, live: boolean) {
  requireEditor(scope);
  const agent = await findAgent(db, scope, slug);
  if (!agent) throw new AgentError("not_found", "Agent not found");
  if (!agent.publishedConfigId) throw new AgentError("nothing_to_publish", "Publish the agent first");
  await db
    .update(agents)
    .set({ status: live ? "published" : "paused", updatedAt: new Date() })
    .where(and(eq(agents.id, agent.id), eq(agents.orgId, scope.orgId)));
}

export async function deleteAgent(db: Database, scope: OrgScope, slug: string) {
  requireEditor(scope);
  const deleted = await db
    .delete(agents)
    .where(and(eq(agents.orgId, scope.orgId), eq(agents.slug, slug)))
    .returning({ id: agents.id });
  if (deleted.length === 0) throw new AgentError("not_found", "Agent not found");
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** Validate an origin for widget embedding: https (or http://localhost for development), no path. */
export function normalizeOrigin(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    if (!local && !u.hostname.includes(".")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export async function updateAllowedOrigins(db: Database, scope: OrgScope, slug: string, origins: string[]) {
  requireEditor(scope);
  const cleaned: string[] = [];
  for (const o of origins.map((x) => x.trim()).filter(Boolean)) {
    const n = normalizeOrigin(o);
    if (!n) throw new AgentError("invalid_input", `“${o.slice(0, 80)}” isn't a valid site address. Use e.g. https://shop.example.com`, { allowedOrigins: "Invalid origin" });
    if (!cleaned.includes(n)) cleaned.push(n);
  }
  if (cleaned.length > 10) throw new AgentError("invalid_input", "Up to 10 sites can embed the widget.");
  const rows = await db
    .update(agents)
    .set({ allowedOrigins: cleaned, updatedAt: new Date() })
    .where(and(eq(agents.orgId, scope.orgId), eq(agents.slug, slug)))
    .returning({ id: agents.id });
  if (!rows.length) throw new AgentError("not_found", "Agent not found");
  return cleaned;
}

/** Take the agent offline (public page, widget and channels stop answering). Its versions are kept. */
export async function unpublishAgent(db: Database, scope: OrgScope, slug: string) {
  requireEditor(scope);
  const rows = await db
    .update(agents)
    .set({ status: "paused", updatedAt: new Date() })
    .where(and(eq(agents.orgId, scope.orgId), eq(agents.slug, slug), eq(agents.status, "published")))
    .returning({ id: agents.id });
  if (!rows.length) throw new AgentError("not_found", "Agent isn't published");
}

/** Re-enable a paused agent with its last published version (no new version). */
export async function resumeAgent(db: Database, scope: OrgScope, slug: string) {
  requireEditor(scope);
  const rows = await db
    .update(agents)
    .set({ status: "published", updatedAt: new Date() })
    .where(and(eq(agents.orgId, scope.orgId), eq(agents.slug, slug), eq(agents.status, "paused"), sql`${agents.publishedConfigId} is not null`))
    .returning({ id: agents.id });
  if (!rows.length) throw new AgentError("not_found", "Agent can't be resumed");
}
