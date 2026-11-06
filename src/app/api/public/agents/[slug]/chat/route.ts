import { z } from "zod";
import { db } from "@/server/db/client";
import { isSameOriginRequest, jsonError } from "@/server/http/origin";
import { runtimeDeps } from "@/server/inference/config";
import { getPublishedAgent } from "@/server/public/agents";
import { clientKey, consumeRateLimit } from "@/server/ratelimit";
import { runAgent, RunAgentError } from "@/server/runtime/run-agent";

export const maxDuration = 60;

const bodySchema = z.object({
  message: z.string().min(1).max(4000),
  conversationId: z.uuid().nullish(),
  visitorToken: z.string().min(20).max(100).regex(/^[A-Za-z0-9_-]+$/),
  channel: z.enum(["web", "widget"]).default("web"),
});

/** Anonymous public chat with a PUBLISHED agent. Same runtime as every other channel. */
export async function POST(request: Request, ctx: RouteContext<"/api/public/agents/[slug]/chat">) {
  // Only our own pages (public page and widget iframe) may call this from a browser.
  if (!isSameOriginRequest(request)) return jsonError(403, "bad_origin", "Request origin not allowed");
  const { slug } = await ctx.params;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, "bad_request", "Invalid message.");

  const database = db();
  const agent = await getPublishedAgent(database, slug);
  if (!agent) return jsonError(404, "not_found", "This agent isn't available.");

  // Abuse/cost protection: per client and per agent, per minute.
  const [perClient, perAgent] = await Promise.all([
    consumeRateLimit(database, `chat:client:${clientKey(request)}`, 12, 60),
    consumeRateLimit(database, `chat:agent:${agent.agentId}`, 60, 60),
  ]);
  if (!perClient.ok || !perAgent.ok) {
    const retryAfter = Math.max(perClient.ok ? 0 : perClient.retryAfter, perAgent.ok ? 0 : perAgent.retryAfter);
    return Response.json(
      { error: { code: "rate_limited", message: "You're sending messages too quickly. Please wait a moment." } },
      { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } },
    );
  }

  try {
    const result = await runAgent(runtimeDeps(), {
      agent: { orgId: agent.orgId, agentId: agent.agentId },
      configVersion: "published",
      channel: body.data.channel,
      conversationId: body.data.conversationId ?? null,
      userMessage: body.data.message,
      visitorToken: body.data.visitorToken,
    });
    return Response.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RunAgentError) {
      const status = error.code === "daily_limit" ? 429 : error.code === "conversation_not_found" ? 404 : 400;
      return jsonError(status, error.code, error.message);
    }
    console.error("[public-chat] unexpected error", error instanceof Error ? error.name : "unknown");
    return jsonError(500, "internal_error", "Something went wrong. Please try again.");
  }
}
