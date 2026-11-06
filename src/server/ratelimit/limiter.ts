import "server-only";
import { lt, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { rateLimitBuckets } from "@/server/db/schema";

export type RateRule = {
  /** Namespaced, already-hashed key, e.g. `chat:visitor:<sha256>`. Never a raw IP or token. */
  key: string;
  limit: number;
  windowSeconds: number;
};

export type RateDecision = { ok: true } | { ok: false; key: string; retryAfterSeconds: number };

/**
 * Fixed-window counters in Postgres (no extra infrastructure). Every rule is incremented atomically with an upsert;
 * the request is rejected if any rule is over its limit. Rejected requests still count, so hammering doesn't help.
 */
export async function consumeRateLimits(db: Database, rules: RateRule[], now = new Date()): Promise<RateDecision> {
  let denied: RateDecision = { ok: true };
  for (const rule of rules) {
    const windowMs = rule.windowSeconds * 1000;
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const [row] = await db
      .insert(rateLimitBuckets)
      .values({ key: rule.key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimitBuckets.key, rateLimitBuckets.windowStart],
        set: { count: sql`${rateLimitBuckets.count} + 1` },
      })
      .returning({ count: rateLimitBuckets.count });
    if (row.count > rule.limit && denied.ok) {
      denied = { ok: false, key: rule.key, retryAfterSeconds: Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000)) };
    }
  }
  return denied;
}

/** Delete windows older than `olderThanSeconds` (called opportunistically; buckets are tiny). */
export async function purgeRateLimits(db: Database, olderThanSeconds = 24 * 60 * 60, now = new Date()) {
  await db.delete(rateLimitBuckets).where(lt(rateLimitBuckets.windowStart, new Date(now.getTime() - olderThanSeconds * 1000)));
}
