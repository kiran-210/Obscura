/**
 * Live deployment configuration for the Wraith frontend.
 *
 * Source of truth: `deployments.json` at the repo root (testnet). The values are inlined
 * here (a typed config) so the app does not need filesystem access outside its own root,
 * and every value can be overridden at build time via `VITE_*` env vars for other
 * networks / private deployments.
 *
 * deployments.json (testnet):
 *   pool        CD7EF4GG32IPVS2PGD2LMXEO3TPEWBZRUCBBSPXQ236CD6TMF5S4UUZR
 *   native SAC  CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
 *   passphrase  "Test SDF Network ; September 2015"
 */
import { assetFromSac, hash2, NATIVE_ASSET_ID, toField, type Field } from '@wraith/sdk'
import type { AssetCode } from './wraith-sdk'

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
 * WraithPool contract id on the configured network.
 *
 * Points at the match-memo pool (redeployed 2026-07-02): `transfer` AND `match_orders` carry
 * encrypted note payloads (+ full leaf set/indices) in their events, which the recipient's
 * indexer scans to auto-discover incoming notes and settlement fills. Fresh tree; reuses the
 * existing verifier contracts. Prior pools: memo pool CBVM7B622FSW47FDNUVU7GEU7TNRVRWEVOTNAUWVUOHFMIPSTDL2YVNG,
 * pre-memo pool CD7EF4GG32IPVS2PGD2LMXEO3TPEWBZRUCBBSPXQ236CD6TMF5S4UUZR.
 */
export const POOL_CONTRACT_ID = env(
  'VITE_WRAITH_POOL',
  'CA2CI7VKG27V3FIXD3OYXFYTN33DMI5QR4WFBX3N5SRC6JWEO3AWDILD',
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
export const POOL_DEPLOY_LEDGER = Number(env('VITE_POOL_DEPLOY_LEDGER', '3402675'))

/** Stellar network passphrase. */
export const NETWORK_PASSPHRASE = env('VITE_NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015')

/** When true, the app uses the offline `MockWraithSdk` instead of the live client. */
export const USE_MOCK = flag('VITE_USE_MOCK')

/** Optional USDC SAC address — not part of the single-asset testnet demo. */
export const USDC_SAC = env('VITE_USDC_SAC', '')

// ---------------------------------------------------------------------------
// Cross-chain bridge (Ethereum Sepolia <-> Stellar). BRIDGE_SPEC §3/§7/§9.
//
// PLACEHOLDER addresses below ship with the app so the Bridge tab type-checks,
// builds, and runs in mock mode TODAY. Fill the `VITE_BRIDGE_*` env vars (or edit
// these defaults) with the real deployed addresses to take it live. Until the L1
// bridge + Soroban light-client/bridge contracts are deployed, the live reads
// fail gracefully and the UI shows a "simulated" light-client head.
// ---------------------------------------------------------------------------

/** When true, the Bridge tab runs a self-contained mock walkthrough (no wallets). */
export const USE_MOCK_BRIDGE = USE_MOCK || flag('VITE_USE_MOCK_BRIDGE')

/** Ethereum chain the L1 bridge is deployed on (Sepolia testnet = 11155111). */
export const L1_CHAIN_ID = Number(env('VITE_L1_CHAIN_ID', '11155111'))

/** Sepolia execution RPC used by viem reads (eth_getProof is done by the relayer). */
export const SEPOLIA_RPC_URL = env('VITE_SEPOLIA_RPC_URL', 'https://ethereum-sepolia-rpc.publicnode.com')

/** `WraithBridgeL1` escrow address on Sepolia (locks/unlocks the backing). */
export const L1_BRIDGE_ADDRESS = env(
  'VITE_L1_BRIDGE_ADDRESS',
  '0x0000000000000000000000000000000000000000',
)

/** Soroban `EthLightClient` contract id (trusted Ethereum head on Stellar). */
export const ETH_LIGHT_CLIENT_ID = env('VITE_ETH_LIGHT_CLIENT', '')

/** Soroban `WraithBridge` contract id (bridge_in / bridge_out). */
export const WRAITH_BRIDGE_ID = env('VITE_WRAITH_BRIDGE', '')

/**
 * Optional relayer base URL. If set, `requestBridgeIn` POSTs the commitment to nudge
 * the relayer; otherwise the UI just polls the Stellar `BridgeInEvent` (the relayer
 * watches L1 `Locked` events on its own — BRIDGE_SPEC §8).
 */
export const RELAYER_URL = env('VITE_RELAYER_URL', '')

/**
 * Bridge-asset domain separator (BRIDGE_SPEC §3):
 *   asset_id(bToken) = hash2( hash2(eth_chain_id, eth_token_address_as_field), BRIDGE_DOMAIN )
 * The numeric domain is not pinned by the spec; this default is deterministic and
 * overridable so it can be aligned with the contract when the derivation lands on-chain.
 */
export const BRIDGE_DOMAIN: Field = toField(env('VITE_BRIDGE_DOMAIN', '0x627269646765')) // "bridge"

/** Map a 20-byte L1 token address (hex) to its bridged Wraith `asset_id` field. */
export function deriveBridgedAssetId(tokenAddressHex: string): Field {
  const addrField = toField(BigInt(tokenAddressHex))
  return hash2(hash2(L1_CHAIN_ID, addrField), BRIDGE_DOMAIN)
}

/** Native ETH is represented on L1 by the zero address (BRIDGE_SPEC §4). */
export const ETH_L1_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Sepolia test-USDC (Circle faucet token) — override via env for other deployments. */
export const USDC_L1_ADDRESS = env('VITE_BRIDGE_USDC_L1', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')

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
  // Bridged assets: no Stellar SAC (the backing lives in the L1 escrow). The
  // `assetId` follows BRIDGE_SPEC §3 so the minted note interoperates with the pool.
  bETH: {
    code: 'bETH',
    assetId: deriveBridgedAssetId(ETH_L1_ADDRESS),
    sac: undefined,
    decimals: 18,
    priceUsd: 3500,
  },
  bUSDC: {
    code: 'bUSDC',
    assetId: deriveBridgedAssetId(USDC_L1_ADDRESS),
    sac: undefined,
    decimals: 6,
    priceUsd: 1,
  },
}
