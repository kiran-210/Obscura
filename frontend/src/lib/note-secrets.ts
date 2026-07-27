/**
 * Deterministic note secrets, so the wallet's own notes are recoverable from chain data
 * on any device (SPEC — note recovery).
 *
 * Deposits are public (the `DepositEvent` carries asset + amount), so instead of a random
 * blinding we derive it as `hash4(nsk, assetId, amount, salt)`. A fresh device can then
 * recompute a deposit note's commitment from the event and match it. `salt` is the wallet's
 * running per-`(asset, amount)` deposit index — reconstructed at recovery by counting owned
 * deposits in ledger order (so foreign deposits never consume it).
 *
 * Received and change notes stay random-blinded but are delivered as encrypted memos, so
 * this only covers the outputs whose amount is public on-chain.
 */
import { hash2, hash4, toField, type Field } from '@obscura/sdk'

// Domain-separated from the owner key (hash2(sk,0)) and viewing key.
const DOMAIN_NOTE_SECRET: Field = toField('0x6e6f74655f736563726574') // "note_secret"

/** The wallet's note-derivation secret. */
export function noteSecret(spendingKey: Field): Field {
  return hash2(spendingKey, DOMAIN_NOTE_SECRET)
}

/** Deterministic blinding for a deposit note of `(assetId, amount)` at deposit index `salt`. */
export function depositBlinding(nsk: Field, assetId: Field, amount: bigint, salt: number): Field {
  return hash4(nsk, assetId, toField(amount), toField(BigInt(salt)))
}
