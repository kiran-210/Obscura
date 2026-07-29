/**
 * Live deployment configuration for the Obscura frontend.
 *
 * Source of truth: `deployments.json` at the repo root (testnet). The values are inlined
 * here (a typed config) so the app does not need filesystem access outside its own root,
 * and every value can be overridden at build time via `VITE_*` env vars for other
 * networks / private deployments.
 *
 * deployments.json (testnet, redeployed 2026-07-29):
 *   pool        CA6KV2PFQ3IRTJNFCWRDRBJLNI2VB47AOGH57HMUDSLLSIC2RX5WMQJE
 *   native SAC  CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
 *   USDC SAC    CDXJVN37QOE3L33WMHMH4XU2HXEICFOSOMM7TYLJAPIQIBI6OTRA4G4Z
 *   passphrase  "Test SDF Network ; September 2015"
 */
import { assetFromSac, NATIVE_ASSET_ID, type Field } from '@obscura/sdk'
import type { AssetCode } from './obscura-sdk'

// Tolerate a missing `import.meta.env` (Node/SSR/test contexts, where Vite hasn't injected it)
// by falling back to the compiled defaults rather than throwing.
const META_ENV = (import.meta.env ?? {}) as Partial<ImportMetaEnv>

function env(key: string, fallback: string): string {
  const v = META_ENV[key as keyof ImportMetaEnv] as string | undefined
  return v && v.length > 0 ? v : fallback
}

function flag(key: string): boolean {
  const v = META_ENV[key as keyof ImportMetaEnv] as string | undefined
  return v === 'true' || v === '1'
}

/**
 * ObscuraPool contract id on the configured network.
 *
 * Redeployed 2026-07-29 with a fresh Merkle tree and fresh UltraHonk verifier instances.
 * `transfer` AND `match_orders` carry encrypted note payloads (+ full leaf set/indices) in
 * their events, which the recipient's indexer scans to auto-discover incoming notes and
 * settlement fills.
 * Prior pools: CABEK4ZKQI3LSSFLUWC3MNMNE53QYVBE5Y6ZTM2ERVLNQFLTFAAYHFJH,
 * CA2CI7VKG27V3FIXD3OYXFYTN33DMI5QR4WFBX3N5SRC6JWEO3AWDILD,
 * CBVM7B622FSW47FDNUVU7GEU7TNRVRWEVOTNAUWVUOHFMIPSTDL2YVNG.
 */
export const POOL_CONTRACT_ID = env(
  'VITE_OBSCURA_POOL',
  'CA6KV2PFQ3IRTJNFCWRDRBJLNI2VB47AOGH57HMUDSLLSIC2RX5WMQJE',
)

/** Native (XLM) Stellar Asset Contract address. */
export const NATIVE_SAC = env(
  'VITE_NATIVE_SAC',
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
)

/** Soroban RPC endpoint (Testnet by default). */
export const SOROBAN_RPC_URL = env('VITE_SOROBAN_RPC_URL', 'https://soroban-testnet.stellar.org')

/** Off-chain dark-pool matcher base URL (e.g. http://localhost:8787). Empty = matching
 *  disabled: orders still place + cancel on-chain, they just won't be matched/filled. */
export const MATCHER_URL = env('VITE_MATCHER_URL', '')

/** Ledger the pool was deployed at — the client indexer's cold-start floor (clamped to the
 *  RPC's event-retention window, so older history is unavailable). */
export const POOL_DEPLOY_LEDGER = Number(env('VITE_POOL_DEPLOY_LEDGER', '3849362'))

/** Stellar network passphrase. */
export const NETWORK_PASSPHRASE = env('VITE_NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015')

/** When true, the app uses the offline `MockObscuraSdk` instead of the live client. */
export const USE_MOCK = flag('VITE_USE_MOCK')

/**
 * USDC SAC address. Defaults to the testnet faucet-token mock deployed alongside the
 * pool (contracts/faucet-token, 7 decimals) — override to point at real mainnet USDC.
 */
export const USDC_SAC = env('VITE_USDC_SAC', 'CDXJVN37QOE3L33WMHMH4XU2HXEICFOSOMM7TYLJAPIQIBI6OTRA4G4Z')

/** Per-asset on-chain config. `assetId` is the in-circuit field id (native XLM = 0). */
export interface AssetConfig {
  code: AssetCode
  /** Field identifier used in notes/commitments. */
  assetId: Field
  /** SAC contract address (StrKey "C…"), or undefined if not deployed on this network. */
  sac: string | undefined
  /** On-chain fixed-point decimals (stroops for XLM = 7). */
  decimals: number
  /** Display price estimate (USD), portfolio only. */
  priceUsd: number
}

export const ASSET_CONFIG: Record<AssetCode, AssetConfig> = {
  XLM: { code: 'XLM', assetId: NATIVE_ASSET_ID, sac: NATIVE_SAC, decimals: 7, priceUsd: 0.39 },
  USDC: {
    code: 'USDC',
    // Derived from the SAC address when configured; otherwise a placeholder id.
    assetId: USDC_SAC ? assetFromSac(USDC_SAC, 'USDC').assetId : 0n,
    sac: USDC_SAC || undefined,
    decimals: 7,
    priceUsd: 1,
  },
}
