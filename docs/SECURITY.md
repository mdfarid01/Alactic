# Security & Privacy

Status: Phase 0 threat model. Each control lists the phase that implements it.

## 1. Assets

0G Router API key and deposit · `alactic.eth` owner wallet and any delegated ENS publisher key · session tokens · integration credentials (Slack/Discord/Zendesk) · business documents and knowledge chunks · conversation contents (may contain end-customer PII) · agent configuration/instructions (business-confidential).

## 2. Threats and controls

| Threat | Control | Phase |
|---|---|---|
| Wallet impersonation | SIWE: server nonce, single-use atomic consumption, domain + URI origin check against **configured** host, chainId allowlist, ≤10-min expiry, `verifySiweMessage`; address taken only from session | 1 |
| Session theft/fixation | Random 256-bit token, only the hash stored, `__Host-` cookie `HttpOnly; Secure; SameSite=Lax`, rotation on login, server-side revoke on logout, absolute expiry | 1 |
| CSRF on mutations | SameSite=Lax + Origin header check on all state-changing routes; server actions' built-in origin check | 1 |
| Cross-tenant data access | Composite FKs, `OrgScope`-required data access, authorization check on every route (`requireOrgRole`), integration tests that try cross-org access for every resource | 1–3 |
| Cross-tenant retrieval in RAG | **Implemented:** composite FKs source→document→chunk, retrieval filters `org_id` AND `agent_id` resolved server-side, tests with two orgs and two agents sharing similar content, plus a DB-level test that a cross-tenant chunk insert fails | 3 |
| Prompt injection (user or documents) | **Implemented:** fixed platform policy first; business instructions and knowledge in escaped delimiter blocks marked as data; user text only as a user message; no tools/actions; citation markers without a matching passage are stripped; output rendered as plain text (no HTML) | 3–4 |
| Leaking system prompt/config | Policy instruction + config never included in public manifest/ENS; accept that LLM refusal isn't a guarantee, so **no secrets ever go in prompts** | 4 |
| Silent privacy downgrade | **Implemented and tested:** explicit `X-0G-Provider-Trust-Mode` on every chat and embedding request; no retry in another tier (a single 502 retry in the same tier only); 503 surfaced as a readable error plus the fallback answer; trust mode stored per inference and shown in the UI | 4 |
| False verification claims | **Implemented:** the badge comes only from `verification_records`; the tooltip states the method (Router) and that verification ≠ correctness; `tee_verified=false` withholds the response; no evidence → "Verification unavailable" | 4 |
| API key exposure | All 0G/Firecrawl/Supabase/integration secrets server-only (`server-only` import guard, no `NEXT_PUBLIC_` secrets); secret scanning in CI | 1+ |
| Auth endpoint abuse (nonce flooding) | **Not yet implemented:** rate limiting on `/api/auth/nonce` and `/api/auth/verify`. Expired/consumed nonces have a `purgeNonces` helper but no scheduled job yet. Both land with the shared rate limiter + Inngest in Phases 3–4 | 3–4 |
| Cost abuse via public chat | Per-IP-hash + per-agent + per-org rate limits; message length caps; max output tokens; daily per-org spend cap that pauses public chat | 4 |
| SSRF via crawl URLs | **Implemented:** http(s) only; IP literals, localhost, single-label and private-use TLDs, credentials and non-80/443 ports rejected; crawling happens on Firecrawl's network, same-site only. We never fetch customer URLs from our servers (if that changes, DNS must be re-checked after resolution and every redirect) | 3 |
| Malicious uploads | **Implemented:** 4 MB cap checked from Content-Length before reading the body; extension + magic bytes must agree; UTF-8 strict decoding; DOCX ZIP central-directory size guard (50 MB, ZIP64 refused); PDF page cap; files parsed in-request and never stored or served back; extracted text rendered as plain text only. Residual risk: parser bugs in pdf.js/mammoth (keep dependencies updated) | 3 |
| XSS via agent output / knowledge | Render model output as sanitized Markdown (no raw HTML), links `rel="noopener noreferrer nofollow"` | 4/6 |
| Widget abuse / clickjacking | Widget iframe served from our origin; per-agent `allowed_origins` checked on the chat API (Origin header) + `frame-ancestors` CSP from allowed origins; visitor token is random, not tied to an identity | 6 |
| Webhook forgery | Discord Ed25519 signature check; Slack v0 HMAC-SHA256 signing secret + 5-min timestamp window; Zendesk webhook signature (HMAC) — exact schemes re-verified against platform docs in Phase 7 | 7 |
| Integration credential theft | AES-256-GCM encryption at rest with a key from env/secret manager; least-privilege OAuth scopes; revoke on uninstall | 7 |
| ENS record tampering / misuse | Parent owner wallet never on a server (hardware wallet/multisig recommended); 5a: founder signs each batch; 5b: publisher key limited to `ROLE_SET_TEXT` on agent keys only (no addr/link/upgrade/admin), revocable; never write the `0x00` default bundle; record values derived from whitelisted public fields; identity page compares live resolution with manifest hash; reserved-label + brand-impersonation policy | 5 |
| Logging leaks | Structured logs with redaction: no message content, documents, prompts, keys or full addresses at info level; log IDs (`request_id`, `inference_id`) instead | 1+ |
| Error leakage | Public errors are generic codes and messages; details stay in server logs | 1+ |
| Unapproved on-chain actions | Server holds no funded keys in MVP. Any tx (ENS, 0G deposit, Storage) is founder-approved and executed manually or via the business's own wallet | all |

## 3. Privacy statements we can and can't make

**Can say (with `private` trust mode):** "Responses are generated inside a hardware-isolated TEE (Intel TDX). 0G's Router does not store prompts or completions; it keeps billing metadata only."

**Must also say:**
- Alactic's own servers see conversations in plaintext to retrieve knowledge and build prompts, and Alactic stores conversation history (retention configurable).
- In `verified` mode with TeeTLS providers, the upstream model provider processes the prompt under its own data policy.
- In `standard` mode the provider is not disclosed and responses cannot be verified.
- Embeddings of knowledge documents are computed by the configured embedding provider (see RAG_PIPELINE §4).
- TEE verification shows which model/enclave produced a response. It does not make the answer correct.

**Never say:** "fully private", "zero-knowledge", "end-to-end encrypted AI", "trustless", or "verified" without a verification record.

## 4. Security testing plan (Phase 8, plus continuous)

- Unit/integration: SIWE replay, wrong domain, expired message, wrong chain; session revocation; role matrix per route; cross-org access attempts on every resource; RAG isolation fixture; trust-mode never downgraded (mock Router returning 503); verification badge logic.
- Webhook signature tests with recorded fixtures.
- Dependency audit + secret scanning in CI.
- Manual review of public endpoints (chat, widget, manifest, identity page) for data exposure.
