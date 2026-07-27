/**
 * Client-side pool indexer.
 *
 * Rebuilds the pool's append-only Merkle tree from its events (client-side, privacy-
 * preserving) and, in the same pass, recovers the wallet's own notes:
 *
 *   - **Deposits** are public (the `DepositEvent` carries asset + amount), so we recompute
 *     each deposit's commitment from our keys + a deterministic blinding and match it —
 *     `salt` is our running per-`(asset, amount)` deposit index (see lib/note-secrets).
 *   - **Transfer outputs** (recipient + change) are private, delivered as encrypted memos in
 *     the `TransferEvent`; we trial-decrypt both and accept a note whose commitment is a real
 *     on-chain output (untrusted transport can never forge balance).
 *   - **Spends** are detected by matching event `nullifiers` against our owned notes.
 *
 * Because the full leaf set is rebuilt (not just a frontier snapshot), *every* owned note is
 * spendable via {@link WraithIndexer.witnessFor} — this supersedes the deposit-time frontier
 * witness capture and the standalone note-scanner.
 *
 * Scope: within the RPC's ~7-day event-retention window. Older leaves are pruned, so the
 * cold-start floor is the pool's deploy ledger (config `POOL_DEPLOY_LEDGER`); a leaf gap
 * below that surfaces as an explicit error rather than a silently wrong tree.
 */
import { rpc, scValToNative } from '@stellar/stellar-sdk'
import {
  bytesToField,
  computeCommitment,
  computeNullifier,
  deriveOwnerKey,
  deriveViewingKey,
  fieldToHex,
  hexToField,
  MerkleTree,
  PRICE_SCALE,
  TREE_DEPTH,
  type Field,
} from '@wraith/sdk'
import { NATIVE_SAC, POOL_CONTRACT_ID } from './config'
import { decryptNote, decryptOrder, deriveEncKeypair, type EncKeypair } from './note-crypto'
import { depositBlinding, noteSecret } from './note-secrets'
import {
  addNote,
  addOrder,
  loadNotes,
  loadOrders,
  markSpent,
  setLeafIndexForCommitment,
  setOrderStatus,
  upsertReceivedNote,
  type StoredNote,
} from './note-store'
import { assetIdFor, assetMeta, tokenBySac } from './tokens'
import type { MerkleWitness } from './merkle-witness'
import type { AssetCode } from './wraith-sdk'

/** The subset of a wallet's derived keys the indexer needs to recover its notes. */
export interface IndexerIdentity {
  spendingKey: Field
  ownerKeyHex: string
  /** X25519 keypair (from the viewing key) that decrypts transfer memos addressed to us. */
  enc: EncKeypair
  /** Note-derivation secret for the deterministic deposit blinding. */
  nsk: Field
}

/** Derive the full indexer identity from a wallet's shielded spending key. */
export function identityFromSpendingKey(spendingKey: Field): IndexerIdentity {
  return {
    spendingKey,
    ownerKeyHex: fieldToHex(deriveOwnerKey(spendingKey)),
    enc: deriveEncKeypair(deriveViewingKey(spendingKey)),
    nsk: noteSecret(spendingKey),
  }
}

export interface SyncStats {
  fromLedger: number
  toLedger: number
  pages: number
  /** Leaves appended to the tree this sync. */
  newLeaves: number
  /** Owned deposits discovered. */
  deposits: number
  /** Owned transfer outputs (received + change) discovered. */
  received: number
  /** Owned notes newly marked spent. */
  spent: number
}

/** A note the indexer recovered as ours, ready to persist to the note store. */
interface DiscoveredNote {
  source: 'deposit' | 'received'
  assetCode: AssetCode
  assetId: string
  amount: string
  ownerKey: string
  blinding: string
  commitment: string
  leafIndex: number
  decimals?: number
  assetAddress?: string
}

/** Canonical hex (matching `fieldToHex`) for a 32-byte on-chain field, tolerant of leading zeros. */
function fieldHex(bytes: Uint8Array): string {
  return fieldToHex(bytesToField(bytes))
}

/** True if `bytes` is a present, non-zero field (a zero commitment means "not inserted"). */
function nonZeroBytes(bytes: Uint8Array | undefined): boolean {
  return bytes instanceof Uint8Array && bytes.some((b) => b !== 0)
}

function topicSymbol(ev: rpc.Api.EventResponse): string {
  try {
    return String(scValToNative(ev.topic[0]!))
  } catch {
    return ''
  }
}

export class WraithIndexer {
  readonly tree = new MerkleTree(TREE_DEPTH)
  private leaves: string[] = [] // hex commitments (canonical), insertion order
  private leafSet = new Set<string>() // lowercased leaf hexes, for O(1) idempotent appends
  private cursor = 0 // next start ledger (last fully-indexed + 1); 0 = never indexed
  private depositCount = new Map<string, number>() // `${assetIdHex}:${amount}` -> our count
  private nullifiers = new Map<string, string>() // our unspent nullifier hex -> commitment hex

  constructor(
    private readonly id: IndexerIdentity,
    private readonly poolContractId: string = POOL_CONTRACT_ID,
  ) {}

  get root(): Field {
    return this.tree.root
  }
  get size(): number {
    return this.tree.size
  }
  /** The next ledger the indexer will resume from (0 before any sync). */
  get nextLedger(): number {
    return this.cursor
  }
  /** The full leaf set (canonical hex), for persistence. */
  get leafHexes(): readonly string[] {
    return this.leaves
  }

  /** A fresh Merkle witness for a leaf, folding to the current on-chain root. */
  witnessFor(leafIndex: number): MerkleWitness {
    const p = this.tree.generateProof(leafIndex)
    return { pathElements: p.pathElements, pathIndices: p.pathIndices, root: p.root }
  }

  /**
   * Restore in-memory state from persisted leaves + cursor + the owned notes, so an
   * incremental {@link sync} continues correctly (deposit salts + spent-detection indexes).
   */
  hydrate(leaves: string[], cursor: number, ownedNotes: StoredNote[]): void {
    for (const c of leaves) {
      this.tree.insert(hexToField(c))
      this.leaves.push(c)
      this.leafSet.add(c.toLowerCase())
    }
    this.cursor = cursor
    for (const n of ownedNotes) {
      if (n.source === 'deposit') this.bumpDeposit(n.assetId, BigInt(n.amount))
      if (!n.spent) this.registerNullifier(n.commitment)
    }
  }

  private registerNullifier(commitmentHex: string): void {
    const n = fieldToHex(computeNullifier(hexToField(commitmentHex), this.id.spendingKey))
    this.nullifiers.set(n, commitmentHex)
  }

  private bumpDeposit(assetIdHex: string, amount: bigint): number {
    const key = `${assetIdHex}:${amount}`
    const c = this.depositCount.get(key) ?? 0
    this.depositCount.set(key, c + 1)
    return c
  }

  /** Append a leaf at `index`, tolerating already-seen leaves (overlapping windows). */
  private insertLeaf(index: number, hex: string): boolean {
    if (index < this.tree.size) {
      if (this.leaves[index]?.toLowerCase() !== hex.toLowerCase()) {
        throw new Error(`Indexer leaf mismatch at ${index}: have ${this.leaves[index]}, chain has ${hex}.`)
      }
      return false
    }
    if (index > this.tree.size) {
      throw new Error(
        `Indexer leaf gap: expected index ${this.tree.size} but chain reports ${index}. Pool history predates the RPC retention window — cold-start from a later ledger.`,
      )
    }
    this.tree.insert(hexToField(hex))
    this.leaves.push(hex)
    this.leafSet.add(hex.toLowerCase())
    return true
  }

  /**
   * Append a leaf that carries no emitted index (the order events insert a change/refund/fill
   * leaf but don't publish its index). Idempotent by commitment, so an overlapping re-scan
   * can't double-insert. Back-fills the `leafIndex` of a matching local note (a place/cancel
   * change/refund note we created), making it spendable.
   */
  private appendLeaf(hex: string): boolean {
    if (this.leafSet.has(hex.toLowerCase())) return false
    const index = this.tree.size
    this.tree.insert(hexToField(hex))
    this.leaves.push(hex)
    this.leafSet.add(hex.toLowerCase())
    setLeafIndexForCommitment(hex, index)
    return true
  }

  /** Deterministic-match a deposit against our keys; returns the note if it's ours. */
  private ownDeposit(index: number, commitmentHex: string, sac: string, amount: bigint): DiscoveredNote | null {
    const native = sac === NATIVE_SAC
    const assetId = assetIdFor({ native, sac })
    const assetIdHex = fieldToHex(assetId)
    const key = `${assetIdHex}:${amount}`
    const salt = this.depositCount.get(key) ?? 0
    const blinding = depositBlinding(this.id.nsk, assetId, amount, salt)
    const candidate = computeCommitment(assetId, amount, hexToField(this.id.ownerKeyHex), blinding)
    if (fieldToHex(candidate).toLowerCase() !== commitmentHex.toLowerCase()) return null
    // Ours — consume this (asset, amount) salt so the next matching deposit uses salt+1.
    this.depositCount.set(key, salt + 1)
    this.registerNullifier(commitmentHex)
    const meta = tokenBySac(sac)
    const note: DiscoveredNote = {
      source: 'deposit',
      assetCode: meta?.code ?? assetIdHex.slice(0, 10),
      assetId: assetIdHex,
      amount: amount.toString(),
      ownerKey: this.id.ownerKeyHex,
      blinding: fieldToHex(blinding),
      commitment: commitmentHex,
      leafIndex: index,
      assetAddress: sac,
    }
    if (meta?.decimals !== undefined) note.decimals = meta.decimals
    return note
  }

  /** Trial-decrypt a transfer memo; returns the note if it's addressed to us and on-chain. */
  private ownTransferOutput(commitmentHex: string, leafIndex: number, memo: Uint8Array): DiscoveredNote | null {
    if (!(memo instanceof Uint8Array) || memo.length === 0) return null
    const payload = decryptNote(this.id.enc, memo)
    if (!payload) return null
    if (payload.ownerKey.toLowerCase() !== this.id.ownerKeyHex.toLowerCase()) return null
    const recomputed = fieldToHex(
      computeCommitment(
        hexToField(payload.assetId),
        BigInt(payload.amount),
        hexToField(payload.ownerKey),
        hexToField(payload.blinding),
      ),
    )
    if (recomputed.toLowerCase() !== payload.commitment.toLowerCase()) return null
    if (payload.commitment.toLowerCase() !== commitmentHex.toLowerCase()) return null
    this.registerNullifier(commitmentHex)
    const note: DiscoveredNote = {
      source: 'received',
      assetCode: payload.code,
      assetId: payload.assetId,
      amount: payload.amount,
      ownerKey: payload.ownerKey,
      blinding: payload.blinding,
      commitment: commitmentHex,
      leafIndex,
    }
    if (payload.decimals !== undefined) note.decimals = payload.decimals
    return note
  }

  /** If `commitmentHex` is one of our open orders, mark it filled (it was matched + removed
   *  from the active set on-chain; a partial fill's remainder arrives as a residual order). */
  private markMatchedOrder(commitmentHex: string): void {
    if (loadOrders().some((o) => o.commitment.toLowerCase() === commitmentHex.toLowerCase() && o.status === 'open')) {
      setOrderStatus(commitmentHex, 'filled')
    }
  }

  /** Recover a residual order from a match's `residual_memos` into our order store, so a
   *  partial-fill continuation shows up (and stays cancellable). No-op if not ours/known. */
  private recoverResidualOrder(memo: Uint8Array): void {
    if (!(memo instanceof Uint8Array) || memo.length === 0) return
    const p = decryptOrder(this.id.enc, memo)
    if (!p || p.ownerKey.toLowerCase() !== this.id.ownerKeyHex.toLowerCase()) return
    if (loadOrders().some((o) => o.commitment.toLowerCase() === p.commitment.toLowerCase())) return
    const price = BigInt(p.price)
    const amount = BigInt(p.amount)
    const lockedIsBase = p.side === 1 // sell locks base; buy locks quote
    const lockedAssetId = lockedIsBase ? p.assetBase : p.assetQuote
    const lockedAmount = lockedIsBase ? amount : (amount * price) / PRICE_SCALE
    const lockedAssetCode = (lockedIsBase ? p.baseCode : p.quoteCode) ?? ''
    addOrder({
      commitment: p.commitment,
      side: p.side,
      price: p.price,
      amount: p.amount,
      assetBase: p.assetBase,
      assetQuote: p.assetQuote,
      baseCode: p.baseCode ?? '',
      quoteCode: p.quoteCode ?? '',
      ownerKey: p.ownerKey,
      nonce: p.nonce,
      lockedAssetId,
      lockedAmount: lockedAmount.toString(),
      lockedAssetCode,
      lockedDecimals: assetMeta(lockedAssetCode).decimals,
      status: 'open',
      createdAt: Date.now(),
    })
  }

  /** Mark an owned note spent if `nullifierHex` is one of ours. Returns true if it was. */
  private spendByNullifier(nullifierHex: string, out: string[]): boolean {
    const commitment = this.nullifiers.get(nullifierHex)
    if (!commitment) return false
    this.nullifiers.delete(nullifierHex)
    out.push(commitment)
    return true
  }

  /** Apply a single event: insert its leaves, recover ownership, detect spends. */
  private applyEvent(ev: rpc.Api.EventResponse, found: DiscoveredNote[], spent: string[]): number {
    const topic = topicSymbol(ev)
    let leaves = 0
    if (topic === 'deposit') {
      const index = Number(scValToNative(ev.topic[1]!))
      const data = scValToNative(ev.value) as { commitment: Uint8Array; asset: string; amount: bigint }
      const hex = fieldHex(data.commitment)
      if (this.insertLeaf(index, hex)) leaves += 1
      const mine = this.ownDeposit(index, hex, data.asset, BigInt(data.amount))
      if (mine) found.push(mine)
    } else if (topic === 'bridge_mint') {
      // Bridged notes are added locally at bridge time and aren't memo/deterministic-
      // recoverable; we still insert the leaf so the tree (and every witness) stays correct.
      const index = Number(scValToNative(ev.topic[1]!))
      const data = scValToNative(ev.value) as { commitment: Uint8Array }
      if (this.insertLeaf(index, fieldHex(data.commitment))) leaves += 1
    } else if (topic === 'transfer') {
      const data = scValToNative(ev.value) as {
        nullifiers: Uint8Array[]
        commitments: Uint8Array[]
        indices: Array<number | bigint>
        memos: Uint8Array[]
      }
      for (let i = 0; i < data.commitments.length; i += 1) {
        const index = Number(data.indices[i])
        const hex = fieldHex(data.commitments[i]!)
        if (this.insertLeaf(index, hex)) leaves += 1
        const mine = this.ownTransferOutput(hex, index, data.memos[i]!)
        if (mine) found.push(mine)
      }
      for (const n of data.nullifiers ?? []) this.spendByNullifier(fieldHex(n), spent)
    } else if (topic === 'withdraw') {
      this.spendByNullifier(fieldHex(scValToNative(ev.topic[1]!) as Uint8Array), spent)
    } else if (topic === 'order_placed') {
      // place_order spends the input note (nullifier in `order_commitment`? no — the order
      // hides it) and inserts the change note leaf. Append it (if non-zero) for tree
      // correctness + to back-fill our local change note's index.
      const data = scValToNative(ev.value) as { change_commitment: Uint8Array }
      if (nonZeroBytes(data?.change_commitment) && this.appendLeaf(fieldHex(data.change_commitment))) leaves += 1
    } else if (topic === 'order_cancelled') {
      const data = scValToNative(ev.value) as { refund: Uint8Array }
      if (nonZeroBytes(data?.refund) && this.appendLeaf(fieldHex(data.refund))) leaves += 1
    } else if (topic === 'order_matched') {
      // Fills + non-zero refunds are tree leaves with sealed memos — same discovery as
      // `transfer`. `order_a`/`order_b` (topics) are the matched orders; residual orders are
      // delivered via `residual_memos` (they're active orders, not tree leaves).
      const data = scValToNative(ev.value) as {
        leaf_commitments: Uint8Array[]
        leaf_indices: Array<number | bigint>
        leaf_memos: Uint8Array[]
        residual_memos?: Uint8Array[]
      }
      const commits = data?.leaf_commitments ?? []
      for (let i = 0; i < commits.length; i += 1) {
        const index = Number(data.leaf_indices[i])
        const hex = fieldHex(commits[i]!)
        if (this.insertLeaf(index, hex)) leaves += 1
        const mine = this.ownTransferOutput(hex, index, data.leaf_memos[i]!)
        if (mine) found.push(mine)
      }
      this.markMatchedOrder(fieldHex(scValToNative(ev.topic[1]!) as Uint8Array))
      this.markMatchedOrder(fieldHex(scValToNative(ev.topic[2]!) as Uint8Array))
      for (const m of data?.residual_memos ?? []) this.recoverResidualOrder(m)
    }
    return leaves
  }

  /**
   * Pull events in `(fromLedger, latestLedger]`, process them in order, and persist the
   * results. Owned notes + leaves are written before the cursor advances, so an RPC error
   * mid-sync is always safe to retry from the same cursor.
   */
  async sync(server: rpc.Server, latestLedger: number, floor: number): Promise<SyncStats> {
    const start = Math.max(this.cursor, floor, 1)
    const stats: SyncStats = {
      fromLedger: start,
      toLedger: latestLedger,
      pages: 0,
      newLeaves: 0,
      deposits: 0,
      received: 0,
      spent: 0,
    }
    if (start > latestLedger) return stats // already current

    const found: DiscoveredNote[] = []
    const spent: string[] = []
    const filters = [{ type: 'contract' as const, contractIds: [this.poolContractId] }]
    let cursor: string | undefined
    // getEvents scans a bounded window per call and ALWAYS returns a cursor, so we follow it
    // forward until it stops advancing (caught up) rather than breaking on an empty page.
    for (let page = 0; page < 200; page += 1) {
      const res = await server.getEvents(
        cursor ? { filters, cursor, limit: 200 } : { filters, startLedger: start, limit: 200 },
      )
      stats.pages += 1
      for (const ev of res.events ?? []) stats.newLeaves += this.applyEvent(ev, found, spent)
      const next = res.cursor
      if (!next || next === cursor) break
      cursor = next
    }

    // Persist notes + leaves BEFORE advancing the cursor (never skip on a later error).
    const known = new Set(loadNotes().map((n) => n.commitment.toLowerCase()))
    for (const d of found) {
      if (d.source === 'deposit') {
        if (known.has(d.commitment.toLowerCase())) continue
        addNote(
          {
            assetId: hexToField(d.assetId),
            amount: BigInt(d.amount),
            ownerKey: hexToField(d.ownerKey),
            blinding: hexToField(d.blinding),
            spendingKey: this.id.spendingKey,
            commitment: hexToField(d.commitment),
            leafIndex: d.leafIndex,
            ...(d.assetAddress !== undefined ? { assetAddress: d.assetAddress } : {}),
          },
          {
            assetCode: d.assetCode,
            leafIndex: d.leafIndex,
            source: 'deposit',
            ...(d.decimals !== undefined ? { decimals: d.decimals } : {}),
          },
        )
        stats.deposits += 1
      } else {
        const added = upsertReceivedNote({
          assetCode: d.assetCode,
          assetId: d.assetId,
          amount: d.amount,
          ownerKey: d.ownerKey,
          blinding: d.blinding,
          spendingKey: fieldToHex(this.id.spendingKey),
          commitment: d.commitment,
          leafIndex: d.leafIndex,
          source: 'received',
          ...(d.decimals !== undefined ? { decimals: d.decimals } : {}),
        })
        if (added) stats.received += 1
      }
    }
    for (const commitment of spent) {
      markSpent(commitment)
      stats.spent += 1
    }

    this.cursor = latestLedger + 1
    return stats
  }
}
