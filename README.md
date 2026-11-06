# Alactic

**Verifiable AI Agents for Every Business.**
*Create once. Own your identity. Deploy everywhere.*

Alactic lets a business create an AI customer support agent from its own website, documents and FAQs, then deploy it as a public chat page, a website widget, and on Discord, Slack, and Zendesk. All of these channels share one runtime.

- **Verifiable inference:** customer-facing answers are generated on [0G Compute](https://docs.0g.ai/) through the 0G Router. In Private mode they run in hardware TEEs, and every answer shows its real verification status.
- **Agent identity:** each agent gets a public ENS name such as `acme.alactic.eth` with standard agent records (ENSIP-26, draft), a versioned public manifest, and an identity page. Businesses can also link an ENS name they own.
- **No crypto needed for visitors:** website visitors chat without a wallet. The business wallet is used for sign-in (SIWE) and ownership.

> Honest scope: TEE verification proves *where and by which model* an answer was produced, not that it is correct.

## Status

**Phase 6 — public deployment, awaiting review.** Working today: wallet sign-in, organizations and members, agent builder, knowledge sources with background indexing, a playground, **publishing** to a public chat page (`/a/<slug>`) and an embeddable **website widget**, a public **proof receipt** for every answer (`/proof/<id>`) that visitors can **verify in their own browser** against 0G Chain, **voice notes and screenshots** from visitors (transcribed and read on 0G in Private mode, each step with its own proof), **channel connectors** for Telegram, WhatsApp, Slack and Discord (every reply carries its proof link), a **fingerprint on every answer** so customers can prove what support told them, a public **trust report and badge**, a **test suite** of golden questions that runs on 0G before you publish, a **verified human handoff** with AI summaries, a **daily owner briefing**, and a **knowledge-gap inbox** that can draft answers from a page of your site that collects questions the agent couldn't answer so you can teach it in one click. Live answers need `ZG_ROUTER_API_KEY` (and `FIRECRAWL_API_KEY` for websites). Try it fast with `pnpm seed:demo`, which creates a published demo agent at `/a/nimbus`.

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, runtime flow, decisions, manifest schema |
| [docs/TECH_STACK.md](docs/TECH_STACK.md) | Chosen technologies and required accounts |
| [docs/0G_INTEGRATION.md](docs/0G_INTEGRATION.md) | 0G Router findings: trust modes, verification, models, errors |
| [docs/ENS_INTEGRATION.md](docs/ENS_INTEGRATION.md) | ENSv2 status, agent records, naming options, SIWE |
| [docs/RAG_PIPELINE.md](docs/RAG_PIPELINE.md) | Ingestion, chunking, embeddings, retrieval, prompt safety |
| [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) | Tables, tenancy model, constraints |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, controls, privacy statements |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phases, priorities, open decisions |

## Getting started

Requirements: Node 22+, pnpm 10, Docker (for local Postgres), and a browser wallet extension (MetaMask, Rabby, …).

```bash
pnpm install
cp .env.example .env.local      # defaults work for local development
pnpm db:up                      # Postgres 17 + pgvector on 127.0.0.1:54329 (also creates alactic_test)
pnpm db:migrate                 # reads .env.local itself
pnpm dev                        # http://localhost:3000
pnpm inngest:dev                # second terminal: background jobs (Inngest dev server, http://localhost:8288)
```

Open the app at exactly the origin in `APP_URL` (`http://localhost:3000`, not `127.0.0.1`), because sign-in messages are bound to that domain.

| Command | What it does |
|---|---|
| `pnpm dev:clean` | Start dev after clearing Turbopack's dev cache (use if pages reload in a loop) |
| `pnpm test` | Integration tests against the `alactic_test` database (SIWE, sessions, org isolation) |
| `pnpm typecheck` / `pnpm lint` | TypeScript and ESLint |
| `pnpm build && pnpm start` | Production build |
| `APP_URL=http://localhost:3000 node scripts/smoke-auth.mjs` | End-to-end HTTP smoke test of sign-in/logout against a running app (throwaway wallet, no transactions) |
| `pnpm db:generate` | Generate a migration after editing `src/server/db/schema.ts` |
