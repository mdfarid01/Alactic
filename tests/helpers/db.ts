import { sql } from "drizzle-orm";
import { afterAll, beforeEach } from "vitest";
import { createDatabase } from "@/server/db/client";

/** Shared test DB handle. Every test starts with empty tables. */
export function setupTestDb() {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST is not set");
  const { db, client } = createDatabase(url, { max: 4 });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE rate_limit_buckets, verification_records, messages, inference_records, conversations, knowledge_chunks, knowledge_documents, knowledge_sources, agent_configs, agents, organization_members, organizations, sessions, auth_nonces, wallet_identities, users RESTART IDENTITY CASCADE`,
    );
  });
  afterAll(async () => {
    await client.end();
  });
  return db;
}
