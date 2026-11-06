import { acceptInbound } from "@/server/connectors/inbound";
import { connectorKey } from "@/server/connectors/registry";
import { loadConnection, markConnectionEvent } from "@/server/connectors/service";
import { parseDiscordInteraction, verifyDiscordSignature, type DiscordCredentials } from "@/server/connectors/discord";
import { db } from "@/server/db/client";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const EPHEMERAL = 64;

/**
 * Discord Interactions Endpoint URL. Verifies the Ed25519 signature on every request (Discord sends deliberate bad
 * signatures and removes endpoints that accept them), answers PING, and defers commands (type 5) within 3 s;
 * the queued job edits the placeholder with the answer.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/connectors/discord/[connectionId]/interactions">) {
  const { connectionId } = await ctx.params;
  const conn = await loadConnection<DiscordCredentials>(db(), connectionId, connectorKey(), "discord");
  if (!conn) return new Response("not found", { status: 404 });
  const raw = await request.text();
  if (!verifyDiscordSignature(raw, request.headers.get("x-signature-ed25519"), request.headers.get("x-signature-timestamp"), conn.credentials.publicKey)) {
    return new Response("invalid request signature", { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const parsed = parseDiscordInteraction(body, conn.credentials.applicationId);
  if (parsed.kind === "ping") {
    await markConnectionEvent(db(), conn.id, null);
    return json({ type: 1 });
  }
  if (parsed.kind === "empty") return json({ type: 4, data: { content: "Please include a question, a screenshot, or a voice note.", flags: EPHEMERAL } });
  if (parsed.kind !== "message") return json({ type: 4, data: { content: "This command isn't supported.", flags: EPHEMERAL } });
  if (conn.status !== "active") return json({ type: 4, data: { content: "This assistant is paused right now.", flags: EPHEMERAL } });
  const r = await acceptInbound(conn.id, parsed.message);
  if (r === "error") return json({ type: 4, data: { content: "Something went wrong. Please try again.", flags: EPHEMERAL } });
  return json({ type: 5 });
}
