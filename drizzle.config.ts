import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// Load .env.local without executing it as a shell script (Node ≥ 20.12 built-in parser).
if (!process.env.DATABASE_URL && existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
