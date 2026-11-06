import { sha256Hex } from "@/server/auth/tokens";
import type { Database } from "@/server/db/client";
import { MEDIA_LIMITS, MediaError, attachmentFromBytes } from "@/server/public/media";
import { consumeRateLimits } from "@/server/ratelimit/limiter";
import type { Attachment } from "@/server/runtime/attachments";
import { runAgent, RunAgentError, type RunAgentDeps, type RunAgentResult } from "@/server/runtime/run-agent";
import { markConnectionEvent, type LoadedConnection } from "./service";
import type { ConnectorAdapter, InboundMessage } from "./types";

export const CONNECTOR_USER_LIMIT = { limit: 20, windowSeconds: 10 * 60 } as const;

/** Reply text for a platform: the answer, then a proof footer. Plain text so model output can't inject platform markup. */
export function formatReply(result: RunAgentResult, appOrigin: string, maxChars: number): string {
  const lines: string[] = [];
  if (result.inference) {
    const verified = result.verification?.status === "verified";
    lines.push(`${verified ? "🔒 TEE-verified on 0G" : "Answered on 0G"} · proof: ${appOrigin}/proof/${result.inference.id}`);
  }
  if (result.userTurn.preInference) {
    lines.push(`${result.userTurn.attachment === "voice" ? "🎙 Transcription" : "🖼 Image reading"} proof: ${appOrigin}/proof/${result.userTurn.preInference.id}`);
  }
  const footer = lines.length ? `\n\n${lines.join("\n")}` : "";
  const room = Math.max(200, maxChars - footer.length - 2);
  const body = result.reply.content.length > room ? `${result.reply.content.slice(0, room - 1)}…` : result.reply.content;
  return `${body}${footer}`;
}

/**
 * Handle one inbound platform message for a connection: per-user rate limit → media download + validation →
 * the shared runtime (published config, one conversation per external thread) → reply with proof links.
 * User-facing failures are sent back as short messages; message content is never logged.
 */
export async function handleInbound<C>(
  deps: { db: Database; runtime: RunAgentDeps; appOrigin: string },
  conn: LoadedConnection<C>,
  adapter: ConnectorAdapter<C>,
  msg: InboundMessage,
  channel: "telegram" | "discord" | "slack" | "whatsapp" | "zendesk",
): Promise<"replied" | "skipped" | "limited" | "failed"> {
  if (conn.status !== "active") return "skipped";
  const userHash = sha256Hex(`connector:${conn.id}:${msg.externalUserId}`);
  const limited = await consumeRateLimits(deps.db, [{ key: `connector:user:${userHash}`, ...CONNECTOR_USER_LIMIT }]);
  if (!limited.ok) {
    await adapter.sendReply(conn.credentials, msg.replyTarget, "You're sending messages too quickly. Please wait a few minutes and try again.").catch(() => {});
    return "limited";
  }

  await adapter.sendTyping?.(conn.credentials, msg.replyTarget).catch(() => {});

  let attachment: Attachment | null = null;
  if (msg.media) {
    try {
      const max = msg.media.kind === "voice" ? MEDIA_LIMITS.audioMaxBytes : MEDIA_LIMITS.imageMaxBytes;
      const { bytes } = await adapter.downloadMedia(conn.credentials, msg.media.ref, max);
      attachment = attachmentFromBytes(msg.media.kind, bytes);
    } catch (error) {
      const text = error instanceof MediaError ? error.message : "I couldn't download that file. Please try again or type your question.";
      await adapter.sendReply(conn.credentials, msg.replyTarget, text).catch(() => {});
      await markConnectionEvent(deps.db, conn.id, null);
      return "failed";
    }
  }

  try {
    const result = await runAgent(deps.runtime, {
      agent: { orgId: conn.orgId, agentId: conn.agentId },
      configVersion: "published",
      channel,
      externalRef: `${conn.id}:${msg.externalChatId}`,
      visitorTokenHash: userHash,
      userMessage: attachment?.kind === "voice" ? "" : msg.text,
      attachment,
    });
    await adapter.sendReply(conn.credentials, msg.replyTarget, formatReply(result, deps.appOrigin, adapter.maxReplyChars));
    await markConnectionEvent(deps.db, conn.id, null);
    return "replied";
  } catch (error) {
    if (error instanceof RunAgentError) {
      const text = error.code === "not_published" ? "This assistant isn't available right now." : error.message;
      await adapter.sendReply(conn.credentials, msg.replyTarget, text).catch(() => {});
      await markConnectionEvent(deps.db, conn.id, null);
      return "failed";
    }
    await markConnectionEvent(deps.db, conn.id, "Couldn't deliver a reply. Check the connection's credentials.");
    throw error;
  }
}
