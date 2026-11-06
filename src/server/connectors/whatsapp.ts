import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ConnectorError, type ConnectorAdapter, type InboundMessage } from "./types";

/**
 * WhatsApp Business Cloud API (docs/integrations/WHATSAPP.md, Graph API v27.0).
 * The business brings its own Meta app: phone number id, WABA id, a System User access token, and the App Secret.
 */
export type WhatsAppCredentials = { phoneNumberId: string; wabaId: string; accessToken: string; appSecret: string; verifyToken: string };

export const GRAPH = "https://graph.facebook.com/v27.0";

/** `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(rawBody, appSecret)>`, compared in constant time. */
export function verifyWhatsAppSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const got = header.slice(7);
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

const messageSchema = z
  .object({
    id: z.string(),
    from: z.string().optional(),
    from_user_id: z.string().optional(),
    type: z.string(),
    text: z.object({ body: z.string() }).passthrough().optional(),
    audio: z.object({ id: z.string() }).passthrough().optional(),
    image: z.object({ id: z.string(), caption: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const payloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string(),
          value: z
            .object({ metadata: z.object({ phone_number_id: z.string() }).passthrough().optional(), messages: z.array(z.unknown()).optional() })
            .passthrough(),
        }),
      ),
    }),
  ),
});

export type ParsedWhatsApp = { messages: InboundMessage[]; unsupported: InboundMessage["replyTarget"][] };

/**
 * Normalize a webhook POST: iterate every entry/change/message (batches are possible), keep only messages for this
 * connection's phone number, ignore status updates. Unsupported types (stickers, locations…) get a short note.
 */
export function parseWhatsAppWebhook(raw: unknown, phoneNumberId: string): ParsedWhatsApp {
  const out: ParsedWhatsApp = { messages: [], unsupported: [] };
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success || parsed.data.object !== "whatsapp_business_account") return out;
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages" || change.value.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const rawMsg of change.value.messages ?? []) {
        const m = messageSchema.safeParse(rawMsg);
        if (!m.success) continue;
        const user = m.data.from_user_id ?? m.data.from;
        if (!user) continue;
        // `to` (phone) wins when present; username-only users are addressed by BSUID via `recipient`.
        const replyTarget: InboundMessage["replyTarget"] = m.data.from ? { to: m.data.from, messageId: m.data.id } : { recipient: user, messageId: m.data.id };
        const base = { eventKey: `wa:${m.data.id}`, externalChatId: user, externalUserId: user, replyTarget };
        if (m.data.type === "text" && m.data.text) out.messages.push({ ...base, text: m.data.text.body.slice(0, 4000), media: null });
        else if (m.data.type === "audio" && m.data.audio) out.messages.push({ ...base, text: "", media: { kind: "voice", ref: m.data.audio.id } });
        else if (m.data.type === "image" && m.data.image) out.messages.push({ ...base, text: (m.data.image.caption ?? "").slice(0, 4000), media: { kind: "image", ref: m.data.image.id } });
        else out.unsupported.push(replyTarget);
      }
    }
  }
  return out;
}

async function graph<T>(creds: WhatsAppCredentials, path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${GRAPH}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${creds.accessToken}`, "content-type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ConnectorError("platform_error", "Couldn't reach WhatsApp.");
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: number } }) | null;
  if (!res.ok || json?.error) {
    const code = json?.error?.code;
    if (res.status === 401 || code === 190) throw new ConnectorError("invalid_credentials", "WhatsApp rejected the access token.");
    if (code === 131047) throw new ConnectorError("platform_error", "The 24-hour customer service window has closed for this user.");
    throw new ConnectorError("platform_error", `WhatsApp error${code ? ` ${code}` : ""}: ${(json?.error?.message ?? `HTTP ${res.status}`).slice(0, 160)}`);
  }
  return json as T;
}

export function whatsappAdapter(fetchImpl: typeof fetch = fetch): ConnectorAdapter<WhatsAppCredentials> {
  return {
    platform: "whatsapp",
    maxReplyChars: 4000,
    async downloadMedia(creds, mediaId, maxBytes) {
      const meta = await graph<{ url?: string; file_size?: number }>(creds, `/${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(creds.phoneNumberId)}`, { method: "GET" }, fetchImpl);
      if (!meta.url) throw new ConnectorError("platform_error", "WhatsApp didn't return a media URL.");
      if (meta.file_size && meta.file_size > maxBytes) throw new ConnectorError("too_large", "That file is too large.");
      // The download needs the same bearer token; only send it to Meta's own HTTPS hosts.
      const host = new URL(meta.url).hostname;
      if (!meta.url.startsWith("https://") || !(host.endsWith(".fbsbx.com") || host.endsWith(".facebook.com") || host.endsWith(".whatsapp.net"))) {
        throw new ConnectorError("platform_error", "Unexpected media host.");
      }
      const res = await fetchImpl(meta.url, { headers: { authorization: `Bearer ${creds.accessToken}` }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new ConnectorError("platform_error", "Couldn't download the file from WhatsApp.");
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new ConnectorError("too_large", "That file is too large.");
      return { bytes };
    },
    async sendReply(creds, target, text) {
      const to = target.to ? { to: String(target.to) } : { recipient: String(target.recipient) };
      await graph(
        creds,
        `/${encodeURIComponent(creds.phoneNumberId)}/messages`,
        { method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...to, type: "text", text: { preview_url: false, body: text.slice(0, 4096) } }) },
        fetchImpl,
      );
    },
    /** WhatsApp has no documented typing call we verified; mark the customer's message as read instead. */
    async sendTyping(creds, target) {
      if (!target.messageId) return;
      await graph(creds, `/${encodeURIComponent(creds.phoneNumberId)}/messages`, { method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: String(target.messageId) }) }, fetchImpl);
    },
  };
}
