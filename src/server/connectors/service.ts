import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { channelConnections, connectorEvents, type ConnectorPlatform } from "@/server/db/schema";
import { resolveAgent } from "@/server/knowledge/service";
import { roleAtLeast, type OrgScope } from "@/server/orgs/service";
import { decryptJson, encryptJson } from "./crypto";
import { ConnectorError } from "./types";

export type ConnectionView = {
  id: string;
  platform: ConnectorPlatform;
  status: "active" | "paused" | "error";
  label: string;
  deliveryMode: string;
  lastError: string | null;
  lastEventAt: Date | null;
  createdAt: Date;
};

const viewColumns = {
  id: channelConnections.id,
  platform: channelConnections.platform,
  status: channelConnections.status,
  label: channelConnections.label,
  deliveryMode: channelConnections.deliveryMode,
  lastError: channelConnections.lastError,
  lastEventAt: channelConnections.lastEventAt,
  createdAt: channelConnections.createdAt,
};

function requireAdmin(scope: OrgScope) {
  if (!roleAtLeast(scope.role, "admin")) throw new ConnectorError("forbidden", "Only admins can manage channels.");
}

/** Connections of one agent (org-scoped). Never includes credentials. */
export async function listConnections(db: Database, scope: OrgScope, agentSlug: string): Promise<ConnectionView[]> {
  const agent = await resolveAgent(db, scope, agentSlug);
  return db
    .select(viewColumns)
    .from(channelConnections)
    .where(and(eq(channelConnections.orgId, scope.orgId), eq(channelConnections.agentId, agent.id)))
    .orderBy(desc(channelConnections.createdAt));
}

/**
 * Store a new connection with encrypted credentials. The id is generated up front so it can be bound into the
 * ciphertext as associated data (a ciphertext moved to another row won't decrypt).
 */
export async function createConnection(
  db: Database,
  scope: OrgScope,
  agentSlug: string,
  input: { platform: ConnectorPlatform; label: string; externalId: string; credentials: unknown; deliveryMode: "webhook" | "polling" },
  key: Buffer,
): Promise<ConnectionView> {
  requireAdmin(scope);
  const agent = await resolveAgent(db, scope, agentSlug);
  const id = crypto.randomUUID();
  try {
    const [row] = await db
      .insert(channelConnections)
      .values({
        id,
        orgId: scope.orgId,
        agentId: agent.id,
        platform: input.platform,
        label: input.label.slice(0, 120),
        externalId: input.externalId,
        deliveryMode: input.deliveryMode,
        credentialsEncrypted: encryptJson(key, input.credentials, id),
        createdBy: scope.userId,
      })
      .returning(viewColumns);
    return row;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    if (e?.code === "23505" || e?.cause?.code === "23505") {
      throw new ConnectorError("invalid_input", "This account is already connected to an agent. Disconnect it there first.");
    }
    throw error;
  }
}

async function findOwned(db: Database, scope: OrgScope, agentSlug: string, connectionId: string) {
  requireAdmin(scope);
  const agent = await resolveAgent(db, scope, agentSlug);
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) throw new ConnectorError("not_found", "Connection not found.");
  const [row] = await db
    .select()
    .from(channelConnections)
    .where(and(eq(channelConnections.id, connectionId), eq(channelConnections.orgId, scope.orgId), eq(channelConnections.agentId, agent.id)))
    .limit(1);
  if (!row) throw new ConnectorError("not_found", "Connection not found.");
  return row;
}

/** Remove a connection. Returns its decrypted credentials so the caller can unregister webhooks (best effort). */
export async function deleteConnection<C>(db: Database, scope: OrgScope, agentSlug: string, connectionId: string, key: Buffer) {
  const row = await findOwned(db, scope, agentSlug, connectionId);
  let credentials: C | null = null;
  try {
    credentials = decryptJson<C>(key, row.credentialsEncrypted, row.id);
  } catch {
    // undecryptable (key rotated): still allow removal
  }
  await db.delete(channelConnections).where(and(eq(channelConnections.id, row.id), eq(channelConnections.orgId, scope.orgId)));
  return { platform: row.platform, credentials };
}

export async function setConnectionStatus(db: Database, scope: OrgScope, agentSlug: string, connectionId: string, status: "active" | "paused") {
  const row = await findOwned(db, scope, agentSlug, connectionId);
  await db.update(channelConnections).set({ status, lastError: null, updatedAt: new Date() }).where(eq(channelConnections.id, row.id));
}

// ─── Internal (webhooks / jobs): resolved by connection id, then verified by the platform signature or secret ───

export type LoadedConnection<C> = {
  id: string;
  orgId: string;
  agentId: string;
  platform: ConnectorPlatform;
  status: "active" | "paused" | "error";
  deliveryMode: string;
  credentials: C;
};

export async function loadConnection<C>(db: Database, connectionId: string, key: Buffer, platform?: ConnectorPlatform): Promise<LoadedConnection<C> | null> {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
  const [row] = await db
    .select()
    .from(channelConnections)
    .where(platform ? and(eq(channelConnections.id, connectionId), eq(channelConnections.platform, platform)) : eq(channelConnections.id, connectionId))
    .limit(1);
  if (!row) return null;
  let credentials: C;
  try {
    credentials = decryptJson<C>(key, row.credentialsEncrypted, row.id);
  } catch {
    return null;
  }
  return { id: row.id, orgId: row.orgId, agentId: row.agentId, platform: row.platform, status: row.status, deliveryMode: row.deliveryMode, credentials };
}

/** Record an inbound event; false if it was already seen (webhook retry). */
export async function claimEvent(db: Database, connectionId: string, eventKey: string): Promise<boolean> {
  const rows = await db.insert(connectorEvents).values({ connectionId, eventKey: eventKey.slice(0, 200) }).onConflictDoNothing().returning({ k: connectorEvents.eventKey });
  return rows.length > 0;
}

export async function markConnectionEvent(db: Database, connectionId: string, error: string | null) {
  await db
    .update(channelConnections)
    .set(error ? { lastError: error.slice(0, 300), lastEventAt: new Date() } : { lastError: null, lastEventAt: new Date() })
    .where(eq(channelConnections.id, connectionId));
}

/** Connections that receive updates by polling (local development). */
export async function pollingConnections(db: Database, platform: ConnectorPlatform) {
  return db
    .select({ id: channelConnections.id })
    .from(channelConnections)
    .where(and(eq(channelConnections.platform, platform), eq(channelConnections.deliveryMode, "polling"), eq(channelConnections.status, "active")));
}
