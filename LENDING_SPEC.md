# LENDING_SPEC.md — private collateralised lending (Obscura)

Extends the shielded pool with lending. Reuses the existing note/nullifier/Merkle
infrastructure verbatim; see SHARED.md for the cryptographic invariants, which are
unchanged.

> **Status:** Phase 1 (circuits) implemented. Phases 2–4 (contracts, SDK, UI) pending.
> Risk parameters are **placeholders** — `Verdex_PRD.md` was not supplied. Every one of
> them is a circuit *public input*, so they are governance-settable without recompiling.

---

## 1. The liquidation problem, and what we actually chose

Public lending protocols rely on liquidator bots reading every position's collateral and
debt. Hiding both amounts breaks that: nobody can tell who is liquidatable.

Three designs were evaluated. The result that drove the decision:

> **Both amounts private + no decryption party + executable liquidation is impossible.**

The reason is structural. A note is `hash4(asset_id, amount, owner_key, blinding)` and
spending it requires knowing the preimage. If a stale position's amounts are known only to
the borrower, no liquidator can construct a spend proof and no contract can compute a
payout. Pre-authorising a seizure note does not rescue it: for the seizure to be spendable
by an arbitrary caller its `amount` must be published, which discloses the collateral at
open time — the exact thing being protected.

**Chosen: collateral public, debt private (Option C).**

| Value | Visibility | Why |
|---|---|---|
| Collateral asset + amount | **public** | Makes seizure executable by anyone, with no keeper and no trusted party. |
| Debt (`debt_scaled`) | **private** | Never stored on-chain; lives only inside the position commitment. |
| Supplier positions | **private** | Suppliers are never liquidated, so nothing forces disclosure. |
| Health factor | **private** | Follows from debt being private. |

The honest one-line claim: **your leverage is hidden, your collateral is not.**

Rejected: a keeper viewing key (works, but the keeper can decrypt *every* position at any
time — constraining it on-chain to act only on stale positions does not constrain what it
sees); and threshold decryption across N keepers, which is the correct long-term design
and is out of scope here.

### 1.1 Disclosure — what still leaks

Stated plainly rather than assumed away:

- **Positions are distinguishable from ordinary notes.** Enforcing a deadline requires the
  contract to know which commitments are positions and when each expires, so positions live
  in their own registry. The original request that position notes be indistinguishable from
  transfer notes is **not achievable** and is not claimed.
- **A position is linkable to itself over time.** Attestations and borrows reference the
  same registry entry, so an observer sees the full operation history of one position —
  cadence, timing, and lifetime — though not its debt.
- **`borrow_amount` and `repay_amount` are public.** A pooled protocol cannot stay solvent
  without tracking aggregate borrowings, and that forces a public per-operation delta.
  Consequently **a chain analyst who follows one position's operation chain can reconstruct
  its current debt by accumulation.** What debt privacy buys is that the contract never
  stores it, casual observers do not see it, and it is not exposed to liquidators — not
  confidentiality against a determined analyst. Closing this would require either a
  utilisation-free (governance-set) rate model or ZK aggregate accounting; both are future
  work.

---

## 2. Liveness: self-attestation

Borrowers prove solvency every `ATTESTATION_PERIOD` ledgers via `solvency_attestation`,
which proves `collateral_value × liquidation_threshold ≥ debt_value` at a fresh oracle
price with the debt private. A successful attestation refreshes `deadline[position]`.

`health_deadline` is deliberately **contract state, not a note field**. Committing it would
force a nullify-and-recommit every period — burning a nullifier and a tree leaf each time,
and building an explicit `C₁ → C₂ → C₃…` chain. Keeping it in contract state means an
attestation mutates no notes at all, and `solvency_attestation` needs no Merkle proof
(the contract already holds the commitment), which makes it the cheapest circuit here.

Miss the deadline and the position is seizable by any caller. Because collateral is public,
seizure needs no proof — it is plain contract logic, so there is no `liquidate_stale.nr`.

Seizure is **all-or-nothing**: the caller takes the full public collateral and the protocol
writes off the hidden debt. Proportional liquidation with a surplus refund is impossible
here, because computing the surplus requires knowing the debt. This is punitive by design —
it is the incentive to stay live.

---

## 3. Note layouts

Both use `hash7`, which already exists for orders. **Domain separation is mandatory**: order
commitments are also `hash7`, so without a distinct leading tag a crafted order could be
replayed as a position. The domain tag occupies slot 0.

```
POSITION_DOMAIN = 7001
SUPPLY_DOMAIN   = 7002

position_commitment = hash7(POSITION_DOMAIN, collateral_asset, collateral_amount,
                            debt_asset, debt_scaled, owner_key, nonce)

supply_commitment   = hash7(SUPPLY_DOMAIN, asset, supply_scaled,
                            owner_key, nonce, 0, 0)
```

Nullifiers reuse `hash2(commitment, spending_key)` unchanged.

## 4. Interest: scaled balances

Storing a raw `debt_amount` would freeze the debt at commit time — it would stop accruing.
Debt is therefore stored **scaled**, Aave-style, against a public monotonic index:

```
debt_scaled  = borrow_amount × INDEX_SCALE / borrow_index      (at borrow time)
debt_now     = debt_scaled   × borrow_index / INDEX_SCALE      (at any later time)
```

`borrow_index` and `supply_index` are public contract state and public circuit inputs, so
interest accrues with no note ever being touched.

## 5. Solvency inequality

```
collateral_value = collateral_amount × collateral_price / PRICE_SCALE
debt_now         = debt_scaled       × borrow_index     / INDEX_SCALE
debt_value       = debt_now          × debt_price       / PRICE_SCALE

borrow / withdraw_collateral :  collateral_value × max_ltv_bps       / BPS_SCALE ≥ debt_value
solvency_attestation         :  collateral_value × liq_threshold_bps / BPS_SCALE ≥ debt_value
```

**Overflow.** All operands are range-checked to 64 bits before any integer reasoning, and
each intermediate is re-checked to 64 bits. A `Field as u128` cast in Noir truncates
silently and does **not** range-check; unchecked inputs would wrap and forge solvency.
`mul_div` in `lending_lib` enforces this on both inputs and its result.

## 6. Placeholder risk parameters

Swap these when `Verdex_PRD.md` lands. All are public inputs — no recompilation needed.

| Parameter | Placeholder | Notes |
|---|---|---|
| `max_ltv_bps` | 7500 (75%) | borrow / withdraw ceiling |
| `liq_threshold_bps` | 8000 (80%) | attestation floor; must exceed `max_ltv_bps` |
| `INDEX_SCALE` | 1e9 | interest index precision |
| `BPS_SCALE` | 1e4 | basis points |
| `ATTESTATION_PERIOD` | ~1 day in ledgers | contract-side |

Oracle: **Reflector** on Stellar testnet is assumed. Prices enter as public inputs; the
contract MUST bind them to a fresh on-chain read, otherwise a stale favourable price can be
replayed.

## 7. Circuits

| Circuit | Merkle proofs | Est. constraints | Notes |
|---|---|---|---|
| `position_open` | 1 | ~7k | spends a collateral note, opens a position |
| `borrow` | 1 | ~8k | + solvency at `max_ltv` |
| `repay` | 1 | ~8k | spends a note of the debt asset |
| `withdraw_collateral` | 1 | ~8k | re-checks solvency post-withdrawal |
| `solvency_attestation` | 0 | ~1k | opening + health only |
| `supply` | 1 | ~7k | |
| `redeem` | 1 | ~7k | |

For comparison the existing `transfer` circuit runs ~12k and already proves in-browser, so
**client proving time is not a bottleneck.** UltraHonk proof size is fixed at 14,592 bytes.

The real cost is deployment: **one verifier contract per VK** (SHARED §6), so this adds 7
verifier deployments on top of the existing 5.

## 8. Contract-layer constraint (Phase 2)

Position, supply and balance notes **must share one Merkle tree**. If lending used a
separate tree, moving collateral in would require a public `withdraw` from the pool, whose
`amount` is a public input — leaking collateral at the boundary and shrinking the anonymity
set. So the lending logic must live inside the pool contract, or in a contract granted
insert/nullify rights on the pool's tree.

`obscura_pool.wasm` is already 68 KB; adding 7 verify paths plus a position registry may
press against limits. Resolving this is the first Phase 2 task.
