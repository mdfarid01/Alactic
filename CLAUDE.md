# CLAUDE.md — Alactic

Alactic: Web3-native AI customer support platform. Businesses create support agents trained on their knowledge, deploy them on web/widget/Discord/Slack/Zendesk, run inference on **0G Compute**, and publish an **ENS** identity per agent. Product name is always **Alactic**.

## Read first
`docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_PLAN.md` (current phase), plus the topic doc for the area you touch (`0G_INTEGRATION`, `ENS_INTEGRATION`, `RAG_PIPELINE`, `SECURITY`, `DATABASE_SCHEMA`, `TECH_STACK`).

## Working agreement
- Work phase by phase; stop for founder approval at the end of each phase. Ask before major architectural changes.
- Explain what changed, why, and how to test it. Update docs when decisions change.
- Inspect files before overwriting.

## Hard rules
1. Never invent SDK methods, endpoints, headers, model IDs, network IDs, or response fields. Check current official docs (or the live API) before implementing an integration and record findings in `docs/`.
2. No hardcoded mock data in place of real functionality. Anything mocked or incomplete must be labelled in the UI and docs.
3. Never show "verified" without a `verification_records` row with status `verified`. Always state that TEE verification ≠ factual correctness.
4. Always send an explicit `X-0G-Provider-Trust-Mode`. Never downgrade or retry in a lower trust mode.
5. Secrets server-side only (`server-only` modules; no secret in `NEXT_PUBLIC_*`). No customer private keys stored, ever.
6. Tenant isolation: tenant data only through `OrgScope`-scoped data access; RAG queries filter `org_id` AND `agent_id`; add a cross-tenant test for every new resource.
7. User messages and retrieved documents are untrusted. Agents have no tools/actions. Validate structured model output.
8. No blockchain transactions, deposits, ENS registrations, contract deployments, or fund spending without explicit founder approval.
9. Don't log message content, documents, prompts, or secrets.
10. Never publish private prompts, documents, or confidential config to ENS, manifests, or decentralized storage.

## Stack
Next.js (App Router) + TypeScript strict · Tailwind + shadcn/ui + Lucide · wagmi + viem (SIWE, ENS) · Postgres + pgvector (Supabase) · Drizzle · Inngest · Firecrawl, unpdf, mammoth · 0G Compute Router via `openai` SDK with `baseURL` override · Vitest.

## Commands
`pnpm dev` · `pnpm test` (needs `pnpm db:up`) · `pnpm typecheck` · `pnpm lint` · `pnpm build` · `pnpm db:generate` / `pnpm db:migrate` · `node scripts/smoke-auth.mjs` (against a running app).

## Codebase conventions
- Next.js 16 with `cacheComponents` + `partialPrefetching`. AGENTS.md: read `node_modules/next/dist/docs/` before using Next APIs. `proxy.ts` replaces middleware (optimistic checks only). Anything reading cookies/session goes inside `<Suspense>`; `getCurrentUser()` calls `connection()` before time-dependent checks.
- Server-only code lives in `src/server/**` (imports `server-only`). DB access functions take a `Database` argument so they're testable against `alactic_test`.
- Tenant data functions take an `OrgScope` (from `authorizeOrg`), never a raw org id. Dashboard pages use `getPageOrgScope()` (404 for non-members).
- Server Actions re-authorize on every call; call `refresh()` after mutations.
- shadcn/ui here is the Base UI variant (`render` prop, not `asChild`); style links with `buttonVariants()`.
