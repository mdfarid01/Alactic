import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { db } from "@/server/db/client";
import { readSessionCookie } from "./cookies";
import { findSessionByToken, type SessionUser } from "./sessions";

/**
 * Data Access Layer entry point: the only way UI code learns who the user is.
 * Reads the session at request time (never cached across requests, so revocation applies immediately).
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = await readSessionCookie();
  if (!token) return null;
  // Session validity depends on the current time; mark this as request-time work so it's never prerendered.
  await connection();
  return findSessionByToken(db(), token);
});

export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(returnTo ? `/sign-in?next=${encodeURIComponent(returnTo)}` : "/sign-in");
  return user;
}
