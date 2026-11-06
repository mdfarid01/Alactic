import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  isHex,
  recoverMessageAddress,
  type Hex,
} from "viem";
import { mainnet, sepolia } from "viem/chains";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import type { Database } from "@/server/db/client";
import { authNonces } from "@/server/db/schema";
import { sha256Hex } from "./tokens";

export const NONCE_TTL_MS = 5 * 60 * 1000;
/** Maximum lifetime of a SIWE message we accept (issuedAt → expirationTime). */
export const MAX_MESSAGE_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

export type SiweConfig = {
  /** Canonical app origin, e.g. https://app.example.com */
  origin: URL;
  allowedChainIds: readonly number[];
  /**
   * Verifies a signature from a smart-contract wallet (EIP-1271 / EIP-6492), which needs an RPC call.
   * Plain wallets (EOAs) are verified locally by signature recovery and never reach this function.
   */
  verifyContractSignature: (args: {
    chainId: number;
    message: string;
    signature: Hex;
    address: Hex;
    nonce: string;
    domain: string;
    now: Date;
  }) => Promise<boolean>;
  now?: () => Date;
};

export type SiweFailure =
  | "malformed_message"
  | "domain_mismatch"
  | "uri_mismatch"
  | "unsupported_chain"
  | "invalid_timing"
  | "invalid_nonce"
  | "invalid_signature";

export type SiweResult =
  | { ok: true; address: Hex; chainId: number }
  | { ok: false; reason: SiweFailure };

/** Issue a single-use nonce bound to the caller's pre-session cookie value. */
export async function issueNonce(db: Database, preSessionToken: string, now = new Date()) {
  const nonce = generateSiweNonce();
  await db.insert(authNonces).values({
    nonce,
    preSessionHash: sha256Hex(preSessionToken),
    expiresAt: new Date(now.getTime() + NONCE_TTL_MS),
  });
  return { nonce, expiresAt: new Date(now.getTime() + NONCE_TTL_MS) };
}

/**
 * Verify a signed EIP-4361 message.
 *
 * Order matters: cheap structural checks first, then the nonce is consumed atomically (so a message can
 * never be used twice, even concurrently), then the signature is checked.
 * The address is taken from the signed message, never from anything else the client sends.
 */
export async function verifySiweSignIn(
  db: Database,
  config: SiweConfig,
  input: { message: string; signature: string; preSessionToken: string },
): Promise<SiweResult> {
  const now = config.now?.() ?? new Date();

  if (input.message.length > 4096 || !isHex(input.signature) || input.signature.length > 20_000) {
    return { ok: false, reason: "malformed_message" };
  }

  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(input.message);
  } catch {
    return { ok: false, reason: "malformed_message" };
  }
  const { address, domain, uri, nonce, chainId, version, issuedAt, expirationTime, scheme } = parsed;
  if (!address || !isAddress(address) || !domain || !uri || !nonce || !chainId || version !== "1") {
    return { ok: false, reason: "malformed_message" };
  }

  // Domain / origin binding: compare with the configured origin, not with request headers.
  if (domain !== config.origin.host) return { ok: false, reason: "domain_mismatch" };
  if (scheme && `${scheme}:` !== config.origin.protocol) return { ok: false, reason: "domain_mismatch" };
  let uriOrigin: string;
  try {
    uriOrigin = new URL(uri).origin;
  } catch {
    return { ok: false, reason: "uri_mismatch" };
  }
  if (uriOrigin !== config.origin.origin) return { ok: false, reason: "uri_mismatch" };

  if (!config.allowedChainIds.includes(chainId)) return { ok: false, reason: "unsupported_chain" };

  // Freshness: require a short-lived message.
  if (!issuedAt || !expirationTime) return { ok: false, reason: "invalid_timing" };
  const t = now.getTime();
  if (
    issuedAt.getTime() > t + CLOCK_SKEW_MS ||
    issuedAt.getTime() < t - MAX_MESSAGE_TTL_MS ||
    expirationTime.getTime() <= t ||
    expirationTime.getTime() - issuedAt.getTime() > MAX_MESSAGE_TTL_MS
  ) {
    return { ok: false, reason: "invalid_timing" };
  }
  if (!validateSiweMessage({ message: parsed, domain: config.origin.host, nonce, time: now })) {
    return { ok: false, reason: "invalid_timing" };
  }

  // Consume the nonce atomically. Single use; must belong to this browser's pre-session; must be unexpired.
  const consumed = await db
    .update(authNonces)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authNonces.nonce, nonce),
        eq(authNonces.preSessionHash, sha256Hex(input.preSessionToken)),
        isNull(authNonces.consumedAt),
        gt(authNonces.expiresAt, now),
      ),
    )
    .returning({ nonce: authNonces.nonce });
  if (consumed.length !== 1) return { ok: false, reason: "invalid_nonce" };

  const signature = input.signature as Hex;
  const claimed = getAddress(address);

  // EOA fast path: local ECDSA recovery, no network.
  let recovered: Hex | undefined;
  try {
    recovered = await recoverMessageAddress({ message: input.message, signature });
  } catch {
    recovered = undefined;
  }
  if (recovered && isAddressEqual(recovered, claimed)) {
    return { ok: true, address: claimed, chainId };
  }

  // Smart-contract wallets: EIP-1271 / EIP-6492 via RPC on the message's chain.
  try {
    const valid = await config.verifyContractSignature({
      chainId,
      message: input.message,
      signature,
      address: claimed,
      nonce,
      domain: config.origin.host,
      now,
    });
    if (valid) return { ok: true, address: claimed, chainId };
  } catch {
    // Fall through: treat RPC/verification errors as invalid, never as success.
  }
  return { ok: false, reason: "invalid_signature" };
}

/** Production smart-wallet verifier using viem's `verifySiweMessage` (ERC-6492 universal validator). */
export function rpcContractSignatureVerifier(rpcUrls: Partial<Record<number, string | undefined>>) {
  const chains = { [mainnet.id]: mainnet, [sepolia.id]: sepolia } as const;
  return async (args: Parameters<SiweConfig["verifyContractSignature"]>[0]) => {
    const chain = chains[args.chainId as keyof typeof chains];
    if (!chain) return false;
    const client = createPublicClient({ chain, transport: http(rpcUrls[args.chainId]) });
    return client.verifySiweMessage({
      message: args.message,
      signature: args.signature,
      address: args.address,
      nonce: args.nonce,
      domain: args.domain,
      time: args.now,
    });
  };
}

/** Housekeeping: drop expired or consumed nonces. */
export async function purgeNonces(db: Database, now = new Date()) {
  await db
    .delete(authNonces)
    .where(or(lt(authNonces.expiresAt, now), lt(authNonces.consumedAt, new Date(now.getTime() - NONCE_TTL_MS))));
}
