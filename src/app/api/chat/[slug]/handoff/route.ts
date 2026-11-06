import { z } from "zod";
import { sha256Hex } from "@/server/auth/tokens";
import { db } from "@/server/db/client";
import { HandoffError, requestHandoff } from "@/server/handoff/service";
import { isSameOriginRequest, jsonError } from "@/server/http/origin";
import { runtimeDeps } from "@/server/inference/config";
import { getPublicAgent } from "@/server/public/service";
import { consumeRateLimits } from "@/server/ratelimit/limiter";

const bodySchema = z.object({
  conversationId: z.uuid(),
  contact: z.string().max(200).optional(),
  note: z.string().max(1000).optional(),
});

/** A visitor asks for a human on their own conversation (same visitor token that started it). */
export async function POST(request: Request, ctx: RouteContext<"/api/chat/[slug]/handoff">) {
  if (!isSameOriginRequest(request)) return jsonError(403, "bad_origin", "Request origin not allowed");
  const visitor = request.headers.get("x-alactic-visitor") ?? "";
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(visitor)) return jsonError(400, "bad_visitor", "Missing visitor token. Reload the page and try again.");
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, "bad_request", "Invalid request.");
  const { slug } = await ctx.params;
  const agent = await getPublicAgent(db(), slug);
  if (!agent) return jsonError(404, "not_found", "This agent isn't available.");
  const visitorHash = sha256Hex(`visitor:${visitor}`);
  const limited = await consumeRateLimits(db(), [{ key: `handoff:visitor:${visitorHash}`, limit: 3, windowSeconds: 60 * 60 }]);
  if (!limited.ok) return jsonError(429, "rate_limited", "You've already asked for a person. The team will get back to you.");
  try {
    const r = await requestHandoff(runtimeDeps(), { orgId: agent.orgId, agentId: agent.agentId }, { conversationId: body.data.conversationId, visitorTokenHash: visitorHash, contact: body.data.contact, note: body.data.note });
    return Response.json({ ok: true, reference: r.id.slice(0, 8).toUpperCase(), alreadyOpen: r.alreadyOpen }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof HandoffError) return jsonError(error.code === "not_found" ? 404 : 400, error.code, error.message);
    console.error("[handoff] unexpected error", error instanceof Error ? error.name : "unknown");
    return jsonError(500, "internal_error", "Something went wrong. Please try again.");
  }
}
