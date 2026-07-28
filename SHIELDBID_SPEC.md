# SHIELDBID_SPEC.md — privacy-first lending on Stellar

The workflow spec for **ShieldBid**. This supersedes `LENDING_SPEC.md` for product
design; `SHARED.md` (crypto invariants) and the deployed contracts are unchanged
unless this document says otherwise.

> **Read §1 and §2 before implementing anything.** They define what is and is not
> privately achievable. Several natural-sounding requirements are cryptographically
> impossible, and building the UI as if they were true would ship a false claim.

---

## 1. Privacy model — what is actually private

### 1.1 Private (genuinely)

| Action | What nobody can see |
|---|---|
| Pay / transfer | amount, sender, recipient |
| Swap | order side, price, amount, counterparty |
| Borrow | how much debt a given user carries |
| Supply | how much a given user supplied |
| Collateral | amount locked |
| Health factor | never published |
| Portfolio balances | shielded XLM / USDC holdings |

### 1.2 NOT private — state this plainly in the UI

**Deposits and withdrawals are public Stellar payments.** Moving real XLM or USDC
into the pool is an ordinary SAC transfer: the amount and the sending account are
on the explorer, unavoidably. Withdrawal is the same in reverse — the contract
must know the amount and recipient to send tokens, so both are public inputs to
the `withdraw` circuit by necessity.

What the shielded pool provides is **unlinkability**: nobody can connect your
deposit to your later withdrawal, payment, loan, or trade. The interior is
private; the two edges where real money enters and leaves are not. Every shielded
pool works this way.

**Do not** label deposit or withdraw "private" in the UI. Label them
*"enters your private portfolio"* — accurate, and the honest version of the claim.

**A position is visibly a position.** Enforcing an attestation deadline requires
the contract to know which commitments are loans and when each expires, so loans
live in a registry. Their *existence* and *timing* are public; their *amounts* are
not.

**Loan operations are linkable to each other.** Borrow, repay and attest all
reference the same registry entry, so an observer sees one loan's operation
history over time — cadence and lifetime, never amounts.

### 1.3 The honest one-line claim

> Your balances, debts, collateral and transfers are private. Deposits and
> withdrawals — where money crosses between Stellar and ShieldBid — are public,
> but they cannot be linked to anything you do inside.

---

## 2. UNRESOLVED: freeze-only liquidation vs. the supply side

**Decision taken:** collateral, debt and health are all private, with **no keeper**.
An unhealthy loan **freezes** rather than being liquidated.

This is the strongest privacy position available. It also has a consequence that
is not yet resolved, and implementers must not assume it away.

### 2.1 Why liquidation is impossible here

A note is a Poseidon2 hash commitment. Spending it requires knowing the preimage.
If only the borrower knows the collateral and debt:

- no liquidator can construct a spend proof for a commitment they cannot open;
- the contract cannot compute a payout for an amount it cannot see.

So a defaulted loan can be **frozen** — barred from borrowing, repaying or
withdrawing collateral — but its collateral can never be seized or sold.

### 2.2 The consequence

A defaulting borrower's collateral is **permanently stranded** inside the pool, and
their debt is **never recovered**. Suppliers funded that debt. The obvious hope —
"the stranded collateral covers the loss, since every loan is over-collateralised"
— **does not hold**, for two reasons:

1. **Asset mismatch.** Collateral is typically XLM; debt is typically USDC. The
   pool ends up with surplus XLM and a USDC shortfall. Converting requires knowing
   the amount, which it does not.
2. **Unattributable.** Even same-asset, the contract cannot decrement
   `total_borrowed` for a frozen loan, because it never knew that loan's debt.
   Utilisation drifts permanently upward and supply APY becomes fiction.

### 2.3 Options — pick one before building the supply side

- **(a) Ship borrow-only.** Drop Supply. The protocol lends its own seeded reserve
  and bears its own losses. Fully private, fully trustless, coherent. Smallest
  change, and it is the only option with no unresolved accounting.
- **(b) Same-asset lending only.** Collateral and debt are the same asset, so
  stranded collateral directly offsets bad debt. Removes the mismatch but makes
  borrowing far less useful (leverage only, not "hold XLM, spend USDC").
- **(c) Protocol insurance reserve.** A treasury absorbs defaults. Honest and
  simple, but it is a subsidy, not a solution — it runs dry under real defaults.
- **(d) Reintroduce a keeper.** Restores real liquidation and a sound supply side,
  at the cost of a party that can decrypt positions. This is what production
  private lending protocols do.

**Recommendation: (a) for launch, (d) when the supply side must be real.**
Until this is decided, **any supply APY shown is not backed by a sound recovery
mechanism** and the UI must not imply a guaranteed yield.

---

## 3. Risk parameters

| Parameter | Value | Meaning |
|---|---|---|
| Max LTV | **65%** | borrow ceiling → 154% collateralisation |
| Liquidation threshold | **80%** | freeze point |
| Attestation period | ~1 day (17,280 ledgers) | how often solvency must be proven |

Currently on-chain: `max_ltv_bps 7142` (71.43%). **Change to 6500** via
`set_risk_params` — governance-settable, no recompile, no redeploy.

> Note: an earlier instruction specified 140% collateralisation (71.43% LTV). This
> spec's 65% supersedes it. Confirm before changing.

Rates use the contract's kinked curve (placeholder until real parameters arrive):
2% base → 8% at an 80% utilisation kink → steep above.

```
utilisation   = total_borrowed / total_supplied
borrow APY    = base + slope1 · (u / kink)                    for u ≤ kink
              = base + slope1 + slope2 · (u − kink)/(1 − kink) for u > kink
supply APY    = borrow APY · utilisation
```

---

## 4. Portfolio — the hub

Every operation starts here. One screen, private, no blockchain terminology.

```
BALANCES        shielded XLM · shielded USDC          (reveal toggle)
LOANS           borrowed total · APY paid · health factor · borrow limit
SUPPLIED        supplied total · APY earned · interest accrued
ACTIONS         Deposit · Withdraw · Pay · Swap · Borrow · Supply
```

All figures are decrypted **client-side** from locally held secrets. Nothing is
read from chain state, because the chain does not hold them.

**Health factor** = `collateral_value × liq_threshold / debt_value`. `∞` when
debt is zero. Show a bar anchored at **1.0** (the freeze boundary), not 0.

**Borrow limit** = `collateral_value × max_ltv / debt_price − current_debt`.

---

## 5. Deposit / Withdraw

Assets: **XLM and USDC only**. Remove ETH, BTC, XRP, bETH, bUSDC everywhere —
`lib/tokens.ts`, the deposit picker, the faucet, `ASSET_CONFIG`.

Copy must say *"enters your private portfolio"*, never *"private deposit"* (§1.2).

---

## 6. Pay — dark-pool transfer

```
Asset       ( ) XLM   ( ) USDC
Recipient   receive code
Amount
[ Send Privately ]
```

Genuinely private: amount, sender and recipient are all hidden. Recipients share a
**receive code**, never a public address.

---

## 7. Swap

Pair restricted to **XLM / USDC**. Orders stay sealed until matched at the
midpoint. Requires the off-chain matcher running (`VITE_MATCHER_URL`); with no
matcher, orders place and cancel but never fill — say so rather than letting them
sit silently.

---

## 8. Lend — two separate tabs

### 8.1 Borrow

Seven steps, all calculated live as the user types:

1. Assets already sit in Portfolio.
2. User opens **Borrow**.
3. **Choose collateral asset** — XLM or USDC.
4. **Enter collateral amount** — any amount up to the shielded balance, taken
   directly from Portfolio and locked privately.
5. **Live calculation:** borrow limit, LTV, liquidation threshold, health factor.
6. **Choose borrow amount** — cannot exceed the limit; disable, don't error.
7. **Show borrow APY**, updating with utilisation.
8. **Borrow** → USDC appears in Portfolio.

**Borrow card:** collateral asset · collateral amount · borrow asset · borrow
amount · borrow limit · health factor · borrow APY · Borrow button.

**Loan cards:** collateral (private) · debt (private) · borrow APY · health factor
· **Repay** · **Add Collateral** · **Withdraw Collateral**.

> **Repay must ship with borrow.** Today `repay` is unwired in the client — a user
> can borrow and never close the loan, so every position eventually freezes. Do
> not ship Borrow without Repay.

### 8.2 Supply

Separate page. Assets: XLM, USDC.

```
Choose asset → choose amount → Supply
```

**Supply card:** asset · amount (private) · supply APY · interest earned (private)
· estimated daily earnings · estimated monthly earnings · **Withdraw** ·
**Claim Rewards**.

Subject to §2 — do not present supply yield as guaranteed until §2.3 is resolved.

---

## 9. UI rules

Keep the existing visual language: dark theme, elegant cards, the Act framing,
typography, animations. Change the workflow, not the look.

**Never surface:** "collateral note", "position note", "attestation", "commitment",
"nullifier", "Merkle", contract IDs, raw hashes, or diagnostic error codes.

**Translate instead:**

| Internal | User-facing |
|---|---|
| attest solvency | "Confirm your loan is healthy" |
| position frozen | "This loan is locked — contact support" |
| `InsufficientLiquidity` | "Not enough USDC available to borrow right now" |
| `StalePrice` | "Prices are updating, try again in a moment" |
| note has no leaf index | "Still confirming your deposit…" |

Amounts hide behind the existing reveal toggle.

---

## 10. Work required against today's build

| # | Task | Notes |
|---|---|---|
| 1 | Resolve §2.3 | **blocks the supply side** |
| 2 | `set_risk_params` → 6500 bps | on-chain, no redeploy |
| 3 | Remove ETH/BTC/XRP/bETH/bUSDC | `lib/tokens.ts`, config, faucet |
| 4 | Restrict swap to XLM/USDC | Swap already takes arbitrary pairs |
| 5 | Rebuild Portfolio as hub | loans, supplied, APY, health, limit |
| 6 | Split Lend into Borrow / Supply tabs | |
| 7 | Partial collateral | needs a change output in `position_open.nr` → recompile, new VK, redeploy that one verifier, update pool + SDK |
| 8 | **Wire repay** | must ship with borrow |
| 9 | Wire withdraw-collateral, redeem, claim | |
| 10 | APY everywhere | replicate the kinked curve client-side; must match `lending.rs` |
| 11 | Language pass | §9 table |

**Already done and reusable:** all 7 circuits (compiled, VKs deployed), the pool
contract with the full lending module, SDK primitives and input builders, position
and supply persistence, live `openPosition` / `borrowAgainst` / `attestSolvency` /
`supplyLiquidity`, oracle plumbing.

**Item 7 is the only circuit change.** Everything else is contract config, SDK
wiring, or UI.

---

## 11. Known gaps carried over

- Oracle is an **admin-pushed placeholder** with a 60-ledger freshness gate; the
  publisher is trusted. Replacing it with Reflector means rewriting one function,
  `lending::oracle_price`.
- Interest-rate curve is a placeholder — no real parameters were ever supplied.
- `repay`'s circuit `main()` has no end-to-end test (needs a two-leaf tree fixture).
- Swap fills need the off-chain matcher running.
