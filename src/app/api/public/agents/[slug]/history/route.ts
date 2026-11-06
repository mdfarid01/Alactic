import { z } from "zod";
import { db } from "@/server/db/client";
import { isSameOriginRequest, jsonError } from "@/server/http/origin";
import { getPublishedAgent, publicConversationHistory } from "@/server/public/agents";

const bodySchema = z.object({ conversationId: z.uuid(), visitorToken: z.string().min(20).max(100) });

/** Restore a visitor's own conversation after a reload. Requires the visitor token that started it. */
export async function POST(request: Request, ctx: RouteContext<"/api/public/agents/[slug]/history">) {
  if (!isSameOriginRequest(request)) return jsonError(403, "bad_origin", "Request origin not allowed");
  const { slug } = await ctx.params;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, "bad_request", "Invalid request.");
  const agent = await getPublishedAgent(db(), slug);
  if (!agent) return jsonError(404, "not_found", "This agent isn't available.");
  const messages = await publicConversationHistory(db(), agent, body.data.conversationId, body.data.visitorToken);
  if (!messages) return jsonError(404, "not_found", "Conversation not found.");
  return Response.json({ messages }, { headers: { "Cache-Control": "no-store" } });
}
