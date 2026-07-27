# Obscura Bridge — live on testnet (full L1→L2 loop verified)

The Obscura cross-chain bridge is deployed and the **complete trustless loop is verified live** —
Ethereum Sepolia → Stellar — with **no trusted relayer**. Provenance is established by an Ethereum
sync-committee BLS signature verified natively on Soroban; inclusion by an in-contract Merkle-Patricia
storage proof; privacy by the shielded pool.

Network: `testnet` · passphrase `Test SDF Network ; September 2015`
Deployer / admin: `GAGEXK4SPRFYJMR3HXYXMCDBEWBFO4BHJP4XWO3L43HJU366UWPY4MKX` (`obscura-deployer`)

## Full L1→L2 loop — verified live ✅

| Step | Where | Evidence |
|------|-------|----------|
| **1. Lock** 0.001 ETH against a Obscura commitment | Sepolia `ObscuraBridgeL1` [`0xcF40c553…`](https://sepolia.etherscan.io/address/0xcF40c553Cb47A0E3448FF468C8A7ee41769205be) | block 11173795, tx [`0xcf24c4d7…`](https://sepolia.etherscan.io/tx/0xcf24c4d7a905ee39d2f1cbf907b3c179da8e3b11e6b329e455a65ea48f6ce802) |
| **2. Verify ETH header** (sync-committee BLS) → trusted exec `state_root` | Stellar `EthLightClient` `CCI47AHP…` | `update_header` tx `df258a68…`, head → block 11173818 |
| **3. Prove inclusion** (in-contract MPT vs `state_root`) + **mint** shielded note | Stellar `ObscuraBridge` `CB6MKCFR…` → pool `CBCFCJQ5…` | `bridge_in` tx [`4b3760d1…`](https://stellar.expert/explorer/testnet/tx/4b3760d1f31b50da6a54bec54fe5f5645fe1719429f5acc05544c3a431289ffc) **SUCCESS** |

The `bridge_in` call fetched `eth_getProof` for the lock at the light client's head block (9 account
nodes + 1 storage node), the contract Keccak-verified the Merkle-Patricia path against the trusted
`state_root`, decoded the locked `(token=ETH, amount=0.001)`, set the replay guard
(`is_bridged`=true), and minted the commitment into the shielded pool (root advanced to
`2acd0da6…`). Every value the relayer carried was re-verified on-chain.

> **Why Stellar:** verifying the sync-committee BLS signature costs ~80M gas on the EVM (why everyone
> SNARK-wraps it); on Soroban it is ~30M of the 100M instruction budget via native BLS12-381 host
> functions — so the light client runs **directly on-chain, no SNARK needed**.

---

## Headline evidence — a real ETH state root verified onto Stellar via sync-committee BLS

A real Sepolia finality update (period **1292**, fork **fulu**, ~100% participation) was fed to the
deployed `EthLightClient.update_header`. The contract ran the full Ethereum light-client check
on-chain — strict `> 2/3` participation, BLS `FastAggregateVerify` 2-pairing check against the
seeded committee, and the SSZ `finality_branch` / `execution_branch` Merkle proofs — and stored the
proven execution `state_root`.

| What | Value |
|------|-------|
| `update_header` tx | [`2f1549ee8bbcdf5d803d11a99886b2d160fd53c094fb6029a65929a2ee56749c`](https://stellar.expert/explorer/testnet/tx/2f1549ee8bbcdf5d803d11a99886b2d160fd53c094fb6029a65929a2ee56749c) — **SUCCESS**, ledger `3364177` |
| signature slot | `10591824` (period `10591824 / 8192 = 1292`) |
| finalized exec block | `11173658` |
| proven exec `state_root` | `5e294caed189617cdb5473fc1b9f733f56f0db775b36a585d173b3833cd2ba76` |
| `head()` after submit | `[11173658, 5e294caed189617cdb5473fc1b9f733f56f0db775b36a585d173b3833cd2ba76]` |
| `state_root_at(11173658)` | `5e294caed189617cdb5473fc1b9f733f56f0db775b36a585d173b3833cd2ba76` |

**Independent cross-check (irrefutable):** Sepolia execution block `11173658`, queried from a
public execution RPC (`ethereum-sepolia-rpc.publicnode.com`, `eth_getBlockByNumber`), has
`stateRoot = 0x5e294caed189617cdb5473fc1b9f733f56f0db775b36a585d173b3833cd2ba76` — **byte-identical**
to what the light client verified and stored on Stellar. The Stellar contract did not trust the
relayer for this value; it re-derived trust from the Ethereum sync committee's BLS signature.

---

## Contracts (testnet)

| Contract | ID | Deploy tx |
|----------|----|-----------|
| **EthLightClient** (seeded, period 1292) | [`CCI47AHPL6RETKEDIUGD3XWSBPOHY3IJAZVKBODCBAKZ6UAP27AQ6WH5`](https://stellar.expert/explorer/testnet/contract/CCI47AHPL6RETKEDIUGD3XWSBPOHY3IJAZVKBODCBAKZ6UAP27AQ6WH5) | [`2c13b71b…`](https://stellar.expert/explorer/testnet/tx/2c13b71bd5cc088eaa25767e1bac83be48c86d95b02946932251540bd1b3d581) |
| **ObscuraBridge** | [`CAY44CMEIJKB2TBVVPFZMEAIDQIROJPB5RIQX5TFQIYCG46WTSWDUXV6`](https://stellar.expert/explorer/testnet/contract/CAY44CMEIJKB2TBVVPFZMEAIDQIROJPB5RIQX5TFQIYCG46WTSWDUXV6) | [`5ee66771…`](https://stellar.expert/explorer/testnet/tx/5ee66771c7dbb817b112fd4be64e8486f9d67e1c2f4706da2dc9ffa3544ef8f7) |
| **ObscuraPool** (bridge-enabled, has `bridge_mint`) | [`CCVYCO7X7Z3NAJ3U3AAC27Y3VOKJ4YKEKQIP6SJ5UQFH7VMXUMVVYIBX`](https://stellar.expert/explorer/testnet/contract/CCVYCO7X7Z3NAJ3U3AAC27Y3VOKJ4YKEKQIP6SJ5UQFH7VMXUMVVYIBX) | [`2ef74375…`](https://stellar.expert/explorer/testnet/tx/2ef74375746975ff2a3acc43889d2b4cf714dd09d47cd23ae67b7847fade9bdf) |

`EthLightClient` wasm upload tx: [`bfb57cfb…`](https://stellar.expert/explorer/testnet/tx/bfb57cfbe01b8c63e0c2cc93d6922c0b0f94781bf016ae223e31e56ee9ec4e22) (wasm hash `5bb07f5d9df9c19941bf9765894169917625b3b4236c3aa97da9d69072786cb3`).

### Reused from the prior deployment (`deployments.json`)

| Role | ID |
|------|----|
| Verifier · withdraw (reused by `bridge_out` + pool) | `CBKB3P72CTZAGODIKMQRLUJ2INHQULK5J66N6QQR7GCHGDUFCTUPJ6M3` |
| Verifier · transfer | `CBXOZGAWSLJEXVMHY6WMBDLAJWDESUPOJV2TEAK6F77IYD7EVRDINS6I` |
| Verifier · place_order | `CDOEXIJR3OE7527IBTBGYX62TNWBIOHMR7IBMWBMBBR6QA4TIXZSBXEE` |
| Verifier · match_orders | `CB5HNMW6IIMLQPSAKAC3ADTDHEOTKX6EHYCXNK5EITTFMO33BMD2EKM4` |
| Verifier · cancel_order | `CAI6B5ZTWOGJIBLNMOG67H3MAPSORU64ZEXBB7YYQ6TQ5RQJMSQQSA3B` |
| Native XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |

### Wiring (verified on-chain)

```
pool.bridge()          = CAY44CME… (ObscuraBridge)      ← set_bridge tx df44eec6…
bridge.light_client()  = CCI47AHP… (EthLightClient)
bridge.pool()          = CCVYCO7X… (ObscuraPool)
bridge.l1_chain_id()   = 11155111  (Sepolia)
bridge.l1_bridge_addr()= 0x0000000000000000000000000000000000000000  (placeholder — L1 pending)
bridge.withdraw_vf()   = CBKB3P72… (UltraHonk withdraw verifier)
```

---

## Light-client seed (period 1292)

The light client was seeded **at construction** with the real current Sepolia sync committee.

| Field | Value |
|-------|-------|
| `genesis_validators_root` | `d8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078` |
| `fork_version` (current, fulu) | `90000075` |
| committee | 512 × 96-byte **uncompressed** G1 pubkeys (the relayer decompresses Ethereum's 48-byte wire form off-chain) |
| bootstrap anchor root | `0x1912e0c2d057011eb9d988c95d4d7820565eac84c8495f726378567542c630b8` |
| bootstrap anchor slot | `10591744` (period 1292) |

`genesis_validators_root` and the current `fork_version` were fetched live from the beacon API
(`/eth/v1/beacon/genesis`, `/eth/v1/beacon/states/head/fork`) and match the period-1292 update.

### Did the 49 KB committee need a contract change to deploy? — **No.**

The brief flagged that the constructor seeds all `512 × 96 = 49,152` bytes of committee pubkeys in
one transaction, which "may exceed live testnet tx-size or instance-storage limits." It did **not**.
The full `__constructor(committee: Vec<BytesN<96>>, genesis_root, fork_version, admin)` deployed and
simulated successfully on the first attempt — the committee is stored in **persistent** storage
(< the 64 KB single-entry cap) and the all-512 BLS aggregate is folded in-contract during the
constructor, all within the per-transaction CPU / read / write limits. **No batched
`seed_committee` / `finalize_seed` entrypoint was required; the contract is unmodified.** The
committee was passed via `--committee-file-path` (a JSON array of 512 hex strings) to avoid any CLI
arg-length concern.

---

## What's live vs pending (honest status)

**Live on testnet:**
- `EthLightClient` deployed and seeded with the real period-1292 Sepolia sync committee.
- A **real** Sepolia sync-committee BLS signature **verified on-chain** by `update_header`; the real
  Sepolia execution `state_root` for block `11173658` is now the contract's trusted head (evidence
  above, cross-checked against an independent Sepolia execution RPC).
- `ObscuraBridge` and the bridge-enabled `ObscuraPool` (`bridge_mint`) deployed and **wired**
  (`set_bridge` done; constructor links verified on-chain).

**Pending — the Ethereum (L1) lock side:**
- The `ObscuraBridgeL1` escrow (`bridge/l1/src/ObscuraBridgeL1.sol`) is **not** deployed to Sepolia: it
  needs a **funded Sepolia key** (out of scope here, not attempted). Until it is deployed, the bridge
  is configured with a placeholder `l1_bridge_addr = 0x00…00`.
- The full inbound loop (`relayer relay-in` → `ObscuraBridge.bridge_in` → `pool.bridge_mint`) and the
  outbound loop (`bridge_out` → L1 `unlock`) therefore can't be exercised end-to-end yet: there is no
  L1 contract to produce a real `eth_getProof` inclusion proof against. The Stellar side is ready —
  `bridge_in` would prove an L1 `locks[commitment]` against exactly the trusted state root the light
  client already holds (block `11173658`).

**Exact remaining step for the full L1→L2 loop:**
1. Fund a Sepolia key and deploy `ObscuraBridgeL1` (`bridge/l1`, Foundry).
2. Point the bridge at it. NOTE: `ObscuraBridge` stores `l1_bridge_addr` **only in its constructor**
   (no setter), so this means **redeploying `ObscuraBridge`** with the real L1 address (and re-running
   `set_bridge` on the pool with the new bridge id), or adding an admin setter for `l1_bridge_addr`.
3. Lock funds on L1, then run `relayer relay-in <commitment> --submit` to mint the shielded note on
   Stellar against the light-client-proven state root.

---

## Reproduce

```bash
source ./env.sh
export SEPOLIA_BEACON_API="https://ethereum-sepolia-beacon-api.publicnode.com"
export STELLAR_RPC="https://soroban-testnet.stellar.org"

# 0. build (rust 1.92.0)
( cd contracts/eth-light-client && RUSTUP_TOOLCHAIN=1.92.0 stellar contract build )
( cd contracts                  && RUSTUP_TOOLCHAIN=1.92.0 stellar contract build )
( cd bridge/relayer && pnpm install && pnpm build )

# 1. fetch the current Sepolia committee + seed metadata
node bridge/deploy/fetch-committee.mjs        # writes bridge/deploy/committee.json + seed-meta.json

# 2. deploy + seed the light client (full 512-pubkey constructor)
stellar contract upload --wasm contracts/eth-light-client/target/wasm32v1-none/release/eth_light_client.wasm \
  --source obscura-deployer --network testnet
ADMIN=$(stellar keys address obscura-deployer)
stellar contract deploy --wasm-hash <hash> --source obscura-deployer --network testnet -- \
  --committee-file-path bridge/deploy/committee.json \
  --genesis_root d8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078 \
  --fork_version 90000075 --admin "$ADMIN"

# 3. THE SHOWPIECE — verify a real Sepolia finality update on-chain
export LIGHT_CLIENT_CONTRACT=<light-client-id>
export STELLAR_SIGNER_SECRET=$(stellar keys show obscura-deployer)
node bridge/relayer/dist/index.js relay-header --submit
stellar contract invoke --id $LIGHT_CLIENT_CONTRACT --source obscura-deployer --network testnet -- head

# 4-5. deploy bridge + bridge-enabled pool, wire them
#   (pool constructor: 5 verifier ids + native SAC from deployments.json;
#    bridge constructor: light_client, pool, l1_chain_id=11155111, l1_bridge_addr=0x00..00, withdraw_vf;
#    then pool.set_bridge(admin, bridge))
```

> Note: the committee is reproducible public data; `bridge/deploy/committee.json` (~99 KB) is
> git-ignored. Re-generate it with `node bridge/deploy/fetch-committee.mjs`. A live re-run fetches
> the *current* finality update, so the slot/block/state-root will be newer than the values above —
> those are the exact ones recorded by tx `2f1549ee…`.
