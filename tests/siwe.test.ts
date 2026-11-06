import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { issueNonce, verifySiweSignIn, type SiweConfig } from "@/server/auth/siwe";
import { setupTestDb } from "./helpers/db";

const db = setupTestDb();
const ORIGIN = new URL("https://app.alactic.test");
const NOW = new Date("2026-11-06T12:00:00Z");

function config(overrides: Partial<SiweConfig> = {}): SiweConfig {
  return {
    origin: ORIGIN,
    allowedChainIds: [1, 11155111],
    verifyContractSignature: vi.fn(async () => false),
    now: () => NOW,
    ...overrides,
  };
}

async function signedMessage(opts: {
  preSession?: string;
  domain?: string;
  uri?: string;
  chainId?: number;
  issuedAt?: Date;
  expirationTime?: Date | null;
  nonce?: string;
} = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const preSession = opts.preSession ?? "pre-session-token-a";
  const nonce = opts.nonce ?? (await issueNonce(db, preSession, NOW)).nonce;
  const message = createSiweMessage({
    address: account.address,
    chainId: opts.chainId ?? 1,
    domain: opts.domain ?? ORIGIN.host,
    uri: opts.uri ?? ORIGIN.origin,
    nonce,
    version: "1",
    statement: "Sign in to Alactic.",
    issuedAt: opts.issuedAt ?? NOW,
    expirationTime: opts.expirationTime === null ? undefined : (opts.expirationTime ?? new Date(NOW.getTime() + 5 * 60_000)),
  });
  const signature = await account.signMessage({ message });
  return { account, message, signature, preSession };
}

describe("SIWE sign-in", () => {
  it("accepts a valid, fresh, correctly bound message", async () => {
    const { account, message, signature, preSession } = await signedMessage();
    const result = await verifySiweSignIn(db, config(), { message, signature, preSessionToken: preSession });
    expect(result).toEqual({ ok: true, address: account.address, chainId: 1 });
  });

  it("rejects replay of the same message (nonce is single-use)", async () => {
    const { message, signature, preSession } = await signedMessage();
    const first = await verifySiweSignIn(db, config(), { message, signature, preSessionToken: preSession });
    const second = await verifySiweSignIn(db, config(), { message, signature, preSessionToken: preSession });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "invalid_nonce" });
  });

  it("rejects concurrent replays: only one of two simultaneous attempts succeeds", async () => {
    const { message, signature, preSession } = await signedMessage();
    const results = await Promise.all([
      verifySiweSignIn(db, config(), { message, signature, preSessionToken: preSession }),
      verifySiweSignIn(db, config(), { message, signature, preSessionToken: preSession }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("rejects a nonce issued to a different browser (pre-session)", async () => {
    const { message, signature } = await signedMessage({ preSession: "victim-pre-session" });
    const result = await verifySiweSignIn(db, config(), { message, signature, preSessionToken: "attacker-pre-session" });
    expect(result).toEqual({ ok: false, reason: "invalid_nonce" });
  });

  it("rejects a nonce that was never issued", async () => {
    const { message, signature, preSession } = await signedMessage({ nonce: "notissuednonce12345" });
    const result = await verifySiweSignIn(db, config(), { message, signature, preSessionToken: preSession });
    expect(result).toEqual({ ok: false, reason: "invalid_nonce" });
  });

  it("rejects an expired nonce even if the message itself is still valid", async () => {
    // Message valid for 9 minutes, nonce TTL is 5 minutes; verify at +6 minutes.
    const { message, signature, preSession } = await signedMessage({
      expirationTime: new Date(NOW.getTime() + 9 * 60_000),
    });
    const later = new Date(NOW.getTime() + 6 * 60_000);
    const result = await verifySiweSignIn(db, config({ now: () => later }), {
      message,
      signature,
      preSessionToken: preSession,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_nonce" });
  });

  it("rejects a message for another domain (phishing site relay)", async () => {
    const { message, signature, preSession } = await signedMessage({ domain: "evil.example" });
    expect(await verifySiweSignIn(db, config(), { message, signature, preSessionToken: preSession })).toEqual({
      ok: false,
      reason: "domain_mismatch",
    });
  });

  it("rejects a URI on another origin", async () => {
    const { message, signature, preSession } = await signedMessage({ uri: "https://evil.example/login" });
    expect(await verifySiweSignIn(db, config(), { message, signature, preSessionToken: preSession })).toEqual({
      ok: false,
      reason: "uri_mismatch",
    });
  });

  it("rejects chains outside the allowlist", async () => {
    const { message, signature, preSession } = await signedMessage({ chainId: 137 });
    expect(await verifySiweSignIn(db, config(), { message, signature, preSessionToken: preSession })).toEqual({
      ok: false,
      reason: "unsupported_chain",
    });
  });

  it("requires an expiration time and a short lifetime", async () => {
    const noExpiry = await signedMessage({ expirationTime: null });
    expect(
      await verifySiweSignIn(db, config(), { ...noExpiry, preSessionToken: noExpiry.preSession }),
    ).toEqual({ ok: false, reason: "invalid_timing" });

    const tooLong = await signedMessage({ expirationTime: new Date(NOW.getTime() + 60 * 60_000) });
    expect(await verifySiweSignIn(db, config(), { ...tooLong, preSessionToken: tooLong.preSession })).toEqual({
      ok: false,
      reason: "invalid_timing",
    });
  });

  it("rejects a message issued in the future or long ago", async () => {
    const future = await signedMessage({
      issuedAt: new Date(NOW.getTime() + 5 * 60_000),
      expirationTime: new Date(NOW.getTime() + 9 * 60_000),
    });
    expect((await verifySiweSignIn(db, config(), { ...future, preSessionToken: future.preSession })).ok).toBe(false);
  });

  it("rejects a signature from a different wallet than the message claims", async () => {
    const { message, preSession } = await signedMessage();
    const other = privateKeyToAccount(generatePrivateKey());
    const signature = await other.signMessage({ message });
    const verifier = vi.fn(async () => false);
    const result = await verifySiweSignIn(db, config({ verifyContractSignature: verifier }), {
      message,
      signature,
      preSessionToken: preSession,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verifier).toHaveBeenCalledOnce(); // smart-wallet path was tried and declined
  });

  it("rejects a tampered message (signature no longer matches)", async () => {
    const { message, signature, preSession } = await signedMessage();
    const tampered = message.replace("Sign in to Alactic.", "Sign in to Alactic!");
    const result = await verifySiweSignIn(db, config(), { message: tampered, signature, preSessionToken: preSession });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("treats smart-wallet verifier errors as failure, never success", async () => {
    const { message, preSession } = await signedMessage();
    const result = await verifySiweSignIn(
      db,
      config({ verifyContractSignature: async () => { throw new Error("rpc down"); } }),
      { message, signature: "0x1234", preSessionToken: preSession },
    );
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects garbage input", async () => {
    const result = await verifySiweSignIn(db, config(), { message: "hello", signature: "0xdead", preSessionToken: "x" });
    expect(result.ok).toBe(false);
  });
});
