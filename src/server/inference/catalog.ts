import "server-only";
import { cacheLife } from "next/cache";
import type { TrustModeOption } from "@/lib/agent-options";
import { env } from "@/server/env";
import { parseChatModels, parseSpeechModels, parseTrustAvailability, type CatalogModel, type SpeechModel, type TrustAvailability } from "./catalog-parse";

const TIMEOUT_MS = 15_000;
/** Last catalog successfully fetched from 0G, used only if 0G is temporarily unreachable (never invented data). */
const LAST_GOOD_MAX_AGE_MS = 6 * 60 * 60 * 1000;
let lastGood: { at: number; models: CatalogModel[]; availability: Record<string, TrustAvailability> } | null = null;

async function getJson(url: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`0G Router responded ${res.status} for ${new URL(url).pathname}`);
      return await res.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Public model catalog (no auth). Cached for a few minutes; failures are not cached. */
async function fetchChatModels(): Promise<CatalogModel[]> {
  "use cache";
  cacheLife("minutes");
  return parseChatModels(await getJson(`${env().ZG_ROUTER_BASE_URL}/models`));
}

async function fetchSpeechModels(): Promise<SpeechModel[]> {
  "use cache";
  cacheLife("minutes");
  return parseSpeechModels(await getJson(`${env().ZG_ROUTER_BASE_URL}/models`));
}

/**
 * What a published agent can accept besides text, from the live catalog:
 * images if its chat model lists the "image" input modality; voice if the configured speech model supports the agent's trust mode.
 */
export async function mediaCapabilities(modelId: string, trustMode: TrustModeOption): Promise<{ images: boolean; voice: boolean }> {
  try {
    const [models, speech] = await Promise.all([fetchChatModels(), fetchSpeechModels()]);
    const chat = models.find((m) => m.id === modelId);
    const stt = speech.find((m) => m.id === env().TRANSCRIPTION_MODEL);
    return { images: chat?.inputModalities.includes("image") ?? false, voice: stt?.trustModes.includes(trustMode) ?? false };
  } catch {
    return { images: false, voice: false };
  }
}

async function fetchTrustAvailability(modelId: string): Promise<TrustAvailability> {
  "use cache";
  cacheLife("minutes");
  const url = new URL(`${env().ZG_ROUTER_BASE_URL}/providers`);
  url.searchParams.set("model", modelId);
  return parseTrustAvailability(await getJson(url.toString()));
}

export type CatalogResult =
  | { ok: true; models: CatalogModel[]; availability: Record<string, TrustAvailability>; staleSince?: string }
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
    const availability = Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => e !== null));
    lastGood = { at: Date.now(), models, availability };
    return { ok: true, models, availability };
  } catch (error) {
    console.error("[catalog] failed to load 0G model catalog", error instanceof Error ? error.message : error);
    if (lastGood && Date.now() - lastGood.at < LAST_GOOD_MAX_AGE_MS) {
      return { ok: true, models: lastGood.models, availability: {}, staleSince: new Date(lastGood.at).toISOString() };
    }
    return { ok: false, error: "Couldn't reach the 0G model catalog. Model and trust settings can't be changed right now." };
  }
}
