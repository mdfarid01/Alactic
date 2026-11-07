# Telegram connector

## Sources (read 2026-11-07)
- Telegram Bot API reference: https://core.telegram.org/bots/api (sections: Making requests, Getting updates, setWebhook, getUpdates, Update, Message, Voice, PhotoSize, getFile, sendMessage, sendChatAction, getMe)

## Recommended MVP approach
The business creates its own bot with @BotFather and pastes the bot token into Alactic. One token = one bot = one Alactic agent. No app review, no OAuth.

## Verified facts
- **Requests:** `https://api.telegram.org/bot<token>/METHOD_NAME`, GET or POST, JSON bodies allowed (multipart only for uploads). Responses: `{ ok: true, result }` or `{ ok: false, description, error_code, parameters? }` (`error_code` "subject to change").
- **getMe:** validates the token and returns the bot `User` (`id`, `username`, …).
- **setWebhook:** `url` (HTTPS; empty string removes the webhook), `allowed_updates` (e.g. `["message"]`), `drop_pending_updates`, and `secret_token` (1–256 chars, `A-Za-z0-9_-`), which is sent back on every webhook request in the header **`X-Telegram-Bot-Api-Secret-Token`**. Non-2xx responses are retried "a reasonable amount of attempts".
- **getUpdates** (long polling): `offset`, `limit` (1–100), `timeout`, `allowed_updates`. **It doesn't work while a webhook is set.** We use it only for local development (http://localhost can't receive webhooks).
- **Update:** `update_id` (sequential; use it to ignore repeats) plus at most one of `message`, `edited_message`, …
- **Message:** `message_id`, `from` (User, optional), `chat` (`id`, `type` = private / group / supergroup / channel), `text`, `caption`, `photo` (array of `PhotoSize`: `file_id`, `width`, `height`, `file_size?`), `voice` (`file_id`, `duration`, `mime_type?`, `file_size?`), `audio`, `document`, `entities`.
- **getFile:** returns `File` with `file_path`; download from `https://api.telegram.org/file/bot<token>/<file_path>`. Bots can download files up to **20 MB**. Links are valid for at least 1 hour.
- **sendMessage:** `chat_id`, `text` (1–4096 chars after entity parsing), `parse_mode`, `link_preview_options`, `reply_parameters` (reply to a message).
- **sendChatAction:** `chat_id`, `action` (`typing`), which shows for up to 5 s.

## How Alactic uses it
- **Connect:** validate with `getMe`, generate a random `secret_token`, and store token + secret encrypted (AES-256-GCM). If `APP_URL` is https, call `setWebhook(url=/api/connectors/telegram/<connectionId>, secret_token, allowed_updates=["message"])`. Otherwise the connection runs in local **polling** mode (`pnpm connectors:poll`).
- **Inbound:** check the secret header with a timing-safe compare, dedupe by `update_id`, queue a job, and return 200 at once.
- **Job:** private chats are always answered. In groups the bot answers only when mentioned, replied to, or via `/ask`; Telegram's default privacy mode already limits what bots see. Voice notes (OGG/Opus) and photos (largest size ≤ 4 MB) go through the same transcription / screenshot pipeline as the web chat. The reply goes out with `sendMessage` (plain text, no parse_mode, so model output can't inject formatting) and ends with the proof receipt link.
- **Disconnect:** `setWebhook(url="")` (best effort), then delete the stored credentials.

## Gotchas
- Telegram retries failed webhooks, so we always return 200 after queuing and dedupe on `update_id`.
- The 4096-char limit applies after entity parsing; replies are truncated to 3900 chars, with room for the proof footer.
