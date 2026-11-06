import { and, eq, gt, isNull } from "drizzle-orm";
import type { Hex } from "viem";
import type { Database } from "@/server/db/client";
import { sessions, users, walletIdentities } from "@/server/db/schema";
import { randomToken, sha256Hex } from "./tokens";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionUser = {
  sessionId: string;
  userId: string;
  /** Checksummed address the session was created with (from a verified SIWE signature). */
  walletAddress: Hex;
  displayName: string | null;
};

/** Find or create the user owning a verified wallet address. */
export async function upsertWalletUser(db: Database, address: Hex, now = new Date()) {
  const normalized = address.toLowerCase();
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ userId: walletIdentities.userId })
      .from(walletIdentities)
      .where(eq(walletIdentities.address, normalized))
      .limit(1);
    if (existing[0]) {
      await tx
        .update(walletIdentities)
        .set({ lastSignInAt: now })
        .where(eq(walletIdentities.address, normalized));
      return existing[0].userId;
    }
    const [user] = await tx.insert(users).values({}).returning({ id: users.id });
    await tx.insert(walletIdentities).values({ userId: user.id, address: normalized, lastSignInAt: now });
    return user.id;
  });
}

/** Create a session and return the raw token (to be placed in an HttpOnly cookie, never stored). */
export async function createSession(
  db: Database,
  input: { userId: string; walletAddress: Hex; userAgent?: string | null },
  now = new Date(),
) {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    tokenHash: sha256Hex(token),
    userId: input.userId,
    walletAddress: input.walletAddress,
    userAgent: input.userAgent?.slice(0, 512) ?? null,
    expiresAt,
  });
  return { token, expiresAt };
}

export async function findSessionByToken(db: Database, token: string, now = new Date()): Promise<SessionUser | null> {
  if (!token || token.length > 128) return null;
  const rows = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      walletAddress: sessions.walletAddress,
      displayName: users.displayName,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .limit(1);
  const row = rows[0];
  return row ? { ...row, walletAddress: row.walletAddress as Hex } : null;
}

export async function revokeSessionByToken(db: Database, token: string, now = new Date()) {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt)));
}
