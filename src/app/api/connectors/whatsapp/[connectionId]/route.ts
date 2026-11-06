import { timingSafeEqual } from "node:crypto";
import { acceptInbound } from "@/server/connectors/inbound";
import { connectorKey } from "@/server/connectors/registry";
import { loadConnection, markConnectionEvent } from "@/server/connectors/service";
import { parseWhatsAppWebhook, verifyWhatsAppSignature, whatsappAdapter, type WhatsAppCredentials } from "@/server/connectors/whatsapp";
import { db } from "@/server/db/client";

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Meta's webhook verification handshake: echo hub.challenge when hub.verify_token matches. */
export async function GET(request: Request, ctx: RouteContext<"/api/connectors/whatsapp/[connectionId]">) {
  const { connectionId } = await ctx.params;
  const conn = await loadConnection<WhatsAppCredentials>(db(), connectionId, connectorKey(), "whatsapp");
  if (!conn) return new Response("not found", { status: 404 });
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (mode !== "subscribe" || !safeEqual(token, conn.credentials.verifyToken)) return new Response("forbidden", { status: 403 });
  await markConnectionEvent(db(), conn.id, null);
  return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

/**
 * Inbound messages. Verify X-Hub-Signature-256 over the raw body with the App Secret, then queue each message
 * (deduped on the wamid) and answer 200 quickly (Meta retries for up to 7 days).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/connectors/whatsapp/[connectionId]">) {
  const { connectionId } = await ctx.params;
  const conn = await loadConnection<WhatsAppCredentials>(db(), connectionId, connectorKey(), "whatsapp");
  if (!conn) return new Response("not found", { status: 404 });
  const raw = await request.text();
  if (!verifyWhatsAppSignature(raw, request.headers.get("x-hub-signature-256"), conn.credentials.appSecret)) {
    return new Response("unauthorized", { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("ok", { status: 200 });
  }
  if (conn.status !== "active") return new Response("ok", { status: 200 });
  const parsed = parseWhatsAppWebhook(body, conn.credentials.phoneNumberId);
  for (const target of parsed.unsupported) {
    await whatsappAdapter()
      .sendReply(conn.credentials, target, "I can read text messages, voice notes and images. Please send your question in one of those.")
      .catch(() => {});
  }
  for (const message of parsed.messages) {
    if ((await acceptInbound(conn.id, message)) === "error") return new Response("retry", { status: 503 });
  }
  return new Response("ok", { status: 200 });
}
