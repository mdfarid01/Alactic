# Discord connector (research)

Status: research only. Nothing here is implemented yet. Everything below comes from the official docs listed under Sources (read 2026-11-07). Items marked **UNVERIFIED** were not confirmed in the official docs and must be checked before we rely on them.

## Sources (read 2026-11-07)
`discord.com/developers/docs/*` now 301-redirects to `docs.discord.com/developers/*`, so these are the canonical URLs.
- Interactions overview (endpoint URL, signature headers, PING): https://docs.discord.com/developers/interactions/overview
- Receiving and responding (interaction object, callback types, 3 s rule, 15 min token, follow-ups): https://docs.discord.com/developers/interactions/receiving-and-responding
- Application commands (types, option types, registration endpoints, limits): https://docs.discord.com/developers/interactions/application-commands
- Gateway, Message Content intent: https://docs.discord.com/developers/events/gateway
- OAuth2 (bot authorization flow, scopes, client credentials): https://docs.discord.com/developers/topics/oauth2
- Permissions (bit values): https://docs.discord.com/developers/topics/permissions
- Message resource (limits, attachment object, voice messages, allowed_mentions): https://docs.discord.com/developers/resources/message
- Rate limits: https://docs.discord.com/developers/topics/rate-limits
- API reference (base URL, auth header, User-Agent, signed CDN URLs): https://docs.discord.com/developers/reference
- Webhook resource: https://docs.discord.com/developers/resources/webhook

## Recommended MVP approach
**HTTP interactions only, with slash commands plus a message context menu command. Each business brings its own Discord application.**

1. **HTTP only means no plain @mentions or DMs.** Apps receive interactions in "two mutually-exclusive ways": through the Gateway (the default) or through an HTTP Interactions Endpoint URL. HTTP interactions cover only application commands, components, autocomplete and modals. Ordinary messages (`MESSAGE_CREATE`) are Gateway dispatch events tied to the `GUILD_MESSAGES` / `DIRECT_MESSAGES` intents. The docs never say outright "MESSAGE_CREATE is Gateway-only", but no HTTP delivery path for it is documented. So with no websocket process, the bot **cannot** react to a plain `@Bot question` or a plain DM. Users interact through:
   - `/ask question:<text> [file:<attachment>]`, a CHAT_INPUT command (type 1) with a STRING option and an optional ATTACHMENT option (type 11).
   - **"Ask Alactic"**, a MESSAGE context menu command (type 3). The user right-clicks a message, then Apps, then Ask Alactic. Message commands "don't take any arguments", and the interaction carries `data.target_id` plus the full message in `data.resolved.messages[target_id]`. The Message Content intent does not apply here: "Content of the message a message context menu command is used on" is a listed exception. This lets support staff point the agent at any customer's message, including attachments. **UNVERIFIED:** that `attachments` on the resolved message is populated without the intent. It falls under the "content of the message" exception, so it most likely is, but test it.
   - DMs: slash commands can be used in the bot DM if the command's `contexts` includes `BOT_DM` (1).
2. **Bring your own app (BYO).** The business creates a Discord application, sets our per-connection Interactions Endpoint URL, and pastes **Application ID, Public Key and Bot Token** into Alactic.
   - Pros: the bot carries the business's own name and avatar. No shared-app verification (verification is "required for apps in 100+ guilds", and a shared Alactic app would hit that quickly). Rate limits are isolated per business. One business's abuse cannot get the shared app flagged. No Discord OAuth flow to build.
   - Cons: about 10 minutes of setup in the Developer Portal, and we must store a bot token (encrypted, server-side). A bot token is a service credential, not a wallet private key, so it does not conflict with hard rule 5. Treat it like any other secret.
   - Alternative (later): one shared "Alactic" application with an install link (`scope=bot` with `guild_id`). Onboarding is one click, but every tenant shares one name and avatar, one endpoint and one rate-limit budget. Tenant routing would use `guild_id`, and we would need app verification after 100 servers. Revisit once the product is proven.
3. **Endpoint per connection:** `POST /api/connectors/discord/<connectionId>/interactions` (matches the Telegram connector convention). The connection ID tells us which public key to verify against before we parse anything.

## Setup steps the business must do (BYO)
1. https://discord.com/developers/applications, then **New Application**.
2. **General Information:** copy the **Application ID** and **Public Key**. After Alactic shows the endpoint URL, paste it into **Interactions Endpoint URL** (the docs label this field both "Interactive Endpoint URL" and "Interactions Endpoint URL") and save. Discord sends a PING immediately, and our endpoint must already verify signatures and answer PONG or the save fails.
3. **Bot:** reset or copy the **Bot Token** and paste it into Alactic. Leave all privileged intents off; we don't need them. Optionally untick **Public Bot** so that "only you can add the bot to guilds".
4. Alactic validates the token and registers commands (see Outbound).
5. Install to the server with the URL that Alactic generates:
   `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=<INT>`
   The `applications.commands` scope is "included by default with the `bot` scope". Adding `+applications.commands` explicitly is harmless.
   Suggested `permissions` = VIEW_CHANNEL (1<<10 = 1024) + SEND_MESSAGES (1<<11 = 2048) + EMBED_LINKS (1<<14 = 16384) + READ_MESSAGE_HISTORY (1<<16 = 65536) = **84992**. Interaction responses and follow-ups use the interaction webhook, so they need no channel permissions. These permissions are only for the optional "post into channel" path.

## Inbound

### Signature verification (every request, including PING)
- Headers: **`X-Signature-Ed25519`** (hex signature) and **`X-Signature-Timestamp`**.
- Message = `timestamp + rawBody` (string concatenation, raw bytes before JSON parsing). Verify with Ed25519 against the app's **Public Key** (hex). The doc's example is `verify_key.verify(f'{timestamp}{body}'.encode(), bytes.fromhex(signature))`.
- On failure return **401**. "you must validate the request each time you receive an interaction." Discord actively sends bad signatures as a test: "If you fail the validation, we will remove your interactions URL and alert you via email and System DM."
- Implementation note: Node's `crypto.verify(null, msg, publicKeyObject, sig)` supports Ed25519. Build the key from the 32-byte raw key, e.g. as SPKI DER. In Next.js read `await req.text()` **before** any JSON parsing.

### PING
`type: 1`, so return 200 with `{"type":1}` and `Content-Type: application/json` ("You must provide a valid `Content-Type` when responding to `PING`s").

### Interaction types
PING 1 · APPLICATION_COMMAND 2 · MESSAGE_COMPONENT 3 · APPLICATION_COMMAND_AUTOCOMPLETE 4 · MODAL_SUBMIT 5.

### Fields we need from the interaction object
`id`, `application_id`, `type`, `token` (continuation token), `data` (absent only on PING), `guild_id?`, `channel_id?`, `member?` (sent in guilds, includes `member.user`), `user?` (sent in DMs), `app_permissions`, `context` (GUILD 0 · BOT_DM 1 · PRIVATE_CHANNEL 2).
- `data.name`, `data.type` (1 = CHAT_INPUT, 3 = MESSAGE).
- `data.options[]`: `{ name, type, value }`. For an ATTACHMENT option, `value` is the attachment ID (snowflake string) used as the key into `data.resolved.attachments`.
- `data.resolved`: maps of `users`, `members`, `roles`, `channels`, `messages`, `attachments` ("Map of Snowflakes to attachment objects").
- `data.target_id`: message commands only.

### Response flow (the 3-second rule)
"you must send an initial response within 3 seconds of receiving the event. If the 3 second deadline is exceeded, the token will be invalidated." The agent takes 2–10 s, so:
1. Verify, then reply inline to the POST with **`{"type":5}`** = `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`. The user sees "Bot is thinking…". To make the eventual answer private, use `{"type":5,"data":{"flags":64}}` (EPHEMERAL = 1<<6; the only valid flag for type 5).
2. Enqueue an Inngest job carrying `application_id`, `token`, the question, attachment URLs and the connection ID. Don't log the question (hard rule 9).
3. In the job, run the agent and then edit the placeholder (see Outbound). The token is "valid for 15 minutes", so the job must finish within that window.

Other callback types for reference: PONG 1 · CHANNEL_MESSAGE_WITH_SOURCE 4 · DEFERRED_UPDATE_MESSAGE 6 · UPDATE_MESSAGE 7 · AUTOCOMPLETE_RESULT 8 · MODAL 9.

## Outbound
Base URL: `https://discord.com/api/v10` (v10 is "Available"; pin the version explicitly).
Auth header: `Authorization: Bot <token>`, or `Authorization: Bearer <token>` for client-credentials tokens.
User-Agent: "`DiscordBot ($url, $versionNumber)`". Requests without a valid UA "may be blocked".

| Purpose | Method + path | Auth |
|---|---|---|
| Initial response (if not inline) | `POST /interactions/{interaction.id}/{interaction.token}/callback` | token in path |
| Edit the deferred placeholder (our main reply) | `PATCH /webhooks/{application.id}/{interaction.token}/messages/@original` | token in path |
| Extra follow-up message | `POST /webhooks/{application.id}/{interaction.token}` | token in path |
| Delete original | `DELETE /webhooks/{application.id}/{interaction.token}/messages/@original` | token in path |
| Bulk overwrite global commands | `PUT /applications/{application.id}/commands` | Bot token |
| Bulk overwrite guild commands | `PUT /applications/{application.id}/guilds/{guild.id}/commands` | Bot token |
| Validate bot token / fetch app | `GET /applications/@me` ("Returns the application object associated with the requesting bot user"); check that its `id` equals the pasted Application ID ([source](https://docs.discord.com/developers/resources/application)) | Bot token |

- Interaction webhook endpoints: the docs' examples send no `Authorization` header, and the token in the path is the credential. Webhook "with Token" endpoints are documented as "does not require authentication". We should still send the User-Agent.
- Command registration accepts "a bot token or a client credentials token for your app with the `applications.commands.update` scope". With BYO we already hold the bot token, so use that. Bulk overwrite (PUT) is idempotent and replaces "all types of application commands", so call it on connect and whenever command definitions change.
- **Global vs guild commands:** guild commands "update instantly". For global commands the docs give no fixed propagation delay. MVP: register **global** commands with `contexts: [0, 1]` (guild + bot DM) and `integration_types: [0]` (guild install). Use guild commands only for instant testing in a dev server. Limits: 100 global CHAT_INPUT, 15 MESSAGE, 15 USER commands; "200 application command creates per day, per guild".
- Command shape (from documented fields):
  `{ name: "ask", type: 1, description: "Ask the support agent", options: [{ type: 3, name: "question", description: "...", required: true }, { type: 11, name: "file", description: "Optional image or audio", required: false }], contexts: [0,1] }`
  and `{ name: "Ask Alactic", type: 3 }` (message command names may be mixed case and contain spaces, and their description must be empty).
  - CHAT_INPUT names must match `^[-_ʼ\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$` and be lowercase. Descriptions are 1–100 chars. At most 25 options.
  - `default_member_permissions: "0"` hides a command from everyone except admins. That's useful if a business wants "Ask Alactic" (message command) limited to staff.

### Reply body
`{ "content": "<answer>\n\n<proof URL>", "allowed_mentions": { "parse": [] } }`.
- **Always** send `allowed_mentions.parse = []` so model output can't ping `@everyone` or roles (hard rule 7: treat output as untrusted).
- Alternatively put the proof link in an embed (`embeds: [{ title, url, description }]`). Plain content keeps it simple, and Discord auto-links URLs.

## Attachments
- Attachment object fields: `id`, `filename`, `content_type`, `size`, `url`, `proxy_url`, `duration_secs` (voice), `waveform` (voice), `flags`.
- Sources: `data.resolved.attachments[<id>]` (slash ATTACHMENT option) or `data.resolved.messages[target_id].attachments` (message command).
- Voice messages: message flag `IS_VOICE_MESSAGE` = 1<<13. "Only a single audio attachment is allowed. No content…". Use `content_type` to decide between transcription and image reading. **UNVERIFIED:** the exact audio container/MIME (believed to be Ogg/Opus). Sniff it rather than assume.
- Download: attachment CDN URLs "have signed URLs with a preset expiry time" (query params `ex` = expiry hex timestamp, `is` = issued, `hm` = signature). They are pre-signed, so the URL itself is the credential and no Authorization header is needed (inferred from the signing scheme; **UNVERIFIED** as an explicit statement). Download inside the job promptly. Never send the bot token to CDN hosts. Enforce our own size and type caps using `size` and `content_type` before downloading. Allowlist the host (`cdn.discordapp.com` / `media.discordapp.net`; **UNVERIFIED** exact host list) to avoid SSRF.

## Limits / rate limits
- `content` is up to **2000 characters**. Embeds: up to 10, title 256, description 4096, 25 fields, **6000 total** across all embeds. Truncate the answer to about 1800 chars and leave room for the proof link footer (embed description gives 4096 if needed).
- Rate-limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (epoch s), `X-RateLimit-Reset-After` (s), `X-RateLimit-Bucket`, `X-RateLimit-Global` (only on 429), `X-RateLimit-Scope` (`user` | `global` | `shared`). A 429 body includes `retry_after` (seconds) and `global`. Honour `retry_after` in the Inngest step retry.
- Global: "All bots can make up to 50 requests per second". "Interaction endpoints are not bound to the bot's Global Rate Limit."
- Invalid-request limit: **10,000 per 10 minutes** (401/403/429), which triggers a Cloudflare ban, so stop retrying on 401/403. A revoked token should mark the connection as broken.
- Follow-ups: "limited to 5 followup messages per interaction" for user-installed apps outside the server. Not our case, but we send one edit anyway.

## Gotchas
- Discord's only replay protection is the signed timestamp. We can also reject timestamps that are clearly stale (our own policy; Discord specifies no window). Dedupe on `interaction.id` in case the job is enqueued twice.
- Return the deferred response **inline** in the HTTP response, which is faster and simpler than calling `/callback`. Never wait for the agent inside the request.
- If the job fails, PATCH `@original` with a short error message so the user doesn't see "thinking…" forever. The token dies after 15 min.
- A business that already runs its own Gateway bot for this application can't also use HTTP interactions (the modes are mutually exclusive). They need a separate application.
- Message Content intent: we deliberately don't need it. If we ever add a Gateway worker for @mentions, the intent exceptions cover "Content in which the app is mentioned" and "Content in DMs with the app", and verified apps (100+ guilds) need intent approval.
- `member.user.id` (guild) vs `user.id` (DM): normalise into one `externalUserId`. Never trust displayed names in prompts.
- Never put the bot token, public key or prompts into ENS or manifests (hard rule 10).
