# ENS Integration

Research date: **2026-11-06** (revised the same day after the founder obtained `alactic.eth`).
**VERIFIED** = read in official ENS docs, or observed on-chain with read-only calls / `eth_call` simulation. **UNVERIFIED** = must be confirmed during Phase 5.

## Sources

- https://docs.ens.domains/ (index: https://docs.ens.eth.limo/llms.txt)
- https://docs.ens.domains/ensv2/overview · /ensv2/subnames/ · /ensv2/tutorial-app-developers · /ensv2/permissioned-registry · /ensv2/permissioned-resolver · /ensv2/registry-hierarchy
- https://docs.ens.domains/learn/deployments
- https://docs.ens.domains/web/subdomains · /resolvers/ccip-read · /web/siwe
- https://docs.ens.domains/ensip/25 · /ensip/26
- https://viem.sh/docs/siwe/utilities/createSiweMessage · https://viem.sh/docs/siwe/actions/verifySiweMessage
- https://github.com/namestonehq/durin

---

## 1. `alactic.eth` — verified on-chain state (2026-11-06)

All checks are read-only RPC calls (public mainnet/Sepolia RPC, viem 2.57.16). No transactions were sent.

| Check | Result |
|---|---|
| Network | **Ethereum mainnet, ENSv2.** Not registered on Sepolia (Sepolia v2 `.eth` registry returns no resolver, expiry 0). |
| ENSv1 registry / BaseRegistrar | owner `0x0`, `available("alactic") = true`. The name does **not** exist in ENSv1. Tools that only read v1 contracts won't see it. |
| ENSv2 path | RootRegistry `0x2553c09b…a91e` → `getSubregistry("eth")` = `.eth` registry `0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2` |
| Token owner | `ownerOf(tokenId)` = **`0x86bE57d9FDE6492C4bDbAf83E639b8EC99fF7b75`** (an EOA; holds balance 1 of the ERC-1155 token). Its primary (reverse) name is `alactic.eth`. **Founder: please confirm this is your wallet.** |
| Expiry | `1825486343` = **2027-11-06 07:32 UTC** (1 year). Renewal must be scheduled. |
| Owner's registry roles on the name | `SET_RESOLVER` (+admin), `SET_SUBREGISTRY` (+admin), `CAN_TRANSFER_ADMIN`. Not `RENEW` (renewal is via the registrar). |
| Subregistry | none (`0x0`) |
| Resolver | `0x38344362245103BC931E57B6001023304Ce59832`, a proxy whose EIP-1967 implementation is `0x565b0f456a04ac9b48758190e90030623cff57c5` = **PermissionedResolverImpl** (matches the official mainnet deployments list). |
| Owner's roles on the resolver | All root roles **and** all admin roles (root-resource bitmap is fully set). |
| Records | `addr` = `0x86bE…7b75`; `description`, `url`, `avatar` unset. |
| Subname resolution | `acme.alactic.eth` and `support.alactic.eth` already resolve to the **same resolver** (ENSv2 "deepest resolver wins": with no subregistry, subnames inherit the parent's resolver). They currently return no records. |
| Write permission (simulation only) | `eth_call` of `setText(dns("acme.alactic.eth"), "description", …)` on the resolver **succeeds from the owner** and **reverts from an unrelated address**. |
| Universal Resolver | viem's default mainnet Universal Resolver (`0xeeeeeeee14d718c2b47d9923deab1335e144eeee`, upgradeable proxy) already resolves this ENSv2 name. The deployments page wording ("mainnet resolution still through ENSv1 until launch") appears to be out of date. **Re-check at Phase 5.** |

**Conclusion:** we can serve agent identities like `acme.alactic.eth` today by writing records on the existing PermissionedResolver. No new contract and no resolver change is needed. **Not yet verified end to end:** a real write followed by resolution of the written record. That needs either a real transaction (approval) or a local mainnet fork (Foundry `anvil`, not installed yet). That test is the first step of Phase 5.

## 2. ENS protocol state — VERIFIED from docs

- ENSv2: resolver setters take **DNS-encoded names**; writes require **Enhanced Access Control (EAC) roles** on the resolver. Ownership of the name alone doesn't grant them. Look the resolver up for each write; don't hardcode it.
- ENSv1 names keep resolving (mirror resolver). Read-only apps only need a current library (viem/wagmi/ethers/ENSjs).
- ENSjs ≥ 5.2.5 has ENSv2 write helpers at `@ensdomains/ensjs/wallet/v2` (latest 5.2.12).
- **PermissionedResolver** (docs): setters `setText(bytes name, string key, string value)`, `setAddress(bytes name, uint256 coinType, bytes addr)`, `setContenthash`, `setData`, `multicall(calls)`. Records are keyed by DNS-encoded name; the first write for a name creates its record bundle. Roles: `ROLE_SET_ADDRESS = 1<<0`, `ROLE_SET_TEXT = 1<<4`, `ROLE_SET_CONTENTHASH = 1<<8`, `ROLE_SET_DATA = 1<<24`, `ROLE_LINK = 1<<28`, `ROLE_UPGRADE = 1<<124`; admin = role `<<128`. Grants: `grantRootRoles(bitmap, account)`, `grantSetterRoles(setterCalldata, account)` (argument-scoped, e.g. to one text key). **Argument-scoped grants apply to every name the resolver serves, not to one name.**
- **Default bundle:** records written for the DNS-encoded empty name `0x00` are served to every name without its own record. **We must never write to `0x00`.** It would make every `*.alactic.eth` label resolve those records.
- Draft agent standards: **ENSIP-26** (`agent-context`, `agent-endpoint[mcp|a2a|web]`) and **ENSIP-25** (`agent-registration[<registry>][<agentId>]`, for ERC-8004-style registries). Both are **Draft**.

## 3. Two kinds of agent identity

The product must always show which kind an agent has.

| | **Alactic-managed subname** | **Business-owned name (BYO)** |
|---|---|---|
| Example | `acme.alactic.eth` | `support.acme.eth`, `acme.eth` |
| Who controls it | **Alactic** (the `alactic.eth` owner and any key it delegates to). The business does **not** own it and cannot transfer it. | **The business** (its wallet holds the name) |
| Who writes the records | Alactic | The business, signing in its own wallet. Alactic only prepares the values. |
| Business needs crypto | No | Yes (gas for the record update) |
| What it proves | "Alactic's platform publishes this agent under its namespace" | "The owner of `acme.eth` endorses this agent" |
| UI label | "Managed by Alactic" | "Owned by 0x… · verified" |
| Revocation | Alactic can change or clear it (e.g. the agent is unpublished or the account is terminated for abuse) | Only the business |

## 4. Permission model for Alactic-managed subnames

### Roles

| Actor | Holds | Use |
|---|---|---|
| **Parent owner** (founder wallet `0x86bE…7b75`, ideally a hardware wallet/multisig later) | `.eth` registry token + resolver root and admin roles | Rare admin actions: renewals, granting/revoking publisher roles, emergency fixes. **Never on a server.** |
| **ENS publisher** (optional, Phase 5b) | Resolver `ROLE_SET_TEXT` scoped via `grantSetterRoles` to the agent keys only (section 5). No `ROLE_SET_ADDRESS`, `ROLE_LINK`, `ROLE_UPGRADE`, no admin roles. | Writes agent records on publish. |
| Business wallet | nothing on `alactic.eth` | — |

### Known limitation of the shared resolver

Argument-scoped roles cover **all names on this resolver**, including `alactic.eth` itself. A publisher key allowed to set `description` for agents could also set `description` on `alactic.eth`. Mitigations:

1. Keep `alactic.eth`'s own profile on keys the publisher cannot write, or move the parent's profile to a separate resolver later.
2. Publisher can only write ENSIP-26 + `<prefix>.*` keys (no `addr`, no `contenthash`, no linking, no upgrade).
3. Every record value is derived server-side from whitelisted public fields; the publisher is never given free-form input.
4. The publisher's roles can be revoked instantly by the parent owner.

Full isolation (each agent label with its own record scope or token) requires **a subregistry for `alactic.eth` (ENSv2 UserRegistry) and/or a dedicated agents resolver instance.** That means deploying contracts and changing configuration, so it is **Phase 5c, approval required.** It is also the path to transferable subnames (a business "claims" its token).

### Rollout

| Stage | What | Needs approval |
|---|---|---|
| **5a (recommended for hackathon)** | Records written to the existing PermissionedResolver for `<slug>.alactic.eth`. The app builds a `multicall` of `setText` calls; **the founder signs it in the browser** from an admin "ENS publishing" screen. No hot key on the server. | Each batch is a mainnet tx (gas): founder signs each one |
| 5b | Grant a dedicated publisher key scoped `ROLE_SET_TEXT` (agent keys only); server publishes automatically on agent publish, with a spend cap | Granting the role (tx) + key custody |
| 5c | `alactic.eth` subregistry (UserRegistry) + agents resolver; per-agent tokens; optional transfer to business | Contract deployment + `setSubregistry()` |
| Alternative | CCIP-Read offchain resolver for subnames (no gas per update, trusted gateway) | Deployment + resolver change |

**Recommendation:** 5a for the hackathon (a handful of agents, fully on-chain, no new trust assumptions), designed so 5b/5c only change the "writer" component.

### Label policy

- Labels = agent slugs: `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$`, ENS-normalized (`viem/ens` `normalize`), globally unique in our DB.
- Reserved: `www`, `app`, `api`, `admin`, `support`, `help`, `docs`, `status`, `mail`, `alactic`, `ens`, `wallet`, `team`, `security`, plus a brand/impersonation blocklist; manual review for well-known brands. (`support.alactic.eth` is therefore reserved for Alactic's own support agent.)
- **Every label resolves to the parent's resolver**, even ones we never assigned. Clients must treat a subname as an Alactic agent **only if** it carries our records (`agent-endpoint[web]` + manifest hash). The identity page checks this.
- When an agent is unpublished or deleted, its records are cleared in the next publish batch.

## 5. Records published per agent

Public data only, permanent in chain history. **Never** prompts, documents, secrets, internal config, or source URLs.

| Key | Value | Standard |
|---|---|---|
| `agent-context` | Short Markdown: what the agent does, operator org, "Managed by Alactic" or owner, trust mode, manifest URL, accuracy disclaimer | ENSIP-26 (draft) |
| `agent-endpoint[web]` | `https://<app-domain>/a/<slug>` | ENSIP-26 (draft) |
| `description` | one-line description | ENSIP-5 |
| `url` | same as web endpoint | ENSIP-5 |
| `<prefix>.manifest` | `https://<app-domain>/api/public/agents/<slug>/manifest.json` | custom |
| `<prefix>.manifest-sha256` | SHA-256 of the current manifest JSON | custom |
| `<prefix>.operator` | business wallet address (managed names only) | custom |

`<prefix>` = reverse-DNS of Alactic's production domain (open question), per ENSIP-5's convention for service keys. **No `addr` record** on managed subnames: the agent has no wallet, and an address would invite people to send funds. `avatar` is optional, added later.

Cost control: one `multicall` per publish (or per batch of agents); only changed keys are written (diff against the last-published values stored in `ens_identities`).

## 6. Configuration (no hardcoded parent or network)

```
ENS_PARENT_NAME=alactic.eth          # parent for managed subnames
ENS_CHAIN=mainnet                    # mainnet | sepolia
ENS_RPC_URL=...                      # server-side RPC for reads/verification
ENS_RECORD_PREFIX=<reverse-domain>   # e.g. com.example (open question)
ENS_PUBLISH_MODE=manual              # manual (founder signs) | publisher-key (5b) | disabled
```

- The resolver address is **looked up at write time** (`getEnsResolver(parent)`), never configured or hardcoded. The UI refuses to build a publish batch if the resolver isn't a PermissionedResolver we've validated.
- Network switch changes chain + RPC only. A Sepolia test parent can be used for development once one exists (registering it needs approval).
- The ENS module is behind an interface (`EnsIdentityWriter`: `prepareBatch()` / `submit()` / `verify()`), so 5a → 5b → 5c or CCIP-Read are swappable.

## 7. Resolution & verification in the app

- Reads use viem `getEnsText` / `getEnsAddress` / `getEnsResolver` (Universal Resolver, CCIP-Read capable).
- The public identity page `/a/<slug>/identity` resolves live from ENS, compares with the current manifest hash, and shows **in sync / pending publish / out of sync**. It never shows DB values as if they were on-chain.
- BYO verification: resolve `agent-endpoint[web]` and `<prefix>.manifest-sha256` on the business name; verified only if both point to this agent. Store the name's on-chain owner at verification time and re-check periodically.

## 8. Sign-In with Ethereum (SIWE)

**VERIFIED:** viem ships `createSiweMessage`, `generateSiweNonce`, `parseSiweMessage` (`viem/siwe`) and the public action `verifySiweMessage({ message, signature, address?, domain?, nonce?, scheme?, time?, blockNumber/blockTag/blockHash? })`. Block params exist for smart-contract-account signatures. **UNVERIFIED:** EIP-1271/6492 handling; test with a smart wallet.

Flow (implemented in Phase 1):

1. `POST /api/auth/nonce` → random nonce stored in `auth_nonces` (5-min expiry), bound to a short-lived pre-session cookie.
2. Client builds the EIP-4361 message (domain = configured host, uri = configured origin, chainId, nonce, issuedAt, expirationTime ≤ 10 min) and the wallet signs.
3. `POST /api/auth/verify`: parse; check domain/uri against **configured** values; chainId allowlist; nonce consumed atomically (single use); `verifySiweMessage`; upsert user + wallet; create DB session; set `HttpOnly; Secure; SameSite=Lax` cookie.
4. The address is taken only from the session afterwards. ENS name/avatar of the user is display-only.

## 9. What ENS does and does not give us

- **Does:** a public, resolvable identity; discovery of the public endpoint and manifest; for BYO names, proof the name owner endorses the agent.
- **Does not:** prove an agent is safe or correct, or (for managed names) prove business ownership. It doesn't protect against a compromised parent-owner wallet; that wallet's security is critical.

## 10. Actions requiring founder approval

- Any transaction: record writes (each 5a batch), role grants (5b), contract deployments or `setSubregistry()`/`setResolver()` changes (5c / CCIP-Read), renewals, registering any additional name (including a Sepolia test name).
- Creation and custody of any publisher key.

## 11. Open questions

1. Confirm `0x86bE57d9FDE6492C4bDbAf83E639b8EC99fF7b75` is your wallet, and consider moving the name to a hardware wallet or multisig before production.
2. Renewal before **2027-11-06** — set a reminder or extend now?
3. Production domain → `ENS_RECORD_PREFIX` and public URLs.
4. Is gas per publish batch (5a) acceptable for the hackathon, or do you want 5b/5c/CCIP-Read sooner?
5. Do you want a Sepolia test parent for development, or should we test writes on a local mainnet fork only (no approval needed; requires installing Foundry)?
6. ENSIP-25/ERC-8004 registration as a stretch goal?
