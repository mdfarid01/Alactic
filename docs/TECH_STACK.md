# Tech Stack

Versions checked on npm on **2026-11-06**. They will be pinned at install time in Phase 1.

| Layer | Choice | Version seen | Why |
|---|---|---|---|
| Framework | Next.js App Router | 16.4.5 | Server routes + UI in one deploy on Vercel |
| Language | TypeScript (strict) | — | Typed end-to-end |
| Styling | Tailwind CSS + shadcn/ui + Lucide | — | Consistent, owned component code, light/dark themes |
| Wallet | wagmi + viem | 3.7.11 / 2.57.16 | Standard EVM tooling; viem includes SIWE + ENS resolution |
| Auth | SIWE (`viem/siwe`) + DB-backed sessions | — | No third-party auth vendor; revocable sessions |
| Validation | zod | — | Runtime validation at every trust boundary |
| Database | PostgreSQL + pgvector (hosted on Supabase) | — | Relational + vectors + tenant filters in one store |
| ORM / migrations | Drizzle ORM + drizzle-kit | 0.45.4 | SQL-close, first-class pgvector type, plain SQL migrations |
| Background jobs | Inngest | 4.26.2 | Serverless-friendly durable steps and retries |
| Crawling | Firecrawl (hosted API) | `@mendable/firecrawl-js` 4.52.0 | Handles JS sites, sitemaps, returns clean markdown; no Python service to host |
| PDF parsing | unpdf | 2.1.0 | Pure JS, serverless-friendly |
| DOCX parsing | mammoth | 1.13.0 | Mature DOCX → text/HTML |
| Inference | 0G Compute Router via the `openai` SDK with `baseURL` override | openai 7.53.0 | 0G documents OpenAI compatibility ("change base_url and api_key"); extra headers + `verify_tee` passed through |
| Embeddings | Provider interface; 0G Router embeddings first, explicit configured fallback | — | See [RAG_PIPELINE](RAG_PIPELINE.md) |
| ENS | viem (reads); `@ensdomains/ensjs` ≥ 5.2.5 (`/wallet/v2`) for ENSv2 record writes (managed batches + BYO) | 5.2.12 | ENSv2-aware; Universal Resolver |
| File storage | Supabase Storage (private bucket), server-side access only | — | Raw uploads kept for re-indexing |
| Tests | Vitest (unit/integration against real Postgres), Playwright (later, smoke) | — | Security boundaries must be tested against the real DB |
| Hosting | Vercel (app), Supabase (DB/storage), Inngest Cloud (jobs) | — | Managed, minimal ops |

## Deliberately not used (for now)

- **Supabase Auth / client-side Supabase queries.** All DB access is server-side with the service connection. The browser never receives a Supabase key. This keeps one authorization path (ours) to audit.
- **Redis/Upstash.** Rate limiting starts in Postgres. We add Redis only if load requires it.
- **LangChain/LlamaIndex.** The RAG pipeline is small; we write it directly so the prompt boundaries are explicit and auditable.
- **Crawl4AI.** It is Python and would need its own service. Firecrawl covers the need. Option: a simple self-hosted fetcher with SSRF protection for single pages if Firecrawl cost is a concern.
- **0G Storage SDK, ethers.** Not until 0G Storage is in scope.
- **Monorepo tooling.** One app until there is a second deployable.

## Required accounts and secrets (Phase 1–4)

| Secret | Where | Needed by |
|---|---|---|
| `DATABASE_URL` | Supabase | Phase 1 |
| `SESSION_SECRET` | generated | Phase 1 |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (public by design) | Reown/WalletConnect | Phase 1 (optional: injected wallets work without it) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server only) | Supabase | Phase 3 (uploads) |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | Inngest | Phase 3 |
| `FIRECRAWL_API_KEY` | Firecrawl | Phase 3 |
| `ZG_ROUTER_API_KEY` (`sk-…`), optionally one per trust tier | pc.0g.ai | Phase 3/4 (**requires a funded 0G deposit — approval**) |
| `ENS_PARENT_NAME` (`alactic.eth`), `ENS_CHAIN`, `ENS_RPC_URL`, `ENS_RECORD_PREFIX`, `ENS_PUBLISH_MODE` | config | Phase 5 |
| ENS publisher key (only in stage 5b) | generated, secret manager | Phase 5b (**approval**) |
| Discord / Slack / Zendesk app credentials | each platform | Phase 7 |
