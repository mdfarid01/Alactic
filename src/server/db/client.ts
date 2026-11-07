import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/server/env";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export function createDatabase(url: string, options: { max?: number } = {}) {
  // Pool size per server instance; keep small on serverless (Supabase session pooler). TLS comes from ?sslmode=require.
  const client = postgres(url, { max: options.max ?? (Number(process.env.DB_POOL_MAX) || 10), prepare: false });
  return { db: drizzle(client, { schema, casing: "snake_case" }), client };
}

// Reuse one pool across hot reloads in development.
const globalForDb = globalThis as unknown as { __alacticDb?: ReturnType<typeof createDatabase> };

export function db(): Database {
  if (!globalForDb.__alacticDb) {
    globalForDb.__alacticDb = createDatabase(env().DATABASE_URL);
  }
  return globalForDb.__alacticDb.db;
}
