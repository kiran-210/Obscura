import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ISupportedWallet } from '@creit.tech/stellar-wallets-kit'
import {
  clearStoredWalletId,
  kit,
  persistWalletId,
  readStoredWalletId,
  WalletNetwork,
} from '../lib/wallet-kit'

export type WalletStatus =
  | 'checking' // probing for installed wallets / an existing session
  | 'not-installed' // no Stellar wallet is available in this browser
  | 'disconnected' // a wallet is available, but none is connected yet
  | 'connecting' // the wallet-select modal is open / awaiting approval
  | 'connected'

export interface WalletState {
  status: WalletStatus
  address: string | null
  /** Network reported by the connected wallet, e.g. "TESTNET" / "PUBLIC". */
  network: string | null
  /** True only when the connected wallet is pointed at Stellar Testnet. */
  isTestnet: boolean
  installed: boolean
  error: string | null
  connect: () => Promise<void>
  disconnect: () => void
}

const TESTNET = 'TESTNET'
/** Where users without any Stellar wallet can get one (the kit modal also links installs). */
export const FREIGHTER_INSTALL_URL = 'https://www.freighter.app/'

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

const WalletContext = createContext<WalletState | null>(null)

/**
 * Single source of truth for the connected Stellar wallet, via the Stellar Wallets Kit.
 * Provided once at the app root so the Connect button, the Deposit widget, and the
 * shielded-identity derivation all observe the *same* address and connect events
 * (independent `useState` copies would drift apart). `connect()` opens the kit's
 * wallet-select modal, records the choice, reads the active public key, and surfaces a
 * Testnet indicator. The selected wallet is persisted for smooth reconnection.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>('checking')
  const [address, setAddress] = useState<string | null>(null)
  const [network, setNetwork] = useState<string | null>(null)
  const [installed, setInstalled] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadNetwork = useCallback(async () => {
    try {
      const { network: net, networkPassphrase } = await kit.getNetwork()
      if (networkPassphrase === WalletNetwork.PUBLIC) setNetwork('PUBLIC')
      else if (networkPassphrase === WalletNetwork.TESTNET) setNetwork(TESTNET)
      else setNetwork(net ? net.toUpperCase() : TESTNET)
    } catch {
      // Some wallets don't expose getNetwork; the kit signs on Testnet regardless.
      setNetwork(TESTNET)
    }
  }, [])

  // On mount: detect available wallets and silently resume a persisted session.
  useEffect(() => {
    let cancelled = false
    async function probe() {
      let anyAvailable = false
      try {
        const supported = await kit.getSupportedWallets()
        anyAvailable = supported.some((w) => w.isAvailable)
      } catch {
        anyAvailable = false
      }
      if (cancelled) return
      setInstalled(anyAvailable)

      const storedId = readStoredWalletId()
      if (!storedId) {
        if (!cancelled) setStatus(anyAvailable ? 'disconnected' : 'not-installed')
        return
      }
      try {
        kit.setWallet(storedId)
        // skipRequestAccess keeps Freighter from popping a prompt on load; other
        // wallets simply ignore it (and may stay disconnected until reconnected).
        const { address: addr } = await kit.getAddress({ skipRequestAccess: true })
        if (cancelled) return
        if (addr) {
          setAddress(addr)
          await loadNetwork()
          if (!cancelled) setStatus('connected')
          return
        }
        setStatus('disconnected')
      } catch {
        if (!cancelled) setStatus(anyAvailable ? 'disconnected' : 'not-installed')
      }
    }
    void probe()
    return () => {
      cancelled = true
    }
  }, [loadNetwork])

  const connect = useCallback(async () => {
    setError(null)
    setStatus('connecting')
    try {
      await kit.openModal({
        onWalletSelected: async (option: ISupportedWallet) => {
          try {
            kit.setWallet(option.id)
            persistWalletId(option.id)
            const { address: addr } = await kit.getAddress()
            setAddress(addr)
            setInstalled(true)
            await loadNetwork()
            setError(null)
            setStatus('connected')
          } catch (err) {
            setStatus('disconnected')
            setError(errorMessage(err, 'Could not read the wallet address.'))
          }
        },
        onClosed: () => {
          // Modal dismissed without a selection — not an error, just stay put.
          setStatus((prev) => (prev === 'connected' ? prev : 'disconnected'))
        },
      })
    } catch (err) {
      setStatus('disconnected')
      setError(errorMessage(err, 'Could not open the wallet selector.'))
    }
  }, [loadNetwork])

  const disconnect = useCallback(() => {
    // Clears async sessions (e.g. WalletConnect) plus our local UI + persisted state.
    void kit.disconnect().catch(() => undefined)
    clearStoredWalletId()
    setAddress(null)
    setNetwork(null)
    setError(null)
    setStatus('disconnected')
  }, [])

  const value = useMemo<WalletState>(
    () => ({
      status,
      address,
      network,
      isTestnet: network === TESTNET,
      installed,
      error,
      connect,
      disconnect,
    }),
    [status, address, network, installed, error, connect, disconnect],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used within a WalletProvider')
  return ctx
}
