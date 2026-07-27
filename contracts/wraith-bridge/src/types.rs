use soroban_sdk::{contracterror, contractevent, contracttype, BytesN};

/// Instance / persistent storage keys for `WraithBridge`.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// `Address`: the deployed `EthLightClient` (cross-called for `state_root_at`).
    LightClient,
    /// `Address`: the deployed `WraithPool` (cross-called for `bridge_mint` /
    /// `is_known_root`).
    Pool,
    /// `u32`: the Ethereum L1 chain id the bridge is bound to (Sepolia). Recorded
    /// for the relayer / asset-id derivation; the commitment already encodes it.
    L1ChainId,
    /// `BytesN<20>`: the `WraithBridgeL1` escrow address on Ethereum whose `locks`
    /// mapping is proven by `bridge_in`.
    L1BridgeAddr,
    /// `Address`: the existing UltraHonk **withdraw** verifier reused by
    /// `bridge_out` (BRIDGE_SPEC §7).
    WithdrawVf,
    /// Replay guard: marks an L1-lock `commitment` already minted inbound, so one
    /// lock mints exactly once (BRIDGE_SPEC §12).
    Bridged(BytesN<32>),
    /// Spent set for outbound notes: marks a `nullifier` already bridged out.
    Nullifier(BytesN<32>),
}

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum BridgeError {
    /// The light client has no proven execution `state_root` for `block_number`.
    UnknownBlock = 1,
    /// The MPT account/storage proof did not verify against the trusted state root.
    ProofInvalid = 2,
    /// The token decoded from the proven `locks` record != the `token` argument.
    TokenMismatch = 3,
    /// The amount decoded from the proven `locks` record != the `amount` argument.
    AmountMismatch = 4,
    /// `commitment` was already bridged in (replay guard, BRIDGE_SPEC §12).
    AlreadyBridged = 5,
    /// The cross-call to `pool.bridge_mint` failed.
    MintFailed = 6,
    /// `public_inputs` was not the expected number of 32-byte field elements.
    InvalidPublicInputs = 7,
    /// The outbound note `nullifier` was already spent via `bridge_out`.
    NullifierUsed = 8,
    /// `l1_recipient` does not derive the proof's public `recipient_hash`.
    RecipientMismatch = 9,
    /// The `bridge_out` merkle root is not a root the pool knows.
    UnknownRoot = 10,
    /// The withdraw-circuit proof failed to verify.
    ProofVerifyFailed = 11,
}

/// Emitted on a successful trustless inbound mint. The relayer / frontend track
/// this to surface the shielded note in the portfolio (BRIDGE_SPEC §7).
#[contractevent(topics = ["bridge_in"], data_format = "map")]
pub struct BridgeInEvent {
    #[topic]
    pub commitment: BytesN<32>,
    pub token: BytesN<20>,
    pub amount: i128,
    pub block_number: u64,
}

/// Emitted on a successful outbound burn. The relayer settles this on Ethereum
/// via `WraithBridgeL1.unlock` (BRIDGE_SPEC §7/§8).
#[contractevent(topics = ["bridge_out"], data_format = "map")]
pub struct BridgeOutEvent {
    #[topic]
    pub nullifier: BytesN<32>,
    pub l1_recipient: BytesN<20>,
    pub amount: i128,
}
