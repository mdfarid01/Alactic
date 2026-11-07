/**
 * LOCAL DEVELOPMENT ONLY: receive Telegram messages without a public HTTPS URL.
 * Long-polls getUpdates for every active Telegram connection in "polling" mode and feeds updates into the same
 * pipeline as the webhook (dedupe → job queue → agent → reply). Requires `pnpm dev` and `pnpm inngest:dev`.
 *
 * Usage: pnpm connectors:poll
 */
import { acceptInbound, agentDisplayName, welcomeText } from "@/server/connectors/inbound";
import { connectorKey } from "@/server/connectors/registry";
import { loadConnection, pollingConnections } from "@/server/connectors/service";
import { parseTelegramUpdate, telegramAdapter, telegramApi, type TelegramCredentials } from "@/server/connectors/telegram";
import { db } from "@/server/db/client";

const offsets = new Map<string, number>();

async function pollOnce(connectionId: string) {
  const conn = await loadConnection<TelegramCredentials>(db(), connectionId, connectorKey(), "telegram");
  if (!conn) return;
  const updates = (await telegramApi.getUpdates(conn.credentials.botToken, offsets.get(conn.id) ?? 0)) as { update_id: number }[];
  for (const update of updates) {
    offsets.set(conn.id, update.update_id + 1);
    const parsed = parseTelegramUpdate(update, conn.credentials);
    if (parsed.kind === "start") {
      await telegramAdapter().sendReply(conn.credentials, { chatId: parsed.chatId }, welcomeText(await agentDisplayName(conn.agentId)));
    } else if (parsed.kind === "message") {
      const r = await acceptInbound(conn.id, parsed.message);
      console.log(`[poll] ${conn.credentials.botUsername}: update ${update.update_id} → ${r}${parsed.message.media ? ` (${parsed.message.media.kind})` : ""}`);
    }
  }
}

async function main() {
  console.log("[poll] Polling Telegram connections in local mode. Ctrl+C to stop.");
  for (;;) {
    const conns = await pollingConnections(db(), "telegram");
    if (conns.length === 0) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    await Promise.all(
      conns.map((c) =>
        pollOnce(c.id).catch((e) => {
          console.error(`[poll] ${c.id}: ${e instanceof Error ? e.message : "error"}`);
          return new Promise((r) => setTimeout(r, 3000));
        }),
      ),
    );
  }
}

void main();
