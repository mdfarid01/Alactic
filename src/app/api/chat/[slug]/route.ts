import { z } from "zod";
import { sha256Hex } from "@/server/auth/tokens";
import { db } from "@/server/db/client";
import { isSameOriginRequest, jsonError } from "@/server/http/origin";
import { mediaCapabilities } from "@/server/inference/catalog";
import { runtimeDeps } from "@/server/inference/config";
import { PUBLIC_CHAT_LIMITS } from "@/server/public/limits";
import { MEDIA_LIMITS, MediaError, toAttachment } from "@/server/public/media";
import { getPublicAgent } from "@/server/public/service";
import { toPublicReply } from "@/server/public/reply";
import { consumeRateLimits, type RateRule } from "@/server/ratelimit/limiter";
import type { Attachment } from "@/server/runtime/attachments";
import { MAX_USER_MESSAGE_CHARS, runAgent, RunAgentError } from "@/server/runtime/run-agent";

const fieldsSchema = z.object({
  message: z.string().max(MAX_USER_MESSAGE_CHARS).default(""),
  conversationId: z.uuid().nullish(),
  channel: z.enum(["web", "widget"]).default("web"),
});

const VISITOR_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_MULTIPART_BYTES = Math.max(MEDIA_LIMITS.audioMaxBytes, MEDIA_LIMITS.imageMaxBytes) + 64 * 1024;

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown").slice(0, 64);
}

type Parsed = { fields: z.infer<typeof fieldsSchema>; file: { kind: "voice" | "image"; file: File } | null };

/** JSON for text; multipart/form-data with an `audio` or `image` file for voice notes and screenshots. */
async function parseBody(request: Request): Promise<Parsed | Response> {
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const declared = Number(request.headers.get("content-length") ?? "NaN");
    if (!Number.isFinite(declared) || declared > MAX_MULTIPART_BYTES) return jsonError(413, "too_large", "That file is too large.");
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return jsonError(400, "bad_request", "Couldn't read the upload.");
    }
    const fields = fieldsSchema.safeParse({
      message: form.get("message") ?? undefined,
      conversationId: form.get("conversationId") || null,
      channel: form.get("channel") ?? undefined,
    });
    if (!fields.success) return jsonError(400, "bad_request", "Invalid message.");
    const audio = form.get("audio");
    const image = form.get("image");
    if (audio instanceof File && image instanceof File) return jsonError(400, "bad_request", "Send one attachment at a time.");
    const file = audio instanceof File ? { kind: "voice" as const, file: audio } : image instanceof File ? { kind: "image" as const, file: image } : null;
    return { fields: fields.data, file };
  }
  try {
    const fields = fieldsSchema.parse(await request.json());
    if (!fields.message.trim()) throw new Error("empty");
    return { fields, file: null };
  } catch {
    return jsonError(400, "bad_request", `Messages must be between 1 and ${MAX_USER_MESSAGE_CHARS} characters.`);
  }
}

/**
 * Public chat for published agents (public page + widget iframe, both served from our origin).
 * Anonymous visitors identify with a random token kept in their browser; only its hash is stored.
 * Voice notes and screenshots are validated by magic bytes, processed in memory on 0G, and never stored.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/chat/[slug]">) {
  if (!isSameOriginRequest(request)) return jsonError(403, "bad_origin", "Request origin not allowed");
  const visitor = request.headers.get("x-alactic-visitor") ?? "";
  if (!VISITOR_RE.test(visitor)) return jsonError(400, "bad_visitor", "Missing visitor token. Reload the page and try again.");

  const parsed = await parseBody(request);
  if (parsed instanceof Response) return parsed;

  const { slug } = await ctx.params;
  const agent = await getPublicAgent(db(), slug);
  if (!agent) return jsonError(404, "not_found", "This agent isn't available.");

  const visitorHash = sha256Hex(`visitor:${visitor}`);
  const rules: RateRule[] = [
    { key: `chat:visitor:${visitorHash}`, ...PUBLIC_CHAT_LIMITS.perVisitor },
    { key: `chat:ip:${sha256Hex(`ip:${clientIp(request)}`)}`, ...PUBLIC_CHAT_LIMITS.perIp },
    { key: `chat:agent:${agent.agentId}`, ...PUBLIC_CHAT_LIMITS.perAgent },
  ];
  if (parsed.file) rules.push({ key: `chat:media:${visitorHash}`, ...PUBLIC_CHAT_LIMITS.mediaPerVisitor });
  const decision = await consumeRateLimits(db(), rules);
  if (!decision.ok) {
    return Response.json(
      { error: { code: "rate_limited", message: "You're sending messages too quickly. Please wait a moment." } },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds), "Cache-Control": "no-store" } },
    );
  }

  let attachment: Attachment | null = null;
  if (parsed.file) {
    const caps = await mediaCapabilities(agent.modelId, agent.trustMode);
    if (parsed.file.kind === "voice" && !caps.voice) return jsonError(400, "unsupported", "This agent doesn't accept voice notes.");
    if (parsed.file.kind === "image" && !caps.images) return jsonError(400, "unsupported", "This agent's model can't read images.");
    try {
      attachment = await toAttachment(parsed.file.kind, parsed.file.file);
    } catch (error) {
      if (error instanceof MediaError) return jsonError(error.code === "too_large" ? 413 : 415, error.code, error.message);
      throw error;
    }
  }

  try {
    const result = await runAgent(runtimeDeps(), {
      agent: { orgId: agent.orgId, agentId: agent.agentId },
      configVersion: "published",
      channel: parsed.fields.channel,
      conversationId: parsed.fields.conversationId ?? null,
      userMessage: parsed.fields.message,
      visitorTokenHash: visitorHash,
      attachment,
    });
    return Response.json({ ok: true, reply: toPublicReply(result) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RunAgentError) {
      const status =
        error.code === "daily_limit"
          ? 429
          : error.code === "conversation_not_found" || error.code === "agent_not_found" || error.code === "not_published"
            ? 404
            : error.code === "invalid_message" || error.code === "empty_transcript" || error.code === "unsupported"
              ? 400
              : 502;
      return jsonError(status, error.code, error.message);
    }
    console.error("[public-chat] unexpected error", error instanceof Error ? error.name : "unknown");
    return jsonError(500, "internal_error", "Something went wrong. Please try again.");
  }
}
