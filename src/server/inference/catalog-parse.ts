import { z } from "zod";
import type { TrustModeOption } from "@/lib/agent-options";

/** Verifiability values observed on GET /v1/models and /v1/providers (2026-11-06). Unknown values are treated as none. */
export type Verifiability = "TeeML" | "TeeTLS" | null;

export type CatalogModel = {
  id: string;
  name: string;
  contextLength: number | null;
  /** Highest verifiability among the model's providers (0G lists each model under its best provider). */
  verifiability: Verifiability;
  supportsTools: boolean;
  supportedParameters: string[];
  pricingUsd: { prompt: string | null; completion: string | null };
  /** Trust modes this model can be requested with, based on its verifiability (capability, not live health). */
  trustModes: TrustModeOption[];
};

export type TrustAvailability = Record<TrustModeOption, boolean>;

const modelSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().optional(),
    type: z.string().optional(),
    context_length: z.number().nullable().optional(),
    provider_count: z.number().optional(),
    verifiability: z.string().nullable().optional(),
    supported_parameters: z.array(z.string()).optional(),
    pricing_usd: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const listSchema = z.object({ data: z.array(z.unknown()) });

function normalizeVerifiability(v: unknown): Verifiability {
  return v === "TeeML" || v === "TeeTLS" ? v : null;
}

export function trustModesFor(verifiability: Verifiability): TrustModeOption[] {
  if (verifiability === "TeeML") return ["private", "verified", "standard"];
  if (verifiability === "TeeTLS") return ["verified", "standard"];
  return ["standard"];
}

/** Parse GET /v1/models into chat models usable by agents. Malformed entries are skipped, not trusted. */
export function parseChatModels(json: unknown): CatalogModel[] {
  const list = listSchema.safeParse(json);
  if (!list.success) throw new Error("Unexpected 0G model catalog format");
  const models: CatalogModel[] = [];
  for (const raw of list.data.data) {
    const m = modelSchema.safeParse(raw);
    if (!m.success) continue;
    if (m.data.type !== "chatbot") continue;
    if (m.data.provider_count !== undefined && m.data.provider_count < 1) continue;
    const verifiability = normalizeVerifiability(m.data.verifiability);
    const price = (k: string) => {
      const v = m.data.pricing_usd?.[k];
      return typeof v === "string" ? v : null;
    };
    models.push({
      id: m.data.id,
      name: m.data.name ?? m.data.id,
      contextLength: m.data.context_length ?? null,
      verifiability,
      supportsTools: m.data.supported_parameters?.includes("tools") ?? false,
      supportedParameters: m.data.supported_parameters ?? [],
      pricingUsd: { prompt: price("prompt"), completion: price("completion") },
      trustModes: trustModesFor(verifiability),
    });
  }
  // TEE-capable models first, then alphabetical.
  const rank = (v: Verifiability) => (v === "TeeML" ? 0 : v === "TeeTLS" ? 1 : 2);
  return models.sort((a, b) => rank(a.verifiability) - rank(b.verifiability) || a.id.localeCompare(b.id));
}

const providerSchema = z
  .object({
    trust_mode: z.string().nullable().optional(),
    verifiability: z.string().nullable().optional(),
    is_healthy: z.boolean().nullable().optional(),
  })
  .passthrough();

/**
 * Parse GET /v1/providers?model=<id> into "is there a healthy provider for each trust mode right now".
 * A provider counts for `private` only if it reports trust_mode=private (TeeML); for `verified` if private or verified.
 * Health is a point-in-time signal for the UI, never a guarantee: the Router decides at request time.
 */
export function parseTrustAvailability(json: unknown): TrustAvailability {
  const list = listSchema.safeParse(json);
  if (!list.success) throw new Error("Unexpected 0G providers format");
  const availability: TrustAvailability = { private: false, verified: false, standard: false };
  for (const raw of list.data.data) {
    const p = providerSchema.safeParse(raw);
    if (!p.success || p.data.is_healthy !== true) continue;
    const mode = p.data.trust_mode;
    if (mode === "private") availability.private = true;
    if (mode === "private" || mode === "verified") availability.verified = true;
    availability.standard = true;
  }
  return availability;
}

/** Server-side check that a model/trust-mode pair is allowed. Returns an error message or null. */
export function validateModelChoice(
  models: CatalogModel[],
  modelId: string,
  trustMode: TrustModeOption,
): string | null {
  const model = models.find((m) => m.id === modelId);
  if (!model) return "That model isn't available on the 0G Router right now. Choose another model.";
  if (!model.trustModes.includes(trustMode)) {
    return `${model.id} can't run in ${trustMode} mode. Choose a TEE-capable model or a different trust mode.`;
  }
  return null;
}
