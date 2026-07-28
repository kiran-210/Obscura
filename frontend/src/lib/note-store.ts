/**
 * Local wallet persistence for the live Obscura client.
 *
 * A shielded balance note's secret material (spending key, blinding) is the ONLY thing
 * that lets the owner later spend/withdraw it — it lives nowhere on-chain. We persist it
 * in `localStorage` so Portfolio can show real deposited notes and (experimental)
 * withdraw can rebuild a Merkle witness. This is demo-grade storage: clearing browser
 * data loses access to the notes' funds, exactly like losing a key.
 *
 * BN254 field elements (bigint) are serialized as 0x-hex; amounts as decimal strings.
 */
import { fieldToHex, hexToField, type BalanceNote, type Field, type Position } from '@obscura/sdk'
import { POOL_CONTRACT_ID } from './config'
import type { AssetCode } from './obscura-sdk'

const NOTES_PREFIX = 'obscura.notes.v1'
const SPENDING_PREFIX = 'obscura.spendingKey.v1'
// The client indexer's persisted state (per identity): the full leaf set (to rebuild the
// Merkle tree) and the last fully-indexed ledger (cold-start resumes from here).
const LEAVES_PREFIX = 'obscura.leaves.v1'
const CURSOR_PREFIX = 'obscura.indexcursor.v1'
// Placed dark-pool orders (per identity).
const ORDERS_PREFIX = 'obscura.orders.v1'
// Lending positions (per identity). Unlike collateral — which the contract
// publishes — a position's `debtScaled` and `nonce` exist NOWHERE on-chain. Lose
// them and the position can never be attested or repaid: it simply freezes and is
// seized once its deadline lapses. This store is the only copy.
const POSITIONS_PREFIX = 'obscura.positions.v1'

// The shielded identity is derived per Stellar address (see lib/shielded-identity).
// `activeAddress` namespaces both the notes list and the cached spending key, so
// switching wallets switches the shielded balance; `activeKey` is the in-memory key.
let activeAddress: string | null = null
let activeKey: Field | null = null

// Per-pool tag: notes/leaves/cursor/orders belong to a specific pool's Merkle tree, so a pool
// redeploy (fresh tree) must not reuse the old pool's cached state. The spending key is
// pool-independent (same wallet → same identity), so it is NOT tagged.
const POOL_TAG = POOL_CONTRACT_ID.slice(-8)

function notesStorageKey(): string {
  return `${NOTES_PREFIX}:${POOL_TAG}:${activeAddress ?? 'anon'}`
}
function spendingStorageKey(address: string): string {
  return `${SPENDING_PREFIX}:${address}`
}
function leavesStorageKey(): string {
  return `${LEAVES_PREFIX}:${POOL_TAG}:${activeAddress ?? 'anon'}`
}
function cursorStorageKey(): string {
  return `${CURSOR_PREFIX}:${POOL_TAG}:${activeAddress ?? 'anon'}`
}

/** A persisted note: a {@link BalanceNote} plus app bookkeeping. */
export interface StoredNote {
  assetCode: AssetCode
  assetId: string // 0x-hex field
  amount: string // decimal base units (stroops for XLM)
  ownerKey: string
  blinding: string
  spendingKey: string
  commitment: string
  leafIndex?: number
  assetAddress?: string // the token's SAC address (for withdraw)
  decimals?: number // token fixed-point decimals (for formatting)
  spent: boolean
  createdAt: number
  txHash?: string
  /** How this note entered the wallet (drives the deterministic deposit salt + provenance). */
  source?: 'deposit' | 'received' | 'change'
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function read<T>(key: string, fallback: T): T {
  const ls = safeLocalStorage()
  if (!ls) return fallback
  try {
    const raw = ls.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full / unavailable — non-fatal for the in-memory session */
  }
}

/** Point the store at a wallet's shielded identity namespace (clears the in-memory key). */
export function setActiveAddress(address: string | null): void {
  if (address === activeAddress) return
  activeAddress = address
  activeKey = null
}

/** True when a spending key for the active address is available (in memory or cached). */
export function hasSpendingKey(): boolean {
  if (activeKey) return true
  if (!activeAddress) return false
  return Boolean(safeLocalStorage()?.getItem(spendingStorageKey(activeAddress)))
}

/** Activate and persist a derived spending key for the active address. */
export function setSpendingKey(key: Field): void {
  activeKey = key
  const ls = safeLocalStorage()
  if (ls && activeAddress) ls.setItem(spendingStorageKey(activeAddress), fieldToHex(key))
}

/** Read a cached spending key for `address` without activating it (null if none). */
export function peekCachedSpendingKey(address: string): Field | null {
  const raw = safeLocalStorage()?.getItem(spendingStorageKey(address))
  if (!raw) return null
  // Tolerate both raw hex and older JSON-quoted values.
  const hex = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw
  return hexToField(hex)
}

/** Forget the active shielded identity (on disconnect). */
export function clearActiveIdentity(): void {
  activeAddress = null
  activeKey = null
}

/** Generate a fresh 32-byte spending key via the platform CSPRNG (not yet persisted). */
export function randomSpendingKey(): Field {
  const buf = new Uint8Array(32)
  globalThis.crypto.getRandomValues(buf)
  let hex = '0x'
  for (const b of buf) hex += b.toString(16).padStart(2, '0')
  return hexToField(hex)
}

/**
 * The active shielded spending key. Returns the in-memory key, or lazily loads the one
 * cached for the active address. Throws when no identity has been established yet — the
 * caller must connect a wallet so {@link setSpendingKey} runs first.
 */
export function getSpendingKey(): Field {
  if (activeKey) return activeKey
  if (activeAddress) {
    const cached = peekCachedSpendingKey(activeAddress)
    if (cached) {
      activeKey = cached
      return cached
    }
  }
  throw new Error('Shielded identity is not ready. Connect your Stellar wallet to derive your spending key.')
}

export function loadNotes(): StoredNote[] {
  return read<StoredNote[]>(notesStorageKey(), [])
}

/** The client indexer's persisted leaf set (all pool commitments in insertion order). */
export function loadLeaves(): string[] {
  return read<string[]>(leavesStorageKey(), [])
}
export function saveLeaves(leaves: string[]): void {
  write(leavesStorageKey(), leaves)
}

/** The last ledger the indexer fully processed (0 = never indexed → cold start). */
export function loadIndexCursor(): number {
  return read<number>(cursorStorageKey(), 0)
}
export function saveIndexCursor(ledger: number): void {
  write(cursorStorageKey(), ledger)
}

/**
 * Wipe every locally-cached note (all wallet namespaces plus any legacy global key).
 * Leaves the derived spending keys and wallet selection intact — so you stay connected
 * and won't be re-prompted to sign, you just start from a zero shielded balance.
 */
export function clearAllNotes(): void {
  const ls = safeLocalStorage()
  if (!ls) return
  const doomed: string[] = []
  for (let i = 0; i < ls.length; i += 1) {
    const k = ls.key(i)
    // Notes for every wallet + the indexer's leaves/cursor + legacy scan cursors, so
    // both discovery and the Merkle-tree rebuild re-run from the pool's deploy ledger.
    if (
      k &&
      (k === NOTES_PREFIX ||
        k.startsWith(`${NOTES_PREFIX}:`) ||
        k.startsWith(`${LEAVES_PREFIX}:`) ||
        k.startsWith(`${CURSOR_PREFIX}:`) ||
        k.startsWith(`${ORDERS_PREFIX}:`) ||
        k.startsWith('obscura.scan.'))
    ) {
      doomed.push(k)
    }
  }
  for (const k of doomed) ls.removeItem(k)
}

function saveNotes(notes: StoredNote[]): void {
  write(notesStorageKey(), notes)
}

/** Persist a freshly created note (keyed by commitment; replaces any prior copy). */
export function addNote(
  note: BalanceNote,
  meta: {
    assetCode: AssetCode
    txHash?: string
    leafIndex?: number
    decimals?: number
    source?: 'deposit' | 'received' | 'change'
  },
): void {
  const stored: StoredNote = {
    assetCode: meta.assetCode,
    assetId: fieldToHex(note.assetId),
    amount: note.amount.toString(),
    ownerKey: fieldToHex(note.ownerKey),
    blinding: fieldToHex(note.blinding),
    spendingKey: fieldToHex(note.spendingKey),
    commitment: fieldToHex(note.commitment),
    spent: false,
    createdAt: Date.now(),
  }
  if (meta.leafIndex !== undefined) stored.leafIndex = meta.leafIndex
  else if (note.leafIndex !== undefined) stored.leafIndex = note.leafIndex
  if (note.assetAddress !== undefined) stored.assetAddress = note.assetAddress
  if (meta.decimals !== undefined) stored.decimals = meta.decimals
  if (meta.source !== undefined) stored.source = meta.source
  if (meta.txHash !== undefined) stored.txHash = meta.txHash

  const notes = loadNotes().filter((n) => n.commitment !== stored.commitment)
  notes.push(stored)
  saveNotes(notes)
}

/**
 * Add a note discovered from an incoming transfer memo (or recovered by the indexer). No-op
 * if already known. Returns true if added. The note is spendable via its `leafIndex` — the
 * Merkle witness is rebuilt on demand from the indexer, so none is stored here.
 */
export function upsertReceivedNote(fields: {
  assetCode: AssetCode
  assetId: string
  amount: string
  ownerKey: string
  blinding: string
  spendingKey: string
  commitment: string
  leafIndex: number
  decimals?: number
  source?: 'deposit' | 'received' | 'change'
}): boolean {
  const notes = loadNotes()
  if (notes.some((n) => n.commitment === fields.commitment)) return false
  const stored: StoredNote = {
    assetCode: fields.assetCode,
    assetId: fields.assetId,
    amount: fields.amount,
    ownerKey: fields.ownerKey,
    blinding: fields.blinding,
    spendingKey: fields.spendingKey,
    commitment: fields.commitment,
    leafIndex: fields.leafIndex,
    source: fields.source ?? 'received',
    spent: false,
    createdAt: Date.now(),
  }
  if (fields.decimals !== undefined) stored.decimals = fields.decimals
  notes.push(stored)
  saveNotes(notes)
  return true
}

/** Mark a note spent by its commitment hex. */
export function markSpent(commitmentHex: string): void {
  const notes = loadNotes().map((n) => (n.commitment === commitmentHex ? { ...n, spent: true } : n))
  saveNotes(notes)
}

/**
 * Set a note's `leafIndex` once its commitment appears on-chain. Used for notes created
 * locally without a known index (a place/cancel-order change/refund note): the indexer
 * matches the emitted leaf to the stored note and back-fills the index so it's spendable.
 * Returns true if a note was updated. No-op if the note already has an index.
 */
export function setLeafIndexForCommitment(commitmentHex: string, leafIndex: number): boolean {
  let changed = false
  const notes = loadNotes().map((n) => {
    if (n.commitment.toLowerCase() === commitmentHex.toLowerCase() && n.leafIndex === undefined) {
      changed = true
      return { ...n, leafIndex }
    }
    return n
  })
  if (changed) saveNotes(notes)
  return changed
}

// --- Dark-pool orders (device-local; the order's secrets never leave this browser) --------

/** A placed sealed order the wallet is tracking so it can display + later cancel it. */
export interface StoredOrder {
  /** order_commitment hex — the id. */
  commitment: string
  side: number // OrderSide: 0 buy / 1 sell
  price: string // scaled u64 (human price × PRICE_SCALE), decimal string
  amount: string // base-asset base units (u64), decimal string
  assetBase: string // asset id hex
  assetQuote: string // asset id hex
  baseCode: AssetCode
  quoteCode: AssetCode
  ownerKey: string
  nonce: string
  /** The asset+amount locked by the order (buy locks quote, sell locks base). */
  lockedAssetId: string
  lockedAmount: string // base units
  lockedAssetCode: AssetCode
  lockedDecimals: number
  status: 'open' | 'cancelled' | 'filled'
  createdAt: number
  txHash?: string
}

function ordersStorageKey(): string {
  return `${ORDERS_PREFIX}:${POOL_TAG}:${activeAddress ?? 'anon'}`
}

export function loadOrders(): StoredOrder[] {
  return read<StoredOrder[]>(ordersStorageKey(), [])
}

function saveOrders(orders: StoredOrder[]): void {
  write(ordersStorageKey(), orders)
}

// ---------------------------------------------------------------------------
// Lending positions (LENDING_SPEC)
// ---------------------------------------------------------------------------

function positionsStorageKey(): string {
  return `${POSITIONS_PREFIX}:${POOL_TAG}:${activeAddress ?? 'anon'}`
}

/**
 * A persisted lending position.
 *
 * `collateralAmount` is public on-chain, so it is recoverable. `debtScaled` and
 * `nonce` are NOT — they exist only inside the position commitment. This record is
 * the only thing that lets the owner attest solvency or repay.
 */
export interface StoredPosition {
  /** Position commitment (0x-hex) — the on-chain registry key. */
  commitment: string
  collateralAsset: string // 0x-hex asset_id
  collateralAssetCode: AssetCode
  collateralAmount: string // decimal base units
  collateralAssetAddress?: string
  debtAsset: string // 0x-hex asset_id
  debtAssetCode: AssetCode
  /** PRIVATE. Real debt is `debtScaled * borrowIndex / 1e9`. */
  debtScaled: string
  /** PRIVATE. Part of the commitment preimage. */
  nonce: string
  ownerKey: string
  spendingKey: string
  /** Merkle leaf index of the position commitment, once observed on-chain. */
  leafIndex?: number
  /** Ledger after which anyone may seize this position. Mirrors contract state. */
  deadline?: number
  status: 'open' | 'closed' | 'seized'
  createdAt: number
  txHash?: string
}

export function loadPositions(): StoredPosition[] {
  return read<StoredPosition[]>(positionsStorageKey(), [])
}

function savePositions(positions: StoredPosition[]): void {
  write(positionsStorageKey(), positions)
}

/** Persist a position, replacing any prior record with the same commitment. */
export function addPosition(position: StoredPosition): void {
  const rest = loadPositions().filter((p) => p.commitment !== position.commitment)
  rest.push(position)
  savePositions(rest)
}

/**
 * Replace a position after an operation that re-commits it (borrow / repay /
 * withdraw collateral). The old commitment is nullified on-chain, so it is marked
 * closed rather than deleted — keeping it makes the history legible and avoids a
 * window where a failed submission leaves NO record of the secrets.
 */
export function replacePosition(oldCommitment: string, next: StoredPosition): void {
  const positions = loadPositions().map((p) =>
    p.commitment === oldCommitment ? { ...p, status: 'closed' as const } : p,
  )
  savePositions([...positions.filter((p) => p.commitment !== next.commitment), next])
}

/** Update a tracked position's lifecycle status. */
export function setPositionStatus(commitmentHex: string, status: StoredPosition['status']): void {
  savePositions(
    loadPositions().map((p) => (p.commitment === commitmentHex ? { ...p, status } : p)),
  )
}

/** Record a refreshed attestation deadline (or a leaf index once observed). */
export function updatePosition(
  commitmentHex: string,
  patch: Partial<Pick<StoredPosition, 'deadline' | 'leafIndex' | 'txHash'>>,
): void {
  savePositions(
    loadPositions().map((p) => (p.commitment === commitmentHex ? { ...p, ...patch } : p)),
  )
}

/** Rehydrate an SDK {@link Position} from a stored record. */
export function toSdkPosition(stored: StoredPosition): Position {
  return {
    collateralAsset: hexToField(stored.collateralAsset),
    collateralAmount: BigInt(stored.collateralAmount),
    debtAsset: hexToField(stored.debtAsset),
    debtScaled: BigInt(stored.debtScaled),
    ownerKey: hexToField(stored.ownerKey),
    nonce: hexToField(stored.nonce),
    spendingKey: hexToField(stored.spendingKey),
    commitment: hexToField(stored.commitment),
  }
}

/** Serialize an SDK {@link Position} for storage. */
export function fromSdkPosition(
  position: Position,
  meta: {
    collateralAssetCode: AssetCode
    debtAssetCode: AssetCode
    collateralAssetAddress?: string
    leafIndex?: number
    deadline?: number
    txHash?: string
  },
): StoredPosition {
  if (!position.spendingKey) {
    throw new Error('cannot persist a position without its spendingKey')
  }
  const out: StoredPosition = {
    commitment: fieldToHex(position.commitment),
    collateralAsset: fieldToHex(position.collateralAsset),
    collateralAssetCode: meta.collateralAssetCode,
    collateralAmount: position.collateralAmount.toString(),
    debtAsset: fieldToHex(position.debtAsset),
    debtAssetCode: meta.debtAssetCode,
    debtScaled: position.debtScaled.toString(),
    nonce: fieldToHex(position.nonce),
    ownerKey: fieldToHex(position.ownerKey),
    spendingKey: fieldToHex(position.spendingKey),
    status: 'open',
    createdAt: Date.now(),
  }
  if (meta.collateralAssetAddress) out.collateralAssetAddress = meta.collateralAssetAddress
  if (meta.leafIndex !== undefined) out.leafIndex = meta.leafIndex
  if (meta.deadline !== undefined) out.deadline = meta.deadline
  if (meta.txHash) out.txHash = meta.txHash
  return out
}

/** Persist a freshly placed order (keyed by commitment; replaces any prior copy). */
export function addOrder(order: StoredOrder): void {
  const orders = loadOrders().filter((o) => o.commitment !== order.commitment)
  orders.push(order)
  saveOrders(orders)
}

/** Update a tracked order's lifecycle status (open → cancelled/filled). */
export function setOrderStatus(commitmentHex: string, status: StoredOrder['status']): void {
  const orders = loadOrders().map((o) => (o.commitment === commitmentHex ? { ...o, status } : o))
  saveOrders(orders)
}

/** Rehydrate a {@link BalanceNote} from a stored record. */
export function toBalanceNote(stored: StoredNote): BalanceNote {
  const note: BalanceNote = {
    assetId: hexToField(stored.assetId),
    amount: BigInt(stored.amount),
    ownerKey: hexToField(stored.ownerKey),
    blinding: hexToField(stored.blinding),
    spendingKey: hexToField(stored.spendingKey),
    commitment: hexToField(stored.commitment),
  }
  if (stored.leafIndex !== undefined) note.leafIndex = stored.leafIndex
  if (stored.assetAddress !== undefined) note.assetAddress = stored.assetAddress
  return note
}
