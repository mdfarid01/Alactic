import "server-only";
import { appOrigin, env } from "@/server/env";
import { rpcContractSignatureVerifier, type SiweConfig } from "./siwe";

export function siweConfig(): SiweConfig {
  const e = env();
  return {
    origin: appOrigin(),
    allowedChainIds: e.SIWE_ALLOWED_CHAIN_IDS,
    verifyContractSignature: rpcContractSignatureVerifier({
      1: e.ETH_RPC_URL_MAINNET,
      11155111: e.ETH_RPC_URL_SEPOLIA,
    }),
  };
}
