import "server-only";
import { appOrigin } from "@/server/env";

/**
 * CSRF defence for cookie-authenticated JSON endpoints: the browser-set Origin header must equal the app origin.
 * (Server Actions get an equivalent check from Next.js.)
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === appOrigin().origin;
}

export function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}
