/**
 * bridge.ts — the typed client for the cross-chain Bridge tab (Ethereum Sepolia <->
 * Stellar). This is the single seam between the Bridge UI and the two chains:
 *
 *   • EVM side  — `ObscuraBridgeL1.lock` via wagmi/viem (MetaMask). Native ETH locks
 *                 `value = amount`; ERC20 locks `approve` + `lock` (BRIDGE_SPEC §4).
 *   • Stellar   — reads the `EthLightClient` trusted head and the `ObscuraBridge`
 *                 mint state over Soroban RPC; the relayer (untrusted transport)
 *                 proves the L1 lock and calls `bridge_in`, which mints a shielded
 *                 note (BRIDGE_SPEC §7/§8).
 *
 * A "bridge in" creates a Obscura note with a *bridged* `asset_id` (BRIDGE_SPEC §3),
 * locks the backing on L1, then waits for the Stellar mint. Everything here is
 * structured to run in MOCK mode today and go LIVE by filling the `VITE_BRIDGE_*`
 * config — see `config.ts`.
 */
import { buildTransaction, createNote, fieldToHex, type BalanceNote, type Field } from '@obscura/sdk'
import { Account, Contract, rpc, scValToNative, xdr } from '@stellar/stellar-sdk'
import type { Address, Hex, PublicClient, WalletClient } from 'viem'
import { sepolia } from 'wagmi/chains'
import {
  ASSET_CONFIG,
  ETH_L1_ADDRESS,
  ETH_LIGHT_CLIENT_ID,
  L1_BRIDGE_ADDRESS,
  NETWORK_PASSPHRASE,
  RELAYER_URL,
  SOROBAN_RPC_URL,
  USDC_L1_ADDRESS,
  OBSCURA_BRIDGE_ID,
} from './config'
import type { AssetCode } from './obscura-sdk'

// ---------------------------------------------------------------------------
// Token registry
// ---------------------------------------------------------------------------

export type BridgeTokenSymbol = 'ETH' | 'tUSDC'

export interface BridgeToken {
  symbol: BridgeTokenSymbol
  label: string
  /** L1 token address (0x00..00 = native ETH). */
  l1Address: Address
  /** L1/native decimals (ETH 18, test-USDC 6). */
  decimals: number
  /** Whether this token is native ETH (locked with `value`) or an ERC20 (approve+lock). */
  native: boolean
  /** The Obscura shielded `AssetCode` this bridges into. */
  assetCode: AssetCode
}

export const BRIDGE_TOKENS: Record<BridgeTokenSymbol, BridgeToken> = {
  ETH: {
    symbol: 'ETH',
    label: 'ETH — native (Sepolia)',
    l1Address: ETH_L1_ADDRESS as Address,
    decimals: 18,
    native: true,
    assetCode: 'bETH',
  },
  tUSDC: {
    symbol: 'tUSDC',
    label: 'test-USDC (Sepolia ERC20)',
    l1Address: USDC_L1_ADDRESS as Address,
    decimals: 6,
    native: false,
    assetCode: 'bUSDC',
  },
}

export const BRIDGE_TOKEN_OPTIONS = Object.values(BRIDGE_TOKENS).map((t) => ({
  value: t.symbol,
  label: t.label,
}))

// ---------------------------------------------------------------------------
// ABIs (inlined — matches bridge/l1/src/ObscuraBridgeL1.sol)
// ---------------------------------------------------------------------------

export const OBSCURA_BRIDGE_L1_ABI = [
  {
    type: 'function',
    name: 'lock',
    stateMutability: 'payable',
    inputs: [
      { name: 'commitment', type: 'bytes32' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'locks',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint96' },
    ],
  },
  {
    type: 'event',
    name: 'Locked',
    inputs: [
      { name: 'commitment', type: 'bytes32', indexed: true },
      { name: 'token', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const

const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function l1Configured(): boolean {
  return L1_BRIDGE_ADDRESS.toLowerCase() !== ZERO_ADDRESS
}

// ---------------------------------------------------------------------------
// Note creation (BRIDGE_SPEC §3): a shielded note with a *bridged* asset_id
// ---------------------------------------------------------------------------

/**
 * Create the Obscura note that backs a bridge-in. The note's `asset_id` is the bridged
 * id (derived per BRIDGE_SPEC §3, see `config.deriveBridgedAssetId`), so the minted
 * note interoperates with the pool's transfer/swap but redeems only back to Ethereum.
 */
export function createBridgeNote(params: {
  token: BridgeToken
  amountBase: bigint
  spendingKey: Field
}): BalanceNote {
  const cfg = ASSET_CONFIG[params.token.assetCode]
  return createNote({
    assetId: cfg.assetId,
    amount: params.amountBase,
    spendingKey: params.spendingKey,
  })
}

/** The note commitment as the 32-byte hex the L1 `lock` expects. */
export function commitmentHex(note: BalanceNote): Hex {
  return fieldToHex(note.commitment) as Hex
}

// ---------------------------------------------------------------------------
// L1 lock (wagmi/viem) — BRIDGE_SPEC §4
// ---------------------------------------------------------------------------

export interface LockResult {
  /** L1 lock transaction hash. */
  hash: Hex
  /** Block the lock was mined in (the inclusion proof is taken at/after this block). */
  blockNumber: bigint
}

/**
 * Write `ObscuraBridgeL1.lock(commitment, token, amount)` on Sepolia.
 * Native ETH: `value = amount`. ERC20: `approve` (if needed) then `lock(value = 0)`.
 * Waits for the lock receipt and returns its block number.
 */
export async function lockOnL1(params: {
  walletClient: WalletClient
  publicClient: PublicClient
  account: Address
  token: BridgeToken
  amountBase: bigint
  commitment: Hex
}): Promise<LockResult> {
  if (!l1Configured()) {
    throw new Error(
      'L1 bridge address is not configured. Set VITE_L1_BRIDGE_ADDRESS to the deployed ObscuraBridgeL1, or use mock mode (VITE_USE_MOCK).',
    )
  }
  const { walletClient, publicClient, account, token, amountBase, commitment } = params
  const bridge = L1_BRIDGE_ADDRESS as Address

  if (!token.native) {
    // ERC20 path: ensure the bridge is approved to pull `amountBase`.
    const allowance = (await publicClient.readContract({
      address: token.l1Address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account, bridge],
    })) as bigint
    if (allowance < amountBase) {
      const approveHash = await walletClient.writeContract({
        address: token.l1Address,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [bridge, amountBase],
        account,
        chain: sepolia,
      })
      await publicClient.waitForTransactionReceipt({ hash: approveHash })
    }
  }

  const hash = await walletClient.writeContract({
    address: bridge,
    abi: OBSCURA_BRIDGE_L1_ABI,
    functionName: 'lock',
    args: [commitment, token.l1Address, amountBase],
    account,
    chain: sepolia,
    value: token.native ? amountBase : 0n,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  return { hash, blockNumber: receipt.blockNumber }
}

// ---------------------------------------------------------------------------
// Relayer nudge (optional) — BRIDGE_SPEC §8
// ---------------------------------------------------------------------------

/**
 * Ask the relayer to fetch `eth_getProof` and submit `bridge_in` for `commitment`.
 * The relayer is untrusted transport and already watches L1 `Locked` events; this
 * is just an optional nudge. No-ops (returns false) when `VITE_RELAYER_URL` is unset.
 */
export async function requestBridgeIn(commitment: Hex): Promise<boolean> {
  if (!RELAYER_URL) return false
  try {
    const res = await fetch(`${RELAYER_URL.replace(/\/$/, '')}/bridge-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commitment }),
    })
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Stellar reads (Soroban RPC) — light-client head + mint detection
// ---------------------------------------------------------------------------

// A valid testnet account used only as the read-only simulation source (the deployer
// from deployments.json). Reads need no wallet; this keeps the light-client chip live
// even before a Stellar wallet is connected.
const READ_SOURCE = 'GAGEXK4SPRFYJMR3HXYXMCDBEWBFO4BHJP4XWO3L43HJU366UWPY4MKX'

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function simulateRead(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown | null> {
  try {
    const server = new rpc.Server(SOROBAN_RPC_URL)
    const source = new Account(READ_SOURCE, '0')
    const tx = buildTransaction(source, new Contract(contractId).call(method, ...args), {
      networkPassphrase: NETWORK_PASSPHRASE,
    })
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null
    return scValToNative(sim.result.retval)
  } catch {
    return null
  }
}

export interface LightClientHead {
  blockNumber: bigint
  stateRoot: Hex
}

/**
 * Read the `EthLightClient` trusted head `(block_number, state_root)` (BRIDGE_SPEC §5).
 * Returns null when the contract is not configured/deployed or the RPC is unreachable —
 * the UI then shows a clearly-labelled simulated head.
 */
export async function readLightClientHead(): Promise<LightClientHead | null> {
  if (!ETH_LIGHT_CLIENT_ID) return null
  const native = await simulateRead(ETH_LIGHT_CLIENT_ID, 'head', [])
  if (!Array.isArray(native) || native.length < 2) return null
  const [block, root] = native as [bigint | number, Uint8Array]
  const rootBytes = root instanceof Uint8Array ? root : new Uint8Array(root)
  return {
    blockNumber: BigInt(block),
    stateRoot: (`0x${Buffer.from(rootBytes).toString('hex')}`) as Hex,
  }
}

/** Has the `ObscuraBridge` already minted this inbound commitment? (BRIDGE_SPEC §7/§12). */
export async function readIsBridged(commitment: Hex): Promise<boolean | null> {
  if (!OBSCURA_BRIDGE_ID) return null
  const arg = xdr.ScVal.scvBytes(Buffer.from(hexToBytes(commitment)))
  const native = await simulateRead(OBSCURA_BRIDGE_ID, 'is_bridged', [arg])
  if (typeof native !== 'boolean') return null
  return native
}

// ---------------------------------------------------------------------------
// Explorer links
// ---------------------------------------------------------------------------

export function sepoliaTxUrl(hash: string): string {
  return `https://sepolia.etherscan.io/tx/${hash}`
}

export function stellarContractUrl(contractId: string): string {
  return `https://stellar.expert/explorer/testnet/contract/${contractId}`
}

export { OBSCURA_BRIDGE_ID, ETH_LIGHT_CLIENT_ID, L1_BRIDGE_ADDRESS }
