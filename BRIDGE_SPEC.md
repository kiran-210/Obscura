# Obscura Bridge — Trustless ZK-Private Cross-Chain Bridge (Ethereum Sepolia → Stellar)

## Technical Specification v1.0

> A **trust-minimized** bridge that moves assets from Ethereum into the Obscura shielded pool on
> Stellar. Assets arrive **private** (as shielded notes), and provenance is established by an
> **Ethereum light client running natively on Soroban** — not a trusted relayer. This is feasible on
> Stellar specifically because it has native **BLS12-381** host functions (CAP-0059): the
> sync-committee signature check that costs ~80M gas on the EVM costs ~30M of the 100M Soroban budget,
> so **no SNARK-wrapping of the light client is needed**. The ZK in the system is the privacy layer
> (the existing Obscura pool); the bridge's trustlessness comes from native BLS + native Keccak.

---

## 1. Trust model

| Component | Trust assumption |
|---|---|
| **Header provenance** (Ethereum → Stellar) | Honest **2/3 of the 512-validator Ethereum sync committee** (identical to Helios / Succinct Telepathy). The relayer is **untrusted transport** — it cannot forge a header or signature. |
| **Inclusion** (state root → lock record) | None beyond the header. An Ethereum Merkle-Patricia storage proof is verified **in-contract** (Keccak/RLP in Rust) against the light-client's trusted execution `state_root`. |
| **Privacy** | The Obscura shielded pool (existing UltraHonk ZK). The link between the Ethereum lock and the Stellar recipient is broken by the note/nullifier scheme. |

### Honest, documented limitations (hackathon scope)
- **Single committee period.** The light client is seeded with one recent checkpoint's 512 sync-committee pubkeys (~27h validity). **No committee rotation** (`next_sync_committee`, gindex 55) — *future work*.
- **PoP-trust for pubkeys.** Per-pubkey BLS subgroup checks (512 × ~0.73M ≈ 374M instructions) are skipped; Ethereum validators register with proof-of-possession, which already defeats the rogue-key attack. Only the final aggregate is curve-checked. *Documented deliberate simplification.*
- **Posted-root fallback.** A trusted `post_root(state_root)` entrypoint (admin-gated, feature-flagged) exists as a day-1 unblock and demo fallback. It is **NOT** the trustless path; the BLS light client is.

---

## 2. Architecture

```
ETHEREUM SEPOLIA            RELAYER (untrusted)          STELLAR (Soroban)
                                                          ┌──────────────────────────────┐
 ObscuraBridgeL1.sol                                       │ EthLightClient               │
   lock(commitment,        beacon API:                    │  update_header(finality_upd)  │
        token, amount) ──►  LightClientFinalityUpdate ───►│   • 2/3 participation          │
   locks[commitment]                                      │   • BLS FastAggregateVerify    │
        = (token,amount)   exec RPC: eth_getProof  ─────► │     (BLS12-381 host fns)       │
                                                          │   • finality + execution branch│
                                                          │   -> trusted execution state_root│
                                                          ├──────────────────────────────┤
                                                          │ ObscuraBridge                  │
                                                          │  bridge_in(storage_proof,     │
                                                          │            commitment, token, amt)│
                                                          │   • MPT verify vs state_root   │
                                                          │     (Keccak host fn, RLP)      │
                                                          │   • not already minted         │
                                                          │   -> pool.bridge_mint(commitment)│
                                                          ├──────────────────────────────┤
 unlock(commitment,    ◄── relayer submits burn proof    │ ObscuraPool (existing + mint)  │
        amount, to)        + Stellar unlock event         │  bridge_mint(commitment)       │
   (releases L1 funds)                                    │   -> insert into Merkle tree   │
                                                          │   (shielded note, asset=bToken)│
                                                          └──────────────────────────────┘
```

Two **native** on-chain verifications on Soroban (BLS for the header, Keccak/MPT for inclusion). The
existing Obscura UltraHonk verifier (Noir/bb 0.87.0) is **untouched** — the bridge adds new contracts
and one new pool entrypoint.

---

## 3. Asset model

Bridged tokens are represented in the pool as a distinct **bridged asset id**, so they interoperate
with all existing shielded flows (transfer, swap) but are redeemable only back to Ethereum.

```
asset_id(bToken) = hash2( hash2(eth_chain_id, eth_token_address_as_field), BRIDGE_DOMAIN )
```

- A Obscura balance note for bridged ETH/USDC uses this `asset_id`. The note is
  `commitment = hash4(asset_id, amount, owner_key, blinding)` — the **same commitment scheme** as
  native notes, so the pool's Merkle tree, nullifiers, transfer and swap circuits work unchanged.
- `bridge_in` **mints** (inserts the commitment) without moving Stellar tokens — the backing lives in
  the L1 lock. `bridge_out` **burns** (spends a note via nullifier) and authorizes the L1 `unlock`.
- A bridged note **cannot** be `withdraw`n as native XLM (asset mismatch with the native SAC); it is
  spent only via `bridge_out`, transfer, or swap. The contract enforces this through `asset_id`.

---

## 4. Ethereum L1 contract — `ObscuraBridgeL1.sol`

Minimal lock/unlock escrow. Solidity ^0.8.24, deployed on Sepolia.

```solidity
contract ObscuraBridgeL1 {
    // commitment => packed lock record. Declaration slot p = 0 (see storage proof).
    mapping(bytes32 => LockRecord) public locks;          // slot 0
    mapping(bytes32 => bool)       public spentOnL2;      // slot 1 (set on unlock)
    address public immutable relayerOrGovernor;           // authorizes unlock settlement

    struct LockRecord { address token; uint96 amount; }   // token=address(0) => native ETH

    event Locked(bytes32 indexed commitment, address token, uint256 amount);

    function lock(bytes32 commitment, address token, uint256 amount) external payable {
        require(locks[commitment].amount == 0, "commitment used");
        if (token == address(0)) require(msg.value == amount, "bad eth");
        else IERC20(token).transferFrom(msg.sender, address(this), amount);
        locks[commitment] = LockRecord(token, uint96(amount));
        emit Locked(commitment, token, amount);
    }

    // Called after a verified Stellar-side bridge_out (relayer submits the Stellar proof off-band;
    // for the hackathon, governor-gated). Releases the original funds to `to`.
    function unlock(bytes32 commitment, address to) external { /* require(msg.sender==governor) ... */ }
}
```

**Storage-slot derivation** (for the inclusion proof): for `locks[commitment]` at declaration slot
`p = 0`, the L1 storage slot is `keccak256(abi.encode(commitment, uint256(0)))`
(= `keccak256(commitment ‖ 0x00..00)`). The `LockRecord { address token; uint96 amount; }` packs into
one 32-byte word `W`, **Solidity declaration-order / low-order-first** (authoritative — proven by the
L1 `vm.load` test, the §4 snippet's earlier prose was backwards):

```
W = (uint256(amount) << 160) | uint256(uint160(token))
  token  = address(uint160(W))   // LOW 20 bytes  (bits 0..159)
  amount = uint96(W >> 160)      // HIGH 12 bytes (bits 160..255)
```

`eth_getProof` returns the storage value RLP-encoded with leading zero bytes stripped, so the Soroban
decoder MUST **left-pad the proven leaf value back to 32 bytes** before applying the formula.

---

## 5. Soroban contract — `EthLightClient`

Verifies the Ethereum Altair/Capella light-client protocol natively. `no_std`, `soroban-sdk 26.0.1`,
uses `env.crypto().bls12_381()` and `env.crypto().keccak256()` / SHA-256.

### Storage
| Key | Type | Notes |
|---|---|---|
| `committee_pubkeys` | `Vec<BytesN<48>>` | 512 G1 pubkeys (seeded for one period) |
| `committee_agg` | `BytesN<96>` | precomputed aggregate of all 512 (G1) — subtract non-signers |
| `genesis_validators_root` | `BytesN<32>` | from the chain |
| `fork_version` | `BytesN<4>` | active fork (Capella/Deneb) |
| `head_state_root` | `BytesN<32>` | latest trusted execution state root |
| `head_block_number` | `u64` | execution block of `head_state_root` |
| `admin` | `Address` | for the posted-root fallback only |

### Interface
```rust
pub fn __constructor(env: Env, committee: Vec<BytesN<48>>, genesis_root: BytesN<32>,
                     fork_version: BytesN<4>, admin: Address);

/// Trustless path. `update` carries attested+finalized headers, sync_aggregate
/// (bits + G2 signature), finality_branch, and the execution payload header + execution_branch.
pub fn update_header(env: Env, update: LightClientUpdate) -> Result<(), LcError>;

/// Fallback (admin-gated, feature-flagged). NOT trustless.
pub fn post_root(env: Env, admin: Address, block_number: u64, state_root: BytesN<32>);

pub fn state_root_at(env: Env, block_number: u64) -> Option<BytesN<32>>;
pub fn head(env: Env) -> (u64, BytesN<32>);
```

### `update_header` verification (per the Altair/Capella spec)
1. **Slot ordering**: `current >= signature_slot > attested_slot >= finalized_slot`; signature period
   within the seeded committee period.
2. **Participation ≥ 2/3**: `sum(sync_committee_bits) * 3 >= 512 * 2`.
3. **Aggregate participating pubkeys** by **G1 point addition** (`bls.g1_add`, not MSM — all scalars
   are 1; ~512 × 7,689 ≈ 3.9M instr). Optimization: start from `committee_agg` and subtract the
   non-signers.
4. **signing_root** = `hash_tree_root(attested_header.beacon)` mixed with
   `domain = compute_domain(DOMAIN_SYNC_COMMITTEE, fork_version, genesis_validators_root)` →
   `hash_to_g2(signing_root)` (`bls.hash_to_g2`, ~6.3M).
5. **Pairing check** (2 pairs): `e(agg_pk, H(m)) == e(g1_generator, signature)` via
   `bls.pairing_check` (~20.4M). Reject if invalid.
6. **finality_branch** (SSZ Merkle, SHA-256) proves `finalized_header` against
   `attested_header.beacon.state_root` at `FINALIZED_ROOT_GINDEX = 105`.
7. **execution_branch** proves `ExecutionPayloadHeader` against the beacon body at
   `EXECUTION_PAYLOAD_GINDEX = 25`; extract `execution.state_root` and `block_number`; store as head.

**Budget**: ~30–35M instructions (~30–35% of 100M) — fits one transaction.

---

## 6. In-contract MPT storage proof (no ZK)

A small Rust verifier inside `ObscuraBridge` (or a shared module). Verifies an EIP-1186 `eth_getProof`
against a trusted `state_root`.

```rust
/// Verify locks[commitment] == (token, amount) under `state_root`.
fn verify_storage(
    env: &Env, state_root: &BytesN<32>, bridge_addr: &[u8; 20],
    storage_slot: &BytesN<32>, account_proof: &Vec<Bytes>, storage_proof: &Vec<Bytes>,
) -> Result<BytesN<32>, BridgeError> {  // returns the proven 32-byte storage value
    // 1. account proof: walk MPT from state_root using keccak256(bridge_addr) as the key path,
    //    RLP-decode the account leaf -> storage_root (the 3rd field of [nonce,balance,storageRoot,codeHash]).
    let storage_root = mpt_verify(env, state_root, &keccak(env, bridge_addr), account_proof)?; // decode account
    // 2. storage proof: walk MPT from storage_root using keccak256(storage_slot) as the key path,
    //    RLP-decode the leaf -> the stored word.
    let value = mpt_verify(env, &storage_root, &keccak(env, &storage_slot.to_array()), storage_proof)?;
    Ok(value)
}
```

`mpt_verify` does: for each node, `keccak256(node) == expected_hash`; RLP-decode (branch=17 items /
extension|leaf=2 items); consume nibbles of the key path (compact-encoding HP prefix handling);
descend to the child hash; at the leaf, return the value. Cost ≈ depth (≤ ~9 nodes) × `keccak256` of
≤532 bytes — a handful of M instructions, fits alongside (or in a separate tx from) the header update.

---

## 7. Soroban contract — `ObscuraBridge`

```rust
pub fn __constructor(env: Env, light_client: Address, pool: Address,
                     l1_chain_id: u32, l1_bridge_addr: BytesN<20>);

/// Trustless mint: prove an L1 lock and mint a shielded note into the pool.
pub fn bridge_in(
    env: Env,
    block_number: u64,
    commitment: BytesN<32>,          // Obscura note commitment = hash4(asset_id, amount, owner, blinding)
    token: BytesN<20>, amount: i128, // the L1 token + amount being claimed
    account_proof: Vec<Bytes>, storage_proof: Vec<Bytes>,
) -> Result<(), BridgeError> {
    // 1. state_root from the light client at block_number
    // 2. slot = keccak256(commitment ‖ 0x..00)  (locks mapping, declaration slot 0)
    // 3. value = verify_storage(state_root, l1_bridge_addr, slot, account_proof, storage_proof)
    // 4. decode (token, amount) from `value`; assert == args
    // 5. assert commitment not already bridged (replay guard, like a nullifier set)
    // 6. cross-call pool.bridge_mint(commitment)   // inserts the note into the shielded tree
}

/// Burn a bridged note (spend via nullifier + ZK) and emit an L1-unlock authorization.
pub fn bridge_out(env: Env, proof: Bytes, public_inputs: Bytes, l1_recipient: BytesN<20>)
    -> Result<(), BridgeError>;   // reuses the withdraw circuit; recipient_hash binds l1_recipient
```

**Pool change** (requires pool redeploy): add `bridge_mint(commitment: BytesN<32>)` callable **only**
by the configured `bridge` address (set in the pool constructor). It inserts the commitment into the
Merkle tree and emits a `BridgeMintEvent`. No SAC transfer (backing is on L1).

`bridge_out` reuses the existing **withdraw** circuit/verifier: the user proves ownership of a bridged
note; instead of releasing a SAC, the contract records an unlock authorization (event) that the
relayer/governor settles on L1 via `ObscuraBridgeL1.unlock`.

---

## 8. Relayer (untrusted transport)

Node/TS service. Holds no authority — every value it relays is re-verified on-chain.

- **Header feed**: poll a Sepolia beacon API (`/eth/v1/beacon/light_client/finality_update`), submit
  `update_header` to `EthLightClient`. (Optional: also drives the posted-root fallback.)
- **Inclusion feed**: on a `Locked` event (or user request), call `eth_getProof(bridgeL1, [slot],
  block)` on a Sepolia execution RPC, package `(account_proof, storage_proof)`, hand to the user /
  submit `bridge_in`.
- **Out feed**: on a Stellar `bridge_out` event, submit `ObscuraBridgeL1.unlock` (governor-gated for
  the hackathon; future: verify the Stellar proof on L1).

---

## 9. Frontend — Bridge tab (rewired)

The existing **Bridge** tab becomes a real cross-chain bridge:
- Connect **two** wallets: an EVM wallet (MetaMask via wagmi/viem) for Sepolia, and the Stellar
  Wallets Kit for Stellar.
- **Bridge in**: pick token + amount → create a Obscura note (SDK) → `lock(commitment, token, amount)`
  on Sepolia (MetaMask) → wait for the relayer's `bridge_in` → the shielded balance appears in the
  Portfolio. Show the cross-chain progress (L1 lock → header finalized → L2 mint).
- **Bridge out**: select a bridged note → `bridge_out` (in-browser ZK proof, withdraw circuit) →
  funds released on Sepolia to the chosen address.
- A "Light client" status chip: current trusted head block + "verified via Ethereum sync committee".

---

## 10. Components & build plan (staged, anti-risk)

| # | Component | Path | Stack |
|---|---|---|---|
| 1 | L1 lock contract | `bridge/l1/ObscuraBridgeL1.sol` | Solidity + Foundry, Sepolia |
| 2 | Light client | `contracts/eth-light-client/` | Rust/Soroban, BLS12-381 host fns |
| 3 | MPT verifier | `contracts/obscura-bridge/src/mpt.rs` | Rust (Keccak host fn, RLP) |
| 4 | Bridge contract | `contracts/obscura-bridge/` | Rust/Soroban |
| 5 | Pool `bridge_mint` | `contracts/obscura-pool/` (extend) | Rust/Soroban (redeploy) |
| 6 | Relayer | `bridge/relayer/` | TS (viem + beacon API + stellar-sdk) |
| 7 | Frontend Bridge tab | `frontend/src/components/Bridge.tsx` (rewire) | React + wagmi/viem + kit |

**Staging:**
- **Stage A (day 1, unblock everything):** L1 contract on Sepolia; `EthLightClient` with the
  **posted-root fallback** only; MPT verifier + `bridge_in`; pool `bridge_mint`; relayer fetching
  `eth_getProof`; frontend lock→mint. End-to-end bridge working with a **trusted posted root**.
- **Stage B (days 2–3, the trustless core):** implement `update_header` (BLS sync-committee
  verification) in `EthLightClient`; seed the committee from a Sepolia checkpoint; relayer feeds
  finality updates; flip `bridge_in` to use the light-client head. Now **trust-minimized**.
- **Stage C (polish):** `bridge_out` loop, light-client status UI, honest docs.

Each stage is shippable. If Stage B's BLS doesn't fully land, Stage A is a working (honestly
trusted-root) bridge + the light client as far as it got, documented.

---

## 11. Toolchain & dependencies

- **L1**: Foundry (`forge`), Solidity ^0.8.24, Sepolia RPC + a funded test key (env).
- **Soroban**: `soroban-sdk 26.0.1`, rust 1.92.0 for `stellar contract build` (wasm32v1-none);
  `env.crypto().bls12_381()` (CAP-0059) + `env.crypto().keccak256()`. No new Noir/bb — the existing
  beta.9 / bb 0.87.0 UltraHonk verifier is reused for `bridge_out`.
- **Relayer/frontend**: `viem` (EVM + `getProof`), a Sepolia beacon API (e.g. a public
  `light_client/finality_update` endpoint), `@stellar/stellar-sdk@14.6.1`, `wagmi` (frontend EVM).
- **Light-client constants**: `DOMAIN_SYNC_COMMITTEE = 0x07000000`, `FINALIZED_ROOT_GINDEX = 105`,
  `EXECUTION_PAYLOAD_GINDEX = 25`, `NEXT_SYNC_COMMITTEE_GINDEX = 55` (future), committee size 512,
  period = 256 epochs.

---

## 12. Security notes

- **Replay**: `bridge_in` keeps a spent-commitment set (a nullifier-like guard) so one L1 lock mints
  exactly once. `bridge_out` spends via the existing nullifier scheme.
- **Value soundness**: the storage proof binds `commitment → (token, amount)` on L1; the user must set
  the note's `amount` field to the locked `amount` (same trust shape as `deposit`). The pool holds no
  L1 backing, so a bridged note is redeemable only via `bridge_out` (enforced by `asset_id`).
- **Light-client safety**: enforce the **>2/3** threshold (not `MIN_SYNC_COMMITTEE_PARTICIPANTS = 1`).
  Single-period scope means the seeded committee must be refreshed within ~27h — documented.
- **Fallback isolation**: `post_root` is admin-gated and clearly marked non-trustless; the trustless
  demo uses `update_header`.

---

## 13. References

- Altair light-client sync protocol: https://github.com/ethereum/consensus-specs/blob/master/specs/altair/light-client/sync-protocol.md
- Capella execution-payload linkage (gindex 25): https://github.com/ethereum/consensus-specs/blob/master/specs/capella/light-client/sync-protocol.md
- CAP-0059 (Soroban BLS12-381 host functions): https://github.com/stellar/stellar-protocol/blob/master/core/cap-0059.md
- Calibrated Soroban BLS cost model: https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/test/budget_metering.rs
- Helios (port reference): https://github.com/a16z/helios
- EIP-1186 `eth_getProof`: https://eips.ethereum.org/EIPS/eip-1186
- BLS FastAggregateVerify (2 pairings): https://eth2book.info/latest/part2/building_blocks/signatures/
