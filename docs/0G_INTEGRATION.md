# 0G Integration

Research date: **2026-11-06**. Everything marked **VERIFIED** was read in official 0G docs or observed live from the public Router API on that date. Everything marked **ASSUMPTION** or **UNVERIFIED** must be confirmed before or during Phase 4.

## Sources

- https://build.0g.ai/llms.txt
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/overview
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/authentication
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/models
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/routing
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/chat-completions
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/privacy
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/errors
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/rate-limits
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/account/deposits
- https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk
- Live: `GET https://router-api.0g.ai/v1/models`, `GET https://router-api.0g.ai/v1/providers?model=<id>`

---

## 1. Decision: use the 0G Compute Router

The Router (`pc.0g.ai`) is 0G's primary, documented path for Compute. It gives us:

- One OpenAI-compatible endpoint and one API key for the whole catalog.
- Server-side routing, failover, and on-chain settlement handled by 0G.
- An explicit **trust mode** (`standard` / `verified` / `private`) we can pin per request.
- TEE signature verification reported in the response (`verify_tee`).

The alternative ("Direct"/"Advanced" mode) connects a wallet straight to a provider through the broker SDK. It would require Alactic to hold a funded wallet private key on the server and manage per-provider sub-accounts. That is more operational and security burden than an MVP needs. We keep the broker SDK only as an **optional tool for independent verification** (section 6).

## 2. Endpoints and authentication — VERIFIED

| Item | Value |
|---|---|
| Mainnet API base | `https://router-api.0g.ai/v1` |
| Testnet API base | `https://router-api-testnet.integratenetwork.work/v1` |
| Web UI | `pc.0g.ai` (mainnet), `pc.testnet.0g.ai` (testnet) |
| Chat | `POST /v1/chat/completions` — "Fully compatible with the OpenAI Chat Completions API", streaming via OpenAI SSE format |
| Models | `GET /v1/models` — public, no auth |
| Providers | `GET /v1/providers?model=<id>` — public, returns per-provider `verifiability`, `trust_mode`, `tee_attested`, `is_healthy`, `latency` |
| Auth header | `Authorization: Bearer sk-...` |

Key types:

- `sk-` **API key**: inference only, billed against the account deposit. Full secret shown once.
- `mk-` **management key**: account and key management, scoped (`account:read`, `keys:read`, `keys:manage`, …). Not billed.

0G explicitly says: *"Never ship keys to browsers"* — proxy through your backend. Alactic keeps `ZG_ROUTER_API_KEY` server-side only.

Mainnet and testnet are separate environments with separate keys and balances.

**UNVERIFIED:** The testnet Router base URL did not respond from our environment on 2026-11-06 (connection failure, HTTP 000). The testnet UI host `pc.testnet.0g.ai` did respond (200). We need to confirm testnet Router availability before relying on it for development.

**UNVERIFIED:** `/v1/embeddings` is not documented on the Router pages we read. A `POST /v1/embeddings` without a key returned `{"error":{"message":"missing API key","type":"gateway_error"}}` rather than a 404, and the catalog lists models of `type: "embedding"`. This strongly suggests the route exists, but we must confirm with an authenticated request in Phase 3/4.

## 3. Request controls — VERIFIED

Routing headers (case-insensitive):

| Header | Values | Notes |
|---|---|---|
| `X-0G-Provider-Trust-Mode` | `standard` \| `verified` \| `private` | Restricts eligible providers. **We always send this explicitly.** |
| `X-0G-Provider-Sort` | `latency` \| `price` | Ignored when Address is set |
| `X-0G-Provider-Address` | `0x…` | Pins one provider. Fallback is **off** by default when pinned |
| `X-0G-Provider-Identity` | e.g. `aliyun` | Filters by upstream channel. Operator-declared, **not attested** |
| `X-0G-Provider-Allow-Fallbacks` | `true` \| `false` | Default `true` (or `false` when pinned) |
| `X-0G-Provider-Max-Price-Usd-Prompt` / `-Completion` / `-Image` | number | Hard price ceilings |

Body extensions (stripped before forwarding to the provider):

- `verify_tee: true` — ask the Router to verify the provider's TEE signature.
- `plugins: [{"id":"web"}]` — web search. **We will not enable this**; support answers must come from the business's knowledge.
- `provider` — deprecated, do not use.
- For GLM models: `chat_template_kwargs: {"enable_thinking": false}` disables thinking.

## 4. Response metadata — VERIFIED (non-streaming)

Every Router response carries an `x_0g_trace` object:

```json
"x_0g_trace": {
  "request_id": "...",
  "provider": "0x… (on-chain provider address)",
  "billing": { "input_cost": "...", "output_cost": "...", "total_cost": "..." },
  "tee_verified": true
}
```

- Billing values are in **neuron** (1e18 neuron = 1 0G).
- `tee_verified` is present only when `verify_tee` was requested:
  - `true` — provider TEE signature validated.
  - `false` — signature present but did not verify. **Treat the response as untrusted.**
  - `null`/absent — not requested.
- The `chatID` needed for independent verification comes from the **`ZG-Res-Key` response header**, falling back to the body `id`.
- Rate-limit headers: `X-RateLimit-Limit-Requests`, `X-RateLimit-Remaining-Requests`, `X-RateLimit-Reset-Requests`.

**UNVERIFIED:** The docs do not say whether `x_0g_trace` (and therefore `tee_verified`) is emitted in **streaming** responses. Phase 4 starts with a spike to check this. If it is not available while streaming, verified/private agents will use non-streaming requests (or stream and then fetch verification separately, if 0G supports that).

## 5. Trust modes and privacy — VERIFIED

| Mode | Eligible providers | What it actually guarantees | What it does NOT guarantee |
|---|---|---|---|
| `private` | TeeML only | Model runs inside an Intel TDX enclave. Prompts enter encrypted; the host, 0G and the hardware operator cannot see data. Responses signed inside the enclave. Enclaves publish hardware attestation verifiable with dstack. | That the answer is correct. That our own server (which builds the prompt) is trusted — Alactic still sees plaintext. |
| `verified` | TeeML + TeeTLS | Response comes with verifiable proof it was produced by the real model/provider. With TeeTLS, 0G's broker runs in a TEE and relays over attested TLS. | Privacy from the upstream provider: with TeeTLS **the upstream provider processes the prompt under its own data policy**. |
| `standard` | All providers, incl. third-party channels | Broadest model access. | No attestation, no signature. Upstream provider is not disclosed. Cannot be verified. |

Router-level retention (all modes): prompts and completions are handled **in memory for the life of the request** and never written to storage. The Router retains only billing/usage metadata: request ID, wallet address, model, provider, token counts, trust tier, cost, timestamp.

Critical behaviours:

- If no provider satisfies the trust mode, the Router returns **HTTP 503, code `no_provider_for_trust_mode`**. It **never silently falls back** to a lower tier. Alactic must surface this as an understandable error and must not retry in a lower mode.
- If **no** trust mode is set, any provider (including `standard`) may serve the request. **Alactic therefore always sends `X-0G-Provider-Trust-Mode`.**
- The model list shows each model under its highest-capability provider, which can mislead. Example observed live: `glm-5.3` has one TeeML provider (0G Foundation) **and** two `standard` providers (Baidu, Tencent channels). Without a pinned trust mode, a `glm-5.3` request could run on Baidu or Tencent.

Privacy language Alactic must use in the UI and docs:

- Say **"Private (TEE)"** only for `private` mode.
- Never say "all inference is private".
- Distinguish: *trusted execution* (TEE isolates computation), *encrypted transport* (TLS/attested TLS protects data in transit), *provider data handling* (what the upstream provider may do with data — relevant for TeeTLS and standard), and *retention* (Router keeps billing metadata only; **Alactic itself stores conversations** in our database, which is our responsibility).

## 6. Verifiable execution — VERIFIED

How it works: every 0G Compute provider runs in a TEE and signs its responses. With `verify_tee: true` the Router verifies that signature and reports `tee_verified`.

Trust limitation stated by 0G: `tee_verified` is a single boolean computed by the Router; the raw signature is not returned. **Trusting it means trusting the Router.**

Independent verification (documented procedure):

1. Read the provider's service record from the on-chain `Service` contract → `url`, `teeSignerAddress`, `verifiability`. If `additionalInfo.targetSeparated` is true, the signer is `additionalInfo.targetTeeAddress`.
2. `GET {url}/v1/proxy/signature/{chatID}?model={model}` → `{ text, signature }`.
3. Verify `signature` as EIP-191 `personal_sign` over `text` against the signer address.
4. Confirm the signed `text` matches the response content we received.

The TS SDK wraps this: `@0gfoundation/0g-compute-ts-sdk` (npm latest **0.9.0**, modified 2026-10-21) → `broker.inference.processResponse(providerAddress, chatID)` returns `true` / `false` / `null` (no verifiable TEE service).

**UNVERIFIED for Phase 4:** the Service contract address and chain for step 1, whether the SDK needs a funded signer just to call `processResponse`, and the exact format of `text` (step 4 comparison).

### Alactic verification state machine

We store each step separately so the UI never overstates trust:

```
inference.status:      requested → completed | failed
verification.status:   not_requested     (standard mode, or verify_tee not sent)
                       router_verified   (x_0g_trace.tee_verified === true)
                       router_failed     (tee_verified === false → response flagged untrusted)
                       unavailable       (requested but tee_verified null/absent, or streaming without trace)
                       independently_verified | independent_failed   (Phase 4 stretch: our own EIP-191 check)
```

UI rules:

- Green "TEE verified" badge **only** for `router_verified` or `independently_verified`, and the tooltip must say who verified (Router vs Alactic).
- `router_failed` → visible warning, and the message is marked untrusted.
- Every badge carries the disclaimer: *"Verification proves which TEE-hosted model produced this response. It does not prove the response is factually correct."*

## 7. Models — VERIFIED live (2026-11-06)

`GET /v1/models` returned **125** models. Only a small subset is TEE-capable:

| Model | Type | Verifiability | TEE | Context | Providers | Healthy now | Price (USD/token, prompt / completion) | Tools |
|---|---|---|---|---|---|---|---|---|
| `glm-5.3` | chatbot | TeeML (+2 standard channels) | — | 1,179,648 | 3 | TeeML provider healthy | 0.0000014 / 0.0000044 | yes |
| `0gm-1.0-35b-a3b` | chatbot | TeeML | TDX / dstack | 262,144 | 1 | healthy | 0.00000008 / 0.00000048 | yes |
| `0gm-1.0-35b-a3b-sia` | chatbot | TeeML | TDX / dstack | 32,768 | 1 | — | 0.000000536 / 0.000003216 | no |
| `qwen3-embedding-0.6b` | embedding | TeeML | TDX | 32,768 | 1 | **unhealthy** | 0.000000005 | — |
| `qwen3-embedding-8b` | embedding | TeeML | TDX | 32,768 | 1 | **unhealthy** | 0.00000001 | — |
| `qwen3.7-text-embedding` | embedding | TeeTLS (Aliyun) | TDX | 128,000 | 1 | healthy | 0.000000105 | — |

All other ~98 chat models (Claude, DeepSeek, Qwen, …) have no `verifiability`, so they are only reachable in `standard` mode.

Implications:

- **Default chat model:** `glm-5.3` with trust mode `private`. Low-cost alternative: `0gm-1.0-35b-a3b`. Both are pinned TeeML. Final choice after a quality/latency test in Phase 4.
- **Availability risk:** each TeeML model has exactly **one** TeeML provider. If it goes down, private-mode agents return 503. That is correct behaviour (no silent downgrade). The UI must explain it and the agent's fallback message must be shown.
- **Model availability changes.** Alactic must read `/v1/models` and `/v1/providers` at runtime (cached a few minutes) to show which trust modes a model currently supports, rather than hardcoding a list.

## 8. Errors — VERIFIED

OpenAI-style body `{ error: { message, type, code }, request_id }`.

| HTTP | Code(s) | Alactic handling |
|---|---|---|
| 400 | `invalid_body`, `invalid_provider_header`, `no_provider_within_max_price`, … | Bug or config error. Do not retry. Log `request_id`. |
| 401 | `missing_authorization`, `invalid_api_key`, `api_key_revoked` | Platform config error. Alert operator. Do not retry. |
| 402 | `insufficient_balance` | Platform balance empty. Alert operator. Show "temporarily unavailable". |
| 403 | `access_denied` | Config error. |
| 429 | `rate_limit_exceeded` | Honour `Retry-After`. Never tight-loop. |
| 502 | `provider_error` | Router already failed over. One bounded retry max. |
| 503 | `no_available_provider`, `no_provider_for_trust_mode` | Do not downgrade. Show the agent's fallback message with an "AI temporarily unavailable in Private mode" explanation. |

## 9. Billing — VERIFIED

- Deposit 0G tokens to the 0G Payment Layer contract (mainnet `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32`, testnet `0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939`), most easily via pc.0g.ai → Dashboard → Deposit.
- `total_cost = input_tokens × prompt_price + output_tokens × completion_price`. No Router markup.
- When balance hits zero → `402 insufficient_balance`.
- Rate limits are per account, numbers not published; per-key limits "on the roadmap".

**Requires founder approval:** depositing funds. In the MVP, Alactic (the platform) holds one Router account and pays for all inference. Businesses do **not** need tokens. Per-business billing/metering is recorded in our `usage_events` table for later.

## 10. 0G Storage — researched, deferred

- SDK: `@0gfoundation/0g-storage-ts-sdk` (npm latest **1.2.13**), peer dep `ethers`.
- Upload: `ZgFile`/`MemData` → `merkleTree()` → `indexer.upload(file, RPC_URL, signer)` → `{ rootHash, txHash }`. Requires a funded signer (gas + storage fee).
- Download with Merkle proof verification: `indexer.download(rootHash, path, true)` or `downloadToBlob(rootHash, { proof: true })`.
- Client-side encryption (SDK ≥ 1.2.6): `aes256` or `ecies`. A wrong key returns ciphertext silently.
- Testnet: EVM RPC `https://evmrpc-testnet.0g.ai`, Turbo indexer `https://indexer-storage-testnet-turbo.0g.ai`. Mainnet endpoints and chain IDs were not on that page.

Plan (post-MVP, needs approval because it signs transactions):

- Upload **public agent manifests** (no secrets) and record `rootHash` in the manifest history and an ENS text record.
- Optionally upload **encrypted** knowledge snapshots (AES key held by the business, never plaintext).
- The live RAG index stays in Postgres + pgvector.

## 10b. Implemented (Phase 2)

- `src/server/inference/catalog.ts` reads the public `GET /v1/models` and `GET /v1/providers?model=` (no key), cached with `cacheLife("minutes")`. Parsing and validation are pure functions in `catalog-parse.ts`, with tests built from live response shapes.
- Trust capability per model comes from `verifiability`: TeeML → private/verified/standard, TeeTLS → verified/standard, none/unknown → standard only.
- Live availability is computed per trust mode from providers that report `is_healthy: true` (unknown health counts as unhealthy). It is shown as a point-in-time hint, never as a guarantee.
- Agent model/trust changes are validated server-side against the live catalog. If the catalog can't be reached, changes are refused rather than assumed valid.

## 10d. LIVE findings (mainnet, 2026-11-06, `scripts/zg-live-check.mjs`)

These override the doc-based statements above where they differ.

| Topic | Docs said | Observed live |
|---|---|---|
| `tee_verified` | Added to `x_0g_trace` when `verify_tee: true` | **Absent** in every response (body flag and `?verify_tee=true` both tried, chat and stream). The Router gives no verdict, so we verify independently (below). |
| Independent verification | Service contract → `/v1/proxy/signature/{chatID}` → EIP-191 | **Works.** Mainnet InferenceServing `0x47340d900bdFec2BD393c626E12ea0656F938d84` on chain 16661 (`https://evmrpc.0g.ai`), `getService(provider)` gives the URL, model, TeeML and acknowledged signer. The signature recovers to the signer. |
| What is signed | "Confirm the signed text matches the response content" | Signed text is `zg-sig-v1/e2ee-ct:<sha256>:<sha256>`, hashes of the **end-to-end-encrypted** exchange. None of our plaintext artifacts hash to them, so **we can't bind the signature to the displayed words.** UI wording reflects this. |
| `ZG-Res-Key` | chatID header | Present |
| Billing units | neuron | `{"currency":"usd", "total_cost_usd_micro": "…"}`, i.e. USD micro-units. Stored as `cost_amount` + `cost_unit`. |
| Streaming | Unknown | Final SSE chunk carries `x_0g_trace` (`choices: []`), so streaming is viable later. |
| Thinking models | `enable_thinking:false` documented for GLM-5 | `0gm-1.0-35b-a3b` spends `max_tokens` on reasoning unless disabled. `glm-5.3` **leaked reasoning into `content`** (`…</think>Answer`) even when disabled. We send the toggle for models whose catalog lists `chat_template_kwargs`, and strip `</think>` prefixes. |
| Errors | Documented list | Also seen: `429 model_overloaded` (upstream, `Retry-After: 30`), `403 trust_mode_mismatch` (key restricted to `private`; good defense in depth). |
| Embeddings | — | `qwen3-embedding-0.6b` private: 1024 dims, ~4 s for one input, 1 USD-micro. |
| Performance | — | `0gm-1.0-35b-a3b` ~1.4–2.5 s, ~20–40 USD-micro per short answer. `glm-5.3` ~7 s, ~324 USD-micro, intermittently overloaded. **Default model switched to `0gm-1.0-35b-a3b`.** |
| Rate limits | Per account | `X-RateLimit-Limit-Requests: 500` per minute on this key |

## 10c. Implemented (Phase 4)

- `src/server/inference/router-client.ts`: `POST /v1/chat/completions`, **non-streaming** (the verification evidence `x_0g_trace` is only documented on non-streaming responses), `max_tokens`, `Authorization: Bearer`, `X-0G-Provider-Trust-Mode` on every request, `verify_tee: true` for private/verified, `chat_template_kwargs.enable_thinking=false` for `glm-*` (documented for GLM-5). chatID = `ZG-Res-Key` header, else body `id`. Typed errors per §8. The only retry is one after a 502 `provider_error`, same trust mode.
- Verification mapping: not requested → `not_requested`; `tee_verified` true → `verified` (method `router`); false → `failed`, and **the response is withheld and the fallback shown**; null/absent → `unavailable`. Stored in `verification_records`, with no message content.
- Cost guard: `INFERENCE_DAILY_ORG_LIMIT` (default 500 AI responses per org per UTC day), counted from `inference_records`.
- Tested: unit tests against recorded response shapes, the runtime against Postgres with a fake Router (every verification outcome, 503 without downgrade, daily cap, tenant isolation), and a browser E2E against a **local mock** Router to check the UI and that trust headers and `verify_tee` reach the wire.
- **Not yet verified live** (needs `ZG_ROUTER_API_KEY`): real `x_0g_trace`/`tee_verified` values, `ZG-Res-Key`, `usage` field names, latency of `glm-5.3` vs `0gm-1.0-35b-a3b`, and whether streaming responses carry the trace.
- **Independent verification implemented** (`tee-verifier.ts`, live-tested): on-chain service lookup (cached 10 min), verifiability + acknowledged-signer checks, `TargetSeparated` rule from the SDK, https-only public signature endpoint, 404 retry, EIP-191 recovery. Both the Router and independent results are stored; a failure from either withholds the answer.

## 11. Open questions

1. Is the testnet Router usable for development, or do we develop against mainnet with a small deposit?
2. Is `/v1/embeddings` officially supported, and when will the TeeML embedding provider be healthy?
3. Is `x_0g_trace` available on streamed responses?
4. Service contract address/chain and SDK requirements for independent verification.
5. Is per-request `X-0G-Provider-Trust-Mode` enough, or should we also create a dedicated `private` API key (defence in depth)? **Recommendation:** use separate keys per trust tier where possible, plus the header.
