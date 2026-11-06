import { db } from "@/server/db/client";
import { clearSessionCookie, readSessionCookie } from "@/server/auth/cookies";
import { revokeSessionByToken } from "@/server/auth/sessions";
import { isSameOriginRequest, jsonError } from "@/server/http/origin";

/** Revoke the session server-side (not just the cookie). */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return jsonError(403, "bad_origin", "Request origin not allowed");
  const token = await readSessionCookie();
  if (token) await revokeSessionByToken(db(), token);
  await clearSessionCookie();
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
