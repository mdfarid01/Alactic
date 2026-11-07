import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ConnectorError, type ConnectorAdapter, type InboundMessage } from "./types";

/**
 * Slack Events API + Web API (docs/integrations/SLACK.md). The business creates its own Slack app (from a manifest we
 * generate), installs it, and pastes the bot token (xoxb-) and signing secret.
 */
export type SlackCredentials = { botToken: string; signingSecret: string; teamId: string; botUserId: string; botId: string | null };

const API = "https://slack.com/api";

/** v0 signature: HMAC-SHA256(signingSecret, `v0:${ts}:${rawBody}`) hex; reject timestamps more than 5 minutes off. */
export function verifySlackSignature(rawBody: string, timestamp: string | null, signature: string | null, signingSecret: string, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 5 * 60) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex")}`;
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const fileSchema = z
  .object({
    mimetype: z.string().optional(),
    size: z.number().optional(),
    mode: z.string().optional(),
    is_external: z.boolean().optional(),
    file_access: z.string().optional(),
    url_private: z.string().optional(),
  })
  .passthrough();

const eventSchema = z
  .object({
    type: z.string(),
    subtype: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    text: z.string().optional(),
    ts: z.string(),
    thread_ts: z.string().optional(),
    channel: z.string(),
    channel_type: z.string().optional(),
    files: z.array(fileSchema).optional(),
  })
  .passthrough();

const envelopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url_verification"), challenge: z.string() }).passthrough(),
  z.object({ type: z.literal("event_callback"), team_id: z.string(), event_id: z.string(), event: z.unknown() }).passthrough(),
]);

export type ParsedSlack = { kind: "challenge"; challenge: string } | { kind: "message"; message: InboundMessage } | { kind: "ignore" };

/**
 * app_mention in channels (reply in thread) and message.im DMs. Ignores other teams, bots (including ourselves),
 * edits/deletes/joins, and external or Slack Connect files.
 */
export function parseSlackEvent(raw: unknown, creds: Pick<SlackCredentials, "teamId" | "botUserId">): ParsedSlack {
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) return { kind: "ignore" };
  if (env.data.type === "url_verification") return { kind: "challenge", challenge: env.data.challenge };
  if (env.data.team_id !== creds.teamId) return { kind: "ignore" };
  const ev = eventSchema.safeParse(env.data.event);
  if (!ev.success) return { kind: "ignore" };
  const e = ev.data;
  if (e.bot_id || !e.user || e.user === creds.botUserId) return { kind: "ignore" };
  if (e.subtype && e.subtype !== "file_share") return { kind: "ignore" };
  const isMention = e.type === "app_mention";
  const isDm = e.type === "message" && e.channel_type === "im";
  if (!isMention && !isDm) return { kind: "ignore" };

  const text = (e.text ?? "").replace(new RegExp(`<@${creds.botUserId}>`, "g"), "").trim();
  let media: InboundMessage["media"] = null;
  for (const f of e.files ?? []) {
    if (f.is_external || f.mode === "external" || f.file_access === "check_file_info" || !f.url_private) continue;
    const mt = f.mimetype ?? "";
    if (mt.startsWith("image/")) media = { kind: "image", ref: f.url_private };
    else if (mt.startsWith("audio/") || mt.startsWith("video/")) media = { kind: "voice", ref: f.url_private };
    if (media) break;
  }
  if (!text && !media) return { kind: "ignore" };
  // Channel mentions: one conversation per thread. DMs: one conversation per DM channel.
  const threadTs = isMention ? (e.thread_ts ?? e.ts) : null;
  return {
    kind: "message",
    message: {
      eventKey: `sl:${env.data.event_id}`,
      externalChatId: threadTs ? `${e.channel}:${threadTs}` : e.channel,
      externalUserId: e.user,
      text: media?.kind === "voice" ? "" : text.slice(0, 4000),
      media,
      replyTarget: threadTs ? { channel: e.channel, threadTs } : { channel: e.channel },
    },
  };
}

/** Escape &, <, > so model output can't inject Slack links or @channel mentions. */
export function escapeSlack(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function api<T>(token: string, method: string, body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${API}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ConnectorError("platform_error", "Couldn't reach Slack.");
  }
  const json = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
  if (!json?.ok) {
    const err = json?.error ?? `HTTP ${res.status}`;
    if (["invalid_auth", "not_authed", "account_inactive", "token_revoked"].includes(err)) throw new ConnectorError("invalid_credentials", "Slack rejected the bot token.");
    throw new ConnectorError("platform_error", `Slack error: ${err.slice(0, 80)}`);
  }
  return json;
}

export const slackApi = {
  authTest: (token: string, f: typeof fetch = fetch) => api<{ team_id: string; team?: string; user_id: string; bot_id?: string }>(token, "auth.test", {}, f),
};

export function slackAdapter(fetchImpl: typeof fetch = fetch): ConnectorAdapter<SlackCredentials> {
  return {
    platform: "slack",
    maxReplyChars: 3900,
    async downloadMedia(creds, url, maxBytes) {
      // Only ever send the bot token to Slack's own file host.
      const u = new URL(url);
      if (u.protocol !== "https:" || u.hostname !== "files.slack.com") throw new ConnectorError("platform_error", "Unsupported file location.");
      const res = await fetchImpl(u, { headers: { authorization: `Bearer ${creds.botToken}` }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new ConnectorError("platform_error", "Couldn't download the file from Slack.");
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) throw new ConnectorError("too_large", "That file is too large.");
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new ConnectorError("too_large", "That file is too large.");
      return { bytes };
    },
    async sendReply(creds, target, text) {
      await api(
        creds.botToken,
        "chat.postMessage",
        { channel: target.channel, ...(target.threadTs ? { thread_ts: target.threadTs } : {}), text: escapeSlack(text), unfurl_links: false, unfurl_media: false },
        fetchImpl,
      );
    },
  };
}

/** App manifest the business pastes into "Create New App → From a manifest" (field names from Slack's manifest reference). */
export function slackManifest(name: string, requestUrl?: string) {
  return {
    _metadata: { major_version: 2, minor_version: 1 },
    display_information: { name: name.slice(0, 35) },
    features: {
      bot_user: { display_name: name.slice(0, 80), always_online: true },
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    },
    oauth_config: { scopes: { bot: ["app_mentions:read", "chat:write", "im:history", "files:read"] } },
    settings: {
      ...(requestUrl ? { event_subscriptions: { request_url: requestUrl, bot_events: ["app_mention", "message.im"] } } : {}),
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
