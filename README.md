# Alactic

**Verifiable AI Agents for Every Business.**
*Create once. Own your identity. Deploy everywhere.*

Alactic lets a business create an AI customer support agent from its own website, documents and FAQs, then deploy it as a public chat page, a website widget, and on Discord, Slack, and Zendesk. All of these channels share one runtime.

- **Verifiable inference:** customer-facing answers are generated on [0G Compute](https://docs.0g.ai/) through the 0G Router. In Private mode they run in hardware TEEs, and every answer shows its real verification status.
- **Agent identity:** each agent gets a public ENS name such as `acme.alactic.eth` with standard agent records (ENSIP-26, draft), a versioned public manifest, and an identity page. Businesses can also link an ENS name they own.
- **No crypto needed for visitors:** website visitors chat without a wallet. The business wallet is used for sign-in (SIWE) and ownership.

> Honest scope: TEE verification proves *where and by which model* an answer was produced, not that it is correct.

## Status

**Phase 2 — agent builder complete, awaiting review.** Working today: landing page, wallet sign-in (SIWE), organizations and members, and creating and configuring agents (instructions, tone, language, fallback, 0G model and trust mode with live provider health). Knowledge, inference, publishing and ENS records come in Phases 3–6.

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
set -a; . ./.env.local; set +a; pnpm db:migrate
pnpm dev                        # http://localhost:3000
```

Open the app at exactly the origin in `APP_URL` (`http://localhost:3000`, not `127.0.0.1`), because sign-in messages are bound to that domain.

| Command | What it does |
|---|---|
| `pnpm test` | Integration tests against the `alactic_test` database (SIWE, sessions, org isolation) |
| `pnpm typecheck` / `pnpm lint` | TypeScript and ESLint |
| `pnpm build && pnpm start` | Production build |
| `APP_URL=http://localhost:3000 node scripts/smoke-auth.mjs` | End-to-end HTTP smoke test of sign-in/logout against a running app (throwaway wallet, no transactions) |
| `pnpm db:generate` | Generate a migration after editing `src/server/db/schema.ts` |
