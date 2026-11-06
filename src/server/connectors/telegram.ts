import { z } from "zod";
import { ConnectorError, type ConnectorAdapter, type InboundMessage } from "./types";

/** Telegram Bot API (docs/integrations/TELEGRAM.md). Business-owned bot; we store its token encrypted. */
export type TelegramCredentials = { botToken: string; secretToken: string; botId: number; botUsername: string };

const API = "https://api.telegram.org";
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

export function isTelegramToken(token: string) {
  return TOKEN_RE.test(token);
}

async function call<T>(token: string, method: string, body?: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(method === "getUpdates" ? 35_000 : 15_000),
    });
  } catch {
    throw new ConnectorError("platform_error", "Couldn't reach Telegram.");
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number } | null;
  if (!json?.ok) {
    if (res.status === 401 || res.status === 404) throw new ConnectorError("invalid_credentials", "Telegram rejected this bot token.");
    throw new ConnectorError("platform_error", `Telegram error: ${(json?.description ?? `HTTP ${res.status}`).slice(0, 160)}`);
  }
  return json.result as T;
}

export const telegramApi = {
  getMe: (token: string, f?: typeof fetch) => call<{ id: number; is_bot: boolean; username?: string; first_name: string }>(token, "getMe", undefined, f),
  setWebhook: (token: string, url: string, secretToken: string, f?: typeof fetch) =>
    call<boolean>(token, "setWebhook", { url, secret_token: secretToken, allowed_updates: ["message"], drop_pending_updates: true }, f),
  deleteWebhook: (token: string, f?: typeof fetch) => call<boolean>(token, "setWebhook", { url: "" }, f),
  getUpdates: (token: string, offset: number, f?: typeof fetch) => call<unknown[]>(token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, f),
  sendMessage: (token: string, body: Record<string, unknown>, f?: typeof fetch) => call<unknown>(token, "sendMessage", body, f),
  sendChatAction: (token: string, chatId: number | string, f?: typeof fetch) => call<boolean>(token, "sendChatAction", { chat_id: chatId, action: "typing" }, f),
  getFile: (token: string, fileId: string, f?: typeof fetch) => call<{ file_id: string; file_size?: number; file_path?: string }>(token, "getFile", { file_id: fileId }, f),
};

const updateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      from: z.object({ id: z.number(), is_bot: z.boolean().optional() }).passthrough().optional(),
      chat: z.object({ id: z.number(), type: z.string() }).passthrough(),
      text: z.string().optional(),
      caption: z.string().optional(),
      photo: z.array(z.object({ file_id: z.string(), file_size: z.number().optional(), width: z.number(), height: z.number() }).passthrough()).optional(),
      voice: z.object({ file_id: z.string(), file_size: z.number().optional() }).passthrough().optional(),
      audio: z.object({ file_id: z.string(), file_size: z.number().optional() }).passthrough().optional(),
      reply_to_message: z.object({ from: z.object({ id: z.number() }).passthrough().optional() }).passthrough().optional(),
    })
    .passthrough()
    .optional(),
});

export type ParsedTelegram = { kind: "message"; message: InboundMessage } | { kind: "start"; chatId: number } | { kind: "ignore" };

const IMAGE_MAX = 4 * 1024 * 1024;

/**
 * Normalize an Update. Private chats: every message. Groups: only `/ask …`, an @mention of the bot, or a reply to
 * the bot (Telegram's default privacy mode already limits what bots receive). Bots' own messages are ignored.
 */
export function parseTelegramUpdate(raw: unknown, bot: { botId: number; botUsername: string }): ParsedTelegram {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.message) return { kind: "ignore" };
  const m = parsed.data.message;
  if (!m.from || m.from.is_bot) return { kind: "ignore" };
  const isPrivate = m.chat.type === "private";
  let text = (m.text ?? m.caption ?? "").trim();
  const mention = `@${bot.botUsername}`.toLowerCase();

  if (/^\/start(@\w+)?$/i.test(text)) return isPrivate ? { kind: "start", chatId: m.chat.id } : { kind: "ignore" };
  const askCmd = /^\/ask(@\w+)?\s*/i;
  const addressed = isPrivate || askCmd.test(text) || text.toLowerCase().includes(mention) || m.reply_to_message?.from?.id === bot.botId;
  if (!addressed) return { kind: "ignore" };
  text = text.replace(askCmd, "").replace(new RegExp(mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "").trim();

  let media: InboundMessage["media"] = null;
  if (m.voice) media = { kind: "voice", ref: m.voice.file_id };
  else if (m.audio) media = { kind: "voice", ref: m.audio.file_id };
  else if (m.photo?.length) {
    // Largest size that fits our limit (sizes are listed small → large).
    const fitting = m.photo.filter((p) => (p.file_size ?? 0) <= IMAGE_MAX);
    const best = (fitting.length ? fitting : m.photo).at(-1)!;
    media = { kind: "image", ref: best.file_id };
  }
  if (!text && !media) return { kind: "ignore" };

  return {
    kind: "message",
    message: {
      eventKey: `tg:${parsed.data.update_id}`,
      externalChatId: String(m.chat.id),
      externalUserId: String(m.from.id),
      text: media?.kind === "voice" ? "" : text.slice(0, 4000),
      media,
      replyTarget: { chatId: m.chat.id, replyTo: m.message_id },
    },
  };
}

export function telegramAdapter(fetchImpl: typeof fetch = fetch): ConnectorAdapter<TelegramCredentials> {
  return {
    platform: "telegram",
    maxReplyChars: 3900,
    async downloadMedia(creds, ref, maxBytes) {
      const file = await telegramApi.getFile(creds.botToken, ref, fetchImpl);
      if (!file.file_path) throw new ConnectorError("platform_error", "Telegram didn't return a file path.");
      if (file.file_size && file.file_size > maxBytes) throw new ConnectorError("too_large", "That file is too large.");
      const res = await fetchImpl(`${API}/file/bot${creds.botToken}/${file.file_path}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new ConnectorError("platform_error", "Couldn't download the file from Telegram.");
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new ConnectorError("too_large", "That file is too large.");
      return { bytes };
    },
    async sendReply(creds, target, text) {
      await telegramApi.sendMessage(
        creds.botToken,
        {
          chat_id: target.chatId,
          text: text.slice(0, 4096),
          link_preview_options: { is_disabled: true },
          ...(target.replyTo ? { reply_parameters: { message_id: target.replyTo, allow_sending_without_reply: true } } : {}),
        },
        fetchImpl,
      );
    },
    async sendTyping(creds, target) {
      await telegramApi.sendChatAction(creds.botToken, target.chatId, fetchImpl);
    },
  };
}
