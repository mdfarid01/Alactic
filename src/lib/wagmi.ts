import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { mainnet, sepolia } from "wagmi/chains";

/**
 * Wallet connection is only used for sign-in (message signing). We never ask the wallet to send transactions here.
 * Browser-extension wallets are discovered via EIP-6963 (MetaMask, Rabby, Coinbase Wallet extension, ...).
 */
export const wagmiConfig = createConfig({
  chains: [mainnet, sepolia],
  connectors: [injected()],
  transports: { [mainnet.id]: http(), [sepolia.id]: http() },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
