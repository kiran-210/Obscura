/**
 * The app-wide client indexer, wired to the note store's cache.
 *
 * Holds one live {@link WraithIndexer} per shielded identity. On start it hydrates the
 * in-memory Merkle tree from the per-identity leaf cache and resumes from the persisted
 * cursor; each {@link syncIndexer} pass pulls new events, updates owned notes + spent
 * flags (via the note store), and persists the extended leaf set + cursor.
 *
 * This is the single source of Merkle witnesses for spending (transfer/withdraw) and the
 * discovery mechanism for incoming notes — superseding the deposit-time frontier capture
 * and the standalone note-scanner.
 */
import { rpc } from '@stellar/stellar-sdk'
import { fieldToHex, type Field } from '@wraith/sdk'
import { POOL_DEPLOY_LEDGER, SOROBAN_RPC_URL } from './config'
import { WraithIndexer, identityFromSpendingKey, type SyncStats } from './indexer'
import { loadIndexCursor, loadLeaves, loadNotes, saveIndexCursor, saveLeaves } from './note-store'

let active: { key: string; indexer: WraithIndexer } | null = null
// Serialize sync passes so an interval tick can't overlap an in-flight deposit-triggered sync.
let inflight: Promise<SyncStats | null> | null = null

function server(): rpc.Server {
  return new rpc.Server(SOROBAN_RPC_URL)
}

/**
 * Create (or reuse) the indexer for `spendingKey`, hydrated from the per-identity cache.
 * The note-store active address must already be set (so the cache is correctly namespaced).
 */
export function startIndexer(spendingKey: Field): WraithIndexer {
  const key = fieldToHex(spendingKey)
  if (active?.key === key) return active.indexer
  const indexer = new WraithIndexer(identityFromSpendingKey(spendingKey))
  indexer.hydrate(loadLeaves(), loadIndexCursor(), loadNotes())
  active = { key, indexer }
  return indexer
}

/** The live indexer, or null before an identity is established. */
export function getIndexer(): WraithIndexer | null {
  return active?.indexer ?? null
}

/** Forget the active indexer (on wallet disconnect). */
export function clearIndexer(): void {
  active = null
  inflight = null
}

/**
 * Run one sync pass against the live chain and persist the extended leaf set + cursor.
 * Concurrent callers share the in-flight pass. Returns the stats, or null if no identity
 * is active or the RPC is unreachable.
 */
export function syncIndexer(): Promise<SyncStats | null> {
  if (inflight) return inflight
  const current = active
  if (!current) return Promise.resolve(null)
  inflight = (async () => {
    const srv = server()
    let latest: number
    try {
      latest = (await srv.getLatestLedger()).sequence
    } catch {
      return null
    }
    const stats = await current.indexer.sync(srv, latest, POOL_DEPLOY_LEDGER)
    // Owned notes were persisted inside sync(); persist the tree + cursor last.
    saveLeaves([...current.indexer.leafHexes])
    saveIndexCursor(current.indexer.nextLedger)
    return stats
  })().finally(() => {
    inflight = null
  })
  return inflight
}
