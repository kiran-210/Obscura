/**
 * wagmi configuration for the EVM (Ethereum Sepolia) side of the bridge.
 *
 * The Bridge tab connects TWO wallets: this wagmi/viem config drives MetaMask (or any
 * injected EIP-1193 wallet) on Sepolia, while the existing Stellar Wallets Kit
 * (`wallet-kit.ts`) stays untouched for the Stellar side. Keeping the two stacks fully
 * separate means none of the other tabs (Portfolio / Pay / Swap) change behaviour.
 */
import { createConfig, http } from 'wagmi'
import { sepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { SEPOLIA_RPC_URL } from './config'

export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [injected()],
  transports: {
    [sepolia.id]: http(SEPOLIA_RPC_URL),
  },
})

/** Make the config the ambient default for wagmi's typed hooks/actions. */
declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
