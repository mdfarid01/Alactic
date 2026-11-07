import { timingSafeEqual } from "node:crypto";
import { agentDisplayName, acceptInbound, welcomeText } from "@/server/connectors/inbound";
import { connectorKey } from "@/server/connectors/registry";
import { loadConnection } from "@/server/connectors/service";
import { parseTelegramUpdate, telegramAdapter, type TelegramCredentials } from "@/server/connectors/telegram";
import { db } from "@/server/db/client";

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Telegram webhook (setWebhook with secret_token). Verifies X-Telegram-Bot-Api-Secret-Token, dedupes by update_id,
 * queues the message and returns 200 at once (Telegram retries non-2xx responses).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/connectors/telegram/[connectionId]">) {
  const { connectionId } = await ctx.params;
  const conn = await loadConnection<TelegramCredentials>(db(), connectionId, connectorKey(), "telegram");
  if (!conn) return new Response("not found", { status: 404 });
  const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(secret, conn.credentials.secretToken)) return new Response("unauthorized", { status: 401 });

  const update = await request.json().catch(() => null);
  const parsed = parseTelegramUpdate(update, conn.credentials);
  if (parsed.kind === "start") {
    await telegramAdapter()
      .sendReply(conn.credentials, { chatId: parsed.chatId }, welcomeText(await agentDisplayName(conn.agentId)))
      .catch(() => {});
  } else if (parsed.kind === "message" && conn.status === "active") {
    const r = await acceptInbound(conn.id, parsed.message);
    if (r === "error") return new Response("retry", { status: 503 });
  }
  return new Response("ok", { status: 200 });
}
