import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { ConnectorError, type ConnectorAdapter, type InboundMessage } from "./types";

/**
 * Discord HTTP interactions (docs/integrations/DISCORD.md, API v10). The business brings its own application:
 * application id, public key (Ed25519, hex) and bot token. Users ask with `/ask` or the "Ask Alactic" message command.
 */
export type DiscordCredentials = { applicationId: string; publicKey: string; botToken: string };

export const DISCORD_API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://alactic.app, 0.1)";
export const ASK_MESSAGE_COMMAND = "Ask Alactic";

/** Ed25519 over `timestamp + rawBody` with the app's public key (hex, 32 bytes). */
export function verifyDiscordSignature(rawBody: string, signature: string | null, timestamp: string | null, publicKeyHex: string): boolean {
  if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature) || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
  try {
    // SPKI DER prefix for an Ed25519 public key, followed by the 32 raw key bytes.
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(timestamp + rawBody, "utf8"), key, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

const attachmentSchema = z.object({ id: z.string(), url: z.string(), content_type: z.string().optional(), size: z.number().optional() }).passthrough();

const interactionSchema = z
  .object({
    id: z.string(),
    application_id: z.string(),
    type: z.number(),
    token: z.string().optional(),
    channel_id: z.string().optional(),
    member: z.object({ user: z.object({ id: z.string() }).passthrough() }).passthrough().optional(),
    user: z.object({ id: z.string() }).passthrough().optional(),
    data: z
      .object({
        name: z.string(),
        type: z.number().optional(),
        target_id: z.string().optional(),
        options: z.array(z.object({ name: z.string(), type: z.number(), value: z.unknown() }).passthrough()).optional(),
        resolved: z
          .object({
            attachments: z.record(z.string(), attachmentSchema).optional(),
            messages: z.record(z.string(), z.object({ content: z.string().optional(), attachments: z.array(attachmentSchema).optional() }).passthrough()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ParsedDiscord = { kind: "ping" } | { kind: "message"; message: InboundMessage } | { kind: "empty" } | { kind: "ignore" };

const MEDIA_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

function mediaFrom(att: z.infer<typeof attachmentSchema> | undefined): InboundMessage["media"] {
  if (!att) return null;
  const ct = att.content_type ?? "";
  if (ct.startsWith("image/")) return { kind: "image", ref: att.url };
  if (ct.startsWith("audio/") || ct.startsWith("video/")) return { kind: "voice", ref: att.url };
  return null;
}

export function parseDiscordInteraction(raw: unknown, applicationId: string): ParsedDiscord {
  const parsed = interactionSchema.safeParse(raw);
  if (!parsed.success || parsed.data.application_id !== applicationId) return { kind: "ignore" };
  const i = parsed.data;
  if (i.type === 1) return { kind: "ping" };
  if (i.type !== 2 || !i.data || !i.token) return { kind: "ignore" };
  const userId = i.member?.user.id ?? i.user?.id;
  if (!userId) return { kind: "ignore" };

  let text = "";
  let media: InboundMessage["media"] = null;
  if (i.data.name === "ask" && (i.data.type ?? 1) === 1) {
    const q = i.data.options?.find((o) => o.name === "question");
    text = typeof q?.value === "string" ? q.value : "";
    const f = i.data.options?.find((o) => o.name === "file");
    media = mediaFrom(typeof f?.value === "string" ? i.data.resolved?.attachments?.[f.value] : undefined);
  } else if (i.data.name === ASK_MESSAGE_COMMAND && i.data.type === 3 && i.data.target_id) {
    const target = i.data.resolved?.messages?.[i.data.target_id];
    text = target?.content ?? "";
    media = mediaFrom(target?.attachments?.find((a) => mediaFrom(a) !== null));
  } else {
    return { kind: "ignore" };
  }
  text = text.trim();
  if (!text && !media) return { kind: "empty" };
  return {
    kind: "message",
    message: {
      eventKey: `dc:${i.id}`,
      externalChatId: i.channel_id ?? `dm:${userId}`,
      externalUserId: userId,
      text: media?.kind === "voice" ? "" : text.slice(0, 4000),
      media,
      replyTarget: { applicationId: i.application_id, token: i.token },
    },
  };
}

async function discordFetch(path: string, init: RequestInit, fetchImpl: typeof fetch) {
  let res: Response;
  try {
    res = await fetchImpl(`${DISCORD_API}${path}`, { ...init, headers: { "user-agent": USER_AGENT, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ConnectorError("platform_error", "Couldn't reach Discord.");
  }
  if (res.status === 401 || res.status === 403) throw new ConnectorError("invalid_credentials", "Discord rejected the bot token.");
  if (!res.ok) throw new ConnectorError("platform_error", `Discord error: HTTP ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

export const discordApi = {
  /** Validate the bot token and fetch the application (GET /applications/@me). */
  getApplication: (botToken: string, f: typeof fetch = fetch) => discordFetch("/applications/@me", { method: "GET", headers: { authorization: `Bot ${botToken}` } }, f) as Promise<{ id: string; name: string }>,
  /** Bulk-overwrite global commands: `/ask question [file]` and the "Ask Alactic" message command. */
  registerCommands: (applicationId: string, botToken: string, f: typeof fetch = fetch) =>
    discordFetch(
      `/applications/${applicationId}/commands`,
      {
        method: "PUT",
        headers: { authorization: `Bot ${botToken}` },
        body: JSON.stringify([
          {
            name: "ask",
            type: 1,
            description: "Ask the support agent",
            contexts: [0, 1],
            integration_types: [0],
            options: [
              { type: 3, name: "question", description: "Your question", required: true },
              { type: 11, name: "file", description: "Optional screenshot or voice note", required: false },
            ],
          },
          { name: ASK_MESSAGE_COMMAND, type: 3, contexts: [0], integration_types: [0] },
        ]),
      },
      f,
    ),
};

export function discordInstallUrl(applicationId: string) {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot+applications.commands&permissions=84992`;
}

export function discordAdapter(fetchImpl: typeof fetch = fetch): ConnectorAdapter<DiscordCredentials> {
  return {
    platform: "discord",
    maxReplyChars: 1950,
    async downloadMedia(_creds, url, maxBytes) {
      const u = new URL(url);
      // Signed CDN URLs: the URL is the credential. Never send the bot token there.
      if (u.protocol !== "https:" || !MEDIA_HOSTS.has(u.hostname)) throw new ConnectorError("platform_error", "Unsupported file location.");
      const res = await fetchImpl(u, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new ConnectorError("platform_error", "Couldn't download the file from Discord.");
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new ConnectorError("too_large", "That file is too large.");
      return { bytes };
    },
    /** Edit the deferred "thinking…" placeholder (interaction token valid 15 min). Mentions are disabled. */
    async sendReply(_creds, target, text) {
      await discordFetch(
        `/webhooks/${encodeURIComponent(String(target.applicationId))}/${encodeURIComponent(String(target.token))}/messages/@original`,
        { method: "PATCH", body: JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } }) },
        fetchImpl,
      );
    },
  };
}
