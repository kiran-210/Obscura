/**
 * RealObscuraSdk — the live client that talks to the deployed ObscuraPool on Stellar
 * Testnet, backed by `@obscura/sdk` (crypto + Soroban op building), `@stellar/stellar-sdk`
 * (RPC submit) and the Stellar Wallets Kit (multi-wallet address + signing).
 *
 * It implements the same `ObscuraSdk` surface the UI is written against (see
 * `obscura-sdk.ts`), so it drops in behind `createObscuraSdk()` with no UI changes.
 *
 * Flow status:
 *   deposit              LIVE  — generates a note, builds + signs + submits the on-chain
 *                                deposit, persists the note locally.
 *   getShieldedBalances  LIVE  — derived from locally-stored notes.
 *   getOpenOrders        LIVE  — local (empty until placeOrder ships).
 *   withdraw             EXPERIMENTAL — real in-browser UltraHonk proof (flag-gated).
 *   transfer/placeOrder/cancelOrder  — not yet wired (clear "coming soon" errors).
 */
import {
  buildCancelOrderInputs,
  buildPlaceOrderInputs,
  buildTransaction,
  buildTransferInputs,
  buildWithdrawInputs,
  createNote,
  createOrder,
  createOutputNote,
  deriveViewingKey,
  encodePublicInputs,
  fieldToBytes,
  fieldToHex,
  hexToField,
  NoirProver,
  noteNullifier,
  orderLockedAmount,
  OrderSide,
  recipientHash,
  toField,
  ObscuraContract,
  type CircuitInputMap,
  type Field,
} from '@obscura/sdk'
import { Account, Contract, rpc, scValToNative, TransactionBuilder, xdr } from '@stellar/stellar-sdk'
import { Buffer } from 'buffer'
import { ASSET_CONFIG, NATIVE_SAC, NETWORK_PASSPHRASE, POOL_CONTRACT_ID, SOROBAN_RPC_URL } from './config'
import { assetIdFor, assetMeta } from './tokens'
import { depositBlinding, noteSecret } from './note-secrets'
import { getKitAddress, signWithKit } from './wallet-kit'
import { formatAmount } from './format'
import {
  addNote,
  addOrder,
  getSpendingKey,
  loadNotes,
  loadOrders,
  markSpent,
  setOrderStatus,
  toBalanceNote,
  type StoredNote,
} from './note-store'
import { dummyPath, readPoolTreeState, witnessesAfterInserts, type MerkleWitness } from './merkle-witness'
import { getIndexer, syncIndexer } from './indexer-service'
import { decodeReceiveCode, deriveEncKeypair, encodeReceiveCode, encryptNote, type NotePayload } from './note-crypto'
import { submitOrderToMatcher } from './matcher-client'
import type {
  AssetCode,
  DepositParams,
  OpenOrder,
  PlaceOrderParams,
  PlaceOrderResult,
  ShieldedBalance,
  TransferParams,
  TxResult,
  WithdrawParams,
  ObscuraSdk,
} from './obscura-sdk'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Parse a human decimal string into integer base units (e.g. "1.5" XLM -> 15000000n). */
export function toBaseUnits(input: string, decimals: number): bigint {
  const trimmed = input.replace(/,/g, '').trim()
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new Error(`Invalid amount: "${input}"`)
  }
  const [whole, frac = ''] = trimmed.split('.')
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0')
}

/** Convert integer base units back to a JS number for display/estimates. */
export function baseUnitsToNumber(value: bigint, decimals: number): number {
  const divisor = 10 ** decimals
  return Number(value) / divisor
}

function walletError(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return typeof err === 'string' ? err : 'The wallet rejected the request.'
}

export class RealObscuraSdk implements ObscuraSdk {
  private readonly contract = new ObscuraContract({
    contractId: POOL_CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
  })

  private server(): rpc.Server {
    return new rpc.Server(SOROBAN_RPC_URL)
  }

  /** The active wallet account, or a clear error if not connected. */
  private async requireAddress(): Promise<string> {
    try {
      return await getKitAddress()
    } catch (err) {
      throw new Error(
        err instanceof Error && err.message
          ? err.message
          : 'Connect a Stellar wallet (on Testnet) before submitting.',
      )
    }
  }

  /**
   * Prepare → sign (via the connected wallet) → submit → confirm a single invoke op.
   * Returns the tx hash plus the contract's return value (the deposit leaf index, for
   * instance).
   */
  private async submitOp(
    op: xdr.Operation,
    from: string,
  ): Promise<{ hash: string; returnValue?: xdr.ScVal }> {
    const server = this.server()
    const account = await server.getAccount(from)
    const tx = buildTransaction(account, op, {
      networkPassphrase: NETWORK_PASSPHRASE,
      timeoutSeconds: 120,
    })
    // Simulate to compute the Soroban footprint, auth and resource fees.
    const prepared = await server.prepareTransaction(tx)
    let signedTxXdr: string
    try {
      signedTxXdr = await signWithKit(prepared.toXDR(), from)
    } catch (err) {
      throw new Error(walletError(err))
    }
    const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE)
    const sent = await server.sendTransaction(signed)
    if (sent.status === 'ERROR') {
      throw new Error(`Submission failed: ${JSON.stringify(sent.errorResult ?? sent.status)}`)
    }
    const final = await this.awaitConfirmation(server, sent.hash)
    const out: { hash: string; returnValue?: xdr.ScVal } = { hash: sent.hash }
    if (final.returnValue) out.returnValue = final.returnValue
    return out
  }

  private async awaitConfirmation(
    server: rpc.Server,
    hash: string,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const deadline = Date.now() + 90_000
    for (;;) {
      const res = await server.getTransaction(hash)
      if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
        if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) return res
        throw new Error(`Transaction ${hash} failed on-chain (${res.status}).`)
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out awaiting confirmation for ${hash}.`)
      }
      await sleep(2000)
    }
  }

  // --- Deposit any Stellar asset (LIVE, asset-agnostic) ---

  async deposit({ asset, amount, sac, decimals, native }: DepositParams): Promise<TxResult> {
    // Resolve the token descriptor: explicit (curated / custom), else fall back to XLM.
    const isNative = native ?? asset === 'XLM'
    const resolvedSac = sac ?? (isNative ? NATIVE_SAC : ASSET_CONFIG[asset]?.sac)
    const resolvedDecimals = decimals ?? ASSET_CONFIG[asset]?.decimals ?? 7
    if (!resolvedSac) {
      throw new Error(`${asset} has no Stellar Asset Contract on this network.`)
    }
    const amountBase = toBaseUnits(amount, resolvedDecimals)
    if (amountBase <= 0n) throw new Error('Amount must be greater than zero.')

    const from = await this.requireAddress()
    const assetId = assetIdFor({ native: isNative, sac: resolvedSac })
    const assetIdHex = fieldToHex(assetId)
    // Deterministic blinding so this deposit is recoverable on any device: salt = the
    // number of prior owned deposits of the same (asset, amount), in ledger order.
    const spendingKey = getSpendingKey()
    const salt = loadNotes().filter(
      (n) => n.source === 'deposit' && n.assetId === assetIdHex && BigInt(n.amount) === amountBase,
    ).length
    const note = createNote({
      assetId,
      amount: amountBase,
      spendingKey,
      blinding: depositBlinding(noteSecret(spendingKey), assetId, amountBase, salt),
    })
    note.assetAddress = resolvedSac

    const op = this.contract.depositOp({
      from,
      asset: resolvedSac,
      amount: amountBase,
      commitment: note.commitment,
    })

    const { hash, returnValue } = await this.submitOp(op, from)

    // The pool's `deposit` returns the new leaf index (u32) — capture it for withdraw.
    let leafIndex: number | undefined
    if (returnValue) {
      try {
        leafIndex = Number(scValToNative(returnValue))
      } catch {
        leafIndex = undefined
      }
    }
    const meta: {
      assetCode: AssetCode
      txHash: string
      leafIndex?: number
      decimals: number
      source: 'deposit'
    } = {
      assetCode: asset,
      txHash: hash,
      decimals: resolvedDecimals,
      source: 'deposit',
    }
    if (leafIndex !== undefined) meta.leafIndex = leafIndex
    addNote(note, meta)

    // Fold the freshly-appended leaf into the client indexer (background) so the tree — and
    // every note's witness — stays current without waiting for the next poll.
    void syncIndexer()

    return { hash }
  }

  /**
   * A spendable Merkle witness for a stored note, straight from the client indexer's rebuilt
   * tree. Syncs first so the note's leaf is present and the proof folds to the current
   * on-chain root (always an `is_known_root`). Supersedes the deposit-time frontier capture.
   */
  private async spendWitness(stored: StoredNote): Promise<MerkleWitness> {
    if (stored.leafIndex === undefined) {
      throw new Error('This note has no leaf index; its Merkle proof cannot be built.')
    }
    const indexer = getIndexer()
    if (!indexer) throw new Error('The wallet indexer is not ready — reconnect your Stellar wallet.')
    await syncIndexer()
    if (stored.leafIndex >= indexer.size) {
      throw new Error('This note is not yet visible on-chain (still indexing). Try again in a moment.')
    }
    return indexer.witnessFor(stored.leafIndex)
  }

  /** Fetch a compiled circuit, generate the UltraHonk proof, and verify it locally (against
   *  the same transcript) before it ever costs gas — a bad witness fails here, not on-chain. */
  private async proveAndVerify(circuitName: string, inputs: CircuitInputMap) {
    const circuit = await fetch(`${import.meta.env.BASE_URL}circuits/${circuitName}.json`).then((r) => {
      if (!r.ok) throw new Error(`Compiled ${circuitName} circuit missing at /circuits/${circuitName}.json.`)
      return r.json()
    })
    const prover = new NoirProver(circuit)
    try {
      const proof = await prover.prove(inputs)
      if (!(await prover.verify(proof))) {
        throw new Error('Local proof verification failed — aborting before submit.')
      }
      return proof
    } finally {
      await prover.destroy().catch(() => undefined)
    }
  }

  // --- Views (LIVE, from local notes) ---

  /**
   * Mark locally-known notes spent whose nullifier is already used on-chain. The event
   * indexer only sees spends whose event carries the nullifier (transfer, withdraw) — a note
   * consumed by `place_order` is NOT recoverable that way (`OrderPlacedEvent` omits it), so on
   * a fresh sync it would re-appear as spendable and fail with `NullifierUsed (#5)` on spend.
   * Querying the pool's authoritative `is_spent` view closes that gap for every spend kind.
   */
  private async reconcileSpentNotes(): Promise<void> {
    const unspent = loadNotes().filter((n) => !n.spent)
    if (unspent.length === 0) return
    let from: string
    try {
      from = await this.requireAddress()
    } catch {
      return // no connected wallet — leave the cache untouched
    }
    const server = this.server()
    const source = new Account(from, '0')
    const pool = new Contract(POOL_CONTRACT_ID)
    await Promise.all(
      unspent.map(async (n) => {
        try {
          const nullifier = noteNullifier(toBalanceNote(n))
          const op = pool.call('is_spent', xdr.ScVal.scvBytes(Buffer.from(fieldToBytes(nullifier))))
          const tx = buildTransaction(source, op, { networkPassphrase: NETWORK_PASSPHRASE })
          const sim = await server.simulateTransaction(tx)
          if (!rpc.Api.isSimulationError(sim) && sim.result?.retval && scValToNative(sim.result.retval) === true) {
            markSpent(n.commitment)
          }
        } catch {
          // Transient RPC/derivation error — keep the note; the next refresh retries.
        }
      }),
    )
  }

  async getShieldedBalances(): Promise<ShieldedBalance[]> {
    await this.reconcileSpentNotes()
    const totals = new Map<AssetCode, bigint>()
    const decimalsFor = new Map<AssetCode, number>()
    for (const n of loadNotes()) {
      if (n.spent) continue
      totals.set(n.assetCode, (totals.get(n.assetCode) ?? 0n) + BigInt(n.amount))
      if (n.decimals !== undefined) decimalsFor.set(n.assetCode, n.decimals)
    }
    const out: ShieldedBalance[] = []
    for (const [asset, base] of totals) {
      if (base <= 0n) continue
      const decimals = decimalsFor.get(asset) ?? assetMeta(asset).decimals
      const human = baseUnitsToNumber(base, decimals)
      out.push({
        asset,
        amount: formatAmount(human),
        usdEstimate: Math.round(human * assetMeta(asset).priceUsd * 100) / 100,
      })
    }
    return out
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    // Orders are sealed on-chain (only their commitment is public), so the wallet tracks its
    // own open orders locally — the secrets it needs to display + cancel them.
    return loadOrders()
      .filter((o) => o.status === 'open')
      .map((o) => ({
        id: o.commitment,
        pair: `${o.baseCode}/${o.quoteCode}`,
        base: o.baseCode,
        quote: o.quoteCode,
        side: o.side === OrderSide.Buy ? 'buy' : 'sell',
        price: formatAmount(baseUnitsToNumber(BigInt(o.price), 7)),
        amount: formatAmount(baseUnitsToNumber(BigInt(o.amount), assetMeta(o.baseCode).decimals)),
        filled: '0',
        createdAt: o.createdAt,
      }))
  }

  // --- Withdraw to a classic Stellar account (LIVE, in-browser ZK proof) ---

  async withdraw({ asset, recipient, commitment }: WithdrawParams): Promise<TxResult> {
    // The withdraw circuit releases one full note (`note_amount == amount`, no change).
    // The note picker passes the exact note's commitment.
    const notes = loadNotes()
    const candidate = commitment
      ? notes.find((n) => !n.spent && n.commitment === commitment && n.leafIndex !== undefined)
      : notes.find((n) => !n.spent && n.assetCode === asset && n.leafIndex !== undefined)
    if (!candidate) throw new Error(`No shielded ${asset} note is available to withdraw.`)
    const sac = candidate.assetAddress
    if (!sac) throw new Error(`This ${asset} note has no SAC address; it can't be withdrawn.`)
    const note = toBalanceNote(candidate)

    // The note's Merkle witness is rebuilt on demand from the client indexer.
    const witness = await this.spendWitness(candidate)
    const inputs = buildWithdrawInputs({
      merkleRoot: witness.root,
      nullifier: noteNullifier(note),
      recipientHash: recipientHash(recipient),
      amount: note.amount,
      assetId: note.assetId,
      noteOwnerKey: note.ownerKey,
      noteBlinding: note.blinding,
      spendingKey: note.spendingKey,
      merklePath: witness.pathElements,
      merkleIndices: witness.pathIndices,
    })

    const proof = await this.proveAndVerify('withdraw', inputs)

    const from = await this.requireAddress()
    const op = this.contract.withdrawOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
      recipient,
      amount: note.amount,
      asset: sac,
    })
    const { hash } = await this.submitOp(op, from)
    markSpent(candidate.commitment)
    return { hash }
  }

  // --- Pay: private transfer (LIVE, in-browser UltraHonk proof) ---

  async transfer({ recipientKey, asset, amount }: TransferParams): Promise<TxResult> {
    const code = decodeReceiveCode(recipientKey)

    // Single-input transfer: pick the smallest unspent note of this asset that covers the
    // amount (the circuit is 2-in/2-out; the second input is a 0-amount dummy). Decimals
    // come from the notes themselves so any asset — curated or custom — works.
    const notes = loadNotes().filter((n) => !n.spent && n.assetCode === asset && n.leafIndex !== undefined)
    const noteDecimals = notes.find((n) => n.decimals !== undefined)?.decimals ?? assetMeta(asset).decimals
    const amountBase = toBaseUnits(amount, noteDecimals)
    if (amountBase <= 0n) throw new Error('Amount must be greater than zero.')

    const chosen = notes
      .filter((n) => BigInt(n.amount) >= amountBase)
      .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0))[0]
    if (!chosen) {
      throw new Error(
        'No single shielded note covers this amount. Deposit into one note first, or send a smaller amount.',
      )
    }

    const input = toBalanceNote(chosen)
    const witness = await this.spendWitness(chosen)
    const assetId = input.assetId
    const changeAmount = input.amount - amountBase

    const spendingKey = getSpendingKey()
    const recipientNote = createOutputNote({ assetId, amount: amountBase, ownerKey: code.ownerKey })
    const changeNote = createNote({ assetId, amount: changeAmount, spendingKey })
    const dummy = createNote({ assetId, amount: 0n, spendingKey })
    const dp = dummyPath()

    const inputs = buildTransferInputs({
      merkleRoot: witness.root,
      nullifiers: [noteNullifier(input), noteNullifier(dummy)],
      outCommitments: [recipientNote.commitment, changeNote.commitment],
      extDataHash: toField(0n),
      inNotes: [
        {
          amount: input.amount,
          assetId,
          spendingKey: input.spendingKey,
          blinding: input.blinding,
          merklePath: witness.pathElements,
          merkleIndices: witness.pathIndices,
        },
        {
          amount: 0n,
          assetId,
          spendingKey: dummy.spendingKey,
          blinding: dummy.blinding,
          merklePath: dp.pathElements,
          merkleIndices: dp.pathIndices,
        },
      ],
      outNotes: [
        { amount: recipientNote.amount, assetId, ownerKey: recipientNote.ownerKey, blinding: recipientNote.blinding },
        { amount: changeNote.amount, assetId, ownerKey: changeNote.ownerKey, blinding: changeNote.blinding },
      ],
    })

    const proof = await this.proveAndVerify('transfer', inputs)

    // Note delivery: compute the two output notes' witnesses, seal the recipient note to
    // THEIR viewing key, and self-seal the change note to OUR viewing key — so both are
    // discoverable/recoverable on any device (SPEC — note recovery).
    const pre = await readPoolTreeState(this.server(), POOL_CONTRACT_ID)
    const base = pre.nextIndex
    const [recipientWitness, changeWitness] = witnessesAfterInserts(pre.frontier, base, [
      recipientNote.commitment,
      changeNote.commitment,
    ])
    const noteMemo = (
      note: { ownerKey: Field; blinding: Field; commitment: Field },
      noteAmount: bigint,
      leafIndex: number,
      witness: MerkleWitness,
    ): NotePayload => ({
      v: 1,
      code: asset,
      decimals: noteDecimals,
      assetId: fieldToHex(assetId),
      amount: noteAmount.toString(),
      ownerKey: fieldToHex(note.ownerKey),
      blinding: fieldToHex(note.blinding),
      commitment: fieldToHex(note.commitment),
      leafIndex,
      root: fieldToHex(witness.root),
      path: witness.pathElements.map(fieldToHex),
      indices: witness.pathIndices,
    })
    const ownEnc = deriveEncKeypair(deriveViewingKey(spendingKey))
    const memos = [
      encryptNote(code.encPub, noteMemo(recipientNote, amountBase, base, recipientWitness)),
      changeAmount > 0n
        ? encryptNote(ownEnc.pub, noteMemo(changeNote, changeAmount, base + 1, changeWitness))
        : new Uint8Array(0),
    ]

    const from = await this.requireAddress()
    const op = this.contract.transferOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
      memos,
    })
    const { hash } = await this.submitOp(op, from)

    // Local wallet update: the input note is spent; keep the change note (leaf index base+1)
    // so it can be spent again — its witness is rebuilt on demand from the indexer.
    markSpent(chosen.commitment)
    if (changeAmount > 0n) {
      addNote(changeNote, { assetCode: asset, txHash: hash, leafIndex: base + 1, decimals: noteDecimals, source: 'change' })
    }
    // Fold the two new output leaves into the indexer (background) so the change note is
    // immediately spendable and the recipient's balance surfaces on their next sync.
    void syncIndexer()
    return { hash }
  }

  // --- Swap: sealed dark-pool order (LIVE, in-browser UltraHonk proof) ---

  /**
   * Place a hidden limit order. Spends a shielded note of the *locked* asset (buy locks
   * quote = amount·price, sell locks base = amount), registers the opaque `order_commitment`
   * on-chain, and keeps the remainder as a change note. Price/amount/side live only inside the
   * commitment — the chain never sees them. Matching (fills) is a separate service; this is
   * the single-party half and needs no matcher.
   *
   * Units: all curated assets are 7-decimals and the circuit's price is scaled by
   * `PRICE_SCALE = 1e7`, so `priceScaled = price × 1e7` and locked-quote = amount·price is
   * decimal-consistent. (Revisit if a non-7-decimal asset is ever listed.)
   */
  async placeOrder({ base, quote, side, price, amount }: PlaceOrderParams): Promise<PlaceOrderResult> {
    const sideNum = side === 'buy' ? OrderSide.Buy : OrderSide.Sell
    const baseMeta = assetMeta(base)
    const quoteMeta = assetMeta(quote)
    const baseSac = base === 'XLM' ? NATIVE_SAC : baseMeta.sac
    const quoteSac = quote === 'XLM' ? NATIVE_SAC : quoteMeta.sac
    if (!baseSac || !quoteSac) {
      throw new Error('Both order assets need a Stellar Asset Contract on this network.')
    }
    const assetBase = assetIdFor({ native: base === 'XLM', sac: baseSac })
    const assetQuote = assetIdFor({ native: quote === 'XLM', sac: quoteSac })

    const amountBase = toBaseUnits(amount, baseMeta.decimals)
    const priceScaled = toBaseUnits(price, 7) // human price × PRICE_SCALE
    if (amountBase <= 0n || priceScaled <= 0n) throw new Error('Price and amount must be greater than zero.')

    const spendingKey = getSpendingKey()
    const order = createOrder({ side: sideNum, price: priceScaled, amount: amountBase, assetBase, assetQuote, spendingKey })
    const locked = orderLockedAmount(order)
    const lockedHex = fieldToHex(locked.assetId)
    const lockedIsBase = lockedHex === fieldToHex(assetBase)
    const lockedCode = lockedIsBase ? base : quote
    const lockedDecimals = lockedIsBase ? baseMeta.decimals : quoteMeta.decimals

    // Fund the lock from a single shielded note of the locked asset.
    const chosen = loadNotes()
      .filter((n) => !n.spent && n.leafIndex !== undefined && n.assetId === lockedHex && BigInt(n.amount) >= locked.amount)
      .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0))[0]
    if (!chosen) {
      throw new Error(
        `No single shielded ${lockedCode} note covers the ${baseUnitsToNumber(locked.amount, lockedDecimals)} ${lockedCode} this order locks. Deposit into one note first.`,
      )
    }
    const input = toBalanceNote(chosen)
    const witness = await this.spendWitness(chosen)
    const changeAmount = input.amount - locked.amount
    // When the note exactly covers the lock (no remainder) the circuit requires
    // change_commitment == 0; only create/store a change note when there's actual change.
    const changeNote = changeAmount > 0n ? createNote({ assetId: locked.assetId, amount: changeAmount, spendingKey }) : null

    const inputs = buildPlaceOrderInputs({
      merkleRoot: witness.root,
      nullifier: noteNullifier(input),
      orderCommitment: order.commitment,
      changeCommitment: changeNote ? changeNote.commitment : toField(0n),
      lockedAssetId: locked.assetId,
      noteAmount: input.amount,
      noteAssetId: input.assetId,
      noteBlinding: input.blinding,
      spendingKey,
      merklePath: witness.pathElements,
      merkleIndices: witness.pathIndices,
      orderSide: sideNum,
      orderPrice: priceScaled,
      orderAmount: amountBase,
      orderAssetBase: assetBase,
      orderAssetQuote: assetQuote,
      orderNonce: order.nonce,
      changeAmount,
      changeBlinding: changeNote ? changeNote.blinding : toField(0n),
    })

    const proof = await this.proveAndVerify('place_order', inputs)
    const from = await this.requireAddress()
    const op = this.contract.placeOrderOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
    })
    const { hash } = await this.submitOp(op, from)

    markSpent(chosen.commitment)
    if (changeNote) {
      addNote(changeNote, { assetCode: lockedCode, txHash: hash, decimals: lockedDecimals, source: 'change' })
    }
    addOrder({
      commitment: fieldToHex(order.commitment),
      side: sideNum,
      price: priceScaled.toString(),
      amount: amountBase.toString(),
      assetBase: fieldToHex(assetBase),
      assetQuote: fieldToHex(assetQuote),
      baseCode: base,
      quoteCode: quote,
      ownerKey: fieldToHex(order.ownerKey),
      nonce: fieldToHex(order.nonce),
      lockedAssetId: lockedHex,
      lockedAmount: locked.amount.toString(),
      lockedAssetCode: lockedCode,
      lockedDecimals,
      status: 'open',
      createdAt: Date.now(),
      txHash: hash,
    })
    // Fold the change-note leaf into the indexer so it becomes spendable + the balance updates.
    void syncIndexer()

    // Opt into matching: hand the matcher the order preimage + our receive code so it can find
    // a cross and seal the fill back to us. Best-effort — the order is already on-chain.
    const ownEnc = deriveEncKeypair(deriveViewingKey(spendingKey))
    void submitOrderToMatcher({
      commitment: fieldToHex(order.commitment),
      side,
      price: priceScaled.toString(),
      amount: amountBase.toString(),
      assetBase: fieldToHex(assetBase),
      assetQuote: fieldToHex(assetQuote),
      ownerKey: fieldToHex(order.ownerKey),
      nonce: fieldToHex(order.nonce),
      receiveCode: encodeReceiveCode(order.ownerKey, ownEnc.pub),
      baseCode: base,
      quoteCode: quote,
    })
    return { hash, orderId: fieldToHex(order.commitment) }
  }

  /** Cancel an open order, releasing the locked funds back into a fresh shielded note. */
  async cancelOrder(orderId: string): Promise<TxResult> {
    const order = loadOrders().find((o) => o.commitment === orderId && o.status === 'open')
    if (!order) throw new Error('That order is not open (already cancelled or filled).')

    const spendingKey = getSpendingKey()
    const lockedAssetId = hexToField(order.lockedAssetId)
    const refundNote = createNote({ assetId: lockedAssetId, amount: BigInt(order.lockedAmount), spendingKey })

    const inputs = buildCancelOrderInputs({
      orderCommitment: hexToField(order.commitment),
      refundCommitment: refundNote.commitment,
      refundAssetId: lockedAssetId,
      side: order.side,
      price: BigInt(order.price),
      amount: BigInt(order.amount),
      assetBase: hexToField(order.assetBase),
      assetQuote: hexToField(order.assetQuote),
      nonce: hexToField(order.nonce),
      spendingKey,
      refundBlinding: refundNote.blinding,
    })

    const proof = await this.proveAndVerify('cancel_order', inputs)
    const from = await this.requireAddress()
    const op = this.contract.cancelOrderOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
    })
    const { hash } = await this.submitOp(op, from)

    setOrderStatus(order.commitment, 'cancelled')
    addNote(refundNote, { assetCode: order.lockedAssetCode, txHash: hash, decimals: order.lockedDecimals, source: 'change' })
    void syncIndexer()
    return { hash }
  }
}
