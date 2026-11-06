# Alactic Architecture

Status: **Phase 0 proposal — awaiting founder approval.** Last updated 2026-11-06.

Related: [TECH_STACK](TECH_STACK.md) · [0G](0G_INTEGRATION.md) · [ENS](ENS_INTEGRATION.md) · [RAG](RAG_PIPELINE.md) · [Security](SECURITY.md) · [Schema](DATABASE_SCHEMA.md) · [Plan](IMPLEMENTATION_PLAN.md)

## 1. Shape: modular monolith

One Next.js application deployed on Vercel, one Postgres database (with pgvector), and one background job runner (Inngest). No microservices, no monorepo. Modules are folders with clear boundaries. Each module is split if (and only if) a real need appears.

```
                      ┌──────────────────────── Next.js app (Vercel) ────────────────────────┐
 Business owner ────► │  Landing · Dashboard · Agent Builder · Knowledge · Playground       │
 (wallet + SIWE)      │                                                                      │
                      │  Server routes / server actions                                      │
 Website visitor ───► │  /a/[slug] public chat · /embed/[slug] widget iframe                  │
 (no wallet)          │                                                                      │
 Discord / Slack ───► │  /api/channels/{discord,slack,zendesk}  (signature-verified webhooks) │
 Zendesk              │                                                                      │
 ENS clients ───────► │  (resolve on-chain: <slug>.alactic.eth → PermissionedResolver)       │
                      │  /api/public/agents/[slug]/manifest.json                             │
                      │                                                                      │
                      │  ┌──────────────── src/server (domain modules) ──────────────────┐   │
                      │  │ auth · orgs · agents · knowledge · runtime · inference(0G)     │   │
                      │  │ verification · ens · manifest · channels · usage · ratelimit   │   │
                      │  └────────────────────────────────────────────────────────────────┘   │
                      └───────────────┬───────────────────────┬──────────────────┬───────────┘
                                      │                       │                  │
                         Postgres + pgvector          Inngest (jobs:       0G Compute Router
                         (Supabase-hosted)            crawl, parse,        (chat + embeddings)
                         + private file bucket        embed, reindex,      Firecrawl (crawl)
                                                      channel replies)     Ethereum RPC (ENS reads)
```

## 2. Request flows

### 2.1 Shared agent runtime (all channels)

All channels call one function: `runAgent(input: AgentRunInput): Promise<AgentRunResult>` in `src/server/runtime`. Channel adapters only translate in/out and never contain AI logic.

```
Channel adapter (web / widget / discord / slack / zendesk / playground)
  │  verifies channel auth (session, widget origin + rate limit, webhook signature)
  ▼
runAgent({ agentRef, channel, conversationRef, userMessage, mode: 'live' | 'playground' })
  1. Resolve agent → (orgId, agentId); require status=published unless mode=playground and caller is an org member
  2. Validate input (zod; length limits; strip control chars)
  3. Load the pinned agent_config version (published version for live, draft for playground)
  4. Retrieve knowledge: embed query → pgvector search filtered by org_id AND agent_id → top-k chunks
  5. Build controlled prompt: system policy + agent config + <knowledge> blocks (marked untrusted) + history + user message
  6. Insert inference_record (status=requested, trust_mode_requested)
  7. Call 0G Router with explicit X-0G-Provider-Trust-Mode and verify_tee (if mode ≠ standard)
  8. Record completion: provider, request_id, chat_id (ZG-Res-Key), tokens, cost, tee_verified → verification_record
  9. Post-process: map [n] citation markers to chunk sources; drop citations that don't match a retrieved chunk
 10. Persist messages, usage_event; return { text, citations, inference, verification }
  On 0G failure: persist the failure, return the agent's configured fallback message + machine-readable error code
```

### 2.2 Knowledge ingestion (async)

`Add source` → row in `knowledge_sources` (status `queued`) → Inngest event → steps: fetch/crawl → extract → normalize → chunk → embed (batched) → upsert chunks in a transaction → status `ready`. Details in [RAG_PIPELINE](RAG_PIPELINE.md).

### 2.3 Publishing

`Publish` → freeze the current draft as a new immutable `agent_config` version → generate manifest v(n) → compute SHA-256 → create `agent_deployments` row → queue managed ENS record update for `<slug>.alactic.eth` (on-chain `multicall` of `setText`, signed by the founder in 5a; see ENS doc §4) → public URL, widget, and identity page go live.

### 2.4 ENS resolution

ENS clients → Universal Resolver → ENSv2 `.eth` registry → `alactic.eth` (no subregistry) → its PermissionedResolver serves the records written for `<slug>.alactic.eth` (verified on-chain 2026-11-06, see [ENS doc §1](ENS_INTEGRATION.md)). Parent name and chain are configuration (`ENS_PARENT_NAME`, `ENS_CHAIN`); the resolver is looked up at write time. Writes are transactions and need **founder approval**.

## 3. Code layout (planned)

```
src/
  app/
    (marketing)/            landing page
    (app)/dashboard/...     authenticated app (org-scoped routes: /dashboard/[orgSlug]/...)
    a/[slug]/               public chat page
    embed/[slug]/           iframe widget UI
    api/
      auth/{nonce,verify,logout}
      chat/[slug]/          public chat API (widget + public page)
      channels/{discord,slack,zendesk}/
      admin/ens/            prepare publish batches (founder signs in browser)
      inngest/
      public/agents/[slug]/{manifest.json,verification}
  components/               ui (shadcn) + feature components
  server/                   server-only domain modules ('server-only' import guard)
    auth/  orgs/  agents/  knowledge/  runtime/  inference/  verification/
    ens/   manifest/  channels/  usage/  ratelimit/  db/ (drizzle schema, scoped queries)
  lib/                      shared pure utilities (validation schemas, formatting)
public/widget.js            tiny loader script that injects the iframe
tests/                      vitest unit + integration (tenant isolation, auth, runtime)
```

## 4. Key architectural decisions

| # | Decision | Why | Alternatives rejected |
|---|---|---|---|
| D1 | Modular monolith on Next.js | Fastest to ship, one deploy, shared types | Separate API service (no need yet) |
| D2 | 0G **Router** (not direct broker) for all customer-facing inference | Documented primary path, OpenAI-compatible, trust modes, failover, no server-held wallet | Direct broker SDK (needs funded server wallet, per-provider accounts) |
| D3 | Always send an explicit trust mode; never downgrade | Router serves unpinned requests from any provider (incl. standard) | Relying on model choice alone (misleading: `glm-5.3` also has standard channels) |
| D4 | Default trust mode `private` with `glm-5.3` (or `0gm-1.0-35b-a3b`) | Only TeeML gives the enclave privacy guarantee | `standard` default (no verification, undisclosed provider) |
| D5 | Postgres + pgvector for the live index | Tenant filters + vectors in one transactional store | Separate vector DB (more infra, harder isolation) |
| D6 | Tenant isolation in the data-access layer, with composite FKs (`(agent_id, org_id)`) | Makes cross-tenant rows impossible to create, and every query takes an org scope | Frontend filtering, ad-hoc `where` clauses |
| D7 | Inngest for background jobs | Works on Vercel serverless, retries, step functions, local dev server | BullMQ (needs Redis + long-running worker host) |
| D8 | SIWE via viem + DB-backed sessions | No extra auth vendor; revocable sessions | NextAuth/Auth.js (extra abstraction), JWT-only (hard to revoke) |
| D9 | ENS: Alactic-managed `<slug>.alactic.eth` records on the existing ENSv2 PermissionedResolver (mainnet) + business-owned (BYO) names | Works today with no contract deployment or resolver change, fully on-chain; BYO gives real ownership | CCIP-Read gateway (needs resolver change + trusted signer), UserRegistry per-agent tokens (deployment; planned 5c) |
| D10 | Widget = script loader + iframe | Style isolation, no secrets in the host page, simple CSP story | Injected DOM widget (CSS conflicts, larger attack surface) |
| D11 | 0G Storage deferred | Not needed for the core product; requires signing txs | — |
| D13 | Don't retain uploaded files; keep only normalized extracted text | Enough to re-chunk/re-embed; less sensitive data held; no storage bucket needed for MVP. Trade-off: a better parser later requires re-upload | Supabase Storage bucket (kept as the path for >4 MB direct uploads later) |
| D12 | Embeddings behind a provider interface; model + dimension stored per chunk | 0G TeeML embedding provider currently unhealthy; must be able to switch deliberately | Hardcoding one provider |

## 5. Environments

| Env | DB | 0G | ENS |
|---|---|---|---|
| local | Docker Postgres (pgvector image) or Supabase dev project | Router (testnet if reachable, else mainnet with small capped deposit — **approval**) | mainnet reads (`alactic.eth`); writes only on a local fork or with approval |
| preview/staging | Supabase project | same as local | mainnet reads |
| production | Supabase project | Router mainnet | mainnet (after approval) |

## 6. Agent manifest (v1 schema, public)

Generated on every publish, immutable per version, served at `/api/public/agents/{slug}/manifest.json` and referenced (URL + SHA-256) from ENS. Contains **only public data** and no fabricated values: any field we can't back with real data is omitted or `null`.

```json
{
  "$schema": "https://<app-domain>/schemas/agent-manifest/v1.json",
  "manifestVersion": 1,
  "agentVersion": 4,
  "name": "Acme Support",
  "description": "Answers questions about Acme products and orders.",
  "publishedAt": "2026-11-20T10:00:00Z",
  "operator": { "organization": "Acme Inc.", "ownerAddress": "0x… (business wallet that published)" },
  "identity": { "ens": "acme.alactic.eth", "ensMode": "managed", "network": "mainnet" },
  "endpoints": { "web": "https://<app-domain>/a/acme" },
  "compute": {
    "network": "0g-compute-router",
    "model": "glm-5.3",
    "trustMode": "private",
    "verifyTee": true
  },
  "knowledge": {
    "snapshotSha256": "sha256 over sorted chunk content hashes of the published index",
    "sourceCount": 12,
    "storage": null
  },
  "channels": { "web": true, "widget": true, "discord": false, "slack": false, "zendesk": false },
  "disclaimer": "AI responses may be inaccurate. TEE verification attests to execution, not correctness."
}
```

- `knowledge.storage` becomes `{ "network": "0g-storage", "rootHash": "…" }` only after a real upload (post-MVP, approval needed).
- Channels are `true` only when an integration is actually active.
- Excluded on purpose: instructions, persona prompt, source URLs/filenames (they may be private), integration IDs.

## 7. What is explicitly out of MVP scope

0G Storage uploads, ENSIP-25/ERC-8004 registration, on-chain transferable subnames, per-business crypto billing, Zendesk (stretch), MCP/A2A endpoints, tool-calling/actions by agents.
