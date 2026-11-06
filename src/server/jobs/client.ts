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

/** An inbound message from a connected platform (Telegram, Discord, Slack, WhatsApp, Zendesk), already verified and deduped. */
export const connectorMessageReceived = eventType("connector/message.received", {
  schema: z.object({
    connectionId: z.uuid(),
    message: z.object({
      eventKey: z.string(),
      externalChatId: z.string(),
      externalUserId: z.string(),
      text: z.string(),
      media: z.object({ kind: z.enum(["voice", "image"]), ref: z.string() }).nullable(),
      replyTarget: z.record(z.string(), z.union([z.string(), z.number()])),
    }),
  }),
});

/** Run an agent's golden-question test suite against its draft config. */
export const agentTestsRequested = eventType("agent/tests.run", {
  schema: z.object({ runId: z.uuid(), agentId: z.uuid(), orgId: z.uuid(), userId: z.uuid() }),
});
