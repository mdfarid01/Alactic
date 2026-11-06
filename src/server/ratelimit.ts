import { createHash, randomBytes } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { rateLimitBuckets } from "@/server/db/schema";

/** Atomic fixed-window counter. Returns ok=false (with seconds until reset) once `limit` is exceeded. */
export async function consumeRateLimit(db: Database, key: string, limit: number, windowSeconds: number, now = new Date()) {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [row] = await db
    .insert(rateLimitBuckets)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateLimitBuckets.key, rateLimitBuckets.windowStart], set: { count: sql`${rateLimitBuckets.count} + 1` } })
    .returning({ count: rateLimitBuckets.count });
  const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000));
  return { ok: row.count <= limit, count: row.count, retryAfter };
}

export async function purgeRateLimits(db: Database, olderThan = new Date(Date.now() - 24 * 60 * 60 * 1000)) {
  await db.delete(rateLimitBuckets).where(lt(rateLimitBuckets.windowStart, olderThan));
}

const salt = process.env.RATE_LIMIT_SALT || randomBytes(16).toString("hex");

/** Salted hash of the client IP (raw IPs are never stored). On Vercel, x-forwarded-for's first entry is set by the platform. */
export function clientKey(request: Request): string {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}
