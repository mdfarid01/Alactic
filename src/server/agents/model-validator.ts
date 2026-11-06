import "server-only";
import type { TrustModeOption } from "@/lib/agent-options";
import { getModelCatalog } from "@/server/inference/catalog";
import { validateModelChoice } from "@/server/inference/catalog-parse";
import type { ModelValidator } from "./service";

/** Validates against the live 0G catalog. If the catalog is unreachable, changes are refused (never assumed valid). */
export const catalogModelValidator: ModelValidator = async (modelId: string, trustMode: TrustModeOption) => {
  const catalog = await getModelCatalog();
  if (!catalog.ok) return catalog.error;
  return validateModelChoice(catalog.models, modelId, trustMode);
};
