import "server-only";
import { NonRetriableError, RetryAfterError } from "inngest";
import { db } from "@/server/db/client";
import { crawler, embeddingProvider } from "@/server/knowledge/config";
import { EmbeddingError } from "@/server/knowledge/embeddings";
import { CrawlerError } from "@/server/knowledge/firecrawl";
import {
  chunkPendingDocuments,
  embedNextBatch,
  finalizeRun,
  loadRun,
  PipelineError,
  setProgress,
  storeCrawledPages,
} from "@/server/knowledge/pipeline";
import { inngest, knowledgeIngestRequested } from "./client";

const RETRIES = 3;
const CRAWL_POLL_LIMIT = 120; // × 5s ≈ 10 minutes
const EMBED_BATCH = 32;
const MAX_EMBED_BATCHES = 700;

function classify(error: unknown): { message: string; retryable: boolean; retryAfterMs?: number } {
  if (error instanceof EmbeddingError) {
    return { message: error.message, retryable: error.retryable, retryAfterMs: error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : undefined };
  }
  if (error instanceof CrawlerError || error instanceof PipelineError) return { message: error.message, retryable: error.retryable };
  // Unknown errors: retry, but never expose internal details to the UI.
  return { message: "Indexing failed due to an internal error. Try re-indexing.", retryable: true };
}

/**
 * Background ingestion for one knowledge source. Every stage re-checks the run id (see pipeline.ts), so a re-index
 * or deletion makes this run stop. Failures are written to the source as a safe, human-readable message.
 */
export const knowledgeIngest = inngest.createFunction(
  {
    id: "knowledge-ingest",
    name: "Index knowledge source",
    triggers: [knowledgeIngestRequested],
    retries: RETRIES,
    // One run per agent at a time keeps embedding and crawl load predictable.
    concurrency: { limit: 1, key: "event.data.agentId" },
  },
  async ({ event, step, attempt, logger }) => {
    const { sourceId, runId } = event.data;

    const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        const { message, retryable, retryAfterMs } = classify(error);
        logger.warn("knowledge-ingest step failed", { sourceId, runId, attempt, retryable, error: error instanceof Error ? error.name : "unknown" });
        if (!retryable || attempt >= RETRIES) {
          await setProgress(db(), sourceId, runId, "failed", message);
          throw new NonRetriableError(message);
        }
        if (retryAfterMs) throw new RetryAfterError(message, retryAfterMs);
        throw error;
      }
    };

    const source = await step.run("load", () => loadRun(db(), sourceId, runId));
    if (!source) return { skipped: "stale run" };

    if (source.type === "website") {
      const live = await step.run("crawl-start", () =>
        guarded(async () => {
          if (!(await setProgress(db(), sourceId, runId, "processing", "Crawling website…"))) return null;
          return crawler().start(source.url!, { maxPages: source.maxPages });
        }),
      );
      if (!live) return { skipped: "stale run" };

      let stored: number | null = null;
      for (let i = 0; i < CRAWL_POLL_LIMIT && stored === null; i++) {
        await step.sleep(`crawl-wait-${i}`, "5s");
        stored = await step.run(`crawl-check-${i}`, () =>
          guarded(async () => {
            const state = await crawler().check(live);
            if (state.state === "failed") throw new CrawlerError(`Website crawl failed: ${state.error}`, false);
            if (state.state === "running") {
              await setProgress(db(), sourceId, runId, "processing", `Crawling website… ${state.completed}/${state.total || "?"} pages`);
              return null;
            }
            return storeCrawledPages(db(), source, runId, state.pages);
          }),
        );
      }
      if (stored === null) {
        await step.run("crawl-timeout", () => setProgress(db(), sourceId, runId, "failed", "The website crawl took too long. Try fewer pages."));
        return { failed: "crawl timeout" };
      }
    }

    await step.run("chunk", () =>
      guarded(async () => {
        if (!(await setProgress(db(), sourceId, runId, "processing", "Splitting into passages…"))) return 0;
        return chunkPendingDocuments(db(), source, runId);
      }),
    );

    let embedded = 0;
    for (let b = 0; b < MAX_EMBED_BATCHES; b++) {
      const n = await step.run(`embed-${b}`, () =>
        guarded(async () => {
          const count = await embedNextBatch(db(), source, runId, embeddingProvider(), EMBED_BATCH);
          if (count) await setProgress(db(), sourceId, runId, "processing", `Embedding passages… ${embedded + count} done`);
          return count;
        }),
      );
      if (n === 0) break;
      embedded += n;
    }

    await step.run("finalize", () => finalizeRun(db(), source, runId));
    return { embedded };
  },
);

export const functions = [knowledgeIngest];
