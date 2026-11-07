// Used by proxy.ts (Node.js runtime). Deliberately minimal: one query, no app modules, small cache.
import postgres from "postgres";

let sql: ReturnType<typeof postgres> | undefined;
const cache = new Map<string, { at: number; origins: string[] }>();
const TTL_MS = 30_000;

/** Origins allowed to frame /embed/<slug> (only for published agents). Empty list ⇒ only our own origin. */
export async function embedAllowedOrigins(slug: string): Promise<string[]> {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return [];
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.origins;
  if (!process.env.DATABASE_URL) return [];
  sql ??= postgres(process.env.DATABASE_URL, { max: 1, prepare: false, idle_timeout: 20 });
  try {
    const rows = await sql<{ allowed_origins: string[] }[]>`
      select allowed_origins from agents where slug = ${slug} and status = 'published' limit 1`;
    // Defence in depth: only keep values that are plain origins (no spaces/semicolons that could alter the CSP).
    const origins = (rows[0]?.allowed_origins ?? []).filter((o) => /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(o));
    cache.set(slug, { at: Date.now(), origins });
    return origins;
  } catch {
    return [];
  }
}

export function frameAncestorsHeader(origins: string[]) {
  return `frame-ancestors 'self'${origins.length ? " " + origins.join(" ") : ""}`;
}
