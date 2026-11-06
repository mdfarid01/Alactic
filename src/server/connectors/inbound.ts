import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { agentConfigs, agents, connectorEvents } from "@/server/db/schema";
import { connectorMessageReceived, inngest } from "@/server/jobs/client";
import { claimEvent } from "./service";
import type { InboundMessage } from "./types";

/**
 * Accept a verified inbound message: claim its event key (drops platform retries), then queue it.
 * If queuing fails the claim is released so the platform's retry can succeed.
 */
export async function acceptInbound(connectionId: string, message: InboundMessage): Promise<"queued" | "duplicate" | "error"> {
  if (!(await claimEvent(db(), connectionId, message.eventKey))) return "duplicate";
  try {
    await inngest.send(connectorMessageReceived.create({ connectionId, message }));
    return "queued";
  } catch (error) {
    console.error("[connectors] failed to enqueue message", error instanceof Error ? error.message : "unknown");
    await db().delete(connectorEvents).where(and(eq(connectorEvents.connectionId, connectionId), eq(connectorEvents.eventKey, message.eventKey.slice(0, 200))));
    return "error";
  }
}

/** Published display name of an agent (for greetings). */
export async function agentDisplayName(agentId: string): Promise<string | null> {
  const [row] = await db()
    .select({ name: agentConfigs.name, status: agents.status })
    .from(agents)
    .innerJoin(agentConfigs, and(eq(agentConfigs.id, agents.publishedConfigId), eq(agentConfigs.agentId, agents.id)))
    .where(eq(agents.id, agentId))
    .limit(1);
  return row && row.status === "published" ? row.name : null;
}

export function welcomeText(name: string | null) {
  return name
    ? `Hi! I'm ${name}. Ask me anything. You can also send a voice note or a screenshot.\n\nEvery answer is generated on 0G and comes with a public proof link.`
    : "This assistant isn't available right now.";
}
