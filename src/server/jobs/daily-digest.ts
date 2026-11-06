import "server-only";
import { db } from "@/server/db/client";
import { generateDigest, orgsForDigest } from "@/server/digest/service";
import { runtimeDeps } from "@/server/inference/config";
import { inngest } from "./client";

/** Every day at 07:00 UTC, write the briefing for each org with a published agent (one step per org). */
export const dailyDigest = inngest.createFunction(
  { id: "daily-digest", name: "Daily owner digest", triggers: [{ cron: "0 7 * * *" }], retries: 1 },
  async ({ step }) => {
    const orgs = await step.run("list-orgs", () => orgsForDigest(db()));
    for (const org of orgs) await step.run(`digest-${org.id}`, async () => (await generateDigest(runtimeDeps(), org.id)).day);
    return { orgs: orgs.length };
  },
);
