# @obscura/matcher

Off-chain order-matching service for the **Obscura** ZK dark pool on Stellar.

Traders submit their order details (the order's commitment plus its full preimage) to this
service. The engine keeps an in-memory book, finds crossable matches with **price-time
priority**, and for each match assembles the `match_orders` circuit inputs + the 8
public-input fields (SHARED §7) and submits `obscura-pool.match_orders(proof, public_inputs)`
to the Soroban contract.

The matching math is a byte-for-byte mirror of the `match_orders` Noir circuit
(`circuits/noir/match_orders/src/main.nr`). If it diverged, the on-chain UltraHonk verifier
would reject the settlement.

## Trust model

This is the same model as TradFi dark pools (IEX, Liquidnet): the operator sees flow but
cannot touch funds.

| The matcher **can** | The matcher **cannot** |
|---|---|
| See submitted order details (price, amount, owner key, nonce) | **Steal funds** — settlement notes are ZK-enforced by the circuit |
| Choose which orders to cross / match priority | Change the execution price (proven to be the midpoint in-circuit) |
| Refuse to match (censor) | Mint settlement notes to anyone but the real order owners (`owner_key` is bound in the commitment) |
| Learn who is trading what | Front-run — it can't trade without depositing & placing its own order |

Why it can't steal: every settlement note (`fill_note_*`, `residual_order_*`, `refund_note_*`)
is a Poseidon2 commitment that the circuit recomputes from the **order preimages** the
trader committed to on-chain. The matcher only chooses fresh blindings/nonces for the *new*
notes; it cannot redirect value, alter amounts, or change the price without producing a proof
the verifier rejects.

## Matching rules (mirror of the circuit)

All integer math, floor rounding, prices scaled by `PRICE_SCALE = 10^7`:

- **Compatible** iff opposite sides, same `(asset_base, asset_quote)` pair, and
  `buy_price >= sell_price`.
- `exec_price   = floor((buy_price + sell_price) / 2)`  (midpoint).
- `fill         = min(buy_amount, sell_amount)`  → residual on the **larger** side.
- `quote_filled = floor(fill * exec_price / PRICE_SCALE)`.
- Buyer receives `fill` of the **base** asset; seller receives `quote_filled` of the **quote**
  asset.
- Per order (mapped to **A/B**, not buyer/seller — exactly as the circuit's `settle_order`):
  - `amount > fill` → **partially filled**: a residual order is re-committed (same side &
    price, remaining amount); **no refund** on the filled portion (documented MVP
    simplification).
  - `amount == fill` → **fully filled**: a **BUY** gets a quote-asset refund of its price
    improvement `floor(amount*price/SCALE) - quote_filled` (when positive); a **SELL** gets
    no refund.

Order A is the buy and order B is the sell by convention, but every quantity is computed
per-order, so the A/B labelling is purely positional.

### Price-time priority

Per pair: sort buys by price **descending** then submission time **ascending**; sort sells by
price **ascending** then time ascending; cross best-buy vs best-sell while
`best_buy.price >= best_sell.price`. Each order is matched at most once per pass.

## Public inputs (SHARED §7, load-bearing order)

`match_orders` publishes 8 fields, in this exact order (the contract parses them positionally
as 32-byte big-endian Fr → 256 bytes total):

```
0 order_commitment_a   1 order_commitment_b
2 fill_note_buyer       3 fill_note_seller
4 residual_order_a      5 residual_order_b
6 refund_note_a         7 refund_note_b
```

## HTTP API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/orders` | submit an order (JSON, below) → `201 { commitment, sequence }` |
| `GET`  | `/orders` | `200 { count, commitments }` — **commitments only**, never order details |
| `GET`  | `/health` | `200 { ok, orders, mode }` |

`POST /orders` body (numbers may be JSON numbers or strings; `price`/`amount` are integers):

```json
{
  "commitment": "0x…",
  "side": "buy",
  "price": "20000000",
  "amount": "10",
  "assetBase": "0",
  "assetQuote": "1",
  "ownerKey": "0x…",
  "nonce": "42"
}
```

## Run

```bash
# from matcher/
pnpm install            # installs the matcher + its @obscura/sdk workspace dep
pnpm build              # tsup -> dist/
pnpm test               # vitest (engine + prover + submitter)

# live server (needs the SDK built: pnpm --filter @obscura/sdk build)
pnpm start              # http://localhost:8787
```

Environment:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `OBSCURA_POOL_CONTRACT` | — | pool contract id (else read from `deployments.json` — the match-memo pool wins) |
| `OBSCURA_DEPLOYMENTS` | `../deployments.json` | path to `deployments.json` |
| `MATCH_CIRCUIT` | — | path to compiled `match_orders.json`; set it to prove for real (needs the bb.js CRS at runtime). Unset ⇒ `MockMatchProver`. |
| `OBSCURA_SUBMIT` | `dry-run` | set to `live` to actually submit |
| `OBSCURA_MATCHER_SECRET` | — | funded `S…` key the matcher signs + pays gas with (required when `live`). **Server secret — never ship it to the frontend.** |
| `OBSCURA_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC used for live submission |
| `MATCH_INTERVAL_MS` | `2000` | background match-loop interval (0 disables) |

### Going live (runbook)

```bash
pnpm --filter @obscura/sdk build                 # matcher consumes the SDK dist
pnpm --filter @obscura/matcher build

# 1. compile the match circuit (pinned nargo 1.0.0-beta.9)
( cd circuits/noir/match_orders && nargo compile )   # -> target/match_orders.json

# 2. fund a matcher key (testnet) and export its secret
#    stellar keys generate matcher --network testnet --fund
#    export OBSCURA_MATCHER_SECRET=$(stellar keys show matcher)   # keep this off the frontend

# 3. run live
MATCH_CIRCUIT=circuits/noir/match_orders/target/match_orders.json \
OBSCURA_SUBMIT=live OBSCURA_MATCHER_SECRET=S... \
pnpm --filter @obscura/matcher start
```

Traders opt into matching by POSTing their order preimage **plus their `wr1…` receive code** to
`POST /orders`; the matcher seals each settlement note/residual to that code so fills arrive as
on-chain memos the wallet's indexer discovers (self-custodial — the matcher can't lock funds).

## Live vs mock — what's real and what's stubbed

| Piece | Status |
|---|---|
| Order book + price-time matching (`engine.ts`) | **Real**, fully unit-tested, mirrors the circuit math (cross-checked against the circuit's own `#[test]` golden vectors). |
| Public-input assembly + commitments (`prover.ts`) | **Real** Poseidon2 commitments via `@obscura/sdk`; validated against the circuit's golden settlement vectors. |
| ZK proof generation | **Integration-only.** `proveMatch` takes an injectable `MatchProver`; wire the SDK's `NoirProver` (compiled `match_orders.json` + bb.js, keccak transcript) for real proofs. The default `MockMatchProver` returns the correct public inputs with a zero-filled proof (the verifier will reject it) so the pipeline runs without a circuit. |
| Settlement memo sealing (`memo.ts`) | **Real & unit-tested** — seals each fill/refund note + residual order to its owner (shared `@obscura/sdk` sealed box), in the contract's exact insertion order; round-trip verified against owner recovery. |
| Soroban encoding (`submitter.ts`) | **Real & unit-tested** — builds the exact `match_orders(proof, public_inputs, leaf_memos, residual_memos)` invoke op. |
| On-chain submission (`MatchSubmitter.submit`) | **Integration-only** — RPC prepare → sign → send; never exercised by unit tests. Needs a funded source account and a real, verifier-accepted proof. |
| Note discovery / persistence | Delivery is **on-chain memos** (`OrderMatchedEvent`), discovered by the wallet's indexer — self-custodial, works offline. The book is still in-memory (persistence is a hardening item). |

Addresses (testnet) come from the repo-root `deployments.json` — the matcher targets the
match-memo pool `contracts.obscuraPoolMatchMemo.contract`
(`CA2CI7VKG27V3FIXD3OYXFYTN33DMI5QR4WFBX3N5SRC6JWEO3AWDILD`); the match verifier is
`contracts.verifiers.match_orders` (`CB5HNMW6IIMLQPSAKAC3ADTDHEOTKX6EHYCXNK5EITTFMO33BMD2EKM4`).
