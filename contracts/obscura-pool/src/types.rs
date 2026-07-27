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
