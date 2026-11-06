import { db } from "@/server/db/client";
import { readPreSessionCookie, setPreSessionCookie } from "@/server/auth/cookies";
import { issueNonce } from "@/server/auth/siwe";
import { randomToken } from "@/server/auth/tokens";
import { isSameOriginRequest, jsonError } from "@/server/http/origin";

/** Issue a single-use SIWE nonce bound to this browser's pre-session cookie. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return jsonError(403, "bad_origin", "Request origin not allowed");

  const preSession = (await readPreSessionCookie()) ?? randomToken();
  await setPreSessionCookie(preSession);
  const { nonce, expiresAt } = await issueNonce(db(), preSession);

  return Response.json({ nonce, expiresAt: expiresAt.toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
