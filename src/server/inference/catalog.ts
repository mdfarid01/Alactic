import "server-only";
import { cacheLife } from "next/cache";
import { env } from "@/server/env";
import { parseChatModels, parseTrustAvailability, type CatalogModel, type TrustAvailability } from "./catalog-parse";

const TIMEOUT_MS = 8_000;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`0G Router responded ${res.status} for ${new URL(url).pathname}`);
  return res.json();
}

/** Public model catalog (no auth). Cached for a few minutes; failures are not cached. */
async function fetchChatModels(): Promise<CatalogModel[]> {
  "use cache";
  cacheLife("minutes");
  return parseChatModels(await getJson(`${env().ZG_ROUTER_BASE_URL}/models`));
}

async function fetchTrustAvailability(modelId: string): Promise<TrustAvailability> {
  "use cache";
  cacheLife("minutes");
  const url = new URL(`${env().ZG_ROUTER_BASE_URL}/providers`);
  url.searchParams.set("model", modelId);
  return parseTrustAvailability(await getJson(url.toString()));
}

export type CatalogResult =
  | { ok: true; models: CatalogModel[]; availability: Record<string, TrustAvailability> }
  | { ok: false; error: string };

/**
 * Chat models plus live per-trust-mode availability for TEE-capable models.
 * (Availability is only fetched for TEE models; standard-only models are checked by the Router at request time.)
 */
export async function getModelCatalog(): Promise<CatalogResult> {
  try {
    const models = await fetchChatModels();
    const teeModels = models.filter((m) => m.verifiability !== null);
    const entries = await Promise.all(
      teeModels.map(async (m) => {
        try {
          return [m.id, await fetchTrustAvailability(m.id)] as const;
        } catch {
          return null; // unknown availability for this model; shown as "not checked"
        }
      }),
    );
    return {
      ok: true,
      models,
      availability: Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => e !== null)),
    };
  } catch (error) {
    console.error("[catalog] failed to load 0G model catalog", error instanceof Error ? error.message : error);
    return { ok: false, error: "Couldn't reach the 0G model catalog. Model and trust settings can't be changed right now." };
  }
}
