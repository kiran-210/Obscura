# Wraith Circuits (Noir / UltraHonk)

Five zero-knowledge circuits that gate every state transition out of Wraith's
shielded layer, plus a shared library (`wraith_lib`) holding the cryptographic
invariants that must stay byte-for-byte identical across the Noir circuits, the
Soroban contract, and the TypeScript SDK.

| Circuit | Purpose | Public inputs |
|---------|---------|---------------|
| `withdraw` | Shielded -> classic withdrawal | 5 |
| `transfer` | Private payment (2-in / 2-out) | 6 |
| `place_order` | Lock funds, place a hidden order | 5 |
| `match_orders` | Prove fair match + settlement of two orders | 8 |
| `cancel_order` | Cancel an open order, refund locked funds | 3 |

Everything obeys [`SHARED.md`](../SHARED.md) (the source of truth) and
[`SPEC.md`](../SPEC.md) sec 8.

## Toolchain (pinned)

```
nargo  1.0.0-beta.9
bb     0.87.0
poseidon lib  tag v0.2.0  (github.com/noir-lang/poseidon)
```

This pin yields **proof = 14592 bytes** and **vk = 1760 bytes** with the Keccak
transcript — the only combination the `rs-soroban-ultrahonk` verifier accepts.
Source the toolchain first:

```bash
source ../env.sh          # from this directory; puts nargo + bb on PATH
nargo --version           # must print 1.0.0-beta.9
bb --version              # must print 0.87.0
```

## Layout

```
circuits/
  noir/
    wraith_lib/      shared lib: hashes, commitments, nullifier, Merkle, int math
    withdraw/        bin circuit + Prover.toml + #[test]s
    transfer/
    place_order/
    match_orders/
    cancel_order/
    build_all.sh     compile + test + prove + write_vk for all five
  artifacts/         COMMITTED deployment fixtures: per-circuit vk + sample proof
                     + public_inputs (binary) + public_inputs.json (human readable)
```

## Build / test / prove

```bash
source ../env.sh
./noir/build_all.sh        # all five: nargo test, compile, execute, bb prove, bb write_vk
```

Per circuit (manual, SHARED sec 8 pipeline):

```bash
cd noir/withdraw
nargo test
nargo compile
nargo execute witness
bb prove    --scheme ultra_honk --oracle_hash keccak \
            -b target/withdraw.json -w target/witness.gz -o target \
            --output_format bytes_and_fields
bb write_vk --scheme ultra_honk --oracle_hash keccak \
            -b target/withdraw.json -o target --output_format bytes_and_fields
# -> target/proof (14592 B), target/vk (1760 B), target/public_inputs (N*32 B)
```

Verify a generated proof locally:

```bash
bb verify --scheme ultra_honk --oracle_hash keccak \
          -k circuits/artifacts/withdraw/vk \
          -p circuits/artifacts/withdraw/proof \
          -i circuits/artifacts/withdraw/public_inputs
```

All five committed fixtures verify with these flags.

## Shared library (`wraith_lib`)

Poseidon2 (BN254, t=4, RATE 3, HADES, x^5 S-box, IV = `message_size << 64`):

- `hash2/hash4/hash7` -> `Poseidon2::hash([..], N)` with `N` = number of field
  elements absorbed (NOT a capacity).
- `note_commitment(asset_id, amount, owner_key, blinding) = hash4(...)`
- `nullifier(commitment, spending_key) = hash2(...)`
- `owner_key(spending_key) = hash2(spending_key, 0)`
- `order_commitment(side, price, amount, asset_base, asset_quote, owner_key, nonce) = hash7(...)`
- `compute_merkle_root(leaf, siblings[20], bits[20])` — depth 20; `bit == 0` ->
  `hash2(cur, sib)` (current LEFT), `bit == 1` -> `hash2(sib, cur)` (current
  RIGHT); each bit is constrained boolean (SHARED sec 5).
- Bounded-integer helpers (`assert_64`, `geq64`, `gt64`, `min64`, `midpoint`,
  `mul_div_price`) for the price/fill math — see "Integer arithmetic" below.

## Public inputs (in declaration order — load-bearing, SHARED sec 7)

The contract parses `public_inputs` as 32-byte big-endian Fr elements in exactly
this order. `public_inputs.json` in each artifact dir lists the concrete values.

| Circuit | Public inputs, in order |
|---------|-------------------------|
| `withdraw` | `merkle_root, nullifier, recipient_hash, amount, asset_id` |
| `transfer` | `merkle_root, nullifier_0, nullifier_1, out_commitment_0, out_commitment_1, ext_data_hash` |
| `place_order` | `merkle_root, nullifier, order_commitment, change_commitment, locked_asset_id` |
| `match_orders` | `order_commitment_a, order_commitment_b, fill_note_buyer, fill_note_seller, residual_order_a, residual_order_b, refund_note_a, refund_note_b` |
| `cancel_order` | `order_commitment, refund_commitment, refund_asset_id` |

> The 16 pairing-point-object (PPO) elements live inside the proof, not in
> `public_inputs`. So `len(public_inputs) = 32 * (vk.public_inputs_size - 16)`,
> e.g. withdraw = 160 B (5 fields), match_orders = 256 B (8 fields).

## What each circuit proves

- **withdraw** — derive `owner_key`; recompute the note commitment; check the
  nullifier; Merkle membership against `merkle_root`; note amount/asset equal the
  public `amount`/`asset_id`; range-check the amount; bind `recipient_hash`.
- **transfer** — for each of two inputs: recompute commitment + nullifier (must
  match published), and (skipping dummies with amount 0) Merkle membership +
  same-asset; for each of two outputs: recompute commitment (must match), same
  asset, 64-bit range; value conservation `sum_in == sum_out`; nullifiers
  distinct; bind `ext_data_hash`. A second input note of amount 0 is a phantom.
- **place_order** — note ownership + Merkle membership; order commitment uses the
  derived `owner_key`; side-dependent balance lock (BUY locks
  `amount*price/PRICE_SCALE` of quote, SELL locks `amount` of base); change note
  matches (or is 0); 64-bit range checks; `locked_asset_id` consistent.
- **match_orders** — both order preimages verified; sides boolean & opposite;
  same pair; `buy_price >= sell_price`; `exec_price = floor((buy+sell)/2)`;
  `fill = min(buy_amount, sell_amount)`; `quote_filled = floor(fill*exec/PRICE_SCALE)`;
  buyer settlement note in base, seller settlement note in quote; per-order
  residual + refund (see policy below); all amounts range-checked.
- **cancel_order** — order preimage verified against the derived `owner_key`;
  refund amount/asset by side (BUY -> `amount*price/PRICE_SCALE` quote, SELL ->
  `amount` base); refund note + `refund_asset_id` match.

## Integer arithmetic (important)

Field division in Noir is multiplicative inverse, **not** integer division, and a
`Field as u64`/`as u128` cast **truncates silently** (it does not range-check).
So every amount/price is first constrained with `assert_max_bit_size::<64>()`
(`wraith_lib::assert_64`) and only then cast to `u64`/`u128` for the price math:

- `midpoint(a,b)   = floor((a+b)/2)`  via `u128`
- `mul_div_price(a,b) = floor((a*b)/PRICE_SCALE)` via `u128` (product of two
  64-bit values fits in 128 bits)
- `min64/geq64/gt64` via `u64`

All divisions are **floor / integer division**. The midpoint and the
`*/PRICE_SCALE` fills round down; the remainder (sub-unit dust) is not minted.

## Assumptions, deviations, and known gaps

1. **Midpoint & fill rounding (floor).** `exec_price`, `quote_filled`, the BUY
   lock, and the BUY/cancel refund all use integer floor division. Sub-unit
   remainders are dropped, never created — conservative for the pool. SPEC sec 7.4
   asked this be documented; this is it.

2. **`match_orders` residual/refund policy (MVP).** Public inputs are indexed by
   **order A / B**, while the economics are buyer/seller; we map them explicitly:
   - An order whose `amount > fill_amount` is *partially filled* -> a residual
     order (same side, same price, `amount - fill_amount`) is produced and **no
     refund** is issued for that order (its funds stay locked in the residual).
   - A *fully filled* BUY order receives a quote-asset refund equal to its price
     improvement `floor(amount*buy_price/PRICE_SCALE) - quote_filled` (when > 0).
   - A *fully filled* SELL order receives no refund (its locked base is fully
     delivered to the buyer).
   - **Known under-refund:** a partially filled BUY does not get a refund for the
     price improvement on its *filled* portion; that overpayment stays locked.
     SPEC sec 8.4's own pseudocode has this gap ("No refund for buyer (funds stay
     locked in residual)"); we follow it for the MVP. A v2 should split a partial
     buyer's locked quote into {paid, residual-lock, improvement-refund}.

3. **Unconstrained-but-public binders.** `withdraw.recipient_hash` and
   `transfer.ext_data_hash` are not otherwise constrained by the circuit; each is
   squared (`x*x`) so it cannot be optimised away, and being public it is bound
   into the proof transcript. The *contract* is responsible for checking these
   against the real recipient / external data.

4. **No global value conservation in `match_orders`.** The circuit proves the
   settlement notes are well-formed; it does not re-check that locked funds equal
   distributed funds across the pool (that requires the per-order locked amounts
   from `place_order`, which the contract tracks). Combined with gap (2), the
   contract is the final accounting authority.

5. **Merkle proofs are caller-supplied.** Circuits verify a path to a claimed
   `merkle_root`; the contract must confirm that root is in its 100-entry root
   history (SHARED sec 5).

6. **64-bit domain.** Amounts and prices must be `< 2^64`. Derived quantities
   (e.g. a BUY lock `amount*price/PRICE_SCALE`) are also range-checked to 64 bits,
   so extreme inputs whose derived values exceed 2^64 are simply unprovable.

## Tests

`nargo test` per package (also run by `build_all.sh`). Each circuit has at least
one valid witness and several expected-failure cases:

| Package | Tests | Coverage highlights |
|---------|-------|---------------------|
| `wraith_lib` | 6 | hash/commitment field order, Merkle L/R orientation, non-boolean bit rejection, int helpers |
| `withdraw` | 4 | valid; wrong nullifier; wrong root; amount mismatch |
| `transfer` | 5 | valid (1 real + dummy); two real inputs in a 2-leaf tree; value mismatch; duplicate nullifier; bad output commitment |
| `place_order` | 5 | valid buy; valid sell (no change); insufficient balance; wrong locked asset; wrong order commitment |
| `match_orders` | 5 | full fill + buyer refund; partial fill + residual; same-side reject; price-incompatible reject; wrong buyer note |
| `cancel_order` | 5 | valid buy; valid sell; wrong owner; wrong refund amount; wrong refund asset |

Total: **30 tests, all passing.**

## Artifacts (committed)

`circuits/artifacts/<circuit>/` contains the per-circuit verification key plus one
sample proof and its public inputs, for the contract/SDK teams:

- `vk` — 1760 bytes; deploy one UltraHonk verifier per circuit with this key.
- `proof` — 14592 bytes; a sample valid proof (the Prover.toml witness).
- `public_inputs` — `N*32` bytes, big-endian Fr, in the order above.
- `public_inputs.json` — the same values, annotated, for cross-checking ordering.

These are force-tracked via `circuits/artifacts/.gitignore` even though `*.vk`,
`*.proof`, and `target/` are otherwise ignored.
