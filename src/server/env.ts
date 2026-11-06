import "server-only";
import { z } from "zod";

const chainIdList = z
  .string()
  .default("1,11155111")
  .transform((value, ctx) => {
    const ids = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      ctx.addIssue({ code: "custom", message: "must be a comma-separated list of chain IDs" });
      return z.NEVER;
    }
    return ids;
  });

const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.url().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url(),
  DATABASE_URL: z.url(),
  SIWE_ALLOWED_CHAIN_IDS: chainIdList,
  ETH_RPC_URL_MAINNET: optionalUrl,
  ETH_RPC_URL_SEPOLIA: optionalUrl,
  /** Parent ENS name for Alactic-managed agent subnames (see docs/ENS_INTEGRATION.md §6). */
  ENS_PARENT_NAME: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/).default("alactic.eth"),
  /** 0G Compute Router API base. Public endpoints (/models, /providers) need no key. */
  ZG_ROUTER_BASE_URL: z.url().default("https://router-api.0g.ai/v1").transform((u) => u.replace(/\/+$/, "")),
});

export type ServerEnv = z.infer<typeof envSchema>;

let cached: ServerEnv | undefined;

/**
 * Validated server environment. Parsed lazily so `next build` doesn't require runtime secrets,
 * but every request path that needs config fails fast with a clear message if it's missing.
 */
export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment: ${issues}`);
  }
  const appUrl = new URL(parsed.data.APP_URL);
  const isLocalhost = appUrl.hostname === "localhost" || appUrl.hostname === "127.0.0.1";
  if (parsed.data.NODE_ENV === "production" && appUrl.protocol !== "https:" && !isLocalhost) {
    // Plain http is only tolerated for local `next start` runs.
    throw new Error("Invalid server environment: APP_URL must use https in production");
  }
  cached = parsed.data;
  return cached;
}

/** The canonical app origin, e.g. `https://app.example.com`. */
export function appOrigin(): URL {
  return new URL(env().APP_URL);
}

export function isSecureOrigin(): boolean {
  return appOrigin().protocol === "https:";
}
