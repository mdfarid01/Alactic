/**
 * Pieces of 0G TEE signature verification shared by the server verifier and the in-browser verifier.
 * Pure (no Node or DOM APIs). Procedure and ABI: see src/server/inference/tee-verifier.ts and docs/0G_INTEGRATION.md §6.
 */

export const getServiceAbi = [
  {
    type: "function",
    name: "getService",
    stateMutability: "view",
    inputs: [{ name: "provider", type: "address" }],
    outputs: [
      {
        name: "service",
        type: "tuple",
        components: [
          { name: "provider", type: "address" },
          { name: "serviceType", type: "string" },
          { name: "url", type: "string" },
          { name: "inputPrice", type: "uint256" },
          { name: "outputPrice", type: "uint256" },
          { name: "updatedAt", type: "uint256" },
          { name: "model", type: "string" },
          { name: "verifiability", type: "string" },
          { name: "additionalInfo", type: "string" },
          { name: "teeSignerAddress", type: "address" },
          { name: "teeSignerAcknowledged", type: "bool" },
        ],
      },
    ],
  },
] as const;

export type ServiceRecord = {
  url: string;
  model: string;
  verifiability: string;
  teeSignerAddress: string;
  teeSignerAcknowledged: boolean;
  additionalInfo: string;
};

/** The address expected to have signed: the separated target TEE when declared, else the service's TEE signer. Throws on malformed info. */
export function expectedSigner(svc: ServiceRecord): string {
  try {
    const info = JSON.parse(svc.additionalInfo) as { ProviderType?: string; TargetSeparated?: boolean; TargetTeeAddress?: string };
    const centralized = info.ProviderType === "centralized";
    if (info.TargetSeparated === true && !centralized && info.TargetTeeAddress) return info.TargetTeeAddress;
  } catch {
    // Same as the SDK: unparsable additionalInfo is not verifiable.
    throw new Error("unparsable additionalInfo");
  }
  return svc.teeSignerAddress;
}

export const CHAT_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export function signatureUrl(svc: ServiceRecord, chatId: string): string {
  return `${svc.url.replace(/\/+$/, "")}/v1/proxy/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(svc.model)}`;
}
