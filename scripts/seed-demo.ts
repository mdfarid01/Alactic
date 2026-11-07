/**
 * DEMO SEED: creates a fictional business ("Nimbus Coffee Roasters") with a published support agent whose knowledge
 * is indexed through the REAL pipeline (0G embeddings). Answers in the public chat are REAL 0G inference.
 * The business and its FAQ content are fictional demo data; the org is named "(Demo)" so it is clearly labelled.
 *
 * Usage: pnpm seed:demo [--owner 0xYourWallet]
 *   --owner  wallet that will own the demo org, so you can sign in and manage it. Default: a random throwaway wallet.
 * Costs: a handful of embedding calls on your 0G Router key (fractions of a cent).
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isAddress, type Hex } from "viem";
import { eq } from "drizzle-orm";
import { createAgent, publishDraft, saveDraft, getAgentForEdit } from "@/server/agents/service";
import { upsertWalletUser } from "@/server/auth/sessions";
import { createDatabase } from "@/server/db/client";
import { organizations } from "@/server/db/schema";
import { embeddingProvider } from "@/server/knowledge/config";
import { chunkPendingDocuments, embedNextBatch, finalizeRun, loadRun } from "@/server/knowledge/pipeline";
import { addFaqSource, addTextSource } from "@/server/knowledge/service";
import { authorizeOrg, createOrganization } from "@/server/orgs/service";

const ORG_SLUG = "nimbus-demo";
const AGENT_SLUG = "nimbus";

const FAQ: { question: string; answer: string }[] = [
  { question: "What is your refund policy?", answer: "Unopened bags can be returned within 30 days for a full refund. If a bag arrives damaged or tastes off, contact us within 14 days of delivery and we will send a replacement or refund you, no need to return it." },
  { question: "How long does shipping take?", answer: "We roast on Mondays and Thursdays and ship within 24 hours of roasting. Domestic orders arrive in 2-4 business days. International orders take 6-12 business days. Free domestic shipping on orders over $40." },
  { question: "How do I pause or cancel my subscription?", answer: "Go to Account > Subscriptions and choose Pause (up to 3 months) or Cancel. Changes made before 11:59 pm the day before your roast date apply to the next shipment. There are no cancellation fees." },
  { question: "Which grind should I choose?", answer: "Whole bean stays fresh longest. Choose Fine for espresso, Medium-fine for moka pot and AeroPress, Medium for drip and pour-over, and Coarse for French press and cold brew." },
  { question: "Do you have decaf?", answer: "Yes. Our Night Owl decaf is a Colombian coffee decaffeinated with the Swiss Water process, with no chemical solvents. It has notes of cocoa and red apple." },
  { question: "How should I store coffee?", answer: "Keep beans in the resealable bag or an airtight container at room temperature, away from light and heat. Do not refrigerate. Coffee tastes best 4 to 21 days after the roast date printed on the bag." },
  { question: "Do you offer wholesale for cafes and offices?", answer: "Yes. Wholesale starts at 5 kg per month with volume pricing, free equipment advice and staff training. Email wholesale@nimbus.example to get a price list." },
];

const ABOUT = `Nimbus Coffee Roasters is a small-batch specialty roaster (fictional demo business).
Current coffees:
- Cloud Nine (Ethiopia Yirgacheffe, light roast): jasmine, bergamot, peach. Best for pour-over. $19 per 340 g bag.
- Stormfront (Brazil and Sumatra blend, dark roast): dark chocolate, molasses. Best for espresso and French press. $17 per 340 g bag.
- Daybreak (Guatemala Huehuetenango, medium roast): caramel, almond, orange. All-rounder. $18 per 340 g bag.
- Night Owl decaf (Colombia, Swiss Water process, medium roast): cocoa, red apple. $18 per 340 g bag.
Subscriptions save 10% and ship every 1, 2 or 4 weeks.
Customer support hours: Monday to Friday, 9 am to 5 pm Pacific. Email hello@nimbus.example.`;

async function main() {
  const ownerArg = process.argv.indexOf("--owner");
  const owner = ownerArg > 0 ? process.argv[ownerArg + 1] : null;
  if (owner && !isAddress(owner)) throw new Error("--owner must be a wallet address");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (run with --env-file=.env.local)");
  const { db, client } = createDatabase(url, { max: 2 });
  try {
    const existing = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, ORG_SLUG)).limit(1);
    if (existing.length) {
      console.log(`Demo org "${ORG_SLUG}" already exists. Public page: /a/${AGENT_SLUG}. Delete the org to re-seed.`);
      return;
    }
    const address = (owner ?? privateKeyToAccount(generatePrivateKey()).address) as Hex;
    const userId = await upsertWalletUser(db, address);
    await createOrganization(db, userId, { name: "Nimbus Coffee (Demo)", slug: ORG_SLUG });
    const scope = (await authorizeOrg(db, userId, ORG_SLUG))!;

    await createAgent(db, scope, { name: "Nimbus Support", slug: AGENT_SLUG, description: "Answers questions about Nimbus coffees, orders, shipping and subscriptions." }, async () => null);
    const data = (await getAgentForEdit(db, scope, AGENT_SLUG))!;
    await saveDraft(
      db,
      scope,
      AGENT_SLUG,
      {
        config: {
          name: "Nimbus Support",
          description: "Answers questions about Nimbus coffees, orders, shipping and subscriptions.",
          instructions: "Help customers of Nimbus Coffee Roasters. Recommend a coffee when asked, based only on the listed coffees. Keep answers short and warm.",
          persona: "A friendly barista who knows the menu well.",
          tone: "friendly",
          language: "auto",
          fallbackMessage: data.config.fallbackMessage,
          modelId: data.config.modelId,
          trustMode: data.config.trustMode,
          temperature: String(data.config.temperature),
          maxOutputTokens: String(data.config.maxOutputTokens),
          retrievalTopK: String(data.config.retrievalTopK),
        },
        expectedUpdatedAt: data.config.updatedAt.toISOString(),
      },
      async () => null,
    );

    const embedder = embeddingProvider();
    const tickets = [];
    for (const f of FAQ) tickets.push(await addFaqSource(db, scope, AGENT_SLUG, f));
    tickets.push(await addTextSource(db, scope, AGENT_SLUG, { title: "About Nimbus and our coffees", content: ABOUT }));
    for (const t of tickets) {
      const src = (await loadRun(db, t.sourceId, t.runId))!;
      await chunkPendingDocuments(db, src, t.runId);
      while ((await embedNextBatch(db, src, t.runId, embedder)) > 0);
      await finalizeRun(db, src, t.runId);
    }
    const { version } = await publishDraft(db, scope, AGENT_SLUG);
    console.log(`Seeded "Nimbus Coffee (Demo)" owned by ${address}. Agent v${version} published.`);
    console.log(`Public page: ${process.env.APP_URL ?? "http://localhost:3000"}/a/${AGENT_SLUG}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
