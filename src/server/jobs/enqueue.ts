import "server-only";
import { db } from "@/server/db/client";
import { markEnqueueFailed, type IngestTicket } from "@/server/knowledge/service";
import { inngest, knowledgeIngestRequested } from "./client";

/** Queue ingestion. If the job system is unreachable the source is marked failed (with a retry hint), not left hanging. */
export async function enqueueIngest(ticket: IngestTicket): Promise<boolean> {
  try {
    await inngest.send(knowledgeIngestRequested.create(ticket));
    return true;
  } catch (error) {
    console.error("[jobs] failed to enqueue ingestion", error instanceof Error ? error.message : error);
    await markEnqueueFailed(db(), ticket);
    return false;
  }
}
