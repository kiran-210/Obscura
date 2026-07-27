# `@obscura/relayer` — Obscura bridge relayer (UNTRUSTED transport)

Off-chain Node/TS service that feeds Ethereum (Sepolia) data to the Obscura
Soroban contracts. Implements `BRIDGE_SPEC.md` §8. It is **untrusted transport**:
it holds no authority and every value it relays is re-verified on-chain.

## Trust model — why an untrusted relayer is safe

The relayer only moves bytes. It cannot forge a header, a signature, or an
inclusion proof. Every claim is re-checked by a Soroban contract:

| What the relayer relays | Re-verified on-chain by |
|---|---|
| Beacon `LightClientFinalityUpdate` (headers + BLS sig + SSZ branches) | `EthLightClient.update_header`: > 2/3 sync-committee participation, a BLS12-381 **pairing check** (CAP-0059 host fns), and SSZ Merkle branches. The committee (seeded at construction) is the trust root. |
| `eth_getProof` account + storage MPT proof | `ObscuraBridge.bridge_in`: an in-contract Merkle-Patricia verifier (Keccak host fn + RLP) walks the proof against the light client's trusted execution `state_root` and re-derives `(token, amount)`. |

Consequences:

- **BLS decompression adds no trust.** Ethereum serves committee pubkeys 48-byte
  compressed and the sync signature 96-byte compressed; the Soroban host has no
  point-decompression host function, so the on-chain `LightClientUpdate` type
  expects **uncompressed** points (G1 96 bytes, G2 192 bytes). The relayer
  decompresses off-chain with `@noble/curves`. A wrong decompression simply makes
  the on-chain pairing check fail — it cannot mint anything.
- **A wrong/forged storage proof is rejected** by the in-contract MPT verifier
  against the trusted root.
- **The one trusted action** is the L1 `unlock` settlement (governor-gated, for
  the hackathon — `BRIDGE_SPEC` §4/§8); it does not affect the trustless mint
  path. Future work verifies the Stellar `bridge_out` proof on L1.

## BLS decompression (the relayer's core off-chain job)

`beacon.ts` decompresses BLS12-381 points into the **exact byte layout** the
Soroban host consumes, byte-for-byte identical to the zkcrypto `bls12_381` crate
the contract's own on-chain test vectors are produced with
(`contracts/eth-light-client/src/test.rs::decompress_g1/g2`):

- **G1 pubkey** (48 → 96 bytes): `be(x) || be(y)`.
- **G2 signature** (96 → 192 bytes): `be(x.c1) || be(x.c0) || be(y.c1) || be(y.c0)`.

This is anchored by a golden unit test: decompressing the **compressed G1
generator** yields a string identical to the `EthLightClient` contract's own
`G1_GENERATOR` constant (`contracts/eth-light-client/src/verify.rs`). If the byte
order ever drifted, every `update_header` would fail the pairing check — the test
would catch it first.

## Pipelines

### 1. Header feed — `relay-header`
`beacon.ts` → `lightclient.ts`. Fetch `GET {beacon}/eth/v1/beacon/light_client/finality_update`,
parse the JSON, **decompress** the G2 sync signature, assemble the flattened
`LightClientUpdate` (attested + finalized headers, `sync_committee_bits`,
`finality_branch`, the 17-field execution payload header + `execution_branch`,
`base_fee_per_gas` as 32-byte little-endian SSZ), encode it to a Soroban ScVal,
and submit `update_header(update)`. A `post_root` helper drives the admin-gated,
NON-trustless fallback (`--post-root`).

The relayer is fork-aware by construction: it passes the beacon-provided
`finality_branch` through verbatim (length 6 for Capella/Deneb, 7 for
Electra/Fulu), and the contract takes the proof depth from the branch length.

### 2. Inclusion feed — `relay-in <commitment>`
`inclusion.ts`. Derive `slot = keccak256(abi.encode(commitment, uint256(0)))`
(the `locks` mapping at declaration slot 0), call
`eth_getProof(bridgeL1, [slot], block)` on a Sepolia execution RPC, package
`accountProof` + `storageProof[0].proof` as `Bytes[]` (each entry is one
already-RLP-encoded MPT trie node, validated then passed through), and submit
`bridge_in(block, commitment, token, amount, accountProof, storageProof)`
(`BRIDGE_SPEC` §7 argument order). The block defaults to the light client's
current trusted head (so the proof is against a root the contract trusts).

### 3. Out feed — `watch` (governor)
`l1.ts`. Watch the Soroban `ObscuraBridge` `bridge_out` authorization event and
call `ObscuraBridgeL1.unlock(commitment, to)` with the governor key (viem wallet).

> The exact `bridge_out` event schema is finalized in the bridge-contract branch.
> `parseBridgeOutEvent` is written defensively against the documented shape
> (a 32-byte `commitment` + a 20-byte `l1_recipient`) and is easy to retarget.

### `seed-committee` (deploy-time helper)
Fetch a sync-committee `bootstrap` at the finalized checkpoint and decompress its
512 G1 pubkeys to the uncompressed 96-byte form used to seed the
`EthLightClient` constructor (`committee: Vec<BytesN<96>>`). Constructor seeding
happens at deploy time via `stellar contract deploy`.

## Configuration (environment — never hardcode secrets)

| Var | Purpose |
|---|---|
| `SEPOLIA_EXEC_RPC` | Sepolia execution JSON-RPC (`eth_getProof`, events) |
| `SEPOLIA_BEACON_API` | Sepolia beacon API (`light_client/finality_update`, `bootstrap`) |
| `STELLAR_RPC` | Soroban RPC (submit + simulate) |
| `STELLAR_NETWORK_PASSPHRASE` | Soroban network passphrase (default: Testnet) |
| `LIGHT_CLIENT_CONTRACT` | `EthLightClient` contract id (`C…`) |
| `OBSCURA_BRIDGE_CONTRACT` | `ObscuraBridge` contract id (`C…`) |
| `BRIDGE_L1_ADDRESS` | `ObscuraBridgeL1` address (`0x…`) |
| `STELLAR_SIGNER_SECRET` | Soroban tx signer seed (`S…`) — header / bridge_in |
| `LIGHT_CLIENT_ADMIN_SECRET` | admin seed (`S…`) for the `post_root` fallback |
| `GOVERNOR_PRIVATE_KEY` | L1 governor key (`0x…`) — `unlock` settlement |

Without `--submit` (and without the relevant signer secrets), every command is a
**safe dry run**: it fetches/derives and prints the operation it *would* submit
(as base64 XDR), touching no signing key.

## Running

```bash
source ./env.sh                 # node 20 / pnpm 10
pnpm --filter @obscura/relayer build

# dry-run: fetch a finality update and print the update_header op it would submit
SEPOLIA_BEACON_API=https://ethereum-sepolia-beacon-api.publicnode.com \
  node bridge/relayer/dist/index.js relay-header

# live header submit (needs a deployed light client + funded Stellar signer)
SEPOLIA_BEACON_API=… STELLAR_RPC=… LIGHT_CLIENT_CONTRACT=C… STELLAR_SIGNER_SECRET=S… \
  node bridge/relayer/dist/index.js relay-header --submit

# inclusion: package a proof for a commitment (dry-run if no bridge contract / signer)
SEPOLIA_EXEC_RPC=… BRIDGE_L1_ADDRESS=0x… \
  node bridge/relayer/dist/index.js relay-in 0x<commitment> --block <n>

# orchestrator: header loop + watch Locked -> bridge_in + watch bridge_out -> unlock
node bridge/relayer/dist/index.js watch --interval-ms 60000
```

All network calls are bounded by a hard timeout (`AbortController`); no command
hangs silently.

## Tests — what's unit-tested vs integration-only

`pnpm --filter @obscura/relayer test` (vitest, **network-free**, 46 tests):

- **BLS decompression** (`bls.test.ts`): G1 generator → the contract's exact
  `G1_GENERATOR` bytes; G2 generator → 192-byte uncompressed; `compress(decompress(x)) == x`
  round-trips; 512-pubkey committee; length-error cases.
- **Storage-slot derivation** (`inclusion.test.ts`): `keccak256(abi.encode(commitment, 0))`
  matches the L1 README §3 worked example, and the example commitment is
  `keccak256("obscura-note-1")`.
- **Lock-word decode**: token = low 20 bytes, amount = high 12 bytes, for both the
  ERC20 and native-ETH worked examples.
- **RLP proof packaging**: valid trie nodes pass through; non-list RLP is rejected;
  `packageProof` extracts account + first storage proof.
- **ScVal encoding** (`scval.test.ts`): the Soroban symbol comparator; struct maps
  emitted with keys in ascending host order; `LightClientUpdate` round-trips
  through `scValToNative` (bits 64B, signature 192B, 17-field exec header).
- **Op building** (`lightclient.test.ts`): `update_header` (1 struct arg),
  `post_root` (3 args), `bridge_in` (6 args, correct ScVal types, §7 order).
- **Beacon assembly** (`beacon.test.ts`): `assembleLightClientUpdate` maps a raw
  finality update (decompressing a real compressed G2), LE `base_fee`, branch
  lengths, length validation. **RPC responses are not mocked because assembly is
  pure** — it takes the parsed JSON object directly; the fetch wrappers are the
  only networked code.
- **Out feed** (`l1.test.ts`): L1 ABI shape, `Locked` log decode, defensive
  `bridge_out` event parsing (map / tuple / hex forms + error cases).

**Integration-only** (not exercised by the unit suite; requires a reachable RPC
and/or deployed contracts + funded keys, run at deploy time):

- `fetchFinalityUpdate` / `fetchBootstrap` / `fetchFinalizedRoot` (beacon HTTP).
- `fetchInclusionProof` / `readLock` (`eth_getProof`, `eth_call`).
- `submitUpdateHeader` / `submitPostRoot` / `submitBridgeIn` / `readHead`
  (Soroban build → prepare → sign → send / simulate).
- `unlockOnL1`, `watchLocked`, `watchBridgeOut` (live event watching + L1 write).

These are structured so addresses/keys are injected (constructor options / env),
keeping the live path out of the unit tests. A read-only end-to-end check of the
header pipeline against a public Sepolia beacon API has been run manually and
assembles a real update (signature decompressed to 192 bytes, all branches and
fields parsed); it is intentionally not part of `pnpm test` (no network in CI).
