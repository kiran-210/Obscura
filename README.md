# Obscura

**Private money on Stellar.** Deposit XLM or USDC into a shielded pool, hold balances nobody can
see, pay someone without revealing the amount, trade on a dark pool, and borrow against private
collateral — every exit from the shielded layer gated by a zero-knowledge proof verified inside a
Soroban smart contract.

Nothing here is trusted. Withdraw, transfer, order placement, matching, and every lending action
each require a real Noir/UltraHonk proof that the contract checks on-chain. Without a valid proof,
no funds move.

Supported assets: **XLM** and **USDC**. Network: **Stellar Testnet**.

---
## demo video: [youtube](https://youtu.be/V784qyovn18)
## live demo: [vercel](https://obscura-frontend-eight.vercel.app/)
## feedback form: [click here](https://docs.google.com/forms/d/e/1FAIpQLSdAN9N9lLViBQpSj_Su7jhe32nQDi7kn8PdqYI_jnYqXfXXpQ/viewform?usp=publish-editor)
## Feedback Response: [google sheet](https://docs.google.com/spreadsheets/d/1ZJTks1jdDFqe7BxHqkU9mMksBGCsnJjBxanI8mWsVzE/edit?usp=sharing)
## The app

![Landing page](./screenshot/landing_page.png)

| Swap — the sealed book | Receive — your cipher |
|---|---|
| ![Swap](./screenshot/sealed_book.png) | ![Receive](./screenshot/received-address.png) |

![Lend](./screenshot/lending_page.png)

---

## Contracts
### Core

| Contract | ID | Stellar Lab |
|---|---|---|
| **ObscuraPool** | `CA6KV2PFQ3IRTJNFCWRDRBJLNI2VB47AOGH57HMUDSLLSIC2RX5WMQJE` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CA6KV2PFQ3IRTJNFCWRDRBJLNI2VB47AOGH57HMUDSLLSIC2RX5WMQJE) |

### Proof verifiers

One `rs-soroban-ultrahonk` instance per circuit, each bound to that circuit's verifying key.

| Circuit | ID | Stellar Lab |
|---|---|---|
| withdraw | `CCRXL7SSUAYGNYED7IAW7O2FOBDCJN7AZFFPDYYRVJ2XGZET6M54MLY4` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CCRXL7SSUAYGNYED7IAW7O2FOBDCJN7AZFFPDYYRVJ2XGZET6M54MLY4;;) |
| transfer | `CDG5AYT5QBOQZ64YOCHGG4R4DSB6VO7MZATFLWZ4W3JHWON53OR7ZJUN` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CDG5AYT5QBOQZ64YOCHGG4R4DSB6VO7MZATFLWZ4W3JHWON53OR7ZJUN;;) |
| place_order | `CCIZ2TF7ZMGNGUBPGT3R2FXRFPWOC74MUFBOWEMMPPMZPT7RP3GSP7J7` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CCIZ2TF7ZMGNGUBPGT3R2FXRFPWOC74MUFBOWEMMPPMZPT7RP3GSP7J7;;) |
| match_orders | `CCANRVJHIZELERHN5VT4PEQPJJGMOCM433AK4YDDOKPZHTSAOJSJ5YRF` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CCANRVJHIZELERHN5VT4PEQPJJGMOCM433AK4YDDOKPZHTSAOJSJ5YRF;;) |
| cancel_order | `CCT2QC2MQJWQNYCZLDDVRUYG4EXUE7VZPEIZ2ELY5YURJJG6POLFS7AJ` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CCT2QC2MQJWQNYCZLDDVRUYG4EXUE7VZPEIZ2ELY5YURJJG6POLFS7AJ;;) |

### Lending verifiers

Registered on the pool via `set_lending_verifiers`.

| Circuit | ID | Stellar Lab |
|---|---|---|
| position_open | `CBKEPMXWPZRB5CWMZW5S732BXEL3ZV56NPKHS7S4ABFJHIFFHM2SFSO2` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CBKEPMXWPZRB5CWMZW5S732BXEL3ZV56NPKHS7S4ABFJHIFFHM2SFSO2;;) |
| borrow | `CCOZBAFGCZVPSP4YDS7RGFCBLHHDYEFGUTML3L6VP4G3ESTCB6VAPF3F` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CCOZBAFGCZVPSP4YDS7RGFCBLHHDYEFGUTML3L6VP4G3ESTCB6VAPF3F;;) |
| repay | `CBYAT3O5IVE32HQCWXKI6ORGOHGVP44SK4KSJ75TSCD7TNMAYNCT4KC7` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CBYAT3O5IVE32HQCWXKI6ORGOHGVP44SK4KSJ75TSCD7TNMAYNCT4KC7;;) |
| withdraw_collateral | `CCNOT52H3T6HWDNXBAOFAGVZZTVCZWAOOFP6PJ3IBZXWLULQAVO4CO6Z` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CCNOT52H3T6HWDNXBAOFAGVZZTVCZWAOOFP6PJ3IBZXWLULQAVO4CO6Z;;) |
| solvency_attestation | `CB35YP66Y6YND3YHK7OCTZHN6EDQU2OHKG3H2CISSTQARGCAX3KQLVKY` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CB35YP66Y6YND3YHK7OCTZHN6EDQU2OHKG3H2CISSTQARGCAX3KQLVKY;;) |
| supply | `CCK5SHU7SLMMV2JOLMFDATOH7YPAPFQX2SK2Z7VECE5U7FGKMJUQK4CU` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CCK5SHU7SLMMV2JOLMFDATOH7YPAPFQX2SK2Z7VECE5U7FGKMJUQK4CU;;) |
| redeem | `CAWWAHUAEFB4KOH56IFWF4D75YNIZICR2SW4VXZTBTRC5Y4RTFZNDT7N` | [open](https://lab.stellar.org/smart-contracts/contract-explorer?$=network$id=testnet&label=Testnet&horizonUrl=https:////horizon-testnet.stellar.org&rpcUrl=https:////soroban-testnet.stellar.org&passphrase=Test%20SDF%20Network%20/;%20September%202015;&smartContracts$explorer$contractId=CAWWAHUAEFB4KOH56IFWF4D75YNIZICR2SW4VXZTBTRC5Y4RTFZNDT7N;;) |

Machine-readable copy: [`deployments.json`](./deployments.json).

---

## Wallets

Connect with any Stellar wallet — Freighter, xBull, Albedo, Rabet, Lobstr — via
[Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit).

![Wallet picker](./screenshot/different_wallet.png)

Once connected, your shielded total is derived locally from notes only you can decrypt:

![Shielded balance](./screenshot/wallet_balance.png)

Every action is a normal Stellar transaction you can inspect in any explorer:

![Transaction in explorer](./screenshot/explorer_tx.png)

---

## Responsive

The whole app works on mobile.

<img src="./screenshot/phone_responsive.png" alt="Mobile layout" width="320" />

---

## Tech stack

| Layer | What |
|---|---|
| Circuits | Noir `1.0.0-beta.9`, Barretenberg `0.87.0` (UltraHonk, keccak transcript) |
| Contracts | Rust + Soroban SDK `26.1.0`, target `wasm32v1-none` |
| Verifier | [`rs-soroban-ultrahonk`](https://github.com/yugocabrio/rs-soroban-ultrahonk) — on-chain UltraHonk over BN254 |
| Crypto | Poseidon2 hashing, 32-level Merkle tree, ChaCha20-Poly1305 note encryption |
| SDK | TypeScript, `@noble/*`, `@stellar/stellar-sdk`, built with tsup |
| Frontend | React 18, Vite 5, Tailwind, React Router, TanStack Query, three.js |
| Wallets | Stellar Wallets Kit (Freighter / xBull / Albedo / Rabet / Lobstr) |
| Tooling | pnpm workspaces, Rust stable, Stellar CLI |

---

## Architecture

```mermaid
flowchart TD
    U[Browser] -->|deposit XLM / USDC| P[ObscuraPool]
    U -->|prove in-browser| BB[Barretenberg WASM]
    BB -->|proof + public inputs| P
    P -->|verify_proof| V[UltraHonk verifiers<br/>12 instances, one per circuit]
    P -->|events| IDX[Client indexer]
    IDX -->|encrypted notes| U
    M[Matcher service] -->|match_orders| P
```

**How a private payment works.** Your balance is a set of *notes* — commitments in an on-chain
Merkle tree. Only you hold the secrets that open them. To spend, the browser builds a Noir proof
that you know a valid note, that its nullifier is fresh, and that value is conserved. The contract
checks the proof, records the nullifier so it can't be replayed, and inserts the new output
commitments. Amounts and parties never appear on-chain; the encrypted note payload rides along in
the event so the recipient can find it.

```
circuits/noir/   12 Noir circuits (5 core + 7 lending) + shared libs
contracts/       Soroban contracts — obscura-pool, faucet-token, bridge-mpt, obscura-bridge
sdk/             TypeScript client — notes, Poseidon2, Merkle, proofs, tx building
frontend/        React app — Portfolio / Deposit / Pay / Swap / Lend / Receive
matcher/         Off-chain dark-pool order matching
screenshot/      Images used in this README
```

---

## Quick start

```bash
pnpm install                            # workspace deps
pnpm --filter @obscura/sdk build        # frontend imports the SDK from dist/
pnpm --filter frontend dev              # http://localhost:5173
```

Need test USDC? Mint it in the app at `/faucet`.

Contracts:

```bash
cd contracts
cargo test                                      # 22 tests
cargo build --target wasm32v1-none --release    # wasm artifacts
```

## License

MIT
