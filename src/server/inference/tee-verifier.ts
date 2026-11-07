import { createHash } from "node:crypto";
import { createPublicClient, defineChain, getAddress, http, isAddress, isAddressEqual, isHex, recoverMessageAddress, type Hex } from "viem";
import { CHAT_ID_RE, expectedSigner, getServiceAbi, signatureUrl, type ServiceRecord } from "@/lib/tee-shared";
import { validateCrawlUrl } from "@/server/knowledge/url-policy";

export type { ServiceRecord } from "@/lib/tee-shared";

/**
 * Independent TEE signature verification (no trust in the Router's verdict), following 0G's documented procedure
 * and the official SDK's `processResponse`:
 *   1. Read the provider's Service record from the InferenceServing contract on 0G Chain.
 *   2. Require verifiability (TeeML/TeeTLS) and an on-chain-acknowledged TEE signer.
 *   3. GET {service.url}/v1/proxy/signature/{chatID}?model={service.model}
 *   4. Recover the EIP-191 signer of `text` and compare with the TEE signer.
 *
 * Verified live on 2026-11-06 (mainnet, 0gm-1.0-35b-a3b). LIMITATION: the signed text is
 * `zg-sig-v1/e2ee-ct:<sha256>:<sha256>`, hashes of the end-to-end-encrypted exchange, so it can't be matched to
 * the plaintext we display. What this proves: a TEE signer registered and acknowledged on-chain for this provider
 * signed the exchange identified by this chat ID. It does not prove the displayed text or its correctness.
 */

export type TeeVerification = {
  status: "verified" | "failed" | "unavailable";
  /** Why it isn't verified (safe, non-sensitive), or a note on what verification covers. */
  reason: string;
  signerAddress: string | null;
  details: Record<string, unknown>;
};

export type TeeVerifierDeps = {
  readService: (provider: Hex) => Promise<ServiceRecord>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Signatures can appear a moment after the response; retry a 404 this many times. */
  notFoundRetries?: number;
  retryDelayMs?: number;
};

/** On-chain reader with a short cache (service records change rarely). */
export function chainServiceReader(config: { rpcUrl: string; chainId: number; contract: Hex; cacheMs?: number }) {
  const chain = defineChain({
    id: config.chainId,
    name: "0G",
    nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 8_000 }) });
  const cache = new Map<string, { at: number; value: ServiceRecord }>();
  return async (provider: Hex): Promise<ServiceRecord> => {
    const key = provider.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < (config.cacheMs ?? 10 * 60_000)) return hit.value;
    const s = await client.readContract({ address: config.contract, abi: getServiceAbi, functionName: "getService", args: [provider] });
    const value: ServiceRecord = {
      url: s.url,
      model: s.model,
      verifiability: s.verifiability,
      teeSignerAddress: s.teeSignerAddress,
      teeSignerAcknowledged: s.teeSignerAcknowledged,
      additionalInfo: s.additionalInfo,
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  };
}

export async function verifyTeeSignature(
  deps: TeeVerifierDeps,
  input: { provider: string | null; chatId: string | null },
): Promise<TeeVerification> {
  const none = (reason: string, details: Record<string, unknown> = {}): TeeVerification => ({ status: "unavailable", reason, signerAddress: null, details });
  if (!input.provider || !isAddress(input.provider)) return none("The response didn't identify an on-chain provider.");
  if (!input.chatId || !CHAT_ID_RE.test(input.chatId)) return none("The response didn't include a usable chat ID.");

  let svc: ServiceRecord;
  try {
    svc = await deps.readService(getAddress(input.provider));
  } catch {
    return none("Couldn't read the provider's service record from 0G Chain.");
  }
  const base = { provider: getAddress(input.provider), verifiability: svc.verifiability, serviceModel: svc.model };
  if (svc.verifiability !== "TeeML" && svc.verifiability !== "TeeTLS") {
    return { status: "failed", reason: "The provider's on-chain service isn't marked verifiable.", signerAddress: null, details: base };
  }
  if (!svc.teeSignerAcknowledged) {
    return { status: "failed", reason: "The provider's TEE signer isn't acknowledged on-chain.", signerAddress: null, details: base };
  }
  let signer: string;
  try {
    signer = expectedSigner(svc);
  } catch {
    return { status: "failed", reason: "The provider's on-chain service info is malformed.", signerAddress: null, details: base };
  }
  const url = validateCrawlUrl(signatureUrl(svc, input.chatId));
  if (!url.ok || url.url.protocol !== "https:") return none("The provider's signature endpoint isn't a public https URL.", base);

  const doFetch = deps.fetchImpl ?? fetch;
  type SignaturePayload = { text?: unknown; signature?: unknown };
  let payload = null as SignaturePayload | null;
  for (let attempt = 0; attempt <= (deps.notFoundRetries ?? 2); attempt++) {
    let res: Response;
    try {
      res = await doFetch(url.url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000), headers: { accept: "application/json" } });
    } catch {
      return none("The provider's signature endpoint didn't respond.", base);
    }
    if (res.status === 404 && attempt < (deps.notFoundRetries ?? 2)) {
      await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 1_000));
      continue;
    }
    if (!res.ok) return none(`The provider's signature endpoint returned HTTP ${res.status}.`, base);
    payload = (await res.json().catch(() => null)) as SignaturePayload | null;
    break;
  }
  if (!payload || typeof payload.text !== "string" || typeof payload.signature !== "string" || !isHex(payload.signature)) {
    return none("The provider returned no usable signature.", base);
  }

  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message: payload.text, signature: payload.signature as Hex });
  } catch {
    return { status: "failed", reason: "The signature couldn't be decoded.", signerAddress: signer, details: base };
  }
  const details = {
    ...base,
    signedTextFormat: payload.text.split(":")[0]?.slice(0, 40) ?? null,
    signedTextSha256: createHash("sha256").update(payload.text).digest("hex"),
    recoveredAddress: recovered,
  };
  if (!isAddress(signer) || !isAddressEqual(recovered as Hex, signer as Hex)) {
    return { status: "failed", reason: "The signature doesn't match the provider's on-chain TEE signer.", signerAddress: signer, details };
  }
  return {
    status: "verified",
    reason: "Signature for this chat ID recovered to the provider's TEE signer registered on 0G Chain. It covers the encrypted exchange, not the displayed text.",
    signerAddress: getAddress(signer),
    details,
  };
}
