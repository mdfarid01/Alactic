# Implementation Plan

Each phase ends with a demo, tests, doc updates, and a founder review. Complexity: S ≈ ≤1 day, M ≈ 2–3 days, L ≈ 4–6 days (one engineer + AI pair).

## MVP priority (what makes the hackathon demo real)

1. **P0 — core loop:** SIWE login → org → create agent → add website/PDF/FAQ → ask in playground → answer from 0G (`private` mode) with citations and a real verification status.
2. **P0 — public deployment:** publish → public chat URL + embeddable widget, anonymous visitors, rate limits.
3. **P1 — identity:** managed `<slug>.alactic.eth` with ENSIP-26 records + public identity/verification page; BYO-name linking.
4. **P1 — one external channel:** Discord (slash command via HTTP interactions; simplest to get working on serverless).
5. **P2:** Slack. **P3:** Zendesk. **Post-MVP:** independent TEE verification, 0G Storage manifests, ENSIP-25, transferable subnames.

## Phase 0 — Research & architecture ✅ (this document set)

## Phase 1 — Foundation (L) ✅ implemented 2026-11-06, awaiting review

Delivered: Next.js 16 scaffold (cacheComponents), shadcn/ui (Base UI) design tokens with light/dark, landing page, SIWE auth (nonce/verify/logout, DB sessions, `proxy.ts` optimistic redirect), organizations + members (roles, add-by-wallet, last-owner guard), Drizzle migration `0000_init`, 29 integration tests, HTTP smoke script. Deferred from the list below: invite flow beyond add-by-wallet (no email/notifications), rate limiting on auth endpoints (Phase 4 with the shared limiter), smart-contract-wallet sign-in tested only via the code path (needs a real smart wallet + RPC).


1. Scaffold Next.js 16 + TS strict + Tailwind + shadcn/ui + Lucide; ESLint/Prettier; Vitest; `server-only` guards; env validation with zod (fail fast on missing secrets).
2. Design system: tokens (light/dark), typography, base components, app shell (sidebar, org switcher, status badges).
3. Landing page: honest copy (no fake logos/testimonials/stats); sections: problem, how it works, verifiable inference (with accurate caveats), ENS identity, channels (marked "coming soon" until real).
4. Database: Postgres + pgvector (local Docker + Supabase), Drizzle schema for auth/org tables, first migration, `scoped` data-access helpers.
5. SIWE auth: nonce/verify/logout routes, sessions, wagmi connect UI, middleware protecting `/dashboard`.
6. Organizations & memberships: create org, switch org, role checks (`requireOrgRole`), invite-by-wallet (simple).
7. Tests: SIWE replay/domain/expiry, session revoke, cross-org access denial.

**Exit demo:** connect wallet → sign in → create org → empty dashboard. Sign-out revokes the session.

## Phase 2 — Agent builder (M) ✅ implemented 2026-11-06, awaiting review

Delivered: `agents` + versioned `agent_configs` (migration `0001`, DB-enforced tenancy, one-draft rule and published-version immutability), agents service (create/list/edit/save draft with conflict detection/publish/delete, admin+ for writes), live 0G model catalog (`/v1/models` + `/v1/providers`, cached for minutes; failures surface as errors and never fall back), server-side model/trust validation, builder UI (identity, behavior, model and trust with live provider health, advanced), agents list, overview card. 19 new tests (48 total). The browser flow (create org → create agent → edit → save → reload) was verified in headless Chrome.
Not in this phase (by design): a publish button (Phase 6; `publishDraft` exists and is tested), knowledge (Phase 3), playground (Phase 4).


Agents + versioned configs (draft/published), builder UI (name, description, instructions, persona, tone, language, fallback, model, trust mode with live availability from `/v1/models` + `/v1/providers`), list/status UI. Tests: role matrix, config versioning immutability.

## Phase 3 — Knowledge & RAG (L) ✅ implemented 2026-11-06, awaiting review (live embedding/crawl pending keys)

Delivered: knowledge schema (migration 0002, pgvector), upload/extract (PDF/DOCX/TXT/MD), FAQ and text sources, website crawling via Firecrawl v2, chunking with citations metadata, 0G embedding provider, Inngest v4 background ingestion, re-index/delete, tenant-scoped retrieval, knowledge UI with live status and "Test retrieval". Tests: 92 total (44 new). Browser E2E with the real Inngest dev server: sources save, chunk (PDF pages tracked), and stop with explicit "not configured" reasons.
**Not verified live:** 0G `/v1/embeddings` (needs `ZG_ROUTER_API_KEY`) and Firecrawl crawling (needs `FIRECRAWL_API_KEY`). Both are implemented against current docs and unit-tested with recorded response shapes.


0. **Spike:** authenticated 0G `/v1/embeddings` call; confirm dimension; decide embedding model (founder sign-off).
1. Inngest setup; sources CRUD; upload to private bucket with validation.
2. Extractors (Firecrawl, unpdf, mammoth, text, FAQ); normalization; heading-aware chunking.
3. Embedding provider interface; batched embedding; pgvector schema + HNSW index.
4. Retrieval service with org/agent filters; citation metadata.
5. Status UI, re-index, delete (cascade + file removal).
6. Tests: two-tenant isolation fixture, delete removes retrieval, re-index idempotency, SSRF URL validator.

## Phase 4 — 0G Compute (M) ✅ implemented 2026-11-06, awaiting review (live 0G pending API key)

Delivered: Router chat client, shared `runAgent` runtime (retrieval → controlled prompt → inference → verification → citations → persistence), conversation/message/inference/verification schema (migration 0003), daily cost guard, playground (draft config, citations, trust and verification badges, readable errors), real verification stats on the overview. 116 tests. Browser E2E: (a) without a key, a fallback with a clear reason and no false badge; (b) against a local mock Router, a cited answer with a "TEE signature verified" (Router) badge, and every request pinned to `private` with `verify_tee`.
Deferred: live spikes (need key), streaming (D14), independent verification (stretch), operator alerts on 401/402 (currently logged and recorded per inference).


0. **Spikes:** streaming + `x_0g_trace`; `ZG-Res-Key` header; behaviour of 503 `no_provider_for_trust_mode`; latency/quality of `glm-5.3` vs `0gm-1.0-35b-a3b`.
1. `InferenceClient` (openai SDK, baseURL override, explicit trust-mode header, `verify_tee`), typed error mapping (§8 of 0G doc), bounded retries, timeouts.
2. `runAgent` shared runtime (steps 1–10 in ARCHITECTURE §2.1) with inference + verification records and usage events.
3. Verification state machine + UI badges + disclaimer.
4. Spend guard: per-org daily caps; operator alert on 401/402.
5. Tests with a mocked Router: no downgrade on 503, `tee_verified=false` → untrusted, badge logic, error → fallback message.
6. Stretch: independent verification via `@0gfoundation/0g-compute-ts-sdk` `processResponse` or manual EIP-191 check.

## Phase 5 — ENS (M–L)

0. **Spike (no approval needed):** install Foundry, fork mainnet with `anvil`, impersonate the `alactic.eth` owner, write `setText` for `test.alactic.eth` via `multicall`, and confirm viem resolves it through the Universal Resolver. Ownership/resolver/permission checks were already done read-only on 2026-11-06 (ENS doc §1).
1. `EnsIdentityWriter` interface + stage **5a**: admin "ENS publishing" screen builds a diffed `multicall` of `setText` for pending agents; the founder signs in the browser; we record the tx and re-resolve to confirm. Config via `ENS_PARENT_NAME` / `ENS_CHAIN` / `ENS_PUBLISH_MODE`; resolver looked up at write time.
2. Manifest generation + hashing on publish.
3. BYO name flow: show the record values, the business signs in its wallet (ENSjs v2 helpers), then we verify by resolution.
4. Public identity page with live resolution + sync status.

## Phase 6 — Playground & deployment (M) ✅ public chat + widget implemented 2026-11-06

Delivered: publish / unpublish / resume (immutable versions), Deploy tab (public link, widget snippet, allowed sites), public chat `/a/[slug]` (anonymous visitors with a hashed visitor token, history restore), widget `public/widget.js` + `/embed/[slug]` (sandboxed iframe, CSP `frame-ancestors` from the agent's allowed sites), per-answer public verification page `/v/[inferenceId]` (evidence only, no content, public channels only), demo host page `/demo/[slug]`, rate limits (12/min per client hash, 60/min per agent, plus the daily org cap), clickjacking headers. Catalog resilience: 15 s timeout + retry + last-good fallback. 147 tests. Live E2E against 0G mainnet as a stranger with no wallet: answer, citation, independent TEE verification, history, widget and CSP all pass.


Playground (draft config, citations, inference + verification status, readable errors), publish workflow, public chat page `/a/[slug]`, widget loader + iframe + allowed origins + CSP, public verification page per message/inference (shares only inference ID, model, trust mode, provider address, verification status, never message content unless the visitor owns it).

*Note:* a minimal playground is built at the end of Phase 4 so 0G work can be tested in the UI. Phase 6 polishes it.

## Phase 7 — Integrations (M each)

Discord (HTTP interactions, Ed25519, `/ask`, deferred responses via Inngest) → Slack (OAuth v2, Events API, signing secret, threaded replies, 3-s ack + async) → Zendesk (stretch). Each one: re-read the current platform docs first, use the shared runtime, keep incomplete ones labelled "Beta/Not available".

## Phase 8 — Polish & testing (M)

Security test pass (SECURITY §4), Playwright smoke tests, performance (index tuning, caching model catalog), error copy, accessibility, deployment runbook.

## Estimated total

~5–6 weeks for P0–P2 at a sustainable pace. A hackathon cut (P0 + managed ENS + Discord) is ~2.5–3 weeks if decisions below are made quickly.

## Decisions needed from the founder before / during Phase 1

| # | Decision | Recommendation |
|---|---|---|
| 1 | Approve stack in TECH_STACK.md | Approve |
| 2 | Hosting accounts: Vercel, Supabase, Inngest | Create now (free tiers) |
| 3 | 0G environment: testnet Router appears unreachable; fund a small **mainnet** deposit? | Small capped deposit before Phase 3 |
| 4 | Default chat model + trust mode | `glm-5.3`, `private` (confirm after Phase 4 spike) |
| 5 | Embedding provider if 0G TeeML embeddings stay unhealthy | Decide at Phase 3 spike |
| 6 | ENS: `alactic.eth` confirmed on mainnet ENSv2 (owner `0x86bE…7b75`, expires 2027-11-06). Publishing stage? | 5a (founder-signed batches); confirm wallet ownership |
| 7 | Production domain (public URLs, ENS custom-record prefix) | — |
| 8 | Firecrawl (paid API) vs self-hosted single-page fetcher | Firecrawl free tier for MVP |
| 9 | Conversation retention default | 90 days |

## Phase 1 — exact first steps

1. `npx create-next-app@latest` (TS, App Router, Tailwind, ESLint, `src/`), then `npx shadcn@latest init`.
2. Add `zod`, `drizzle-orm`, `drizzle-kit`, `postgres`, `viem`, `wagmi`, `@tanstack/react-query`, `vitest`, `server-only`.
3. `docker-compose.yml` with `pgvector/pgvector` Postgres for local dev; `.env.example`; env validation module.
4. Drizzle schema: `users`, `wallet_identities`, `auth_nonces`, `sessions`, `organizations`, `organization_members` → migration 0001.
5. SIWE routes + session helpers + tests.
6. App shell + landing page.
7. Org create/switch + `requireOrgRole` + cross-org tests.
8. Update docs and report.
