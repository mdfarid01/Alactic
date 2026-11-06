# Slack connector (research)

Status: research only. Nothing here is implemented yet. Everything below comes from the official docs listed under Sources (read 2026-11-07). Items marked **UNVERIFIED** were not confirmed in the official docs.

## Sources (read 2026-11-07)
Slack's developer docs now live at `docs.slack.dev`. Scope pages use dots in the URL slug (`/reference/scopes/app_mentions.read`), but the scope **string** is the colon form (`app_mentions:read`), as shown on those pages.
- Verifying requests (signing secret): https://docs.slack.dev/authentication/verifying-requests-from-slack
- Events API (envelope, 3 s, retries, rate limit, disabling): https://docs.slack.dev/apis/events-api/
- HTTP request URLs: https://docs.slack.dev/apis/events-api/using-http-request-urls
- `url_verification`: https://docs.slack.dev/reference/events/url_verification
- `app_mention`: https://docs.slack.dev/reference/events/app_mention
- `message.im`: https://docs.slack.dev/reference/events/message.im
- `message` event + subtypes: https://docs.slack.dev/reference/events/message
- `bot_message` subtype: https://docs.slack.dev/reference/events/message/bot_message
- `chat.postMessage`: https://docs.slack.dev/reference/methods/chat.postMessage
- `auth.test`: https://docs.slack.dev/reference/methods/auth.test
- Formatting (mrkdwn, links, escaping): https://docs.slack.dev/messaging/formatting-message-text
- Working with files: https://docs.slack.dev/messaging/working-with-files
- File object: https://docs.slack.dev/reference/objects/file-object
- OAuth install: https://docs.slack.dev/authentication/installing-with-oauth
- Distribution: https://docs.slack.dev/distribution/
- App Home (Messages tab): https://docs.slack.dev/surfaces/app-home
- App manifest reference: https://docs.slack.dev/reference/app-manifest
- Web API rate limits: https://docs.slack.dev/apis/web-api/rate-limits
- Non-Marketplace rate-limit change (2025-05-29): https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps

## Recommended MVP approach
**Bring your own app: the business creates a Slack app from a manifest that Alactic generates, installs it to its own workspace, and pastes the Bot Token (`xoxb-…`) and Signing Secret.**

- **Why BYO for the MVP:**
  - No OAuth flow to build.
  - No public distribution checklist and no Marketplace review.
  - The bot carries the business's own name.
  - Crucially, it avoids the **2025-05-29 rate-limit change**. For apps "commercially distributed outside of the Marketplace ('unlisted' apps)", `conversations.history` and `conversations.replies` dropped from Tier 3 to Tier 1, which means "1 request per minute and will return a maximum of 15 objects per request". The changelog states this does **not** apply to "internal customer-built apps". An app the business creates in its own workspace fits that description, so we keep normal limits if we later fetch thread context. (Whether an app built from a vendor-supplied manifest counts as "customer-built" is a terms question. **UNVERIFIED**, so confirm before relying on it.)
- **Cons of BYO:**
  - About 5 minutes of setup, which needs a workspace admin or a member allowed to install apps.
  - Each business has its own signing secret, so we need per-connection request URLs.
  - We store the bot token encrypted. It's a service credential, not a wallet key.
- **Later (distributed app):** one Alactic Slack app with **Activate Public Distribution**. That gets you "an embeddable **Add to Slack** button" without a Marketplace listing, but "apps intended for commercial distribution should be submitted and approved for listing in the Slack Marketplace". OAuth v2 flow:
  - `https://slack.com/oauth/v2/authorize?client_id=…&scope=<bot scopes>&redirect_uri=…&state=…` (redirect must be HTTPS).
  - Then `POST https://slack.com/api/oauth.v2.access` with `code`, `client_id`, `client_secret` and the same `redirect_uri`.
  - The response includes `access_token` (`xoxb-`), `token_type: "bot"`, `scope`, `bot_user_id`, `app_id`, `team{id,name}`, `enterprise`, `authed_user`.
  - Verify `state`: "If it doesn't match what you sent, consider the authorization a forgery."
  - Tenant routing then uses `team_id` / `api_app_id` from the event envelope, with one signing secret for all tenants.
- **Request URL per connection:** `POST /api/connectors/slack/<connectionId>/events`. The connection ID selects the signing secret. After verifying, also check that `api_app_id` and `team_id` match the stored connection.

## Setup steps the business must do (BYO)
1. In Alactic, start "Connect Slack". Alactic shows a manifest with the request URL filled in, plus a link to `https://api.slack.com/apps?new_app=1` (the manifest docs also show a `&manifest_yaml=` prefill variant).
2. **Create New App → From a manifest**, pick the workspace, then paste. Manifest fields (names verified in the manifest reference):
   ```json
   {
     "_metadata": { "major_version": 2, "minor_version": 1 },
     "display_information": { "name": "Acme Support" },
     "features": {
       "bot_user": { "display_name": "Acme Support", "always_online": true },
       "app_home": { "home_tab_enabled": false, "messages_tab_enabled": true, "messages_tab_read_only_enabled": false }
     },
     "oauth_config": { "scopes": { "bot": ["app_mentions:read", "chat:write", "im:history", "files:read"] } },
     "settings": {
       "event_subscriptions": {
         "request_url": "https://<app>/api/connectors/slack/<connectionId>/events",
         "bot_events": ["app_mention", "message.im"]
       },
       "org_deploy_enabled": false, "socket_mode_enabled": false, "token_rotation_enabled": false
     }
   }
   ```
   Slack sends the `url_verification` challenge to `request_url`, and "Your Event request URL must be confirmed before saving". Our endpoint must therefore already exist (with the signing secret pending) when the business creates the app. That's a chicken-and-egg problem: the secret isn't known until the app exists. **Plan:** for `url_verification` only, answer the challenge. It returns nothing sensitive. All other event types require a valid signature. If the URL verification fails, the business can hit **Retry** later in Event Subscriptions.
3. **Basic Information → App Credentials:** copy the **Signing Secret** into Alactic.
4. **Install App → Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`) into Alactic. (The "Install to Workspace" label is the familiar UI, but it is **UNVERIFIED** in the docs we read.)
5. Alactic calls `auth.test` to validate. With a bot token the response contains `team_id`, `user_id` (the bot's user ID) and `bot_id`. We store `bot_user_id`, `bot_id` and `team_id` with the connection.
6. Invite the bot into the channels where it should answer (`/invite @Acme Support`). `app_mention` is only delivered for conversations the app is in: "If your app is mentioned but isn't in the conversation and wasn't invited, you get no event."

## Inbound

### Signature verification (every request)
- Headers: **`X-Slack-Signature`**, **`X-Slack-Request-Timestamp`** (case-insensitive).
- Reject if `|now - timestamp| > 5 minutes` ("verify that the timestamp does not differ from local time by more than five minutes").
- basestring = `v0:` + timestamp + `:` + **raw body** ("before it has been deserialized"). Compute `HMAC-SHA256(signingSecret, basestring)` as hex, then compare `v0=<hex>` against the header with a constant-time compare (`crypto.timingSafeEqual`).
- In Next.js read `await req.text()` first, then `JSON.parse`.

### url_verification
Body `{ token, challenge, type: "url_verification" }` ("You can ignore the `token`… deprecated"). Reply 200 with the challenge as `text/plain`, as `application/x-www-form-urlencoded` `challenge=…`, or as JSON `{"challenge":"…"}`.

### Event envelope (`type: "event_callback"`)
`team_id`, `api_app_id`, `event` (inner), `event_id` ("globally unique across all workspaces"), `event_time`, `authorizations[]` (`enterprise_id`, `team_id`, `user_id`, `is_bot`, `is_enterprise_install`), `is_ext_shared_channel`, `event_context`, `context_team_id`. The `token` field is deprecated, so ignore it.

### Events and scopes
| Need | Bot event | Scope |
|---|---|---|
| @mention in a channel | `app_mention` | `app_mentions:read` |
| DM to the bot (App Home Messages tab) | `message.im` | `im:history` |
| Reply | — | `chat:write` |
| Download shared files | — | `files:read` |
- `app_mention` inner fields: `type`, `user`, `text` (contains `<@BOTID>`; strip it), `ts`, `channel`, `event_ts`. The example doesn't show `thread_ts` or `files`. **UNVERIFIED** that they are present when the mention is in a thread or carries files. Handle them if present.
- `app_mention` is **not** sent for DMs: "Messages sent to your app in direct message conversations are not dispatched via app_mention". That's why we also need `message.im`.
- `message.im` inner: `type: "message"`, `channel` (D…), `user`, `text`, `ts`, `channel_type: "im"`, `event_ts`. "Messages often include many more fields than those shown".
- Messages tab: "Your app needs the chat:write scope to use the Messages tab, and the im:history scope to respond to messages". Enable **App Home → Messages Tab**.
- Not needed for the MVP: `message.channels` (`channels:history`) would deliver *every* public-channel message. Avoid it; mentions are enough.

### 3-second ack and retries
- Respond 2xx "within three seconds". Otherwise the delivery counts as failed and is retried **up to 3 times**: almost immediately, then after 1 minute, then after 5 minutes.
- Retry headers: `x-slack-retry-num` (1–3) and `x-slack-retry-reason` (`http_timeout`, `too_many_redirects`, `connection_failed`, `ssl_error`, `http_error`, `unknown_error`).
- To stop retries for one event, return non-200 with **`x-slack-no-retry: 1`**.
- If >95% of deliveries in 60 min fail (SSL, >3 s, >2 redirects, non-2xx), subscriptions are **temporarily disabled**. Apps with fewer than 1,000 events/hour are exempt from auto-disable.
- **Our handler:** verify, filter, then dedupe on `event_id` by inserting a unique row, enqueue Inngest, and return `200` immediately (empty body). A retried `event_id` is acked with 200 and dropped.

### Loop / duplicate prevention
- Ignore any event where `event.bot_id` is present, or `event.user === connection.bot_user_id`. The docs say: "you can detect if a message was sent by a bot by the presence of the `bot_id` and `bot_profile` fields". Whether our own `chat.postMessage` posts arrive with `subtype: "bot_message"` or only with `bot_id` is not documented (**UNVERIFIED**), so check `bot_id` rather than the subtype.
- Ignore `subtype` values other than none and `file_share` (e.g. `message_changed`, `message_deleted`, `channel_join`, `thread_broadcast`). `file_share` means "A file was shared into a channel" and carries the user's files.
- Dedupe on `event_id`. As a second guard, dedupe on `(team_id, channel, ts)`.
- Don't answer other bots at all (prevents bot-to-bot ping-pong).

## Outbound
`POST https://slack.com/api/chat.postMessage` with `Authorization: Bearer xoxb-…` and `Content-Type: application/json; charset=utf-8`. The docs say the token "should be passed as an HTTP Authorization header". The Bearer scheme is used across the files docs; **UNVERIFIED** wording on this page specifically.
```json
{ "channel": "<event.channel>", "thread_ts": "<event.thread_ts || event.ts>",
  "text": "<answer>\n\n<https://<app>/proof/<id>|Proof receipt>",
  "unfurl_links": false, "unfurl_media": false }
```
- `thread_ts`: "Provide another message's `ts` value to make this message a reply". For channel mentions, reply in the thread. For DMs, replying top-level is fine.
- `mrkdwn` is enabled by default. Links: `<https://url|label>`. Escape `&`, `<`, `>` in model output as `&amp;`, `&lt;`, `&gt;`, which also stops model output from injecting `<!channel>` or `<@U…>` mentions (hard rule 7).
- Response: `{ ok, channel, ts, message }`. Errors include `not_in_channel`, `channel_not_found`, `msg_blocks_too_long`, and `ratelimited` ("Refer to the `Retry-After` header"). Slack returns HTTP 200 with `ok:false` for most errors, so always check `ok`. Map `invalid_auth` / `account_inactive` / `token_revoked` to "connection broken" (**UNVERIFIED** exact error names beyond `invalid_auth` seen in auth.test).
- Optional UX: post a short "Looking into it…" message and later `chat.update` it. **UNVERIFIED** (we didn't read `chat.update`). The MVP simply posts once when done.

## Attachments (voice clips, images)
- Files arrive in message events as a `files` array (subtype `file_share`). **UNVERIFIED** for `app_mention` payloads; see above.
- File object fields: `id`, `name` (may be null), `mimetype`, `filetype` ("do not have a 1-to-1 mapping" with mimetype), `size`, `mode` (`hosted` | `external` | `snippet` | `post`), `is_external`, `url_private`, `url_private_download`, `subtype` ("File subtype"; values like `slack_audio` are **UNVERIFIED**), `duration_ms`, `transcription` ("Transcription data for audio/video files"; structure **UNVERIFIED**), media URLs `mp4`, `hls`, `aac`, `vtt`, and thumbnails `thumb_360`/`thumb_480`/`thumb_720`/`thumb_1024`.
- Download: `GET url_private` (or `url_private_download`) with **`Authorization: Bearer xoxb-…`**, which needs **`files:read`**. Thumbnails need the same header.
- **Security:** "Only send this header to a Slack file host." If `is_external` is true or `mode: "external"`, then `url_private` is an app-supplied external URL. "Never send Slack credentials to that URL." Only attach the token when the URL host is `files.slack.com` (host seen in the docs' example). Skip external files for the MVP.
- Slack Connect files can arrive with `"file_access": "check_file_info"`, meaning "further action is required" to read metadata (presumably `files.info`, which `files:read` covers; **UNVERIFIED** that this is the required call). MVP: skip those files and tell the user.
- Pick images by `mimetype` `image/*`. For audio, use `mimetype` `audio/*` or `video/*`, or the `aac`/`mp4` URLs. Enforce size caps from `size` before downloading.

## Limits / rate limits
- `text`: "limit the `text` field to 4,000 characters". Over 40,000 chars is truncated (`message_truncated` warning). Truncate answers to about 3,800 chars and leave room for the proof link.
- `chat.postMessage`: special tier. "1 message per second per channel", with bursts allowed.
- Web API tiers: T1 1+/min, T2 20+/min, T3 50+/min, T4 100+/min. HTTP **429** with **`Retry-After`** (seconds). `auth.test` allows "hundreds of requests per minute".
- Events: max 30,000 deliveries per workspace per app per 60 min. Beyond that, `app_rate_limited` events are sent.
- `conversations.replies` / `conversations.history` (only if we add thread context): Tier 1, 15 objects, for *new non-Marketplace distributed* installs since 2025-05-29. See the MVP rationale above.

## Gotchas
- The signing secret differs per app, so verify the signature *before* trusting `team_id`. Then cross-check `api_app_id` and `team_id` against the connection.
- Never do agent work in the request. Slack's 3 s limit plus auto-disable makes the queue mandatory.
- Retries arrive with the same `event_id`. Without dedupe the agent answers twice (and bills 0G twice).
- An @mention in a channel the bot isn't in produces no event. Tell the business to `/invite` the bot.
- `text` contains Slack markup (`<@U…>`, `<#C…|name>`, `<url|label>`). Normalise it before sending to the model, and don't log it (hard rule 9).
- Token rotation is off in our manifest (`token_rotation_enabled: false`). If a business turns it on, `xoxb` tokens expire and we would need refresh handling. Out of scope.
- Never publish the bot token or signing secret, or put them in ENS or manifests (hard rule 10).
