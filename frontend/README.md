# Obscura — Frontend

The React app for **Obscura**, a privacy platform on Stellar. Four modules —
**Bridge**, **Portfolio**, **Pay**, and **Swap** — over a shared shielded layer.

> **This app is wired to the LIVE ObscuraPool on Stellar Testnet.** By default
> `createObscuraSdk()` returns the real `RealObscuraSdk` (in `src/lib/real-sdk.ts`),
> backed by `@obscura/sdk` (Poseidon2 commitments, notes, Merkle tree, Soroban op
> building), `@stellar/stellar-sdk` (RPC submit) and the **Stellar Wallets Kit**
> (multi-wallet address + signing). Set `VITE_USE_MOCK=true` to fall back to the
> offline `MockObscuraSdk` for UI dev with no wallet / network.

> **Multi-wallet connect.** Wallet connection and signing go through
> [`@creit.tech/stellar-wallets-kit`](https://github.com/Creit-Tech/Stellar-Wallets-Kit)
> (pinned `1.9.5`) via a single shared instance in `src/lib/wallet-kit.ts`. The
> Connect button opens the kit's wallet-select modal, so users can pick **Freighter,
> xBull, Albedo, Rabet, Lobstr, Hana, HOT Wallet or Klever** — no Freighter lock-in.
> The choice is persisted to `localStorage` for smooth reconnection. (Ledger, Trezor
> and WalletConnect need extra module config — WalletConnect additionally a
> `projectId` — and are not enabled by default.)

> **Cross-chain Bridge (Ethereum Sepolia ↔ Stellar).** The Bridge tab is a real
> trust-minimized bridge (BRIDGE_SPEC §9). It connects **two** wallets: an EVM wallet
> (MetaMask via **wagmi/viem**, `src/lib/wagmi.ts` + `useEvmWallet`) for Sepolia, and the
> Stellar Wallets Kit for Stellar. **Bridge in** locks ETH/test-USDC on Sepolia and mints a
> shielded note on Stellar (proven by the on-chain Ethereum light client); **bridge out**
> burns a bridged note and releases the L1 escrow. See [Bridge tab](#bridge-tab-cross-chain).

## Status: live vs experimental vs mock

| Flow | Status | What actually happens |
|------|--------|-----------------------|
| **Bridge in** (Bridge) | **LIVE-capable / mock** | Creates a Obscura note with a *bridged* `asset_id` (BRIDGE_SPEC §3), writes `ObscuraBridgeL1.lock(commitment, token, amount)` on Sepolia via wagmi/viem (MetaMask — native ETH `value=amount`, ERC20 `approve`+`lock`), then drives a cross-chain progress tracker: **L1 locked → header finalized (light client) → inclusion proven (relayer) → minted on Stellar**, polling the `EthLightClient` head and `ObscuraBridge.is_bridged`. On mint the shielded balance appears in Portfolio. Goes live by filling `VITE_L1_BRIDGE_ADDRESS` / `VITE_ETH_LIGHT_CLIENT` / `VITE_OBSCURA_BRIDGE` + a funded Sepolia wallet + a running relayer. `VITE_USE_MOCK_BRIDGE=true` runs a fake walkthrough with no wallets. |
| **Bridge out** (Bridge) | **MOCK (UX) / live not wired** | Select a bridged note + an Ethereum recipient → animated **prove → bridge_out (burn) → unlock authorized → released on Sepolia** pipeline (mock). The *live* path (real in-browser withdraw proof + `ObscuraBridge.bridge_out` + `ObscuraBridgeL1.unlock`) needs the deployed bridge contract and the withdraw prover (`VITE_ENABLE_WITHDRAW`); it surfaces a clear "not wired" error outside mock. |
| **Light-client chip** | **LIVE-capable** | Reads the `EthLightClient` trusted Ethereum head block over Soroban RPC ("verified via Ethereum sync committee on Stellar"). Shows a clearly-labelled **simulated** head until `VITE_ETH_LIGHT_CLIENT` is set. |
| **Portfolio** | **LIVE** | Real per-asset balances derived from your locally-stored unspent notes (now incl. bridged `bETH`/`bUSDC`). Starts empty; populates after a confirmed deposit or bridge-in. |
| **Open orders** | **LIVE (empty)** | Read from local storage; empty until order placement ships. |
| **Withdraw** (legacy, native) | **EXPERIMENTAL** | Off by default. With `VITE_ENABLE_WITHDRAW=true`, generates a **real** in-browser UltraHonk proof (Noir + Barretenberg WASM, keccak transcript) against the compiled `withdraw` circuit and submits `withdraw(...)`. The same prover backs the live bridge-out. Heavy and not guaranteed to land in every browser — see caveats below. |
| **Pay** (transfer) | **MOCK / coming soon** | The live client returns a clear "coming soon" error; use `VITE_USE_MOCK=true` to demo the UI. |
| **Swap** (place / cancel order) | **MOCK / coming soon** | Same as Pay. |

### How a deposit works end-to-end

1. `RealObscuraSdk.deposit({ asset: 'XLM', amount })` parses the amount to stroops
   (7 dp) and draws/loads the wallet's single `spending_key`.
2. `createNote({ assetId: 0, amount, spendingKey })` →
   `commitment = hash4(asset_id, amount, owner_key, blinding)` (SHARED §4).
3. `ObscuraContract.depositOp` builds the Soroban invoke; `prepareTransaction`
   simulates it (footprint + the source-account auth that covers the SAC transfer).
4. The connected wallet signs the prepared XDR (via the Stellar Wallets Kit); the tx
   is submitted via `rpc.Server` and polled to `SUCCESS`. The pool returns the new
   **leaf index**, which is stored with the note.
5. The note (secret material + leaf index) is saved to `localStorage` so Portfolio
   shows it and the experimental withdraw can rebuild its Merkle witness.

### Experimental withdraw caveats

- Enabled only with `VITE_ENABLE_WITHDRAW=true`. It loads `@noir-lang/noir_js` +
  `@aztec/bb.js` (WASM, may fetch a CRS) lazily — these are excluded from the default
  bundle (`vite.config.ts`), so they are runtime-resolved only on this path.
- The compiled circuit must be present at `public/circuits/withdraw.json`
  (regenerate with `nargo compile` in `circuits/noir/withdraw`).
- The local note tree is reconstructed from your stored notes and must equal the pool's
  current root (no foreign deposits interleaved) — otherwise the client refuses to
  prove rather than submit a stale proof. **Success is never faked.**

## Bridge tab (cross-chain)

The Bridge tab is a real **Ethereum Sepolia ↔ Stellar** bridge (full design in
`BRIDGE_SPEC.md`). It is trust-minimized: provenance comes from an Ethereum light client
running natively on Soroban (BLS sync-committee + Keccak/MPT), not a trusted relayer.

**Two wallets.** The tab connects both an EVM wallet (MetaMask via wagmi/viem on Sepolia)
and the existing Stellar Wallets Kit. The EVM stack lives entirely in `src/lib/wagmi.ts`,
`src/lib/bridge.ts` and `src/hooks/useEvmWallet.ts` — none of the other tabs touch it.

### Bridge in (Sepolia → Stellar)

1. Pick a token (ETH or test-USDC) + amount. The app creates a Obscura note with a
   **bridged `asset_id`** (`asset_id = hash2(hash2(chainId, tokenAddr), BRIDGE_DOMAIN)`,
   BRIDGE_SPEC §3) — so the minted note interoperates with the pool's transfer/swap but
   redeems only back to Ethereum.
2. **Lock on Sepolia** — `ObscuraBridgeL1.lock(commitment, token, amount)` via MetaMask
   (native ETH locks `value=amount`; an ERC20 does `approve` then `lock`).
3. A **cross-chain progress tracker** drives: `L1 locked` → `header finalized (light
   client)` → `inclusion proven (relayer)` → `minted on Stellar`. It polls the
   `EthLightClient` head (does it cover the lock block?) and `ObscuraBridge.is_bridged`
   (has the relayer's `bridge_in` minted yet?), and optionally POSTs a nudge to
   `VITE_RELAYER_URL`. The relayer (untrusted transport) fetches `eth_getProof` and
   submits the MPT inclusion proof; every value is re-verified on-chain.
4. On mint the shielded balance (`bETH` / `bUSDC`) appears in **Portfolio**.

### Bridge out (Stellar → Sepolia)

Select a bridged note + an Ethereum recipient → **prove → bridge_out (burn) → unlock
authorized → released on Sepolia**. The live path reuses the in-browser withdraw prover
(`VITE_ENABLE_WITHDRAW`) + `ObscuraBridge.bridge_out` + `ObscuraBridgeL1.unlock`; it is
**mock-only today** (clear "not wired" error outside mock) until the bridge contracts are
deployed.

### Light-client chip

Reads the `EthLightClient` trusted Ethereum head over Soroban RPC and shows the head block
+ "verified via Ethereum sync committee on Stellar". Until `VITE_ETH_LIGHT_CLIENT` is set it
shows a clearly-labelled **simulated** head.

### Mock vs live (be honest)

- **Mock** (`VITE_USE_MOCK_BRIDGE=true`, or `VITE_USE_MOCK=true`): both flows run a fake,
  self-contained walkthrough with no wallets — for demos / UI dev. Balances update so the
  Portfolio reflects the bridge.
- **Live**: needs the deployed contracts (`VITE_L1_BRIDGE_ADDRESS`, `VITE_ETH_LIGHT_CLIENT`,
  `VITE_OBSCURA_BRIDGE`), a funded Sepolia wallet, a connected Stellar wallet, and a running
  relayer feeding headers + inclusion proofs. Bridge-in is fully wired against those;
  bridge-out's live ZK path is structured but not wired (needs the deployed bridge +
  prover). The light-client chip and mint detection go live as soon as the Soroban
  contracts are configured.

## Stack

- **Vite 5** + **React 18** + **TypeScript** (strict)
- **TailwindCSS 3** (dark "dark-pool / privacy" theme, single spectral accent)
- **react-router-dom 6** (hash routing: `/bridge`, `/portfolio`, `/pay`, `/swap`)
- **@creit.tech/stellar-wallets-kit** for multi-wallet connection + signing
  (Freighter, xBull, Albedo, Rabet, Lobstr, Hana, …) — the Stellar side
- **wagmi 2 + viem 2 + @tanstack/react-query 5** for the EVM (Sepolia / MetaMask)
  side of the cross-chain bridge

## Run

From the repo root (uses the pnpm workspace):

```bash
pnpm install
pnpm --filter frontend dev      # dev server on http://localhost:5173
pnpm --filter frontend build    # type-check + production build (zero type errors)
pnpm --filter frontend preview  # serve the production build
pnpm --filter frontend lint     # ESLint
```

`source ./env.sh` first if `pnpm` / `node` aren't on your PATH.

## What's here

| Area | File(s) | Notes |
|------|---------|-------|
| App shell / nav | `src/components/Layout.tsx`, `src/App.tsx` | Top bar (Obscura wordmark + Connect Wallet), tab nav, footer. |
| **Bridge** | `src/components/Bridge.tsx` | Cross-chain Bridge in / out, dual-wallet connections (MetaMask + Stellar), cross-chain progress tracker, light-client status chip. |
| Bridge client | `src/lib/bridge.ts`, `src/lib/wagmi.ts`, `src/hooks/useEvmWallet.ts` | Typed L1-lock (wagmi/viem) + Stellar reads (light-client head, mint detection) + relayer nudge; wagmi config (Sepolia + injected); EVM wallet hook. |
| **Portfolio** | `src/components/Portfolio.tsx` | Per-asset shielded balance cards, total estimate, loading + empty states. |
| **Pay** | `src/components/Pay.tsx` | Recipient key, asset, amount → private transfer via the proof overlay. |
| **Swap** | `src/components/Swap.tsx` | Pair selector, Buy/Sell toggle, price + amount, Place Order; Open Orders list with Cancel. |
| Wallet | `src/hooks/useWallet.ts`, `src/lib/wallet-kit.ts` | Multi-wallet connect via the Stellar Wallets Kit modal, active public key, Testnet indicator, persisted wallet choice, graceful "no wallet" handling. |
| Proof UX | `src/hooks/useProofFlow.ts`, `src/components/ProofProgress.tsx` | Reusable overlay cycling *Generating witness → Computing proof → Submitting transaction → Confirmed*. Wired into Pay and Swap. |
| **SDK seam** | `src/lib/obscura-sdk.ts` | `ObscuraSdk` interface, `MockObscuraSdk`, and `createObscuraSdk()` (live vs mock switch). **The only place protocol calls live.** |
| **Live client** | `src/lib/real-sdk.ts` | `RealObscuraSdk` — deposit/withdraw/portfolio against the deployed pool. |
| Deployment config | `src/lib/config.ts` | Pool id, native SAC, RPC URL, network passphrase (from `deployments.json`), with `VITE_*` overrides. |
| Local wallet | `src/lib/note-store.ts` | `localStorage` persistence for the spending key + shielded notes. |
| SDK context | `src/hooks/useObscura.tsx` | Provides the SDK client + cached balances/orders, shared across tabs. |
| UI kit | `src/components/ui.tsx` | Typed Button, Card, Field, Select, Badge, icons, etc. |

## Configuration (env)

All optional; defaults target the live testnet deployment in `deployments.json`.

| Var | Default | Purpose |
|-----|---------|---------|
| `VITE_USE_MOCK` | `false` | Use the offline `MockObscuraSdk` (no wallet/network). |
| `VITE_ENABLE_WITHDRAW` | `false` | Enable the experimental in-browser withdraw prover. |
| `VITE_SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint. |
| `VITE_OBSCURA_POOL` | `CA7G45QP…GXYSK` | ObscuraPool contract id. |
| `VITE_NATIVE_SAC` | `CDLZFC3S…GCYSC` | Native XLM SAC address. |
| `VITE_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Stellar network passphrase. |
| `VITE_USDC_SAC` | _(unset)_ | Optional USDC SAC, if a multi-asset pool is deployed. |

### Bridge (cross-chain) env

All optional; without them the Bridge tab still builds and runs (mock / simulated).

| Var | Default | Purpose |
|-----|---------|---------|
| `VITE_USE_MOCK_BRIDGE` | `false` (or `VITE_USE_MOCK`) | Run the Bridge tab as a self-contained mock walkthrough — no wallets, fake progress. |
| `VITE_L1_CHAIN_ID` | `11155111` | Ethereum chain id (Sepolia). |
| `VITE_SEPOLIA_RPC_URL` | `https://ethereum-sepolia-rpc.publicnode.com` | Sepolia execution RPC for viem reads. |
| `VITE_L1_BRIDGE_ADDRESS` | `0x000…000` (placeholder) | Deployed `ObscuraBridgeL1` escrow on Sepolia. **Required for live bridge-in.** |
| `VITE_ETH_LIGHT_CLIENT` | _(unset)_ | Soroban `EthLightClient` contract id (trusted head + finalization). |
| `VITE_OBSCURA_BRIDGE` | _(unset)_ | Soroban `ObscuraBridge` contract id (`bridge_in` mint detection / `bridge_out`). |
| `VITE_RELAYER_URL` | _(unset)_ | Optional relayer base URL; if set, bridge-in POSTs a nudge. The relayer also watches L1 `Locked` events on its own. |
| `VITE_BRIDGE_USDC_L1` | Circle Sepolia USDC | test-USDC ERC20 address to bridge. |
| `VITE_BRIDGE_DOMAIN` | `0x627269646765` ("bridge") | Bridge-asset `asset_id` domain separator (BRIDGE_SPEC §3). |

## The SDK seam

All protocol access is behind one interface in `src/lib/obscura-sdk.ts`:

```ts
export interface ObscuraSdk {
  deposit(params: DepositParams): Promise<TxResult>
  withdraw(params: WithdrawParams): Promise<TxResult>
  transfer(params: TransferParams): Promise<TxResult>
  placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult>
  cancelOrder(orderId: string): Promise<TxResult>
  getShieldedBalances(): Promise<ShieldedBalance[]>
  getOpenOrders(): Promise<OpenOrder[]>
}
```

`createObscuraSdk()` returns `RealObscuraSdk` by default (live) or `MockObscuraSdk`
when `VITE_USE_MOCK=true`. The UI is written against the interface only, so no
component or hook changes are needed to switch.

## What's left to wire

- **transfer / placeOrder / cancelOrder**: return clear "coming soon" errors in the
  live client. Wiring these needs the transfer / place_order / cancel_order circuits
  proven in-browser (same path as withdraw) plus the matcher for Swap fills.
- **Withdraw hardening**: reconstruct the Merkle tree from on-chain deposit events
  (not just local notes) so it works regardless of foreign deposits, and support
  partial withdraws (change output).
- **Proof overlay progress**: Pay/Swap still animate proof steps on timers; once those
  flows go live, drive the overlay from real prover progress.
- **USDC / multi-asset**: the testnet pool is single-asset (native XLM); set
  `VITE_USDC_SAC` once a multi-asset pool is deployed.
- **Bridge go-live**: deploy `ObscuraBridgeL1` (Sepolia) + the Soroban `EthLightClient` /
  `ObscuraBridge`, set the `VITE_*` bridge addresses, and run the relayer. Bridge-in is
  wired end-to-end against those; **bridge-out's live ZK path** (in-browser withdraw proof
  → `bridge_out` → L1 `unlock`) is structured but still mock-only.
