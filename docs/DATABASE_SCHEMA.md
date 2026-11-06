# Database Schema

Postgres 15+ with `pgvector` and `pgcrypto`. Managed with Drizzle migrations (SQL files committed). All IDs are `uuid` (v7 generated in-app, or `gen_random_uuid()`). All tables have `created_at`; mutable ones have `updated_at`. Timestamps are `timestamptz`.

## 1. Tenancy model

- **Tenant = organization.** Every tenant-owned row has `org_id NOT NULL`.
- Rows that belong to an agent carry **both** `org_id` and `agent_id`, with a **composite FK** `(agent_id, org_id) → agents(id, org_id)`. The database itself then rejects a row that claims agent X but org Y. That makes cross-tenant mix-ups structurally impossible, not just "filtered out".
- The app accesses tenant data only through `src/server/db/scoped.ts` helpers that require an `OrgScope` (obtained from an authorization check). Raw table access outside that module is lint-restricted.
- Optional hardening (post-MVP): Postgres RLS keyed on `current_setting('app.org_id')` for `knowledge_chunks`, `messages`, `conversations`.

## 2. Tables

### Identity & auth

**users** — `id`, `display_name?`, `created_at`.

**wallet_identities** — `id`, `user_id → users`, `address` (lowercase, checksummed on display), `chain_id_last_used`, `ens_name_cached?`, `created_at`.
Unique `(address)`. A wallet maps to exactly one user.

**auth_nonces** — `nonce` (PK), `pre_session_id`, `expires_at`, `consumed_at?`.
Single-use; consumed with `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING`. Purged by a job.

**sessions** — `id`, `user_id`, `token_hash` (SHA-256 of the cookie token; the raw token is never stored), `wallet_address`, `expires_at`, `revoked_at?`, `ip_hash?`, `user_agent?`, `created_at`.
Index `(token_hash)` unique.

### Organizations

**organizations** — `id`, `name`, `slug` (unique), `created_by → users`, `plan` (`free`), timestamps.

**organization_members** — `org_id`, `user_id`, `role` (`owner` | `admin` | `member`), `created_at`.
PK `(org_id, user_id)`. Check constraint: every org keeps ≥ 1 owner (enforced in a transaction in the service layer).

Role capabilities: `owner` — everything incl. delete org, integrations, ENS; `admin` — agents, knowledge, publish, integrations; `member` — view + playground.

### Agents

**agents** *(implemented, migration 0001)* — `id`, `org_id`, `slug` (globally unique, used in public URLs and as the ENS label), `status` (`draft` | `published` | `paused` | `archived`), `published_config_id?`, `created_by`, timestamps.
Unique `(id, org_id)` (target of composite FKs). Slug: `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$`, no `--`, reserved list (platform + impersonation-prone labels). The slug is locked once the agent is first published.
`(published_config_id, id) → agent_configs(id, agent_id)` (hand-written FK): the published version must belong to the same agent.
*Change from the Phase 0 design:* no `name` or `draft_config_id` columns. The name lives in the config, and the draft is "the config with `published_at IS NULL`".

**agent_configs** *(implemented)* — `id`, `org_id`, `agent_id`, `version`, `name`, `description`, `instructions` (≤ 8000), `persona` (≤ 500), `tone` enum, `language` (`auto` or a supported code), `fallback_message` (10–500), `model_id`, `trust_mode` enum, `temperature` (0–1), `max_output_tokens` (128–4096), `retrieval_top_k` (1–20), `published_at?`, `created_by`, `updated_by`, timestamps.
- Composite FK `(agent_id, org_id) → agents(id, org_id)`: a config can't claim another tenant's agent.
- Unique `(agent_id, version)`; partial unique index: **one draft per agent**.
- Trigger `agent_configs_guard_update`: **published rows can't be updated**, and `agent_id` / `org_id` / `version` never change on any row.
- Length/range CHECK constraints mirror the app validation.
- Editing after publish creates a new draft version (max + 1); saves use optimistic concurrency on `updated_at`.

### Knowledge

**knowledge_sources** — `id`, `org_id`, `agent_id`, `type` (`website` | `file` | `faq` | `text`), `title`, `url?`, `file_object_key?`, `file_mime?`, `file_size?`, `crawl_options` jsonb (max pages, include/exclude paths), `status` (`queued` | `processing` | `ready` | `failed` | `deleting`), `last_error?` (safe message), `document_count`, `chunk_count`, `last_indexed_at?`, `created_by`, timestamps.

**knowledge_documents** — `id`, `org_id`, `agent_id`, `source_id → knowledge_sources ON DELETE CASCADE`, `title`, `url?`, `filename?`, `content_sha256`, `token_count`, timestamps.
Unique `(source_id, url)` for crawls.

**knowledge_chunks** — `id`, `org_id`, `agent_id`, `source_id`, `document_id → knowledge_documents ON DELETE CASCADE`, `chunk_index`, `content`, `content_sha256`, `token_count`, `heading_path?`, `page_from?`, `page_to?`, `embedding vector(N)`, `embedding_model`, `created_at`.
Indexes: HNSW `(embedding vector_cosine_ops)`; btree `(agent_id, org_id)`; btree `(document_id)`.

**faq entries** are stored as `knowledge_sources(type='faq')` with one document per Q/A, so they share the pipeline. No extra table.

### Conversations

**conversations** — `id`, `org_id`, `agent_id`, `channel` (`playground` | `web` | `widget` | `discord` | `slack` | `zendesk`), `external_ref?` (e.g. Slack thread ts, Discord channel+user, Zendesk ticket id), `visitor_token_hash?` (anonymous web visitors), `integration_id?`, `config_id` (version used at start), `started_at`, `last_message_at`.
Unique `(integration_id, external_ref)` where not null.

**messages** — `id`, `org_id`, `agent_id`, `conversation_id`, `role` (`user` | `assistant` | `system_notice`), `content`, `citations` jsonb (`[{n, chunk_id, document_id, title, url, heading_path}]`), `inference_id?`, `created_at`.
Index `(conversation_id, created_at)`.

### Inference & verification

**inference_records** — `id`, `org_id`, `agent_id`, `conversation_id`, `config_id`, `model_id`, `trust_mode_requested`, `verify_tee_requested` bool, `status` (`requested` | `completed` | `failed`), `router_request_id?`, `chat_id?` (ZG-Res-Key), `provider_address?`, `input_tokens?`, `output_tokens?`, `cost_neuron` numeric(78,0)?, `latency_ms?`, `error_type?`, `error_code?`, `http_status?`, `requested_at`, `completed_at?`.
Index `(org_id, agent_id, requested_at desc)`.

**verification_records** — `id`, `org_id`, `inference_id → inference_records`, `method` (`router` | `independent`), `status` (`not_requested` | `verified` | `failed` | `unavailable`), `signer_address?`, `signature?`, `signed_text_sha256?`, `response_text_sha256?`, `details` jsonb (non-sensitive), `checked_at`.
Multiple rows per inference allowed (Router result, later independent check).

### Deployment, identity, manifest

**agent_deployments** — `id`, `org_id`, `agent_id`, `config_id`, `manifest_id`, `published_by`, `published_at`, `allowed_origins` text[] (widget), `is_current` bool.
Partial unique index: one `is_current` per agent.

**agent_manifests** — `id`, `org_id`, `agent_id`, `version` (int), `manifest` jsonb (public only), `sha256`, `storage_root_hash?` (0G Storage, post-MVP), `created_at`.
Unique `(agent_id, version)`.

**ens_identities** — `id`, `org_id`, `agent_id`, `mode` (`managed` | `byo`), `name` (full ENS name, unique), `parent_name?` (managed: value of `ENS_PARENT_NAME` at creation), `chain` (`mainnet` | `sepolia`), `owner_address?` (byo: resolved on-chain owner), `status` (`pending_publish` | `active` | `out_of_sync` | `verification_failed` | `cleared`), `published_records` jsonb (last values confirmed on-chain, used to diff), `last_publish_tx_hash?`, `last_resolved_at?`, `last_resolution` jsonb, timestamps.
For `managed` names, record values are derived from the current deployment + manifest (whitelisted public fields only) and written on-chain in founder-approved batches. No free-form record storage.

### Integrations & usage

**integrations** — `id`, `org_id`, `agent_id`, `type` (`discord` | `slack` | `zendesk`), `status` (`pending` | `active` | `error` | `revoked`), `external_workspace_id` (guild id / team id / zendesk subdomain), `credentials_encrypted` bytea (AES-256-GCM, app-level key, never returned to the client), `config` jsonb, `installed_by`, timestamps.
Unique `(type, external_workspace_id)` — one workspace maps to one agent route.

**usage_events** — `id`, `org_id`, `agent_id?`, `kind` (`inference` | `embedding` | `crawl_page`), `quantity`, `input_tokens?`, `output_tokens?`, `cost_neuron?`, `inference_id?`, `created_at`.
Index `(org_id, created_at)`. Monthly rollups are computed via queries (no table until needed).

**rate_limit_buckets** — `key` (e.g. `chat:agent:<id>:ip:<hash>`), `window_start`, `count`. PK `(key, window_start)`. Purged periodically.

## 3. Why each table exists

Every table above maps to a listed requirement. Deliberately **not** created: separate `faq_entries` (reuses sources), `billing_invoices` (no billing yet), `jobs` (Inngest owns job state), `api_keys` for businesses (no public API yet), `ens_records` (records are derived, not stored free-form).

## 4. Data retention defaults (to confirm)

- Conversations/messages: kept 90 days by default, configurable per org; deletable on request.
- Visitor IPs: never stored raw; only salted hashes for rate limiting.
- Raw uploaded files: kept while the source exists; deleted with it.
