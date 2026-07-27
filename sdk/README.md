# @wraith/sdk

TypeScript client library for **Wraith**, the privacy platform on Stellar. It provides
the cryptographic primitives (Poseidon2, note/order commitments, an incremental Merkle
tree), UltraHonk proof generation wiring, and Soroban transaction building used by the
frontend and matcher.

- **ESM + CJS**, ships type declarations. Built with `tsup`, tested with `vitest`.
- All cross-component invariants follow [`../SHARED.md`](../SHARED.md) byte-for-byte
  (Poseidon2 params, commitment field order, Merkle bit ordering, public-input encoding).

```bash
pnpm --filter @wraith/sdk build
pnpm --filter @wraith/sdk test
```

---

## Poseidon2 golden-vector result (the headline)

SHARED §9 mandates that the SDK's Poseidon2 reproduce the on-chain / Noir hash before it
is used for any commitment. Golden vectors were generated from the **pinned Noir
`poseidon` v0.2.0 lib** (`nargo 1.0.0-beta.9`, BN254, t=4, RATE=3, `iv = num_inputs·2^64`,
output `state[0]`) — identical params to `soroban-poseidon`'s
`poseidon2_hash::<4, BnScalar>`.

Backing library: **`@zkpassport/poseidon2`** (`poseidon2Hash`).

| Arity | Used for | Golden vector | Result |
|------:|----------|---------------|:------:|
| 2 | Merkle nodes, nullifiers, key derivation | `hash2(1,2)`, `hash2(0,0)` | **PASS** |
| 4 | Balance-note commitments | `hash4(1,2,3,4)` | **PASS** |
| 7 | Order commitments | `hash7(1..7)` | **PASS** |

All three arities pass. The gate lives in [`test/poseidon.test.ts`](test/poseidon.test.ts)
and asserts against [`test/poseidon.golden.json`](test/poseidon.golden.json). The Merkle
`ZEROS`, note/order commitments, and incremental roots are independently anchored to
Noir-generated goldens (`test/merkle.golden.json`, `test/commitments.golden.json`), so a
silent Poseidon regression cannot pass the suite.

Reference values:

```
hash2(1,2)     = 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383
hash2(0,0)     = 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1
hash4(1,2,3,4) = 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9
hash7(1..7)    = 0x16f929bc0d216df4b05bdc44222463edf2b9791bd949ab926eebda06a502d238
```

### Regenerating the goldens

The generator is a tiny Noir program under [`test/golden-gen/`](test/golden-gen):

```bash
source ../env.sh                 # nargo 1.0.0-beta.9 on PATH
cd test/golden-gen && nargo test --show-output
```

It prints the hash vectors, `zeros[0..20]`, the note/order vectors, and incremental Merkle
roots. (It pulls `poseidon` v0.2.0 from git; Noir's stdlib Poseidon2 is `private` in
beta.9, hence the external dep.)

---

## Modules

| File | Exports | Purpose |
|------|---------|---------|
| `src/constants.ts` | `PRICE_SCALE`, `TREE_DEPTH`, `BN254_FIELD_MODULUS`, `ZEROS`, `EMPTY_ROOT`, `PROOF_BYTES`, `VK_BYTES` | Cross-component constants; `ZEROS[0..20]` precomputed (Noir-authoritative). |
| `src/poseidon.ts` | `hash2`, `hash4`, `hash7`, `hash`, `toField`, `fieldToBytes`/`bytesToField`, `fieldToHex`/`hexToField`, `randomField` | Poseidon2 over BN254 + field/byte helpers. Inputs reduced mod r (matches on-chain `rem_euclid`). |
| `src/types.ts` | `BalanceNote`, `OutputNote`, `Order`, `OrderParams`, `MerkleProof`, `KeyPair`, `Asset`, `OrderSide`, `ProofData`, `Field` | Data model, mirroring SHARED §4–7. |
| `src/merkle.ts` | `MerkleTree` | Incremental append-only tree (frontier insertion + proof gen), mirror of the on-chain tree. `rootFromProof` mirrors the in-circuit check. |
| `src/note.ts` | `deriveOwnerKey`/`deriveViewingKey`/`deriveKeys`, `generateKeyPair`, `computeCommitment`, `computeNullifier`, `createNote`, `createOutputNote`, `noteNullifier` | Note commitments (`hash4`), nullifiers (`hash2`), key derivation. |
| `src/order.ts` | `createOrder`, `computeOrderCommitment`, `orderLockedAmount` | Order commitments (`hash7`) + locked-balance math. |
| `src/prover.ts` | `NoirProver`, `buildWithdrawInputs`/`buildPlaceOrderInputs`/`buildCancelOrderInputs`, `isValidProofLength` | UltraHonk proof gen via `@noir-lang/noir_js` + `@aztec/bb.js` with the **keccak** transcript. |
| `src/wallet.ts` | `Wallet` | In-memory note store, per-asset balance aggregation, greedy note selection, open-order tracking. |
| `src/stellar.ts` | `WraithContract`, `encodePublicInputs`/`decodePublicInputs`, `addressToField`, `assetIdFromAddress`, `recipientHash`, `nativeAsset`, `assetFromSac`, `buildTransaction`, `PUBLIC_INPUT_ORDER` | Soroban invoke-op building + public-input encoding (32-byte BE concat). |
| `src/index.ts` | `Wraith` (impl. of `WraithSdk`) + re-exports | High-level surface the frontend uses: `deposit`, `withdraw`, `transfer`, `placeOrder`, `cancelOrder`, `getShieldedBalances`, `getOpenOrders`. |

---

## Proof generation (UltraHonk, keccak transcript)

`NoirProver` drives `@noir-lang/noir_js` (witness) + `@aztec/bb.js`'s `UltraHonkBackend`.
The **keccak** transcript is mandatory — the Soroban verifier only accepts Keccak-256:

```ts
const prover = new NoirProver(compiledCircuitJson, { keccak: true }); // keccak:true is the default
const { proof, publicInputs } = await prover.prove(inputs);          // proof: Uint8Array(14592)
```

`{ keccak: true }` is bb.js's equivalent of `bb prove --oracle_hash keccak` (verified
against `@aztec/bb.js@0.87.0` `UltraHonkBackendOptions`). `bb.js`/`noir_js` are imported
lazily, so importing `@wraith/sdk` does not spin up the Barretenberg WASM/threads.

Public inputs are serialized in each circuit's declared `pub` order (`PUBLIC_INPUT_ORDER`,
SHARED §7) as concatenated 32-byte big-endian field elements; the 16 pairing-point-object
elements live inside the proof, not in `public_inputs`.

---

## Pinned dependencies (do not bump silently)

| Package | Version | Why |
|---------|---------|-----|
| `@noir-lang/noir_js` | `1.0.0-beta.9` | Matches pinned `nargo`. |
| `@aztec/bb.js` | `0.87.0` | Matches pinned `bb`; this pin yields the verifier-accepted 14 592-byte proof / 1 760-byte VK. beta.22 / bb 5.0.0 are **rejected** by the verifier. |
| `@zkpassport/poseidon2` | `^0.6.2` | Golden-validated Poseidon2 (see above). |
| `@stellar/stellar-sdk` | `^13.3.0` | Soroban tx building + SAC. |

---

## What's wired vs pending integration

**Fully implemented and unit-tested (deterministic, no external services):**

- Poseidon2 (`hash2/4/7`) — golden-validated for arities 2, 4, 7.
- Merkle tree: frontier insertion, proof generation, `ZEROS`, roots — matched against
  Noir-generated golden roots.
- Note commitments / nullifiers / key derivation — matched against Noir golden vectors.
- Order commitments + locked-amount math — matched against a Noir golden vector.
- Wallet: balances, greedy note selection, order tracking.
- `public_inputs` encode/decode, address→field, SAC asset helpers, and Soroban invoke-op
  construction (deposit/withdraw/transfer/place_order/match_orders/cancel_order).
- `Wraith` orchestrator: `deposit` (no proof) end-to-end; local Merkle mirror sync;
  balance/order views; proof flows assemble notes/commitments/nullifiers/inputs and build
  the submittable op once a prover is supplied.

**Pending integration (tracked, not faked):**

- **Real proof generation against the 5 circuits.** The compiled circuit JSONs
  (`target/<circuit>.json`) live on the `feat/circuits` branch and are not present here.
  `NoirProver` is implemented against the noir_js/bb.js interface; the full pipeline test
  is `it.skip`ped (it also needs the Barretenberg CRS). Wire by passing each compiled
  circuit via `WraithConfig.provers`.
- **`addressToField` convention.** The SDK maps a Stellar address to a field by decoding
  its StrKey to the raw 32 bytes and interpreting them big-endian (mod r). This must match
  whatever the deployed `wraith-pool` contract uses to derive `asset_id` / `recipient_hash`;
  it is the one mapping not verifiable until the contract branch lands.
- **Tx submission / RPC.** `buildTransaction` returns an unsigned tx; footprint prep
  (`rpc.Server.prepareTransaction`) and signing are left to the caller.
- **Note discovery** is out-of-band (MVP, SPEC §6.3) — the wallet is a local cache that
  must be synced from on-chain Deposit/Transfer/settlement commitments in global order via
  `Wraith.observeCommitment` for Merkle proofs to be valid.

---

## Usage sketch

```ts
import { Wraith, nativeAsset, NoirProver } from "@wraith/sdk";

const sdk = new Wraith({
  contractId: "C...WRAITHPOOL",
  // provers: { withdraw: new NoirProver(withdrawJson), ... }  // once feat/circuits lands
});

// Bridge in (no proof):
const { note, operation } = sdk.deposit({ asset: nativeAsset(), amount: 1_000_000n, from: "G..." });
// submit `operation`, then mirror every on-chain commitment in order:
sdk.observeCommitment(note.commitment); // binds note.leafIndex

// Views:
sdk.getShieldedBalances(); // Map<assetId, bigint>
sdk.getOpenOrders();
```
