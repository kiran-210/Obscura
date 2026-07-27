# SHARED.md — Cross-component invariants (source of truth)

Every component (Noir circuits, Soroban contract, TS SDK) **must** agree on the rules below
byte-for-byte. A mismatch in Poseidon2 params or public-input encoding makes deposits unspendable
or proofs unverifiable. When in doubt, the reference implementation in
`vendor/rs-soroban-ultrahonk` (cloned locally) is authoritative; this file distills it.

> Derived from a source-level audit of `vendor/rs-soroban-ultrahonk` (HEAD `661db07`) and
> `vendor/noir-poseidon` (tag semantics of `v0.2.0`). See `vendor/SMOKE_FINDINGS.md` for the
> toolchain proof-size verification.

---

## 1. Toolchain (pinned — do not upgrade)

| Tool | Version | Notes |
|------|---------|-------|
| nargo (Noir) | `1.0.0-beta.9` | `noirup -v 1.0.0-beta.9` |
| bb (Barretenberg) | `0.87.0` | `bbup -v 0.87.0` |
| Noir `poseidon` lib | tag `v0.2.0` | `github.com/noir-lang/poseidon` |
| soroban-sdk | `26.0.1` | |
| soroban-poseidon | `26.0.0` | on-chain Poseidon2 (`poseidon2_hash::<4, BnScalar>`) |
| Rust | `1.91.0` stable | |
| wasm target | **`wasm32v1-none`** | Soroban 26; use `stellar contract build` |
| stellar CLI | `27.0.0` | |

Verified locally: this pin yields **proof = 14 592 bytes**, **vk = 1 760 bytes**. Latest beta.22 / bb
5.0.0 yield 4 544 / 1 888 and the verifier **rejects** them. Source `./env.sh` before any nargo/bb/stellar.

---

## 2. Field & curve

- Curve: **BN254** (alt_bn128). All circuit values are BN254 scalar-field (`Fr`) elements.
- Modulus `r = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
- A "Field element" on the wire is **32 bytes, big-endian**, value `< r` (canonical).

---

## 3. Poseidon2 (THE critical invariant)

All three implementations must produce identical output for identical inputs.

- Parametrization: **BN254, state width `t = 4`, RATE 3, HADES, S-box `x^5`**, variable-length sponge
  with domain/IV `iv = message_size << 64` (i.e. `iv = (num_inputs) * 2^64`), output = `state[0]`.
- **Noir** (in circuit): `use dep::poseidon::poseidon2::Poseidon2;` →
  `Poseidon2::hash([a, b], 2)` — the second argument is the **message size** (number of field
  elements absorbed), NOT a capacity. For a 2-input hash it is `2`; for 4 inputs it is `4`.
- **Soroban** (on-chain): `soroban_poseidon::poseidon2_hash::<4, BnScalar>(env, &inputs)` where
  `4` is the state width `t` and `BnScalar` is BN254 Fr. **Inputs must be reduced mod `r`**
  (`U256::from_be_bytes(...).rem_euclid(&modulus)`) before hashing. Output `.to_be_bytes()` → `[u8;32]`.
- **TypeScript** (SDK): candidate `@zkpassport/poseidon2` (pure-TS BN254 Poseidon2 for Noir compat).
  **MANDATORY**: before using it for any commitment, validate it against golden vectors generated
  from the on-chain/Noir impl (e.g. assert `H(1,2)`, `H(0,0)`, a 4-input hash all match). A silent
  mismatch makes every note unspendable. See §9.

### Hash arities used by Obscura

| Name | Inputs | Call |
|------|--------|------|
| `hash2(a,b)` | 2 | `Poseidon2::hash([a,b], 2)` / `poseidon2_hash::<4,_>([a,b])` |
| `hash4(a,b,c,d)` | 4 | `Poseidon2::hash([a,b,c,d], 4)` |
| `hash7(...)` | 7 | `Poseidon2::hash([...7], 7)` |

> The reference only exercises `hash2`. `hash4`/`hash7` use the **same lib** with a longer input
> array (sponge absorbs RATE=3 at a time; the lib handles padding). Both Noir and `soroban-poseidon`
> implement the same variable-length sponge, so they remain consistent for any arity — but the SDK's
> JS lib must be golden-vector-checked for **each arity** Obscura uses (2, 4, 7).

---

## 4. Note & order commitments

### Key derivation
```
spending_key            : random Fr (secret)
owner_key   = hash2(spending_key, 0)
viewing_key = hash2(spending_key, 1)        // optional, for selective disclosure
```

### Balance note
```
asset_id  : Fr   // hash2(asset_sac_address_as_field, 0); native XLM = 0
amount    : Fr   // < 2^64
owner_key : Fr
blinding  : Fr   // random
commitment = hash4(asset_id, amount, owner_key, blinding)
nullifier  = hash2(commitment, spending_key)
```
Field order in `hash4` is **(asset_id, amount, owner_key, blinding)** — fixed everywhere.

### Order
```
side        : Fr   // 0 = buy, 1 = sell
price       : Fr   // limit price, scaled by PRICE_SCALE; < 2^64
amount      : Fr   // base-asset quantity; < 2^64
asset_base  : Fr
asset_quote : Fr
owner_key   : Fr
nonce       : Fr   // random
order_commitment = hash7(side, price, amount, asset_base, asset_quote, owner_key, nonce)
```
Field order in `hash7` is fixed as listed.

### Address → Field (canonical, authoritative)

`asset_id` and `recipient_hash` bind on-chain Stellar Addresses to circuit field elements.
All three components MUST derive the field from an Address identically:

```
address_as_field(addr) =
    be(raw32(addr))  mod  r
```

- `raw32(addr)` = the address' **raw 32-byte key**: the ed25519 public key for `G…`
  account addresses, the contract-id hash for `C…` contract addresses (SACs).
- `be(·)` interprets those 32 bytes as a **big-endian** integer.
- reduced **mod `r`** (the BN254 scalar modulus, §2) to land in `[0, r)`.

Implementations:
- **SDK** (`sdk/src/stellar.ts`, `addressToField`): `StrKey.decode{Contract,Ed25519PublicKey}` →
  `bytesToField` (big-endian) → `mod r`.
- **Contract** (`contracts/obscura-pool/src/lib.rs`, `address_to_field`): `Address::to_xdr` →
  trailing 32 bytes of the `ScVal::Address` XDR (both the `…Account/PublicKey/Ed25519` and
  `…Contract/Hash` encodings end with the 32-byte key) → `U256::from_be_bytes(..).rem_euclid(r)`.
  Pinned by the cross-impl golden test `address_to_field_matches_sdk_golden` in
  `src/test.rs` (asserts the contract output equals SDK-generated golden constants for a
  known `C…` and a known `G…` address).

Then:
```
asset_id(asset)         = hash2(address_as_field(asset), 0)     // SAC asset_id
                          = 0  for native XLM
recipient_hash(recip)   = hash2(address_as_field(recip), 0)
```

**Native XLM special case:** the native asset's canonical `asset_id` is **`0`**, not
`hash2(address_as_field(native_sac), 0)`. Off-chain the SDK returns `0` directly; on-chain
the pool is constructed with the native SAC address and maps that one Address to `0`. Every
other SAC uses the `hash2(…)` form.

### Constants
```
PRICE_SCALE = 10_000_000        (10^7)
TREE_DEPTH  = 20
```

---

## 5. Merkle tree (incremental, append-only)

- Depth `20`, leaves are note `commitment`s, hash = `hash2`.
- Empty values: `zeros[0] = 0`; `zeros[i+1] = hash2(zeros[i], zeros[i])`.
- Insertion (frontier / `filled_subtrees`): for level `i`, `bit = (index >> i) & 1`;
  `bit == 0` → save `cur` as frontier[i], `cur = hash2(cur, zeros[i])`;
  `bit == 1` → `cur = hash2(filled_subtrees[i], cur)`.
- Merkle proof in-circuit: `path_bits[i] ∈ {0,1}` (enforced `bit*(1-bit)==0`);
  `bit == 0` → `cur = hash2(cur, sibling)` (current is LEFT);
  `bit == 1` → `cur = hash2(sibling, cur)` (current is RIGHT).
- Contract keeps a **root history ring buffer** (last 100 roots); a proof may reference any root in
  history (so it doesn't go stale between build and submit).

---

## 6. Verifier integration (UltraHonk)

Verifier contract: `vendor/rs-soroban-ultrahonk/contracts/rs-soroban-ultrahonk` (or depend on the
crate `ultrahonk-soroban-verifier`). One **verifier instance per circuit VK** — Obscura deploys 5
(withdraw, transfer, place_order, match_orders, cancel_order) and the pool stores their addresses.

**API (exact):**
```rust
// constructor — VK is immutable after this
fn __constructor(env: Env, vk_bytes: Bytes) -> Result<(), Error>;
// verify — public_inputs FIRST, then proof. Returns Ok(()) on success, Err on failure (no panic).
fn verify_proof(env: Env, public_inputs: Bytes, proof_bytes: Bytes) -> Result<(), Error>;
fn vk_bytes(env: Env) -> Result<Bytes, Error>;
```

**Byte formats:**
- `proof_bytes`: exactly **14 592 bytes** (`456 × 32`). Reject otherwise.
- `vk`: exactly **1 760 bytes** (32-byte header + 27 × 64-byte G1).
- `public_inputs`: concatenation of **32-byte big-endian Fr** elements. The 16 pairing-point-object
  (PPO) elements live **inside the proof**, NOT in `public_inputs`. So
  `len(public_inputs) == 32 * (vk.public_inputs_size − 16)`.
  ⇒ When generating the circuit, the number of `pub` inputs the SDK serializes for `public_inputs`
  is the circuit's declared public inputs; `bb` writes them to `target/public_inputs` in declaration
  order. **Always source `public_inputs` order from the circuit's `pub` parameter order** (see §7).

**Cross-contract call pattern (from mixer.rs):**
```rust
let mut args: Vec<Val> = Vec::new(env);
args.push_back(public_inputs.into_val(env));
args.push_back(proof_bytes.into_val(env));
env.try_invoke_contract::<(), InvokeError>(verifier, &Symbol::new(env, "verify_proof"), args)
    .map_err(|_| Error::VerificationFailed)?
    .map_err(|_| Error::VerificationFailed)?;
```

**Error codes (verifier):** 1 `VkInvalidLength`, 2 `VkInvalidParameters`, 3 `ProofParseError`,
4 `VerificationFailed`, 5 `VkNotSet`, 6 `AlreadyInitialized`.

---

## 7. Public-input ordering per circuit

`public_inputs` bytes = each circuit's `pub` parameters concatenated as 32-byte BE field elements,
**in the order the `pub` params are declared in `main`**. The contract must parse them in the same
order and validate them (root ∈ history, nullifier unspent, order ∈ active set, etc.) before/after
calling the verifier. Declared orders (authoritative):

| Circuit | Public inputs (in order) |
|---------|--------------------------|
| `withdraw` | `merkle_root, nullifier, recipient_hash, amount, asset_id` |
| `transfer` | `merkle_root, nullifier_0, nullifier_1, out_commitment_0, out_commitment_1, ext_data_hash` |
| `place_order` | `merkle_root, nullifier, order_commitment, change_commitment, locked_asset_id` |
| `match_orders` | `order_commitment_a, order_commitment_b, fill_note_buyer, fill_note_seller, residual_order_a, residual_order_b, refund_note_a, refund_note_b` |
| `cancel_order` | `order_commitment, refund_commitment, refund_asset_id` |

`recipient_hash = hash2(recipient_address_as_field, 0)` and `asset_id = hash2(asset_address_as_field, 0)`
(native XLM `asset_id = 0`), both using the canonical `address_as_field` rule in §4. `ext_data_hash`
binds transfer external params (see SPEC §6). `amount`/`asset_id`/`recipient_hash` in `withdraw` are
public so the contract can drive the SAC transfer.

**Binding (contract):** `withdraw` MUST reject unless `asset_id_of(asset) == asset_id` (public) and
`recipient_hash_of(recipient) == recipient_hash` (public) — errors `AssetMismatch` (12) /
`RecipientMismatch` (13). Without this a valid proof for one asset could draw a different pool-held
asset, or be redirected to another recipient. `place_order`/`cancel_order`/`match_orders` carry
`asset_id`s as public inputs but move no SAC funds and take no asset Address argument, so there is no
Address to bind there; `deposit` has no proof, so its `asset` cannot be bound to the note (the
note's `asset_id` is committed off-chain inside the opaque `commitment`).

---

## 8. Proof generation pipeline (per circuit)

```bash
source ./env.sh
cd circuits/noir/<circuit>
nargo compile
nargo execute witness
bb prove    --scheme ultra_honk --oracle_hash keccak \
            -b target/<circuit>.json -w target/witness.gz -o target --output_format bytes_and_fields
bb write_vk --scheme ultra_honk --oracle_hash keccak \
            -b target/<circuit>.json                      -o target --output_format bytes_and_fields
# -> target/proof (14592 B), target/vk (1760 B), target/public_inputs (N*32 B)
```
Transcript is **keccak** (`--oracle_hash keccak`) — the verifier only supports the Keccak-256
transcript, not Poseidon2. The same `bb` flags are used in-browser via `@aztec/bb.js`
`UltraHonkBackend` (keccak/“keccak”/`UltraHonkBackend` with `{ keccak: true }` — confirm the exact
bb.js option matches `--oracle_hash keccak`).

---

## 9. JS Poseidon2 golden-vector gate (blocking for SDK)

Before the SDK computes any commitment, it MUST pass a test that reproduces on-chain/Noir Poseidon2:
1. Generate golden vectors once: run a tiny Noir circuit (or `soroban-poseidon` Rust snippet)
   computing `hash2(1,2)`, `hash2(0,0)`, `hash4(1,2,3,4)`, `hash7(1..7)` and record the 32-byte BE
   outputs into `sdk/test/poseidon.golden.json`.
2. SDK `poseidon.ts` must reproduce all of them exactly. If `@zkpassport/poseidon2` fails any arity,
   switch to driving `@aztec/bb.js`’s `poseidon2Hash` (with matching IV semantics) or generate
   commitments via a Noir helper. **Do not proceed past a failing golden test.**

---

## 10. Risks carried from the reference (mitigations)

- **R1** bb pinned to exactly `0.87.0` (verifier ported from 0.82.2 but CI-green at 0.87.0). Never bump silently.
- **R3** JS Poseidon2 mismatch → §9 golden gate is mandatory.
- **R4** No ready-made deploy path for an app contract on-chain — Obscura ships its own deploy script
  (deploy 5 verifiers with their VKs, then the pool with the 5 addresses).
- **R5** Verifier has no access control; pool must be constructed with the correct verifier addresses
  and should expose `vk_bytes()` checks in the deploy script.
