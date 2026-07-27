# Wraith -- Full Privacy Platform on Stellar

## Technical Specification v2.0

---

## 1. Overview

Wraith is a full-stack privacy platform on Stellar. It provides four integrated modules -- Bridge, Portfolio, Pay, and Swap -- all built on a shared shielded balance layer. Users bridge classic Stellar assets into a private environment, manage hidden balances, send private payments, and trade via a ZK-powered dark pool. Every operation is verified by zero-knowledge proofs on Soroban.

### 1.1 Modules

| Module | What it does |
|---|---|
| **Bridge** | Move assets between classic Stellar and Wraith's private layer (via SAC) |
| **Portfolio** | View and manage shielded multi-asset balances |
| **Pay** | Send private payments -- amounts and participants hidden |
| **Swap** | Dark pool DEX -- hidden orders, ZK-proven fair matching |

### 1.2 Design Principles

- **100% on-chain**: all settlement logic lives in Soroban smart contracts
- **Trustless settlement**: ZK proofs enforce every state transition -- no custodial intermediary
- **Anti-MEV**: orders are cryptographically sealed, no front-running or sandwich attacks
- **Multi-asset**: any classic Stellar asset accessible via SAC (XLM, USDC, EURC, etc.)
- **Shared base layer**: all modules use the same note model, Merkle tree, and nullifier registry

---

## 2. Architecture

```
STELLAR CLASSIC                         WRAITH (Soroban)
                              +--------------------------------------+
  XLM  ----+                  |                                      |
  USDC ----+--- BRIDGE ------>|  SHIELDED BALANCE LAYER              |
  EURC ----+    (SAC)         |  (ZK notes, Merkle tree, nullifiers) |
                              |       |              |               |
                              |       v              v               |
                              |   WRAITH PAY    WRAITH SWAP          |
                              |   (transfer     (place_order,        |
                              |    circuit)      match_orders)       |
                              |                                      |
  XLM  <---+                  |                                      |
  USDC <---+--- BRIDGE <------|                                      |
  EURC <---+    (SAC)         +--------------------------------------+
                              
                              +--------------------+
                              | UltraHonk Verifier |
                              | (1 per circuit VK) |
                              +--------------------+
```

### 2.1 Component Inventory

| Component | Language | Description |
|---|---|---|
| `circuits/transfer` | Noir | Private payment circuit |
| `circuits/place_order` | Noir | Hidden order placement with balance lock |
| `circuits/match_orders` | Noir | Fair match proof between two orders |
| `circuits/withdraw` | Noir | Withdrawal proof (shielded -> public) |
| `circuits/cancel_order` | Noir | Order cancellation proof |
| `contracts/wraith-pool` | Rust/Soroban | Core contract: balances, orders, settlement |
| `sdk/` | TypeScript | Client library: notes, proofs, transactions |
| `matcher/` | TypeScript | Off-chain matching engine |
| `frontend/` | React + TS | 4-tab UI: Bridge, Portfolio, Pay, Swap |

---

## 3. Cryptographic Primitives

### 3.1 Curve & Proof System

| Primitive | Choice | Rationale |
|---|---|---|
| Curve | BN254 | Native Soroban host functions (Protocol 25-26) |
| Hash | Poseidon2 | ZK-friendly, native Soroban host function |
| Proof system | UltraHonk (Noir) | No trusted setup, verifier exists for Soroban |
| Verifier | `rs-soroban-ultrahonk` | Barretenberg v0.82.2, Noir 1.0.0-beta.9 |

### 3.2 Poseidon2 Parameters

All hashes use Poseidon2 over the BN254 scalar field.

```
Field modulus r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
```

| Arity | State width (t) | Rate | Full rounds | Partial rounds | Use |
|---|---|---|---|---|---|
| 2-to-1 | 3 | 2 | 8 | 56 | Merkle nodes, nullifiers |
| 4-to-1 | 5 | 4 | 8 | 60 | Balance note commitments |
| 7-to-1 | 8 | 7 | 8 | 57 | Order commitments |

---

## 4. Shielded Balance Layer (Base)

This is the foundation shared by all modules.

### 4.1 Balance Note

A note represents a hidden balance within Wraith:

```
BalanceNote {
    asset_id:   Field    -- Poseidon2(asset_code, issuer) or 0 for native XLM
    amount:     Field    -- token quantity (constrained to 64 bits in circuit)
    owner_key:  Field    -- Poseidon2(spending_key, 0)
    blinding:   Field    -- random scalar for commitment hiding
}
```

### 4.2 Note Commitment

```
commitment = Poseidon2_4(asset_id, amount, owner_key, blinding)
```

Stored as a leaf in the on-chain Merkle tree.

### 4.3 Nullifier

```
nullifier = Poseidon2_2(commitment, spending_key)
```

- Only the owner can derive the nullifier (requires `spending_key`)
- Deterministic: each note produces exactly one nullifier
- Contract rejects revealed nullifiers to prevent double-spending

### 4.4 Key Derivation

```
spending_key   -- random 254-bit scalar (secret, stored in wallet)
    |
    +-- owner_key   = Poseidon2_2(spending_key, 0)   -- public identity
    +-- viewing_key = Poseidon2_2(spending_key, 1)   -- for auditors (optional)
```

### 4.5 Merkle Tree

| Parameter | Value |
|---|---|
| Type | Incremental append-only binary tree |
| Depth | 20 |
| Capacity | 1,048,576 notes |
| Hash | Poseidon2 (t=3, 2-to-1) |
| Empty leaf | 0 |
| Storage | Frontier-based (1 hash per level + root history) |
| Root history | Ring buffer, last 100 roots |

**Insertion (frontier algorithm):**

```
insert(leaf):
    current = leaf
    index = next_index
    for level in 0..DEPTH:
        if index % 2 == 0:
            filled_subtrees[level] = current
            current = Poseidon2_2(current, zeros[level])
        else:
            current = Poseidon2_2(filled_subtrees[level], current)
        index = index / 2
    roots.push(current)
    next_index += 1
```

**Empty subtree values (precomputed):**

```
zeros[0] = 0
zeros[i] = Poseidon2_2(zeros[i-1], zeros[i-1])
```

### 4.6 Merkle Proof (off-chain)

The SDK maintains a local copy of all leaves (indexed from `Deposit` events) and computes:

```
MerkleProof {
    path_elements: [Field; 20]   -- sibling hashes
    path_indices:  [Field; 20]   -- direction bits (0=left, 1=right)
}
```

Verification in circuit:

```
fn check_merkle_proof(leaf: Field, path: [Field; 20], indices: [Field; 20]) -> Field {
    let mut current = leaf;
    for i in 0..20 {
        let (left, right) = if indices[i] == 0 {
            (current, path[i])
        } else {
            (path[i], current)
        };
        current = poseidon2_hash(left, right);
    }
    current  // returns computed root
}
```

---

## 5. Module: Bridge

### 5.1 Deposit (Classic -> Wraith)

No ZK proof required. Deposit amounts are public.

```
Flow:
1. User generates: spending_key (random), blinding (random)
2. Computes: owner_key = Poseidon2(spending_key, 0)
3. Computes: commitment = Poseidon2_4(asset_id, amount, owner_key, blinding)
4. Calls: contract.deposit(from, asset, amount, commitment)
5. Contract: transfers tokens via SAC, inserts commitment into Merkle tree
6. User stores locally: { asset_id, amount, spending_key, blinding, leaf_index }
```

### 5.2 Withdraw (Wraith -> Classic)

Requires a ZK proof of note ownership.

```
Flow:
1. User selects a balance note to withdraw
2. Generates Withdraw proof (see Section 8.1)
3. Calls: contract.withdraw(proof, root, nullifier, recipient, amount, asset)
4. Contract: verifies proof, marks nullifier spent, transfers tokens via SAC
```

### 5.3 Multi-asset Support

Any Stellar asset with a SAC deployment is supported. The `asset_id` in notes is:

```
asset_id = Poseidon2_2(asset_address, 0)
```

Where `asset_address` is the SAC contract address for that asset. Native XLM uses `asset_id = 0`.

---

## 6. Module: Pay

### 6.1 Private Transfer

Send tokens to another Wraith user without revealing amount or participants.

```
Flow:
1. Sender selects one or more balance notes (total >= transfer amount)
2. Computes recipient's owner_key (shared out-of-band or via stealth address)
3. Creates output notes:
   - Note A: (asset_id, transfer_amount, recipient_owner_key, random_blinding)
   - Note B: (asset_id, change_amount, sender_owner_key, random_blinding)
4. Generates Transfer proof (see Section 8.2)
5. Submits to contract: proof + nullifiers + output commitments
6. Contract: verifies, marks nullifiers spent, inserts new commitments
```

### 6.2 What the Public Sees

Nothing useful. On-chain data shows:
- Two nullifiers (opaque hashes)
- Two new commitments (opaque hashes)
- A valid ZK proof

No amounts, no asset types, no sender/recipient identities.

### 6.3 Note Discovery (MVP)

Sender shares note details with recipient out-of-band (encrypted message, QR code, etc.). In v2: encrypted note data emitted on-chain, recipients trial-decrypt with their viewing key.

---

## 7. Module: Swap (Dark Pool)

### 7.1 Order Structure

```
Order {
    side:         Field    -- 0 = buy, 1 = sell (relative to base asset)
    price:        Field    -- limit price (scaled by PRICE_SCALE = 10^7)
    amount:       Field    -- quantity of base asset
    asset_base:   Field    -- base asset identifier
    asset_quote:  Field    -- quote asset identifier
    owner_key:    Field    -- trader's public key
    nonce:        Field    -- random, prevents commitment collision
}
```

### 7.2 Order Commitment

```
order_commitment = Poseidon2_7(side, price, amount, asset_base, asset_quote, owner_key, nonce)
```

Stored on-chain as an opaque hash. Order details are invisible.

### 7.3 Place Order

```
Flow:
1. Trader has a shielded balance note
2. Creates an Order with desired parameters
3. Generates PlaceOrder proof (see Section 8.3):
   - Proves note ownership and sufficient balance
   - Commits to the order details
   - Locks funds by revealing the note's nullifier
4. Submits: proof + nullifier + order_commitment + change_commitment
5. Contract: verifies proof, stores order, inserts change note if any
```

### 7.4 Matching

**Model:** Peer-to-peer. Anyone who knows two compatible orders can submit a match proof.

**Compatibility rules:**
- Opposite sides (one buy, one sell)
- Same trading pair (asset_base and asset_quote match)
- Price overlap: `buy_price >= sell_price`

**Execution price:** Midpoint of the two limit prices.

```
exec_price = (buy_price + sell_price) / 2
```

**Fill calculation:**

```
fill_amount = min(order_a.amount, order_b.amount)
quote_filled = fill_amount * exec_price / PRICE_SCALE
```

```
Flow:
1. Matcher knows details of two compatible orders
2. Generates MatchOrders proof (see Section 8.4):
   - Proves both orders are valid preimages of their commitments
   - Proves compatibility and correct execution
   - Creates settlement notes for both traders
3. Submits: proof + both commitments + settlement notes
4. Contract: verifies, removes orders, inserts settlement notes
5. Partial fills: residual order re-committed, refund notes created
```

### 7.5 Order Cancellation

```
Flow:
1. Trader proves they know the order preimage (CancelOrder proof, Section 8.5)
2. Contract: removes order, inserts refund balance note
```

### 7.6 Matching Service (MVP)

An off-chain Node.js service that traders submit order details to.

```
Trader A  --[encrypted order]--> Matching Engine  --[match proof]--> Soroban Contract
Trader B  --[encrypted order]-->
```

**Trust model:**

| Can do | Cannot do |
|---|---|
| See submitted order details | Steal funds (ZK-enforced settlement) |
| Choose match priority | Modify execution price (proven in circuit) |
| Refuse to match (censor) | Front-run (can't trade without depositing) |

Same trust model as IEX, Liquidnet, and other TradFi dark pools.

---

## 8. Circuit Specifications

### 8.1 Circuit: Withdraw

Proves note ownership for withdrawal to a classic Stellar address.

**Public Inputs (5):**

| # | Field | Description |
|---|---|---|
| 0 | `merkle_root` | Must exist in contract's root history |
| 1 | `nullifier` | Derived from note + spending_key |
| 2 | `recipient_hash` | Poseidon2 hash of Stellar recipient address |
| 3 | `amount` | Withdrawal amount (public, needed for SAC transfer) |
| 4 | `asset_id` | Asset identifier (public, needed for SAC transfer) |

**Private Inputs:**

| Field | Description |
|---|---|
| `note_amount` | Note balance |
| `note_asset_id` | Note asset |
| `note_owner_key` | Owner key |
| `note_blinding` | Blinding factor |
| `spending_key` | Spending private key |
| `merkle_path[20]` | Merkle siblings |
| `merkle_indices[20]` | Merkle direction bits |

**Constraints:**

```noir
// 1. Derive owner key
owner_key = hash2(spending_key, 0)

// 2. Recompute commitment
commitment = hash4(note_asset_id, note_amount, owner_key, note_blinding)

// 3. Verify nullifier
assert(nullifier == hash2(commitment, spending_key))

// 4. Merkle membership
computed_root = check_merkle_proof(commitment, merkle_path, merkle_indices)
assert(computed_root == merkle_root)

// 5. Amount and asset match public inputs
assert(note_amount == amount)
assert(note_asset_id == asset_id)
```

**Estimated constraints:** ~3,500

---

### 8.2 Circuit: Transfer

Proves a valid private payment: consumes input notes, creates output notes.

**Public Inputs (6):**

| # | Field | Description |
|---|---|---|
| 0 | `merkle_root` | Current Merkle root |
| 1 | `nullifier_0` | Nullifier of first input note |
| 2 | `nullifier_1` | Nullifier of second input note (or phantom) |
| 3 | `out_commitment_0` | Output note for recipient |
| 4 | `out_commitment_1` | Output note for change (back to sender) |
| 5 | `ext_data_hash` | Binds proof to external params (prevents replay) |

**Private Inputs:**

| Field | Description |
|---|---|
| `in_amount[2]` | Input note amounts |
| `in_asset_id[2]` | Input note assets |
| `in_spending_key[2]` | Spending keys |
| `in_blinding[2]` | Blinding factors |
| `in_merkle_path[2][20]` | Merkle proofs |
| `in_merkle_indices[2][20]` | Merkle direction bits |
| `out_amount[2]` | Output amounts |
| `out_owner_key[2]` | Output owner keys |
| `out_blinding[2]` | Output blinding factors |
| `out_asset_id[2]` | Output assets |

**Constraints:**

```noir
let mut sum_in: Field = 0;
let mut sum_out: Field = 0;

// 1. Verify each input note
for i in 0..2 {
    let owner_key = hash2(in_spending_key[i], 0);
    let commitment = hash4(in_asset_id[i], in_amount[i], owner_key, in_blinding[i]);
    let nullifier = hash2(commitment, in_spending_key[i]);

    // Nullifier matches public input
    assert(nullifier == public_nullifiers[i]);

    // Merkle membership (skip if amount == 0, dummy note)
    if in_amount[i] != 0 {
        let root = check_merkle_proof(commitment, in_merkle_path[i], in_merkle_indices[i]);
        assert(root == merkle_root);
    }

    // All inputs must be same asset
    if in_amount[i] != 0 {
        assert(in_asset_id[i] == in_asset_id[0]);
    }

    sum_in += in_amount[i];
}

// 2. Verify each output note
for j in 0..2 {
    let commitment = hash4(out_asset_id[j], out_amount[j], out_owner_key[j], out_blinding[j]);
    assert(commitment == public_out_commitments[j]);

    // Same asset as inputs
    if out_amount[j] != 0 {
        assert(out_asset_id[j] == in_asset_id[0]);
    }

    // Range check
    out_amount[j].assert_max_bit_size::<64>();

    sum_out += out_amount[j];
}

// 3. Value conservation
assert(sum_in == sum_out);

// 4. No duplicate nullifiers
assert(nullifier_0 != nullifier_1);

// 5. Bind external data
let _ = ext_data_hash * ext_data_hash;
```

**Estimated constraints:** ~5,000

---

### 8.3 Circuit: PlaceOrder

Proves sufficient balance to place a hidden order. Locks funds via nullifier.

**Public Inputs (5):**

| # | Field | Description |
|---|---|---|
| 0 | `merkle_root` | Current Merkle root |
| 1 | `nullifier` | Nullifier of consumed balance note |
| 2 | `order_commitment` | Hash of hidden order parameters |
| 3 | `change_commitment` | Balance note for remaining funds (0 if none) |
| 4 | `locked_asset_id` | Asset being locked for this order |

**Private Inputs:**

| Field | Description |
|---|---|
| `note_amount` | Balance note amount |
| `note_asset_id` | Balance note asset |
| `note_owner_key` | Owner key |
| `note_blinding` | Blinding factor |
| `spending_key` | Spending key |
| `merkle_path[20]` | Merkle proof |
| `merkle_indices[20]` | Direction bits |
| `order_side` | 0=buy, 1=sell |
| `order_price` | Limit price (scaled) |
| `order_amount` | Order quantity (base asset) |
| `order_asset_base` | Base asset id |
| `order_asset_quote` | Quote asset id |
| `order_nonce` | Random nonce |
| `change_amount` | Remaining balance |
| `change_blinding` | New blinding for change |

**Constraints:**

```noir
// 1. Note ownership + Merkle membership
let owner_key = hash2(spending_key, 0);
let commitment = hash4(note_asset_id, note_amount, owner_key, note_blinding);
assert(hash2(commitment, spending_key) == nullifier);
let root = check_merkle_proof(commitment, merkle_path, merkle_indices);
assert(root == merkle_root);

// 2. Order commitment
let computed_order = hash7(
    order_side, order_price, order_amount,
    order_asset_base, order_asset_quote, owner_key, order_nonce
);
assert(computed_order == order_commitment);

// 3. Sufficient balance
let PRICE_SCALE: Field = 10000000; // 10^7
if order_side == 0 {
    // Buy: locking quote asset to buy base
    assert(note_asset_id == order_asset_quote);
    let required = order_amount * order_price / PRICE_SCALE;
    assert(note_amount >= required);
    assert(change_amount == note_amount - required);
    assert(locked_asset_id == order_asset_quote);
} else {
    // Sell: locking base asset
    assert(note_asset_id == order_asset_base);
    assert(note_amount >= order_amount);
    assert(change_amount == note_amount - order_amount);
    assert(locked_asset_id == order_asset_base);
}

// 4. Change commitment
if change_amount != 0 {
    let change_comm = hash4(note_asset_id, change_amount, owner_key, change_blinding);
    assert(change_comm == change_commitment);
} else {
    assert(change_commitment == 0);
}

// 5. Range checks
order_amount.assert_max_bit_size::<64>();
order_price.assert_max_bit_size::<64>();
change_amount.assert_max_bit_size::<64>();
```

**Estimated constraints:** ~5,000

---

### 8.4 Circuit: MatchOrders

Proves two orders are compatible and computes correct settlement.

**Public Inputs (8):**

| # | Field | Description |
|---|---|---|
| 0 | `order_commitment_a` | First order (must be in active set) |
| 1 | `order_commitment_b` | Second order (must be in active set) |
| 2 | `fill_note_buyer` | Settlement note: buyer receives base asset |
| 3 | `fill_note_seller` | Settlement note: seller receives quote asset |
| 4 | `residual_order_a` | Remaining order A (0 if fully filled) |
| 5 | `residual_order_b` | Remaining order B (0 if fully filled) |
| 6 | `refund_note_a` | Refund for A's unused locked funds (0 if full fill) |
| 7 | `refund_note_b` | Refund for B's unused locked funds (0 if full fill) |

**Private Inputs:**

All fields of both orders + blinding factors for all new notes:

| Field | Description |
|---|---|
| `a_side, a_price, a_amount, a_asset_base, a_asset_quote, a_owner_key, a_nonce` | Order A fields |
| `b_side, b_price, b_amount, b_asset_base, b_asset_quote, b_owner_key, b_nonce` | Order B fields |
| `buyer_fill_blinding` | Blinding for buyer's settlement note |
| `seller_fill_blinding` | Blinding for seller's settlement note |
| `residual_a_nonce` | New nonce for residual order A |
| `residual_b_nonce` | New nonce for residual order B |
| `refund_a_blinding` | Blinding for refund note A |
| `refund_b_blinding` | Blinding for refund note B |

**Constraints:**

```noir
// 1. Verify order commitments match on-chain values
let computed_a = hash7(a_side, a_price, a_amount, a_asset_base, a_asset_quote, a_owner_key, a_nonce);
assert(computed_a == order_commitment_a);
let computed_b = hash7(b_side, b_price, b_amount, b_asset_base, b_asset_quote, b_owner_key, b_nonce);
assert(computed_b == order_commitment_b);

// 2. Opposite sides
assert(a_side != b_side);

// 3. Same trading pair
assert(a_asset_base == b_asset_base);
assert(a_asset_quote == b_asset_quote);

// 4. Identify buyer and seller
let (buy_price, sell_price, buy_amount, sell_amount, buyer_key, seller_key) =
    if a_side == 0 {
        (a_price, b_price, a_amount, b_amount, a_owner_key, b_owner_key)
    } else {
        (b_price, a_price, b_amount, a_amount, b_owner_key, a_owner_key)
    };

// 5. Price compatibility
assert(buy_price >= sell_price);

// 6. Execution price = midpoint
let exec_price = (buy_price + sell_price) / 2;

// 7. Fill amount
let fill_amount = if buy_amount < sell_amount { buy_amount } else { sell_amount };
let quote_filled = fill_amount * exec_price / PRICE_SCALE;

// 8. Settlement notes
// Buyer receives base asset
let buyer_note = hash4(a_asset_base, fill_amount, buyer_key, buyer_fill_blinding);
assert(buyer_note == fill_note_buyer);

// Seller receives quote asset
let seller_note = hash4(a_asset_quote, quote_filled, seller_key, seller_fill_blinding);
assert(seller_note == fill_note_seller);

// 9. Residual orders (if partial fill)
if buy_amount > fill_amount {
    // Buyer has remaining order
    let residual_buy_amount = buy_amount - fill_amount;
    let residual = hash7(0, buy_price, residual_buy_amount,
                         a_asset_base, a_asset_quote, buyer_key, residual_nonce);
    assert(residual == residual_order_for_buyer);
    // No refund for buyer (funds stay locked in residual)
} else {
    assert(residual_order_for_buyer == 0);
    // Buyer may get a refund if they locked more than quote_filled
    // (because exec_price may be less than buy_price)
    let buyer_locked = buy_amount * buy_price / PRICE_SCALE;
    let buyer_refund_amount = buyer_locked - quote_filled;
    if buyer_refund_amount > 0 {
        let refund = hash4(a_asset_quote, buyer_refund_amount, buyer_key, refund_buyer_blinding);
        assert(refund == refund_note_buyer);
    } else {
        assert(refund_note_buyer == 0);
    }
}
// (symmetric logic for seller)

// 10. Range checks
fill_amount.assert_max_bit_size::<64>();
quote_filled.assert_max_bit_size::<64>();
```

**Estimated constraints:** ~8,000

---

### 8.5 Circuit: CancelOrder

Proves order ownership for cancellation.

**Public Inputs (3):**

| # | Field | Description |
|---|---|---|
| 0 | `order_commitment` | Order to cancel (must be in active set) |
| 1 | `refund_commitment` | Balance note returning locked funds |
| 2 | `refund_asset_id` | Asset being refunded |

**Private Inputs:**

All order fields + spending_key + refund blinding.

**Constraints:**

```noir
// 1. Verify order commitment
let owner_key = hash2(spending_key, 0);
let computed = hash7(side, price, amount, asset_base, asset_quote, owner_key, nonce);
assert(computed == order_commitment);

// 2. Compute refund amount
let PRICE_SCALE: Field = 10000000;
let (refund_amount, refund_asset) = if side == 0 {
    (amount * price / PRICE_SCALE, asset_quote)
} else {
    (amount, asset_base)
};

// 3. Refund note
let refund = hash4(refund_asset, refund_amount, owner_key, refund_blinding);
assert(refund == refund_commitment);
assert(refund_asset == refund_asset_id);
```

**Estimated constraints:** ~3,000

---

## 9. Smart Contract

### 9.1 Interface

```rust
#[contract]
pub struct WraithPool;

#[contractimpl]
impl WraithPool {
    // --- Lifecycle ---

    pub fn __constructor(
        env: Env,
        transfer_vf: Address,
        order_vf: Address,
        match_vf: Address,
        withdraw_vf: Address,
        cancel_vf: Address,
    );

    // --- Bridge ---

    /// Deposit classic Stellar asset into Wraith
    pub fn deposit(
        env: Env,
        from: Address,
        asset: Address,
        amount: i128,
        commitment: BytesN<32>,
    ) -> u32;  // leaf index

    /// Withdraw from Wraith to a classic Stellar account
    pub fn withdraw(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        recipient: Address,
        amount: i128,
        asset: Address,
    ) -> Result<(), WraithError>;

    // --- Pay ---

    /// Private transfer between Wraith users
    pub fn transfer(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
    ) -> Result<(), WraithError>;

    // --- Swap ---

    /// Place a hidden order
    pub fn place_order(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
    ) -> Result<(), WraithError>;

    /// Match two compatible orders
    pub fn match_orders(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
    ) -> Result<(), WraithError>;

    /// Cancel an open order
    pub fn cancel_order(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
    ) -> Result<(), WraithError>;

    // --- View ---

    pub fn get_last_root(env: Env) -> BytesN<32>;
    pub fn is_known_root(env: Env, root: BytesN<32>) -> bool;
    pub fn is_spent(env: Env, nullifier: BytesN<32>) -> bool;
    pub fn is_active_order(env: Env, commitment: BytesN<32>) -> bool;
}
```

### 9.2 Verification Pattern

Every ZK-verified function follows the same pattern:

```rust
fn verify_and_execute(env: &Env, verifier: &Address, proof: Bytes, public_inputs: Bytes) {
    // 1. Cross-contract call to UltraHonk verifier
    env.invoke_contract::<()>(
        verifier,
        &Symbol::new(env, "verify_proof"),
        vec![env, public_inputs.into_val(env), proof.into_val(env)],
    );
    // If we reach here, proof is valid (verifier panics on invalid proof)

    // 2. Parse public inputs
    // 3. Check nullifiers not spent, roots valid, orders exist
    // 4. Update state: mark nullifiers, insert commitments, update orders
}
```

### 9.3 Storage Layout

| Key pattern | Type | Description |
|---|---|---|
| `vf:{circuit}` | Address | Verifier contract per circuit |
| `next_idx` | u32 | Next Merkle leaf index |
| `roots` | Vec<BytesN<32>> | Root ring buffer (100 entries) |
| `frontier:{level}` | BytesN<32> | Merkle frontier hash per level |
| `nulls:{hash}` | bool | Spent nullifiers |
| `orders:{hash}` | bool | Active order commitments |
| `assets:{address}` | bool | Supported asset whitelist |

### 9.4 Events

```rust
// Bridge
Deposit  { commitment: BytesN<32>, index: u32, asset: Address, amount: i128 }
Withdraw { nullifier: BytesN<32>, recipient: Address, asset: Address, amount: i128 }

// Pay
Transfer { nullifiers: Vec<BytesN<32>>, commitments: Vec<BytesN<32>> }

// Swap
OrderPlaced   { order_commitment: BytesN<32>, change_commitment: BytesN<32> }
OrderMatched  { order_a: BytesN<32>, order_b: BytesN<32>,
                fill_buyer: BytesN<32>, fill_seller: BytesN<32> }
OrderCancelled { order_commitment: BytesN<32>, refund: BytesN<32> }
```

---

## 10. SDK

### 10.1 Modules

```
sdk/src/
  types.ts          -- BalanceNote, Order, MerkleProof, etc.
  constants.ts      -- PRICE_SCALE, TREE_DEPTH, zeros[]
  poseidon.ts       -- Poseidon2 hash (BN254, matching circuit params)
  merkle.ts         -- Client-side Merkle tree (mirror of on-chain tree)
  note.ts           -- createNote(), computeCommitment(), computeNullifier()
  order.ts          -- createOrder(), computeOrderCommitment()
  prover.ts         -- generateProof() via noir_js + bb.js
  wallet.ts         -- Note storage, balance aggregation, note selection
  stellar.ts        -- Soroban tx building, SAC interaction
  index.ts          -- Public API
```

### 10.2 Key Functions

```typescript
// Bridge
async function deposit(asset: Asset, amount: bigint): Promise<{ note: BalanceNote, txHash: string }>;
async function withdraw(note: BalanceNote, recipient: string): Promise<string>;

// Pay
async function transfer(fromNotes: BalanceNote[], recipientKey: Field, amount: bigint): Promise<string>;

// Swap
async function placeOrder(note: BalanceNote, order: OrderParams): Promise<{ orderId: string }>;
async function cancelOrder(order: Order): Promise<string>;

// Wallet
function getShieldedBalances(): Map<AssetId, bigint>;
function selectNotes(assetId: Field, amount: bigint): BalanceNote[];
```

---

## 11. Matching Service

### 11.1 Architecture

```typescript
// matcher/src/engine.ts
interface SubmittedOrder {
    commitment: string;        // on-chain commitment
    side: 'buy' | 'sell';
    price: bigint;
    amount: bigint;
    assetBase: string;
    assetQuote: string;
    ownerKey: string;
    nonce: string;
}

class MatchingEngine {
    private buyOrders: Map<string, SubmittedOrder[]>;   // keyed by pair
    private sellOrders: Map<string, SubmittedOrder[]>;

    submit(order: SubmittedOrder): void;
    findMatches(): Match[];
    generateMatchProof(match: Match): Promise<ProofData>;
    submitToContract(match: Match, proof: ProofData): Promise<string>;
}
```

### 11.2 Matching Algorithm (MVP)

Price-time priority:
1. Group orders by pair
2. Sort buys descending by price, sells ascending
3. If best buy >= best sell, match at midpoint
4. Generate MatchOrders proof
5. Submit to contract

---

## 12. Frontend

### 12.1 Views

| Tab | Components |
|---|---|
| **Bridge** | Deposit form (asset picker, amount) / Withdraw form (recipient, amount) |
| **Portfolio** | Shielded balance cards per asset, total value estimate |
| **Pay** | Recipient key input, asset picker, amount, send button |
| **Swap** | Pair selector, side toggle, price input, amount, place order / order list with cancel |

### 12.2 Stack

- React 18 + TypeScript + Vite
- TailwindCSS + shadcn/ui
- `@stellar/stellar-sdk` (Soroban + SAC)
- `@noir-lang/noir_js` + `@aztec/bb.js` (in-browser proof gen)
- Freighter wallet adapter

### 12.3 Proof Generation UX

```
[Place Order] clicked
  -> "Generating proof..." (5-15 sec, progress spinner)
  -> "Signing transaction..." (Freighter popup)
  -> "Confirming..." (Soroban submission)
  -> "Order placed" (success state)
```

---

## 13. Resource Costs

| Operation | ZK Verification (CPU) | App Logic (CPU) | Total | Fee (~) |
|---|---|---|---|---|
| Deposit | 0 | ~5M | ~5M | 0.001 XLM |
| Withdraw | ~80M | ~10M | ~90M | 0.013 XLM |
| Transfer | ~80M | ~10M | ~90M | 0.013 XLM |
| PlaceOrder | ~80M | ~10M | ~90M | 0.013 XLM |
| MatchOrders | ~80M | ~15M | ~95M | 0.014 XLM |
| CancelOrder | ~80M | ~5M | ~85M | 0.012 XLM |

All within the 100M CPU instruction limit per Soroban transaction.

---

## 14. Security

### 14.1 Privacy Guarantees

| Data | Visible to public? | Visible to matcher? |
|---|---|---|
| Deposit amounts | Yes | Yes |
| Shielded balances | No | No |
| Transfer amounts | No | No |
| Transfer parties | No | No |
| Order price | No | Yes (submitted orders only) |
| Order amount | No | Yes (submitted orders only) |
| Trader identity | No | No (only owner_key, not Stellar address) |

### 14.2 Circuit Safety

| Attack | Prevention |
|---|---|
| Double spending | Nullifier uniqueness |
| Insufficient balance | ZK-proven balance >= order cost |
| Price manipulation | Execution = midpoint, proven in circuit |
| Fake orders | Commitment preimage verified in match proof |
| Front-running | Orders opaque until matched |
| Replay attack | ext_data_hash binding (transfers), nonces (orders) |
| Overflow | 64-bit range checks on amounts and prices |

### 14.3 Known Limitations (MVP)

| Limitation | Impact | Path to fix |
|---|---|---|
| Centralized matcher | Can censor, cannot steal | Decentralize via encrypted broadcasting |
| Deposit amounts public | Reduces anonymity | Add shielded deposits (fixed denominations) |
| Single matcher instance | SPOF for order discovery | Multiple competing matchers |
| No order expiry | Stale orders | Add TTL field to orders |
| MVP note discovery | Out-of-band sharing | Encrypted on-chain notes with viewing keys |

---

## 15. Project Structure

```
wraith/
├── circuits/
│   └── noir/
│       ├── withdraw/
│       │   ├── Nargo.toml
│       │   └── src/main.nr
│       ├── transfer/
│       │   ├── Nargo.toml
│       │   └── src/main.nr
│       ├── place_order/
│       │   ├── Nargo.toml
│       │   └── src/main.nr
│       ├── match_orders/
│       │   ├── Nargo.toml
│       │   └── src/main.nr
│       └── cancel_order/
│           ├── Nargo.toml
│           └── src/main.nr
├── contracts/
│   └── wraith-pool/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs          # Entry point, function dispatch
│           ├── merkle.rs       # Incremental Merkle tree
│           ├── types.rs        # Events, errors, storage keys
│           └── test.rs         # Unit tests
├── sdk/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── types.ts
│       ├── constants.ts
│       ├── poseidon.ts
│       ├── merkle.ts
│       ├── note.ts
│       ├── order.ts
│       ├── prover.ts
│       ├── wallet.ts
│       └── stellar.ts
├── matcher/
│   ├── package.json
│   └── src/
│       ├── index.ts            # API server
│       ├── engine.ts           # Matching algorithm
│       ├── prover.ts           # Match proof generation
│       └── submitter.ts        # Soroban tx submission
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       ├── components/
│       │   ├── Bridge.tsx
│       │   ├── Portfolio.tsx
│       │   ├── Pay.tsx
│       │   ├── Swap.tsx
│       │   └── Layout.tsx
│       ├── hooks/
│       │   ├── useWraith.ts
│       │   └── useWallet.ts
│       └── lib/
│           └── wraith-sdk.ts
├── scripts/
│   ├── deploy.ts               # Deploy all contracts
│   └── demo.ts                 # E2E demo script
├── README.md
├── SPEC.md
└── .gitignore
```

---

## 16. Implementation Plan

### Day 1: Circuits

- [ ] Implement `withdraw` circuit in Noir + tests
- [ ] Implement `transfer` circuit in Noir + tests
- [ ] Implement `place_order` circuit in Noir + tests
- [ ] Generate VKs with `bb`

### Day 2: Contract

- [ ] Implement Merkle tree (Poseidon2, depth 20, frontier)
- [ ] Implement `deposit`, `withdraw`, `transfer`
- [ ] Implement `place_order`, `match_orders`, `cancel_order`
- [ ] Deploy UltraHonk verifiers with VKs
- [ ] Deploy to Stellar Testnet

### Day 3: SDK + Matcher

- [ ] TypeScript SDK: notes, orders, proofs, wallet, Soroban tx
- [ ] Matching service: engine, proof gen, contract submission
- [ ] Implement `match_orders` circuit in Noir
- [ ] E2E test: deposit -> transfer -> place order -> match -> withdraw

### Day 4: Frontend + Ship

- [ ] React app: Bridge, Portfolio, Pay, Swap tabs
- [ ] In-browser proof generation
- [ ] Freighter wallet integration
- [ ] Polish, README, demo video recording
- [ ] Submit to DoraHacks

---

## 17. Dependencies

### Noir Circuits

| Dependency | Version | Purpose |
|---|---|---|
| `nargo` | 1.0.0-beta.9+ | Compiler, test runner |
| `bb` | 0.82.2+ | Proof gen, VK export |
| `poseidon` | v0.2.0 | Poseidon2 hash for Noir |

### Soroban Contract

| Dependency | Version | Purpose |
|---|---|---|
| `soroban-sdk` | 26.0.1 | Smart contract SDK |
| `rs-soroban-ultrahonk` | latest | UltraHonk verifier (cross-contract) |

### TypeScript (SDK, Matcher, Frontend)

| Dependency | Purpose |
|---|---|
| `@stellar/stellar-sdk` | Soroban RPC, SAC, tx building |
| `@noir-lang/noir_js` | Circuit execution, witness gen |
| `@aztec/bb.js` | UltraHonk proof gen in JS |
| `react` + `vite` | Frontend |
| `tailwindcss` + `shadcn/ui` | UI components |

---

## 18. References

- [rs-soroban-ultrahonk](https://github.com/yugocabrio/rs-soroban-ultrahonk)
- [Noir Documentation](https://noir-lang.org/docs/)
- [Stellar Asset Contract](https://developers.stellar.org/docs/tokens/stellar-asset-contract)
- [Soroban Overview](https://developers.stellar.org/docs/build/smart-contracts/overview)
- [Polyhedra Dark Pool DEX](https://blog.polyhedra.network/proposal-for-a-fully-on-chain-dark-pool-dex/)
- [Renegade Dark Pool](https://jamesbachini.com/renegade/)
- [CAP-0074: BN254](https://stellar.org/protocol/cap-0074)
- [CAP-0075: Poseidon](https://stellar.org/protocol/cap-0075)
- [Tornado Cash Nova](https://github.com/tornadocash/tornado-nova)
