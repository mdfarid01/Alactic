import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), "");
  // Make the test DB URL visible to globalSetup (runs in this process) and to test workers.
  process.env.DATABASE_URL_TEST ??= fileEnv.DATABASE_URL_TEST;
  return {
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        // `server-only` throws outside the React Server bundle; in tests it's a no-op.
        "server-only": fileURLToPath(new URL("./tests/helpers/empty.ts", import.meta.url)),
      },
    },
    test: {
      environment: "node",
      include: ["tests/**/*.test.ts"],
      globalSetup: ["tests/helpers/global-setup.ts"],
      // Integration tests share one database; run files sequentially.
      fileParallelism: false,
      env: { DATABASE_URL_TEST: process.env.DATABASE_URL_TEST ?? "" },
    },
  };
});
