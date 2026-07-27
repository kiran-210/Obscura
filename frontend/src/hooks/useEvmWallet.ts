import { useMemo } from 'react'
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi'
import { sepolia } from 'wagmi/chains'
import type { Address, PublicClient, WalletClient } from 'viem'

export interface EvmWalletState {
  address: Address | null
  isConnected: boolean
  /** True only when the injected wallet is pointed at Sepolia. */
  isSepolia: boolean
  /** Any injected (MetaMask-class) wallet is available in this browser. */
  hasInjected: boolean
  connecting: boolean
  error: string | null
  connect: () => void
  disconnect: () => void
  switchToSepolia: () => void
  walletClient: WalletClient | null
  publicClient: PublicClient | null
}

/**
 * The EVM (Ethereum Sepolia) side of the bridge — MetaMask via wagmi/viem. Mirrors the
 * shape of the Stellar `useWallet` hook so the Bridge tab can drive both wallets
 * symmetrically. Independent of the Stellar Wallets Kit; the other tabs never touch it.
 */
export function useEvmWallet(): EvmWalletState {
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, status, error } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()

  const injectedConnector = useMemo(
    () => connectors.find((c) => c.type === 'injected') ?? connectors[0],
    [connectors],
  )

  return {
    address: (address as Address | undefined) ?? null,
    isConnected,
    isSepolia: chainId === sepolia.id,
    hasInjected: Boolean(injectedConnector),
    connecting: status === 'pending',
    error: error ? error.message : null,
    connect: () => {
      if (injectedConnector) connect({ connector: injectedConnector })
    },
    disconnect: () => disconnect(),
    switchToSepolia: () => switchChain({ chainId: sepolia.id }),
    walletClient: (walletClient as WalletClient | undefined) ?? null,
    publicClient: (publicClient as PublicClient | undefined) ?? null,
  }
}
