# `eth-light-client` — Ethereum sync-committee light client on Soroban

The **trustless provenance core** of the Obscura bridge (BRIDGE_SPEC §5). It verifies
the Ethereum Altair/Capella light-client protocol *natively* on Stellar using the
CAP-0059 BLS12-381 host functions (`g1_add`, `hash_to_g2`, `pairing_check`, subgroup
checks) and SHA-256 — no SNARK wrapping. A finalized Ethereum execution `state_root`
is accepted **only** if > 2/3 of the seeded 512-member sync committee signed the
attesting beacon header (a BLS aggregate-signature pairing check), and the finalized
execution header is proven against it by SSZ Merkle branches.

Standalone crate (own `[workspace]` table) so it never touches the `obscura-pool`
workspace.

## Build & test

```bash
source ../../env.sh
cargo test                                   # native, default rust 1.91.0  (10 tests)
RUSTUP_TOOLCHAIN=1.92.0 stellar contract build   # wasm32v1-none -> eth_light_client.wasm
```

## Interface

```rust
fn __constructor(committee: Vec<BytesN<96>>, genesis_root: BytesN<32>,
                 fork_version: BytesN<4>, admin: Address);
fn update_header(update: LightClientUpdate) -> Result<(), LcError>;   // trustless
fn post_root(admin: Address, block_number: u64, state_root: BytesN<32>); // fallback, NOT trustless
fn state_root_at(block_number: u64) -> Option<BytesN<32>>;
fn head() -> (u64, BytesN<32>);
```

## What `update_header` verifies (all on real Sepolia data — see tests)

1. **Slot ordering** `signature_slot > attested_slot >= finalized_slot`, and the
   signature's sync-committee period matches the seeded committee (pinned on first use).
2. **Participation > 2/3**: `popcount(sync_committee_bits) * 3 >= 512 * 2` (strict, not `MIN=1`).
3. **Aggregate pubkey** by G1 point addition: start from the precomputed all-512
   aggregate and **subtract non-signers** (`g1_add` of negated pubkeys). Final
   aggregate is G1-subgroup-checked.
4. **`signing_root`** = `hash_tree_root(attested beacon header)` mixed with
   `compute_domain(DOMAIN_SYNC_COMMITTEE=0x07000000, fork_version, genesis_validators_root)`,
   then `H(m) = hash_to_g2(signing_root, "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_")`.
5. **2-pairing FastAggregateVerify**: `e(agg_pk, H(m)) == e(G1, signature)` via
   `pairing_check`. The signature G2 point is subgroup-checked first. Reject on failure.
6. **`finality_branch`** SSZ Merkle proof of the finalized header vs
   `attested_header.state_root`.
7. **`execution_branch`** SSZ Merkle proof of the `ExecutionPayloadHeader` vs
   `finalized_header.body_root` (gindex 25); the full 17-field execution header is
   merkleized in-contract, binding `state_root` + `block_number`, which are stored as head.

### Measured cost

`cargo test` prints, for the real update (100% participation, 0 non-signers):

```
update_header CPU instructions (host-fn metered) = 33,272,051   (~33% of the 100M tx budget)
update_header memory bytes                       = 447,902
```

In line with the BRIDGE_SPEC §5 estimate (~30–35M). The BLS host ops dominate
(`pairing_check` ~20M, `hash_to_g2` ~6M, the two subgroup checks, plus SHA-256 for
SSZ). Each non-signer adds one `g1_add` (~7.7K instr), so a realistic ≤1/3 non-signer
update adds at most ~1.3M. (Native test metering *under*-counts the contract's own
Rust glue vs wasm, but the dominant ops are host-metered at on-chain calibrated cost,
so this is a sound estimate.)

## Trust model & deliberate, documented simplifications

The trust assumption is an **honest 2/3 of the seeded 512-validator Ethereum sync
committee** (identical to Helios / Telepathy). The relayer is **untrusted transport**.

- **Uncompressed point I/O.** The Soroban host exposes no point-*decompression* host
  function. Ethereum serves pubkeys 48-byte compressed and signatures 96-byte
  compressed; here the committee is seeded, and the signature supplied, in
  **uncompressed** form (G1 96B, G2 192B). The untrusted relayer decompresses
  off-chain. **This adds no trust:** (a) the committee is the trust root, seeded at
  construction (and its all-512 aggregate is recomputed in-contract, not trusted);
  (b) any wrong signature decompression is rejected by the pairing check, which binds
  the point to the signed message. The contract works exclusively with uncompressed
  points to avoid implementing a ~381-bit modular square root (decompression) on-chain,
  which has no host primitive and would blow the budget.
- **Single committee period.** The 512 pubkeys are seeded once (~27h validity); there
  is **no** `next_sync_committee` rotation (gindex 55) — future work. The seeded
  committee must be refreshed within the period.
- **PoP-trust for pubkeys.** Per-pubkey subgroup checks (512 × ~0.73M ≈ 374M instr)
  are **skipped**: Ethereum validators register with proof-of-possession, which already
  defeats the rogue-key attack. Only the final **aggregate** (G1) and the **signature**
  (G2) are subgroup-checked. Deliberate, per BRIDGE_SPEC §1.
- **No wall-clock `current_slot` bound.** Altair's `current_slot >= signature_slot`
  (don't-accept-future) check needs an Ethereum slot clock, which a single-period
  seeded client on Soroban does not have. The committee's ~27h window bounds validity
  instead; the inter-slot ordering among the update's own slots is enforced.
- **Posted-root fallback.** `post_root` is admin-gated and clearly marked **NOT
  trustless** — a day-1 unblock / demo path only. The trustless path is `update_header`.

### Fork-awareness (gindex)

The finality proof's generalized index changed at Electra (105 → 169), but the
*subtree index* used by the branch walk is **41 in both** (`105 % 64 == 169 % 128 == 41`),
and the proof depth is taken from `finality_branch.len()`. So the same code verifies
Capella/Deneb (6-deep) and Electra/Fulu (7-deep) proofs. Execution gindex 25 (subtree
index 9, depth 4) is stable.

## Real-data validation

`src/test_vectors.rs` is generated by `scripts/gen_vector.mjs` from a **real Sepolia**
`LightClientFinalityUpdate` + the matching `bootstrap` sync committee (fork: **fulu**,
sync-committee period **1292**, finalized execution block **11173338**). The test
`real_finality_update_accepted` runs the full pipeline above and asserts acceptance;
`reject_*` tests assert that zeroed participation, a negated signature, bad slot order,
a corrupted finality branch, and a tampered execution `state_root` are all rejected.

Regenerate against fresh data:

```bash
B=https://ethereum-sepolia-beacon-api.publicnode.com
curl -s "$B/eth/v1/beacon/light_client/finality_update" > /tmp/fu.json
R=$(curl -s "$B/eth/v1/beacon/headers/finalized" | jq -r .data.root)
curl -s "$B/eth/v1/beacon/light_client/bootstrap/$R" > /tmp/bootstrap.json
# args: <fu> <bootstrap> <genesis_validators_root> <fork_version active at signature_slot>
node scripts/gen_vector.mjs /tmp/fu.json /tmp/bootstrap.json \
  d8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078 90000075
```
(`genesis_validators_root` from `/eth/v1/beacon/genesis`; `fork_version` from
`/eth/v1/config/fork_schedule` for the epoch of `signature_slot`.)
