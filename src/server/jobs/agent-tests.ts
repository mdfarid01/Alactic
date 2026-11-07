import "server-only";
import { runtimeDeps } from "@/server/inference/config";
import { executeTestRun } from "@/server/tests/service";
import { agentTestsRequested, inngest } from "./client";

/** One test run at a time per agent; no retries (a retry would re-bill every question). */
export const agentTests = inngest.createFunction(
  { id: "agent-tests", name: "Run agent test suite", triggers: [agentTestsRequested], retries: 0, concurrency: { limit: 1, key: "event.data.agentId" } },
  async ({ event }) => executeTestRun(runtimeDeps(), event.data),
);
