import "server-only";
import { eventType, Inngest } from "inngest";
import { z } from "zod";

/**
 * Inngest v4 defaults to cloud mode (requires INNGEST_SIGNING_KEY). For local development set INNGEST_DEV=1 and run
 * the Inngest dev server (`pnpm inngest:dev`).
 */
export const inngest = new Inngest({
  id: "alactic",
  // Checkpointing is on by default in v4; keep each invocation well under the route's maxDuration (300s).
  checkpointing: { maxRuntime: "200s" },
});

export const knowledgeIngestRequested = eventType("knowledge/source.ingest", {
  schema: z.object({
    sourceId: z.uuid(),
    runId: z.uuid(),
    agentId: z.uuid(),
    orgId: z.uuid(),
  }),
});
