import "server-only";
import { cookies } from "next/headers";
import { isSecureOrigin } from "@/server/env";

/**
 * On https the `__Host-` prefix forces Secure, Path=/ and no Domain attribute (no subdomain can set or read it).
 * Plain http (local development only) can't use the prefix.
 */
function cookieName(base: string) {
  return isSecureOrigin() ? `__Host-${base}` : base;
}

export const sessionCookieName = () => cookieName("alactic_session");
export const preSessionCookieName = () => cookieName("alactic_siwe");

function baseOptions() {
  return { httpOnly: true, secure: isSecureOrigin(), sameSite: "lax" as const, path: "/" };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(sessionCookieName(), token, { ...baseOptions(), expires: expiresAt });
}

export async function readSessionCookie(): Promise<string | undefined> {
  return (await cookies()).get(sessionCookieName())?.value;
}

export async function clearSessionCookie() {
  (await cookies()).set(sessionCookieName(), "", { ...baseOptions(), maxAge: 0 });
}

export async function setPreSessionCookie(token: string) {
  (await cookies()).set(preSessionCookieName(), token, { ...baseOptions(), maxAge: 10 * 60 });
}

export async function readPreSessionCookie(): Promise<string | undefined> {
  return (await cookies()).get(preSessionCookieName())?.value;
}

export async function clearPreSessionCookie() {
  (await cookies()).set(preSessionCookieName(), "", { ...baseOptions(), maxAge: 0 });
}
