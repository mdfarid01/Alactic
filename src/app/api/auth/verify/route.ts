import { z } from "zod";
import { db } from "@/server/db/client";
import { siweConfig } from "@/server/auth/config";
import { clearPreSessionCookie, readPreSessionCookie, setSessionCookie } from "@/server/auth/cookies";
import { createSession, upsertWalletUser } from "@/server/auth/sessions";
import { verifySiweSignIn, type SiweFailure } from "@/server/auth/siwe";
import { isSameOriginRequest, jsonError } from "@/server/http/origin";

const bodySchema = z.object({
  message: z.string().min(1).max(4096),
  signature: z.string().min(4).max(20_000),
});

const FAILURE_MESSAGES: Record<SiweFailure, string> = {
  malformed_message: "The sign-in message was malformed. Please try again.",
  domain_mismatch: "This sign-in request was created for a different website.",
  uri_mismatch: "This sign-in request was created for a different website.",
  unsupported_chain: "Please switch your wallet to Ethereum mainnet or Sepolia and try again.",
  invalid_timing: "The sign-in request expired. Please try again.",
  invalid_nonce: "The sign-in request expired or was already used. Please try again.",
  invalid_signature: "We couldn't verify the wallet signature.",
};

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return jsonError(403, "bad_origin", "Request origin not allowed");

  const preSession = await readPreSessionCookie();
  if (!preSession) return jsonError(400, "invalid_nonce", FAILURE_MESSAGES.invalid_nonce);

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, "malformed_message", FAILURE_MESSAGES.malformed_message);

  const database = db();
  const result = await verifySiweSignIn(database, siweConfig(), {
    message: body.data.message,
    signature: body.data.signature,
    preSessionToken: preSession,
  });
  if (!result.ok) return jsonError(401, result.reason, FAILURE_MESSAGES[result.reason]);

  const userId = await upsertWalletUser(database, result.address);
  const { token, expiresAt } = await createSession(database, {
    userId,
    walletAddress: result.address,
    userAgent: request.headers.get("user-agent"),
  });
  await setSessionCookie(token, expiresAt);
  await clearPreSessionCookie();

  return Response.json({ ok: true, address: result.address }, { headers: { "Cache-Control": "no-store" } });
}
