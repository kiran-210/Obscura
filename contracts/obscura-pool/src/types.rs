use soroban_sdk::{contracterror, contractevent, contracttype, Address, Bytes, BytesN, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    TransferVf,
    OrderVf,
    MatchVf,
    WithdrawVf,
    CancelVf,
    /// The native-XLM SAC address. Its canonical `asset_id` is `0` (SHARED §4),
    /// so `withdraw` recognises it specially when binding `asset` to the proof.
    NativeAsset,
    /// Governance admin. Reused from the binding work if already established;
    /// otherwise set on the first `set_bridge` call. Only this admin may
    /// (re)configure the bridge address.
    Admin,
    /// The `ObscuraBridge` contract address authorised to call `bridge_mint`
    /// (BRIDGE_SPEC §3/§7). Set once via `set_bridge` after the bridge deploys.
    Bridge,
    NextIndex,
    Roots,
    Frontier(u32),
    Nullifier(BytesN<32>),
    Order(BytesN<32>),

    // ---- lending (LENDING_SPEC) ------------------------------------------
    // Set via `set_lending_verifiers` rather than the constructor: the pool was
    // already deployed with a 6-arg constructor, and widening it to 13 would
    // break the existing deploy script for no benefit.
    PositionOpenVf,
    BorrowVf,
    RepayVf,
    WithdrawCollateralVf,
    AttestVf,
    SupplyVf,
    RedeemVf,
    /// Live position registry, keyed by position commitment. Positions are
    /// necessarily distinguishable from ordinary notes -- enforcing a deadline
    /// requires the contract to know which commitments are positions
    /// (LENDING_SPEC §1.1).
    Position(BytesN<32>),
    /// Per-asset reserve accounting, keyed by `asset_id`.
    Reserve(BytesN<32>),
    /// Placeholder price feed, keyed by `asset_id`. See `set_price`.
    Price(BytesN<32>),
    /// Governance risk parameters (LTV, liquidation threshold, attestation period).
    RiskParams,
}

/// A live lending position. `collateral_*` is PUBLIC by design: it is what makes
/// a stale position seizable by anyone with no keeper (LENDING_SPEC §1). The debt
/// is NOT here -- it lives only inside the position commitment.
#[contracttype]
#[derive(Clone)]
pub struct Position {
    pub collateral_asset: Address,
    pub collateral_amount: i128,
    pub debt_asset: Address,
    /// Ledger sequence after which this position may be seized.
    pub deadline: u32,
}

/// Per-asset reserve. Indices are fixed-point with `INDEX_SCALE` = 1e9.
#[contracttype]
#[derive(Clone)]
pub struct Reserve {
    pub total_supplied: i128,
    pub total_borrowed: i128,
    pub borrow_index: i128,
    pub supply_index: i128,
    /// Ledger at which the indices were last accrued.
    pub last_accrual: u32,
}

/// Governance-settable risk parameters. These are PLACEHOLDERS: `Verdex_PRD.md`
/// was not supplied. All are passed to the circuits as public inputs, so they can
/// change without recompiling any circuit.
#[contracttype]
#[derive(Clone)]
pub struct RiskParams {
    /// Borrow ceiling in basis points (placeholder 7500 = 75%).
    pub max_ltv_bps: u32,
    /// Liquidation threshold in basis points (placeholder 8000 = 80%).
    pub liq_threshold_bps: u32,
    /// Ledgers a solvency attestation stays valid for.
    pub attestation_period: u32,
    /// Maximum age in ledgers of an oracle price before it is refused.
    pub max_price_age: u32,
}

/// A price observation. `ledger` gates staleness so a favourable price cannot be
/// replayed indefinitely (LENDING_SPEC §6).
#[contracttype]
#[derive(Clone)]
pub struct PriceData {
    pub price: i128,
    pub ledger: u32,
}

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ObscuraError {
    VerifierNotSet = 1,
    VerificationFailed = 2,
    InvalidPublicInputs = 3,
    UnknownRoot = 4,
    NullifierUsed = 5,
    DuplicateNullifier = 6,
    OrderNotActive = 7,
    DuplicateOrder = 8,
    TreeFull = 9,
    InvalidAmount = 10,
    AmountMismatch = 11,
    /// The SAC `asset` Address does not derive the proof's public `asset_id`.
    AssetMismatch = 12,
    /// The `recipient` Address does not derive the proof's public `recipient_hash`.
    RecipientMismatch = 13,
    /// `set_bridge` was called by an address other than the established admin.
    Unauthorized = 14,
    /// `bridge_mint` was called but no bridge address has been configured yet.
    BridgeNotSet = 15,
    /// `set_bridge` was called after the bridge was already configured (one-time).
    BridgeAlreadySet = 16,

    // ---- lending (LENDING_SPEC) ------------------------------------------
    /// No position is registered under that commitment.
    PositionNotFound = 17,
    /// A position is already registered under that commitment.
    PositionExists = 18,
    /// `liquidate_stale` called before `deadline` elapsed.
    PositionNotStale = 19,
    /// A position whose attestation deadline has passed may not borrow, repay,
    /// withdraw collateral, or be mutated -- only seized.
    PositionStale = 20,
    /// The proof's public price does not match the contract's oracle reading.
    PriceMismatch = 21,
    /// The oracle price for this asset is older than `max_price_age` ledgers.
    StalePrice = 22,
    /// The reserve does not hold enough free liquidity to satisfy this borrow or
    /// redemption. The circuit proves entitlement, not availability.
    InsufficientLiquidity = 23,
    /// A lending entrypoint was called before `set_lending_verifiers`.
    LendingNotConfigured = 24,
    /// The proof's public `borrow_index` / `supply_index` disagrees with the
    /// reserve's accrued index.
    IndexMismatch = 25,
    /// No price has ever been recorded for this asset.
    PriceNotSet = 26,
}

#[contractevent(topics = ["deposit"], data_format = "map")]
pub struct DepositEvent {
    #[topic]
    pub index: u32,
    pub commitment: BytesN<32>,
    pub asset: Address,
    pub amount: i128,
}

#[contractevent(topics = ["bridge_mint"], data_format = "map")]
pub struct BridgeMintEvent {
    #[topic]
    pub index: u32,
    pub commitment: BytesN<32>,
}

#[contractevent(topics = ["withdraw"], data_format = "map")]
pub struct WithdrawEvent {
    #[topic]
    pub nullifier: BytesN<32>,
    pub recipient: Address,
    pub asset: Address,
    pub amount: i128,
}

#[contractevent(topics = ["transfer"], data_format = "map")]
pub struct TransferEvent {
    pub nullifiers: Vec<BytesN<32>>,
    pub commitments: Vec<BytesN<32>>,
    /// Leaf indices of `commitments`, in order — lets a recipient locate the note's leaf.
    pub indices: Vec<u32>,
    /// Opaque per-output encrypted note payloads (sealed-box to the owner's viewing key),
    /// aligned with `commitments`. Untrusted transport: a recipient trial-decrypts and
    /// only accepts a note whose commitment is present above (SPEC — note discovery).
    pub memos: Vec<Bytes>,
}

#[contractevent(topics = ["order_placed"], data_format = "map")]
pub struct OrderPlacedEvent {
    #[topic]
    pub order_commitment: BytesN<32>,
    pub change_commitment: BytesN<32>,
}

#[contractevent(topics = ["order_matched"], data_format = "map")]
pub struct OrderMatchedEvent {
    #[topic]
    pub order_a: BytesN<32>,
    #[topic]
    pub order_b: BytesN<32>,
    /// Settlement notes inserted as Merkle leaves — the two fills, then any non-zero refunds,
    /// in insertion order. Aligned with `leaf_indices` and `leaf_memos`. Lets a recipient's
    /// indexer rebuild the tree and discover its fill/refund notes (same model as `transfer`).
    pub leaf_commitments: Vec<BytesN<32>>,
    /// Leaf indices of `leaf_commitments`, in order.
    pub leaf_indices: Vec<u32>,
    /// Opaque per-leaf encrypted note payloads sealed to each note's owner (untrusted
    /// transport; a memo is only accepted for a commitment actually emitted here).
    pub leaf_memos: Vec<Bytes>,
    /// Residual orders re-registered in the active set (non-zero only) — NOT tree leaves.
    /// Aligned with `residual_memos`, which deliver each residual order's secret to its owner
    /// so it stays cancellable/manageable.
    pub residual_commitments: Vec<BytesN<32>>,
    pub residual_memos: Vec<Bytes>,
}

#[contractevent(topics = ["order_cancelled"], data_format = "map")]
pub struct OrderCancelledEvent {
    #[topic]
    pub order_commitment: BytesN<32>,
    pub refund: BytesN<32>,
}

// ---- lending events (LENDING_SPEC) ----------------------------------------
//
// Collateral figures appear in the clear here because they are public by design.
// Debt never does: the contract does not know it.

#[contractevent(topics = ["position_open"], data_format = "map")]
pub struct PositionOpenedEvent {
    #[topic]
    pub position: BytesN<32>,
    pub collateral_asset: Address,
    pub collateral_amount: i128,
    pub deadline: u32,
}

/// `amount` is public because a pooled protocol cannot stay solvent without
/// tracking aggregate borrowings (LENDING_SPEC §1.1).
#[contractevent(topics = ["borrow"], data_format = "map")]
pub struct BorrowEvent {
    #[topic]
    pub old_position: BytesN<32>,
    pub new_position: BytesN<32>,
    pub asset: Address,
    pub amount: i128,
    /// Leaf index of the minted borrowed note.
    pub index: u32,
    /// Sealed note payload for the borrower (untrusted transport, same model as
    /// `transfer`).
    pub memo: Bytes,
}

#[contractevent(topics = ["repay"], data_format = "map")]
pub struct RepayEvent {
    #[topic]
    pub old_position: BytesN<32>,
    pub new_position: BytesN<32>,
    pub asset: Address,
    pub amount: i128,
}

#[contractevent(topics = ["collateral_withdrawn"], data_format = "map")]
pub struct CollateralWithdrawnEvent {
    #[topic]
    pub old_position: BytesN<32>,
    pub new_position: BytesN<32>,
    pub asset: Address,
    pub amount: i128,
    pub index: u32,
    pub memo: Bytes,
}

/// Refreshes the deadline only. Mutates no notes, burns no nullifier, consumes no
/// tree leaf -- see LENDING_SPEC §2.
#[contractevent(topics = ["attested"], data_format = "map")]
pub struct AttestedEvent {
    #[topic]
    pub position: BytesN<32>,
    pub new_deadline: u32,
}

/// All-or-nothing: the caller takes the full public collateral and the protocol
/// writes off the hidden debt. Proportional liquidation is impossible here
/// because computing the surplus would require knowing the debt.
#[contractevent(topics = ["seized"], data_format = "map")]
pub struct SeizedEvent {
    #[topic]
    pub position: BytesN<32>,
    pub liquidator: Address,
    pub collateral_asset: Address,
    pub collateral_amount: i128,
}

#[contractevent(topics = ["supplied"], data_format = "map")]
pub struct SuppliedEvent {
    #[topic]
    pub supply_commitment: BytesN<32>,
    pub asset: Address,
    pub amount: i128,
    pub index: u32,
    pub memo: Bytes,
}

#[contractevent(topics = ["redeemed"], data_format = "map")]
pub struct RedeemedEvent {
    #[topic]
    pub nullifier: BytesN<32>,
    pub asset: Address,
    pub amount: i128,
    /// Leaf indices of the payout note and any remainder supply note.
    pub indices: Vec<u32>,
    pub memos: Vec<Bytes>,
}
