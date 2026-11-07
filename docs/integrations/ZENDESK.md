# Zendesk

Research notes, verified against official Zendesk docs on 2026-11-07. Research only; nothing is implemented yet.
Anything marked **UNVERIFIED** has to be checked again before we build on it.

## Sources

| Topic | URL |
| --- | --- |
| Auth: OAuth, global OAuth, API tokens (deprecated) | https://developer.zendesk.com/api-reference/introduction/security-and-auth/ |
| **API token retirement and OAuth migration** (timeline, client-credentials flow, token lifetimes) | https://developer.zendesk.com/documentation/authentication/oauth-migration/ |
| OAuth token grant types and scopes (`tickets:read`, `tickets:write`, ...) | https://developer.zendesk.com/api-reference/ticketing/oauth/grant_type_tokens/ |
| Global OAuth client (required for multi-customer integrations) | https://developer.zendesk.com/documentation/marketplace/building-a-marketplace-app/set-up-a-global-oauth-client/ |
| Webhooks API (create, signing secret) | https://developer.zendesk.com/api-reference/webhooks/webhooks-api/webhooks/ |
| Verifying webhook signatures | https://developer.zendesk.com/documentation/webhooks/verifying/ |
| Creating webhooks, connecting them to triggers, retries, circuit breaker | https://developer.zendesk.com/documentation/webhooks/creating-and-monitoring-webhooks/ |
| Trigger conditions reference | https://developer.zendesk.com/documentation/ticketing/reference-guides/conditions-reference/ |
| Via types (`web_service` = 5) | https://developer.zendesk.com/documentation/ticketing/reference-guides/via-types/ |
| Placeholders (`{{ticket.id}}` ...) | https://support.zendesk.com/hc/en-us/articles/4408886858138 |
| Tickets API (Update Ticket) | https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/ |
| Ticket Comments API | https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_comments/ |
| Attachments | https://developer.zendesk.com/api-reference/ticketing/tickets/ticket-attachments/ |
| Rate limits | https://developer.zendesk.com/api-reference/introduction/rate-limits/ |
| Support API OpenAPI spec (used to confirm field names) | https://developer.zendesk.com/zendesk/oas.yaml |
| Messaging: Switchboard | https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/switchboard/ |
| Messaging: receiving / sending messages | https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/receiving-messages/ , .../sending-messages/ |
| Conversations API auth | https://developer.zendesk.com/documentation/conversations/getting-started/api-authentication/ |

## Critical findings (these change the original plan)

1. **API tokens are being retired.** From the migration guide:
   - **2026-07-28:** new accounts can't create or use API tokens, and tokens unused for 30 days are deactivated.
   - **2026-10-27 (already passed):** existing accounts can **no longer create new API tokens**.
   - **2027-04-30:** all API tokens are permanently deactivated.

   So `{email}/token:{api_token}` basic auth is **not viable** for onboarding new businesses. Use **OAuth access tokens** (`Authorization: Bearer <token>`).
2. **Zendesk forbids customers from sharing credentials with a multi-customer integration.** Quote: "If you plan on distributing an app, integration, or bot to multiple Zendesk customers, you must use global OAuth tokens … the Zendesk Developer Terms prohibits Zendesk customers from sharing their API credentials with you". This doesn't apply to integrations built "for internal use".

   A "business brings its own credentials" model is therefore against the Developer Terms for Alactic as a SaaS. The compliant path is a **global OAuth client**, which only Zendesk can create:
   - Build a local client whose identifier starts with `zdg-` on a sponsored `d3v-` developer account.
   - Request conversion in the Marketplace portal (apps.zendesk.com > Global OAuth).
   - Zendesk fixes the allowed scopes. No approval time is published.

## Recommended MVP approach

**Option A (Support API + webhook + trigger), with OAuth.**

- **Production / compliant path:** apply for a global OAuth client **now**, since lead time is unknown. Each business then connects through the authorization-code flow:
  - Redirect to `https://{subdomain}.zendesk.com/oauth/authorizations/new`, with our `redirect_uri`, `scope=tickets:read tickets:write` and `state`.
  - Exchange the code at `POST https://{subdomain}.zendesk.com/oauth/tokens` with `grant_type=authorization_code`, `code`, `client_id`, `client_secret`, `redirect_uri`, `scope`. PKCE (`code_verifier`) is required for public clients only.
  - Access tokens last **30 min** by default (`expires_in` can be set from 5 min to 48 h). Refresh tokens last **30 days** (7–90 via `refresh_token_expires_in`). Clients created before 2026-04-30 must set `expires_in` explicitly to receive refresh tokens.
  - **Refresh rotates both tokens, and the old ones die immediately.** Persist the new pair atomically and serialize refreshes per connection with a lock.
- **Interim / pilot path (founder decision required):** while the global client is pending, a pilot customer can create a **local OAuth client** in their Admin Center and give us `client_id` and `client_secret`. We then use **client credentials**:
  - `POST https://{subdomain}.zendesk.com/oauth/tokens` with `grant_type=client_credentials&client_id=..&client_secret=..&scope=tickets:read tickets:write`.
  - Response: `{access_token, token_type:"bearer", scope, expires_in:1800}`. There is no refresh token, so re-request on expiry or on a 401 `invalid_token`.
  - Actions are **attributed to the user who created the OAuth client**. Zendesk recommends a dedicated service account (for example "Alactic AI" agent).
  - **Risk:** this is credential sharing, which the Developer Terms prohibit for multi-customer integrations. Acceptable only as an explicitly labelled pilot or design-partner arrangement, if the founder approves (CLAUDE.md: "Ask before major architectural changes").
- The webhook handler verifies the signature, enqueues `{connectionId, ticketId}` with dedupe, and returns 200 within the **12 s** webhook timeout. A job then fetches comments, runs the agent, and `PUT`s a public comment.

**Option B (Zendesk messaging / Sunshine Conversations)** is not recommended for the MVP (see below).

## Setup steps the business must do (Option A)

1. Have a Zendesk Support plan with webhooks and triggers. Trial accounts are limited to 10 webhooks. Note the subdomain (`{subdomain}.zendesk.com`).
2. Auth, choose one:
   - **(global OAuth)** click "Connect Zendesk" in Alactic and approve as an admin, or
   - **(pilot)** Admin Center > Apps and integrations > APIs > OAuth clients: create a confidential client owned by a dedicated "Alactic AI" agent user, with allowed scopes `tickets:read tickets:write`, and paste the identifier and secret into Alactic. Exact Admin Center menu label **UNVERIFIED**.
3. Create a **webhook**: Admin Center > Apps and integrations > Webhooks, or `POST /api/v2/webhooks`. Settings:
   - endpoint: our per-connection URL `https://<app>/api/integrations/zendesk/<connectionId>`
   - `http_method: POST`, `request_format: json`
   - **connect to trigger/automation**, i.e. `subscriptions: ["conditional_ticket_events"]`
   - optional `authentication: {type: "bearer_token", data: {token}, add_position: "header"}` with a per-connection token we generate. The exact JSON shape of `authentication` is **UNVERIFIED**; the docs list the `basic_auth`, `bearer_token` and `api_key` types.

   Then copy the **signing secret** (webhook details > "Reveal secret") and paste it into Alactic.
4. Create a **trigger** with action "Notify webhook". The API field is `notification_webhook: ["<webhook_id>", "<json body>"]`. Body:
   `{"ticket_id": "{{ticket.id}}", "via": "{{ticket.via}}", "updater_email": "{{current_user.email}}"}`.
   Don't put comment text in the payload; we fetch it via the API (less data in transit, and the API is authoritative).
5. Trigger conditions (meet ALL):
   - `update_type` is `Create` or `Change` (use two triggers or an ANY block),
   - `comment_is_public` = `true`,
   - **`current_via_id` is_not `5`** (5 = `web_service`, i.e. updates made via the API, which includes our own replies),
   - `requester_role` is `end-user` (optional),
   - `current_tags` not_includes `alactic_handoff` (our human-escalation tag; optional, for escalated tickets).

   The UI condition "Current user is (end user)" would be the cleanest loop guard, but its API name was not found in the conditions reference: **UNVERIFIED**.

## Inbound

### Signature verification

Headers: `X-Zendesk-Webhook-Signature` and `X-Zendesk-Webhook-Signature-Timestamp`.

Expected value = `base64(HMAC_SHA256(key = signing_secret, message = timestamp + rawBody))`, i.e. the timestamp string concatenated directly with the raw body. Compare in constant time.

- Read `req.text()` before parsing.
- Reject stale timestamps; the tolerance is our own choice (for example 5 min), not specified by Zendesk.
- While testing a webhook *before it is created*, Zendesk signs with the static test secret `dGhpc19zZWNyZXRfaXNfZm9yX3Rlc3Rpbmdfb25seQ==`.
- The signing secret can also be fetched via `GET /api/v2/webhooks/{webhook_id}/signing_secret`, which returns `{"signing_secret":{"algorithm":"SHA256","secret":"..."}}` (admin only; requires an admin-level token). We could automate webhook and trigger creation once we hold an admin OAuth token, but the required scopes are **UNVERIFIED**, so keep this manual for the MVP.

### Payload

Whatever the trigger body template defines. Placeholders render as plain text, so `ticket_id` arrives as a string; parse it as an integer and validate it.

### Reading the latest requester comment

`GET https://{subdomain}.zendesk.com/api/v2/tickets/{ticket_id}/comments` (agents only, up to 100 per page). Sorting:
- cursor pagination: `sort=-created_at` for newest first;
- offset pagination: `sort_order=desc`.

Comment fields (confirmed in the OpenAPI spec): `id`, `type` (`Comment`|`VoiceComment`), `body`, `html_body`, `plain_body`, `public`, `author_id`, `attachments[]`, `via`, `created_at`, `metadata`.

Pick the newest comment where `public === true` **and `author_id !== ourBotUserId`**, which is the second loop guard. Look up `ourBotUserId` once via `GET /api/v2/users/me` (**UNVERIFIED** in this research pass). Optionally include earlier public comments as conversation context.

## Outbound

```
PUT https://{subdomain}.zendesk.com/api/v2/tickets/{ticket_id}
Authorization: Bearer <oauth access token>
Content-Type: application/json

{"ticket": {"comment": {"body": "<answer>\n\nProof: https://<app>/proof/<id>", "public": true}}}
```
- Comments can only be added through Update Ticket; there is no create endpoint in the Comments API.
- Use `html_body` instead of `body` for HTML. Markdown in `body` renders only for agent authors.
- `author_id` is optional and defaults to the authenticated user. If set, the API user is still recorded as the updater.
- **Always send `public` explicitly.** The spec says the initial value "persists for any additional comment unless you change it".
- Optional fields: `status` (`new|open|pending|hold|solved|closed`), and `safe_update: true` with `updated_stamp` to avoid collisions (a collision returns 409).
- For human hand-off, post an internal note (`"public": false`), add the tag `alactic_handoff`, and set status `open`. Exact tag-add semantics (`tags` replaces the list; `additional_tags` adds) are **UNVERIFIED** in this pass.
- Response 200: `{ticket: {...}, audit: {events: [...]}}`. Store the comment id from the audit events (shape **UNVERIFIED**).
- `.json` suffix: older docs use `/tickets/{id}.json`, while the current reference uses `/api/v2/tickets/{ticket_id}`. Use the latter.

## Attachments / media

- `attachments[]` on each comment: `id`, `file_name`, `content_url`, `mapped_content_url`, `content_type`, `size` (bytes), `inline`, `malware_scan_result` (`malware_found|malware_not_found|failed_to_scan|not_scanned`), `malware_access_override`.
- Set `include_inline_images=true` on the comments call to also list inline images.
- Download from `content_url`. Once a file is attached to a ticket, only users with access to that ticket can see it. Send the OAuth bearer token **only if the host is `{subdomain}.zendesk.com`**. The docs warn that content URLs "may point to externally hosted files" and not to leak credentials to third parties. Follow redirects **without** forwarding `Authorization` to other hosts. Whether the bearer token is accepted on `content_url`: **UNVERIFIED**, test it.
- Skip any attachment whose `malware_scan_result !== "malware_not_found"`, and enforce our own size cap from `size` before downloading.
- No attachment size limit is stated in the API docs.

## Limits

- Support API requests per minute, by plan: Team 200, Growth/Professional 400, Enterprise 700, High Volume add-on / Enterprise Plus 2,500.
- **Update Ticket:** 30 updates per 10 min per user per ticket, and 100 req/min per account (300 with High Volume).
- On 429, wait for the `Retry-After` value (seconds). Headers to watch: `X-Rate-Limit-Remaining`, `ratelimit-remaining`, `ratelimit-reset`, `Zendesk-RateLimit-tickets-update`.
- **Webhooks:**
  - 12 s timeout, retried up to 5 times on timeout.
  - 409 is retried up to 3 times. 429 and 503 are retried only if `retry-after` < 60 s.
  - Circuit breaker: 70% errors or more than 1000 errors in 5 min (only once at least 100 requests are sent) pauses delivery, then probes every 5 s.
  - Invocation history is kept for 7 days.
- Dedupe: the webhook has no delivery id. Dedupe in the job on `(ticket_id, latest end-user comment id)` so a retry or a duplicate trigger never answers the same comment twice.

## Option B: Zendesk messaging (Sunshine Conversations)

- Messaging (Web Widget/SDK chat, plus social channels such as WhatsApp routed through Zendesk) runs on the Sunshine Conversations platform at `https://{subdomain}.zendesk.com/sc/v2/...`.
- A third-party bot **can** respond:
  1. Create a Conversations integration (custom webhook) in Admin Center, or via the Create Integration API (type `custom`).
  2. Add it to the **Switchboard** (Create Switchboard Integration API) and make it the default responder, or receive control via `passControl`.
  3. Receive `conversation:message` webhooks and ignore events with `payload.message.author.type === "business"`. Only reply when our integration is the `activeSwitchboardIntegration`.
  4. Reply with `POST /sc/v2/apps/{app_id}/conversations/{conversation_id}/messages` and `"author": {"type": "business"}` plus a `content` object (`type: "text"`, `text`).
  5. Escalate to humans via `passControl` to `zd-agentWorkspace`.
- Auth uses a Conversations API key (app- or integration-scoped): Basic `key_id:secret` (preferred), or a JWT with `kid` and a `scope` claim. Server-side only; there is no CORS.
- **UNVERIFIED:** the webhook authenticity mechanism for Conversations integrations (believed to be a shared webhook secret header, not confirmed in docs), plan or add-on requirements (MAU limits), and whether the default Zendesk AI agent must be displaced.
- The multi-customer credential rule likely applies here too; the Marketplace-bot variant uses its own tokens and `X-Zendesk-Marketplace-*` headers (**UNVERIFIED** details).

**A vs B for the MVP:**

| | A: tickets + trigger webhook | B: messaging / Switchboard |
| --- | --- | --- |
| Fits our async 2–10 s job model | Yes, ticket replies are asynchronous by nature | Mostly, but users expect chat latency |
| Setup for the business | Webhook + trigger + OAuth | Conversations integration + switchboard config + API key |
| Coverage | Email, web form, API tickets (and messaging conversations once they become tickets) | Live chat only |
| Risk | Low; stable, well-documented APIs | Switchboard control semantics, conflicts with Zendesk's own AI agent, plan gating unknown |

**Recommendation: Option A.** Revisit B after the MVP if customers ask for live-chat deflection.

## Gotchas

- **Reply loops:** guard in three layers: the trigger condition `current_via_id is_not 5`, the `author_id !== bot user` check before answering, and dedupe on the comment id.
  - **Caveat:** `current_via_id is_not 5` also suppresses tickets created via the API by other integrations. Accept this, or switch to a role- or tag-based condition.
- Client-credentials tokens act as the client's creator. If that creator is a human admin, our replies appear under their name, so require a dedicated agent user (it uses a seat).
- Refresh tokens rotate on every use. Losing the new one means the business must reconnect.
- Raw body is required for the HMAC. Never log ticket content (hard rule 9). Ticket text and attachments are untrusted (hard rule 7).
- Signing secret, OAuth client secret, and tokens are server-only and encrypted at rest.
- Placeholders render as plain text: escape-safe JSON in the trigger body only works for simple values like ids, which is another reason not to embed comment text.
- The webhook timeout is 12 s, but the agent takes 2–10 s, so always enqueue and return 200 instead of answering inline.
