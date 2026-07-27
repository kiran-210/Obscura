# Wraith — Live on Stellar Testnet

The full system is deployed and the end-to-end private flow is **verified on-chain**. Every claim
below is backed by a testnet transaction you can open on stellar.expert.

## Contracts (testnet)

| Contract | ID |
|----------|----|
| **Wraith Pool** | [`CD7EF4GG32IPVS2PGD2LMXEO3TPEWBZRUCBBSPXQ236CD6TMF5S4UUZR`](https://stellar.expert/explorer/testnet/contract/CD7EF4GG32IPVS2PGD2LMXEO3TPEWBZRUCBBSPXQ236CD6TMF5S4UUZR) |
| Verifier · withdraw | `CBKB3P72CTZAGODIKMQRLUJ2INHQULK5J66N6QQR7GCHGDUFCTUPJ6M3` |
| Verifier · transfer | `CBXOZGAWSLJEXVMHY6WMBDLAJWDESUPOJV2TEAK6F77IYD7EVRDINS6I` |
| Verifier · place_order | `CDOEXIJR3OE7527IBTBGYX62TNWBIOHMR7IBMWBMBBR6QA4TIXZSBXEE` |
| Verifier · match_orders | `CB5HNMW6IIMLQPSAKAC3ADTDHEOTKX6EHYCXNK5EITTFMO33BMD2EKM4` |
| Verifier · cancel_order | `CAI6B5ZTWOGJIBLNMOG67H3MAPSORU64ZEXBB7YYQ6TQ5RQJMSQQSA3B` |

Each verifier is an instance of the `rs-soroban-ultrahonk` UltraHonk verifier, deployed with the
corresponding circuit's verification key (`circuits/artifacts/<circuit>/vk`). The pool is constructed
with all five verifier addresses.

## End-to-end evidence

| Step | Result | Transaction |
|------|--------|-------------|
| `verify_proof` with a real `withdraw` proof | **accepted** (`Ok`) | [`0e7c0dca…`](https://stellar.expert/explorer/testnet/tx/0e7c0dcaaef6be5f35e09d37960864b500c5046d97ad145b5611221fcdcaf8a0) |
| `verify_proof` with a **tampered** proof | **rejected** (`Crypto, InvalidInput` — bn254 point not on curve) | — (simulation fails) |
| `deposit` 1 XLM + note commitment | **success**, leaf index 0 | [`56cd056c…`](https://stellar.expert/explorer/testnet/tx/56cd056ce6790b05bc4ff11b34bcc77e195a2880f6c97a71034ddccb0615da97) |
| on-chain root == SDK-computed root | **byte-identical** `2a58187c…` | — |
| `withdraw` with a real ZK proof (1 XLM out) | **success**, verifier accepted on-chain; **asset/recipient bound** to the proof's `asset_id`/`recipient_hash` | [`6be9162f…`](https://stellar.expert/explorer/testnet/tx/6be9162fa0fc0d1b1fbce175eab97ed90ab3faca486a4f0adad7c7c1b10dda0d) |
| `withdraw` replay (same proof) | **rejected** `NullifierUsed (#5)` | — (simulation fails) |
| **`transfer`** (Pay) — 2-in/2-out shielded, value conserved (0.5 → 0.2 + 0.3, amounts hidden) | **success**, both input nullifiers spent, 2 output commitments inserted | [`8b8eed61…`](https://stellar.expert/explorer/testnet/tx/8b8eed61eabd219c9d766f496ec19fc333549868fca2308cf7e63e00b8add90f) |
| **`place_order`** ×2 (Swap) — hidden orders, ZK-proven balance, funds locked | `OrderPlacedEvent` (commitment opaque) | (settled below) |
| **`match_orders`** (Swap) — match at midpoint, buyer←base / seller←quote | **success**, fair match proven in-circuit | [`5bc05ebf…`](https://stellar.expert/explorer/testnet/tx/5bc05ebfa3f95849e6c6e3bff8375e6cfe09544e8c3318feb4096f81c7c4bdb3) |
| **`cancel_order`** (Swap) — refund locked funds as a new note | `OrderCancelledEvent` | [`51023894…`](https://stellar.expert/explorer/testnet/tx/51023894faf88329a2bd937c55ba05731860a5189aafe998e4964cf9881a4063) |

**All six flows are verified live on testnet** — bridge (deposit/withdraw), private payment (transfer),
and the full dark-pool swap (place/match/cancel) — each gated by a real Noir/UltraHonk proof checked
inside the Soroban contract.

The deposit→withdraw pair is a complete private round-trip: 1 XLM enters the pool against an opaque
commitment, and leaves only when a valid zero-knowledge proof of ownership (against the current
Merkle root, with an unused nullifier) is verified **inside the Soroban contract**. The two
load-bearing cross-implementation invariants are both confirmed live:

1. **SDK ↔ contract Poseidon2 Merkle tree** — the off-chain tree the prover builds against and the
   on-chain tree the pool maintains produce the *same* depth-20 root.
2. **Noir/bb ↔ on-chain UltraHonk verifier** — a proof produced by `bb` (keccak transcript) is
   accepted by the Soroban verifier, and a tampered one is rejected.

## Reproduce

```bash
source ./env.sh
# 1. deploy verifiers + pool (writes deployments.json)
./scripts/deploy.sh
# 2. run the deposit -> withdraw E2E against the deployment
./scripts/e2e.sh
```

The demo note used above is deterministic (`spending_key=12345`, `blinding=67890`, `amount=1 XLM`,
`asset_id=0`), so the commitment `0f09047227…` and nullifier `02e885ea…` are reproducible.

## Soundness: asset/recipient binding (closed)

`withdraw` binds the SAC `asset` and `recipient` Address to the proof's public `asset_id` and
`recipient_hash` via a canonical on-chain `Address→Field` encoding that matches the SDK's
`addressToField` **byte-for-byte** (pinned by the `address_to_field_matches_sdk_golden` cross-impl
test). A proof for one asset/recipient cannot be redirected to another (`AssetMismatch` /
`RecipientMismatch`). The deployed pool above is the binding-enforced build.

## Known limitations (honest WIP)

- Single-asset demo (native XLM). Multi-asset works by the same path with each asset's SAC.
- `transfer` / order flows: circuits + contract paths exist and unit-tested; the live-wired frontend
  ships deposit + portfolio first, with withdraw experimental (in-browser proving) and
  transfer/swap on the mock SDK. The matching service is tracked separately.
