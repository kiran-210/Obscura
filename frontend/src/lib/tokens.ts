/**
 * Token registry.
 *
 * The protocol is asset-agnostic: the pool accepts any Stellar Asset Contract (SAC) and
 * derives the note's `asset_id` from its address (native XLM = 0). So "supporting a token"
 * is purely a client concern — know its SAC, derive the asset id, done. No whitelist, no
 * contract change.
 *
 * This module holds a curated list of well-known tokens (metadata + SAC where available on
 * the active network) and resolves arbitrary custom tokens from a pasted SAC address.
 */
import { assetFromSac, buildTransaction, NATIVE_ASSET_ID, type Field } from '@obscura/sdk'
import { Account, Contract, rpc, scValToNative } from '@stellar/stellar-sdk'
import { NATIVE_SAC, NETWORK_PASSPHRASE, SOROBAN_RPC_URL } from './config'

export interface TokenMeta {
  code: string
  name: string
  /** CoinBadge icon key. */
  icon: string
  /** On-chain fixed-point decimals (classic Stellar assets are all 7). */
  decimals: number
  /** Display price estimate (USD). */
  priceUsd: number
  /** SAC address on the active network, or undefined if not available here. */
  sac?: string
  /** True for the native XLM SAC (asset_id = 0). */
  native?: boolean
  /** True for cross-chain bridged assets (no native SAC; minted by the bridge). */
  bridged?: boolean
  /** True for a testnet faucet token — the app can mint it to you on demand. */
  faucet?: boolean
}

function sacEnv(code: string): string | undefined {
  const v = import.meta.env[`VITE_${code}_SAC` as keyof ImportMetaEnv] as string | undefined
  return v && v.length > 0 ? v : undefined
}

/**
 * Curated tokens shown in the deposit picker. XLM is the real native SAC; USDC is a
 * testnet faucet token (a deployed permissionless-mint mock) so it's depositable out
 * of the box — the app can mint it to you. Override either SAC via `VITE_<CODE>_SAC`
 * (e.g. to point at the real mainnet assets).
 *
 * XLM and USDC are the only supported assets. This list is the single source of
 * truth — deposit, withdraw, pay and swap all derive their options from it.
 */
export const CURATED_TOKENS: TokenMeta[] = [
  { code: 'XLM', name: 'Stellar Lumens', icon: 'XLM', decimals: 7, priceUsd: 0.39, sac: NATIVE_SAC, native: true },
  { code: 'USDC', name: 'USD Coin', icon: 'USDC', decimals: 7, priceUsd: 1, faucet: true,
    sac: sacEnv('USDC') ?? 'CDXJVN37QOE3L33WMHMH4XU2HXEICFOSOMM7TYLJAPIQIBI6OTRA4G4Z' },
]

const REGISTRY = new Map<string, TokenMeta>(CURATED_TOKENS.map((t) => [t.code, t]))

/** The canonical token codes (the global "enum") used by deposit / transfer / swap pickers. */
export const TOKEN_CODES: string[] = CURATED_TOKENS.map((t) => t.code)

/** Select options for the token pickers (code — name). */
export const TOKEN_OPTIONS = CURATED_TOKENS.map((t) => ({ value: t.code, label: `${t.code} — ${t.name}` }))

/** Metadata for a code — falls back to a plain text badge for unknown/custom tokens. */
export function assetMeta(code: string): TokenMeta {
  return REGISTRY.get(code) ?? { code, name: code, icon: code, decimals: 7, priceUsd: 0 }
}

/** The `asset_id` field for a token: native XLM = 0; else Poseidon2 of its SAC address. */
export function assetIdFor(token: Pick<TokenMeta, 'native' | 'sac'>): Field {
  if (token.native) return NATIVE_ASSET_ID
  if (!token.sac) throw new Error('Token has no SAC address to derive its asset id.')
  return assetFromSac(token.sac).assetId
}

/** Curated tokens depositable on the active network (their SAC exists here). */
export function depositableTokens(): TokenMeta[] {
  return CURATED_TOKENS.filter((t) => Boolean(t.sac))
}

/**
 * Reverse lookup: curated metadata for a SAC address (undefined if not curated). Used by the
 * indexer to label/format a deposit recovered from chain (which carries only the SAC address).
 */
export function tokenBySac(sac: string): TokenMeta | undefined {
  if (sac === NATIVE_SAC) return CURATED_TOKENS[0]
  return CURATED_TOKENS.find((t) => t.sac === sac)
}

// A valid testnet account used only as a read-only simulation source.
const READ_SOURCE = 'GAGEXK4SPRFYJMR3HXYXMCDBEWBFO4BHJP4XWO3L43HJU366UWPY4MKX'

async function simRead(server: rpc.Server, sac: string, method: string): Promise<unknown | null> {
  try {
    const tx = buildTransaction(new Account(READ_SOURCE, '0'), new Contract(sac).call(method), {
      networkPassphrase: NETWORK_PASSPHRASE,
    })
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null
    return scValToNative(sim.result.retval)
  } catch {
    return null
  }
}

/**
 * Resolve a custom token from its SAC contract address (`C…`), querying the token's
 * `decimals` and `symbol` so the deposit uses the right units and label.
 */
export async function resolveCustomToken(sacAddress: string): Promise<TokenMeta> {
  const sac = sacAddress.trim()
  if (!/^C[A-Z2-7]{55}$/.test(sac)) {
    throw new Error('Enter a valid Stellar contract (SAC) address — starts with “C”.')
  }
  const server = new rpc.Server(SOROBAN_RPC_URL)
  const [decimalsRaw, symbolRaw] = await Promise.all([simRead(server, sac, 'decimals'), simRead(server, sac, 'symbol')])
  if (decimalsRaw === null && symbolRaw === null) {
    throw new Error('No token found at that address on this network (is the SAC deployed?).')
  }
  const decimals = Number(decimalsRaw)
  const symbol = symbolRaw ? String(symbolRaw) : 'TOKEN'
  return {
    code: symbol,
    name: symbol,
    icon: symbol,
    decimals: Number.isFinite(decimals) && decimals >= 0 ? decimals : 7,
    priceUsd: 0,
    sac,
  }
}
