// Shared (client + server) option lists for the agent builder.

export const TRUST_MODES = ["private", "verified", "standard"] as const;
export type TrustModeOption = (typeof TRUST_MODES)[number];

export const TRUST_MODE_INFO: Record<TrustModeOption, { label: string; summary: string; detail: string }> = {
  private: {
    label: "Private (TEE)",
    summary: "Model runs inside a hardware enclave. Responses are signed and verifiable.",
    detail:
      "Routed only to TeeML providers (Intel TDX). Prompts enter the enclave encrypted; neither 0G nor the hardware operator can read them. Alactic's own servers still see the conversation to retrieve knowledge.",
  },
  verified: {
    label: "Verified",
    summary: "Responses are verifiable, but some providers relay to an upstream model service.",
    detail:
      "Routed to TeeML or TeeTLS providers. With TeeTLS the upstream model provider processes prompts under its own data policy.",
  },
  standard: {
    label: "Standard",
    summary: "Broadest model choice. No attestation; responses can't be verified.",
    detail: "Routed to any provider, including undisclosed third-party channels. Responses are labelled unverified.",
  },
};

export const TONES = [
  { value: "professional", label: "Professional", hint: "Clear, courteous and precise." },
  { value: "friendly", label: "Friendly", hint: "Warm and conversational." },
  { value: "concise", label: "Concise", hint: "Short, direct answers." },
  { value: "empathetic", label: "Empathetic", hint: "Patient and reassuring." },
] as const;
export type ToneOption = (typeof TONES)[number]["value"];

export const LANGUAGES = [
  { value: "auto", label: "Match the customer's language" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
  { value: "it", label: "Italian" },
  { value: "nl", label: "Dutch" },
  { value: "pl", label: "Polish" },
  { value: "tr", label: "Turkish" },
  { value: "ar", label: "Arabic" },
  { value: "hi", label: "Hindi" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
] as const;
export type LanguageOption = (typeof LANGUAGES)[number]["value"];

/**
 * Default chat model. Chosen from live tests on 2026-11-06: 0gm-1.0-35b-a3b (TeeML) answered in ~2s, while
 * glm-5.3 was intermittently overloaded, ~3x slower, ~16x more expensive and leaked reasoning text.
 */
export const DEFAULT_MODEL_ID = "0gm-1.0-35b-a3b";
export const DEFAULT_TRUST_MODE: TrustModeOption = "private";
export const DEFAULT_FALLBACK_MESSAGE =
  "I'm not sure about that one. Please contact our support team and they'll be happy to help.";

export const LIMITS = {
  name: { min: 2, max: 60 },
  description: { max: 280 },
  instructions: { max: 8000 },
  persona: { max: 500 },
  fallback: { min: 10, max: 500 },
  temperature: { min: 0, max: 1 },
  maxOutputTokens: { min: 128, max: 4096 },
  retrievalTopK: { min: 1, max: 20 },
} as const;
