import { acceptInbound } from "@/server/connectors/inbound";
import { connectorKey } from "@/server/connectors/registry";
import { loadConnection, markConnectionEvent } from "@/server/connectors/service";
import { parseSlackEvent, verifySlackSignature, type SlackCredentials } from "@/server/connectors/slack";
import { db } from "@/server/db/client";

/**
 * Slack Events API request URL. Every request, including url_verification, must carry a valid v0 signature
 * (the business pastes the signing secret before adding this URL). Acks within 3 s; work is queued.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/connectors/slack/[connectionId]/events">) {
  const { connectionId } = await ctx.params;
  const conn = await loadConnection<SlackCredentials>(db(), connectionId, connectorKey(), "slack");
  if (!conn) return new Response("not found", { status: 404 });
  const raw = await request.text();
  if (!verifySlackSignature(raw, request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"), conn.credentials.signingSecret)) {
    return new Response("unauthorized", { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("", { status: 200 });
  }
  const parsed = parseSlackEvent(body, conn.credentials);
  if (parsed.kind === "challenge") {
    await markConnectionEvent(db(), conn.id, null);
    return new Response(parsed.challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  if (parsed.kind === "message" && conn.status === "active") {
    if ((await acceptInbound(conn.id, parsed.message)) === "error") return new Response("retry", { status: 503 });
  }
  return new Response("", { status: 200 });
}
