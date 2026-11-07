# WhatsApp (Meta WhatsApp Business Platform, Cloud API)

Research notes, verified against official Meta docs on 2026-11-07. Research only; nothing is implemented yet.
Anything marked **UNVERIFIED** has to be checked again before we build on it.

## Sources

Meta now serves the WhatsApp docs at `developers.facebook.com/documentation/business-messaging/whatsapp/...`. Every page also has a raw markdown version: append `.md` to the URL. The index is at `.../whatsapp/llms.txt`.

| Topic | URL |
| --- | --- |
| Webhook endpoint (GET verification, POST signature, retries) | https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint |
| Webhooks overview (fields, 3 MB payloads, retries up to 7 days) | https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview |
| Inbound text / audio / image / status payloads | https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text (also `/audio`, `/image`, `/status`) |
| Send text message | https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages |
| Service messages and the customer service window | https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages |
| Media (get URL, download, types, sizes) | https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media |
| Mark as read | https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/mark-message-as-read |
| Access tokens | https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens |
| Throughput | https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput |
| Rate limits (incl. pair rate limit) | https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform#rate-limits |
| Error codes | https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes |
| Business-scoped user IDs (BSUID) | https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids |
| Webhook callback override per WABA / phone number | https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override |
| Get started (test number, temporary token) | https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started |

**Graph API version:** the current examples use `v27.0`, which is also the highest version in the Graph API changelog (https://developers.facebook.com/docs/graph-api/changelog/). Store the version in config (for example `WHATSAPP_GRAPH_VERSION=v27.0`) rather than hardcoding it everywhere.

**Terminology change:** Meta now separates the **WhatsApp account (WAAC)**, which holds phone numbers and the display name, from the **Messaging account**, which holds templates and billing. Older docs and the payload (`entry[].id` = `<WHATSAPP_BUSINESS_ACCOUNT_ID>`) still use "WABA". For us, "WABA ID" means the id that arrives in `entry[].id`.

## Recommended MVP approach

- **The business brings its own Meta app.** The business creates a Meta Business app, adds WhatsApp, creates a System User token, and gives us: `phone_number_id`, WABA id, the System User access token, and the **App Secret**. We generate a random `verify_token` for them.
- **One webhook URL per connection**, for example `https://<app>/api/integrations/whatsapp/<connectionId>`. Each business has its own Meta app and therefore its own App Secret, so we need to know which secret to check the signature against before we trust the body. The connection id in the path tells us. After the signature checks out, we also confirm that `value.metadata.phone_number_id` matches the stored connection.
- The webhook handler must be fast: verify the signature, persist or enqueue (dedupe on `messages[].id`), and return `200` immediately. Meta's latency target is a median of 250 ms or less, with under 1% of requests over 1 s. The agent run (2–10 s) happens in the job queue, which then calls the Send API.
- **We only reply to user-initiated messages inside the 24 h window, as free-form text.** No templates in the MVP.
- Later, if we become a Tech Provider: Embedded Signup plus Business Integration System User tokens, a single app-level webhook, and routing by `phone_number_id`. Out of scope for the MVP.

## Setup steps the business must do

1. Have a **Meta business portfolio** and a **Meta developer account**.
2. Create a **Business** app in the App Dashboard (https://developers.facebook.com/apps) and add the WhatsApp product (or the "Connect with customers through WhatsApp" use case). This automatically creates a **test WhatsApp account, a test Messaging account, and a test business phone number**. Test numbers have relaxed limits and need no payment method. In the get-started flow, you add your own phone as a recipient for testing.
3. In **App Dashboard > WhatsApp > API Setup**, copy the **Phone number ID** and the **WhatsApp Business Account ID**. "Generate access token" here creates a **temporary** user token. Docs: it "expires quickly", so it is fine for a first test only.
4. Create a **permanent token**: Business Settings (https://business.facebook.com/settings) > **System users** > Add (Admin or Employee role) > Assign assets (the app, with **Manage app** / full control). Employee system users also need Partial or Full access to **both** the WhatsApp account and the Messaging account. Then click **Generate token**, choose an expiry preference (Never, for the MVP), and grant:
   - `whatsapp_business_messaging`: needed for the `messages` webhook field and for sending.
   - `whatsapp_business_management`: needed for other fields and for WABA management calls such as `subscribed_apps`.
5. Copy the **App Secret**: App Dashboard > App settings > Basic > App secret.
6. In **App Dashboard > WhatsApp > Configuration** (or **Use cases > Customize > Configuration**), set **Callback URL** to our per-connection URL and **Verify token** to the value we generated. Then **subscribe to the `messages` field**.
7. Real numbers: add and register a business phone number and a payment method. The app must be in **Live** mode for production webhooks; per the troubleshooting notes, check this if webhooks don't arrive.
8. **UNVERIFIED for BYO apps:** the WABA may also need the app subscribed via `POST /{WABA_ID}/subscribed_apps`. This endpoint is documented (rate-limit table and the override doc), but the docs we read only explicitly require it for partner/Tech Provider flows. The UI says the app receives webhooks once fields are subscribed in the dashboard. Test this with a real number.

## Inbound

### Verification handshake (GET)

Meta sends this whenever the Callback URL or Verify token is saved:
```
GET <CALLBACK_URL>?hub.mode=subscribe&hub.challenge=<random>&hub.verify_token=<our token>
```
If `hub.verify_token` matches the stored token (use a constant-time compare) and `hub.mode === "subscribe"`, respond `200` with the raw `hub.challenge` value as the body. Otherwise return 4xx. Note that the parameter names contain a dot (`hub.mode`), so read them with `searchParams.get("hub.mode")`.

### Signature (POST)

Header format: `X-Hub-Signature-256: sha256=<hex>`. The hex value is the HMAC-SHA256 of the **raw request body**, keyed with the **App Secret**. Compare it with the part after `sha256=`. In a Next.js route, read `await req.text()` **before** calling `JSON.parse`. If the signature is invalid, reject with a non-200 status.

Also documented:
- Respond `200` to every valid request.
- Payloads can be up to 3 MB.
- Batching: a POST can hold up to 1000 updates, so iterate over every `entry[]`, `changes[]`, and `messages[]`. Batching is not guaranteed.
- Failed deliveries are retried immediately, then with decreasing frequency for **7 days**, and duplicates are possible. **Dedupe on `messages[].id` (`wamid...`)** with a unique constraint.
- There is no API for historical webhooks, so persist what we need.
- Meta recommends mTLS over IP allowlisting (optional).

### Payload (field `messages`)

```jsonc
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<WABA_ID>",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "15550783881", "phone_number_id": "<PHONE_NUMBER_ID>" },
        "contacts": [{ "profile": { "name": "...", "username": "..."? }, "wa_id": "<phone>"?, "user_id": "<BSUID>" }],
        "messages": [{
          "from": "<user phone>"?,          // may be OMITTED (username users)
          "from_user_id": "<BSUID>",        // always present - use as user key
          "id": "wamid....",                // dedupe key; also used for mark-as-read
          "timestamp": "<unix seconds as string>",
          "type": "text" | "audio" | "image" | "video" | "document" | "sticker" | "location" | "reaction" | "interactive" | "button" | "unsupported" | ...,
          "text":  { "body": "..." },
          "audio": { "mime_type": "audio/ogg; codecs=opus", "sha256": "...", "id": "<MEDIA_ID>", "url": "https://lookaside.fbsbx.com/...", "voice": true },
          "image": { "caption": "...", "mime_type": "image/jpeg", "sha256": "...", "id": "<MEDIA_ID>", "url": "..." }
        }]
      }
    }]
  }]
}
```

- **Identity: `from` and `wa_id` can be omitted.** If a user has adopted a WhatsApp username and their phone number is unavailable, those fields are missing. Meta's warning says to use `from_user_id` and `user_id` (the BSUID, for example `US.13491208655302741918`). Store the BSUID as the end-user key, plus the phone number when present. To reply to a BSUID, send `"recipient": "<BSUID>"` instead of `"to"`. If both are present, `to` wins.
- `audio.voice: true` means the clip was recorded with WhatsApp's voice-note feature.
- `audio.url` and `image.url` are being rolled out gradually from 2025-11-12, so they may be missing. Fall back to `GET /{media-id}`.
- **Status updates to ignore:** when `value` contains `statuses[]` instead of `messages[]` (each with `id`, `status`, `timestamp`, `recipient_id`, `recipient_user_id`, ...), it describes our own outbound messages (sent, delivered, read, failed, played). ACK with 200 and drop them. You could log `status === "failed"` and its `errors` for diagnostics, but **don't log message content**.
- For other `type` values (location, sticker, reaction, unsupported, ...), ACK and send at most a short "I can only read text, voice notes and images" reply.

## Outbound

### Send a text reply

```
POST https://graph.facebook.com/v27.0/<PHONE_NUMBER_ID>/messages
Authorization: Bearer <SYSTEM_USER_ACCESS_TOKEN>
Content-Type: application/json

{ "messaging_product": "whatsapp", "recipient_type": "individual",
  "to": "<user phone e.g. +16505551234>",        // or "recipient": "<BSUID>"
  "type": "text",
  "text": { "preview_url": false, "body": "<answer>\n\nProof: https://<app>/proof/<id>" } }
```
- `text.body` can be at most **4096 characters**. The client auto-links URLs, so our proof-receipt URL becomes clickable. `preview_url: true` renders a preview of the **first** URL only. Use `false` so the proof link isn't turned into a large card. That is a product choice; either value is valid.
- Response: `{"messaging_product":"whatsapp","contacts":[{"input":"+1650...","wa_id":"1650..."}],"messages":[{"id":"wamid..."}]}`. When sent via `recipient`, `contacts` returns `input` and `user_id` and omits `wa_id`. Store `messages[0].id`.
- Optional quoting: send a contextual reply (see the "Contextual replies" doc). Not verified in detail; not needed for the MVP.

### Mark as read (optional, nice UX)

```
POST https://graph.facebook.com/v27.0/<PHONE_NUMBER_ID>/messages
{ "messaging_product": "whatsapp", "status": "read", "message_id": "wamid..." }
→ { "success": true }
```
This also marks earlier messages in the conversation as read. It must be sent within 30 days. An invalid id returns error `131009`. A typing indicator also exists in newer docs; **UNVERIFIED**, not researched.

### 24-hour customer service window

- When a user messages (or calls) the business, a 24 h window opens. Each further user message resets it to 24 h. While it is open, any free-form "service message" (text, media, ...) is allowed. After it closes, only pre-approved **template messages** can be sent.
- If you send outside the window, you get error **`131047`** ("More than 24 hours have passed since the recipient last replied"). Our job runs within seconds, so this only matters for long queue delays or human-escalation follow-ups. On `131047`, mark the job failed. Do **not** fall back to a template automatically, because templates cost money and need approval (hard rule 8).
- Docs note a known issue: "In rare cases, you may receive a message from a WhatsApp user but be unable to respond within the customer service window."

## Attachments / media

1. Use `audio.url` or `image.url` from the webhook if present. Otherwise call `GET https://graph.facebook.com/v27.0/<MEDIA_ID>?phone_number_id=<PHONE_NUMBER_ID>` with `Authorization: Bearer <token>`. The response is `{messaging_product, url, mime_type, sha256, file_size, id}`. `phone_number_id` is optional; when set, it ensures the media belongs to that number.
2. `GET <url>` with the **same `Authorization: Bearer <token>` header**. Without the token, the download fails. The response is binary, and the `Content-Type` header gives the MIME type.
3. **Expiry:** media URLs expire after **5 minutes**, so re-query the id if needed. Media ids from webhooks are downloadable for **7 days**. A `404` on download means: get a fresh URL, then if it still fails, check the token.
4. Verify the `sha256`, which is base64 in the examples, against the downloaded bytes (optional integrity check).

Supported types and size limits (from the Media doc; these are the send-side "supported media types", and inbound media follow the same types):

| Kind | Types | Max |
| --- | --- | --- |
| Audio | `audio/aac`, `audio/amr`, `audio/mpeg`, `audio/mp4`, `audio/ogg` (**OPUS codec only**, mono) | 16 MB |
| Image | `image/jpeg`, `image/png`, static `image/webp` (8-bit RGB/RGBA) | 5 MB |
| Video | `video/mp4`, `video/3gpp` | 16 MB |
| Document | pdf, txt, doc(x), xls(x), ppt(x) | 100 MB |

Voice notes arrive as `audio/ogg; codecs=opus` (from the webhook example), so the transcription pipeline must accept OGG/Opus. Cloud API caps inbound media at 100 MB. Larger files trigger a webhook error **`131052`**. Even so, we should enforce our own smaller cap (for example 16 MB for audio, 5 MB for images) before downloading, using the `file_size` returned by `GET /{media-id}`.

## Limits

- **Throughput:** 80 messages/s per business phone number by default, automatically upgraded to 1000 mps for eligible numbers. Exceeding it returns error `130429`. Numbers shared with the WhatsApp Business app are fixed at 20 mps.
- **Pair rate limit:** 1 message every 6 s to the **same user** (about 10/min). Bursts of up to 45 in 6 s are allowed but borrow against future quota. Exceeding it returns error `131056`. Meta's advice: retry after 4^X seconds. So **send one combined reply per answer** rather than splitting it into several messages.
- **Graph API request limits (WABA management endpoints):** 200 req/h per app per Messaging account, or 5000 req/h for active accounts with a registered number. These don't affect sending messages.
- Text body max 4096 characters. If we must split, mind the pair limit.
- Webhook payloads are at most 3 MB. Webhook servers should handle 3× outbound plus 1× inbound volume, with concurrent requests.
- Expired or invalid token: error `190`.

## Gotchas

- **Read the raw body before parsing** or the HMAC will not match. Never log the body (hard rule 9). Log only the `wamid` and the type.
- Return 200 quickly and process asynchronously. Slow or non-200 responses trigger retries for up to 7 days, which means duplicate agent runs unless we dedupe on `wamid`.
- **Use the BSUID (`from_user_id`) as the user key.** `from` and `wa_id` can be missing.
- Ignore `statuses[]` payloads and messages whose `metadata.phone_number_id` doesn't match the connection.
- Temporary dashboard tokens expire within hours. Require a System User token and validate it at connect time, for example with `GET /v27.0/<PHONE_NUMBER_ID>` (**UNVERIFIED** as a validation call; it is the documented phone-number node used for `?fields=throughput`).
- The App Secret and access token are secrets: encrypt them at rest, keep them server-only, and never put them in `NEXT_PUBLIC_*`.
- Inbound messages and media are untrusted input to the agent (hard rule 7). Image captions and transcripts count as user content.
- Test numbers can only message recipients the developer has added in API Setup.
- Meta has `smb_message_echoes` and `message_echoes` webhooks for numbers shared with the WhatsApp Business app. We don't subscribe to them, so our own replies don't come back as `messages[]`.
