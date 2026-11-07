import "server-only";
import { NonRetriableError } from "inngest";
import { handleInbound } from "@/server/connectors/handle";
import { adapterFor, connectorKey } from "@/server/connectors/registry";
import { loadConnection } from "@/server/connectors/service";
import { db } from "@/server/db/client";
import { appOrigin } from "@/server/env";
import { runtimeDeps } from "@/server/inference/config";
import { connectorMessageReceived, inngest } from "./client";

/**
 * Answer one inbound connector message. One run at a time per thread keeps replies in order.
 * No automatic retries: a retry could send the customer a duplicate answer.
 */
export const connectorMessage = inngest.createFunction(
  {
    id: "connector-message",
    name: "Answer connector message",
    triggers: [connectorMessageReceived],
    retries: 0,
    concurrency: { limit: 1, key: 'event.data.connectionId + ":" + event.data.message.externalChatId' },
  },
  async ({ event }) => {
    const conn = await loadConnection<never>(db(), event.data.connectionId, connectorKey());
    if (!conn) throw new NonRetriableError("Connection not found");
    const adapter = adapterFor(conn.platform);
    if (!adapter) throw new NonRetriableError("No adapter for platform");
    const outcome = await handleInbound({ db: db(), runtime: runtimeDeps(), appOrigin: appOrigin().origin }, conn, adapter, event.data.message, conn.platform);
    return { outcome };
  },
);
