#![no_std]

mod lending;
mod merkle;
mod types;

#[cfg(test)]
mod test;

use soroban_poseidon::Field;
use soroban_sdk::{
    contract, contractimpl, crypto::BnScalar, panic_with_error, token, xdr::ToXdr, Address, Bytes,
    BytesN, Env, IntoVal, InvokeError, MuxedAddress, Symbol, Val, Vec, U256,
};

use crate::types::{
    BridgeMintEvent, DataKey, DepositEvent, ObscuraError, OrderCancelledEvent, OrderMatchedEvent,
    OrderPlacedEvent, Position, PriceData, Reserve, RiskParams, TransferEvent, WithdrawEvent,
};

/// UltraHonk proof length (SHARED.md §6): exactly 456 * 32 bytes.
const PROOF_BYTES: usize = 456 * 32;

#[contract]
pub struct ObscuraPool;

#[contractimpl]
impl ObscuraPool {
    pub fn __constructor(
        env: Env,
        transfer_vf: Address,
        order_vf: Address,
        match_vf: Address,
        withdraw_vf: Address,
        cancel_vf: Address,
        native_asset: Address,
    ) {
        let s = env.storage().instance();
        s.set(&DataKey::TransferVf, &transfer_vf);
        s.set(&DataKey::OrderVf, &order_vf);
        s.set(&DataKey::MatchVf, &match_vf);
        s.set(&DataKey::WithdrawVf, &withdraw_vf);
        s.set(&DataKey::CancelVf, &cancel_vf);
        // The native-XLM SAC. Its canonical `asset_id` is `0` (SHARED §4), so
        // `withdraw` maps it to `0` instead of `hash2(addr_field, 0)`.
        s.set(&DataKey::NativeAsset, &native_asset);
    }

    /// Bridge: deposit a classic Stellar asset into Obscura. The amount is public;
    /// the depositor supplies the note `commitment` (computed off-chain from secret
    /// data) which is inserted as a Merkle leaf. No ZK proof required (SPEC §5.1).
    pub fn deposit(
        env: Env,
        from: Address,
        asset: Address,
        amount: i128,
        commitment: BytesN<32>,
    ) -> u32 {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, ObscuraError::InvalidAmount);
        }
        let token = token::Client::new(&env, &asset);
        let contract: MuxedAddress = env.current_contract_address().into();
        token.transfer(&from, &contract, &amount);

        let index = merkle::insert(&env, &commitment);
        DepositEvent {
            index,
            commitment,
            asset,
            amount,
        }
        .publish(&env);
        index
    }

    /// One-time setter that records the `ObscuraBridge` contract address allowed to
    /// call `bridge_mint` (BRIDGE_SPEC §3/§7). A setter (rather than a constructor
    /// arg) breaks the deploy-time circular dependency: the bridge needs the pool
    /// address and the pool needs the bridge address.
    ///
    /// Admin-gated and one-time: `admin` must authorise the call, must match the
    /// established governance admin if one already exists (reused from the binding
    /// work; otherwise this first caller establishes it), and the bridge can only
    /// be set while still unset.
    pub fn set_bridge(env: Env, admin: Address, bridge: Address) -> Result<(), ObscuraError> {
        admin.require_auth();
        let s = env.storage().instance();
        if s.has(&DataKey::Bridge) {
            return Err(ObscuraError::BridgeAlreadySet);
        }
        match s.get::<DataKey, Address>(&DataKey::Admin) {
            Some(existing) if existing != admin => return Err(ObscuraError::Unauthorized),
            None => s.set(&DataKey::Admin, &admin),
            _ => {}
        }
        s.set(&DataKey::Bridge, &bridge);
        Ok(())
    }

    /// Bridge: mint a shielded note for a bridged asset. Callable ONLY by the
    /// configured bridge contract (BRIDGE_SPEC §7). Inserts `commitment` into the
    /// same Merkle tree as native deposits — so bridged notes interoperate with
    /// transfer/swap — and returns the leaf index. No SAC transfer: the backing
    /// lives in the Ethereum L1 lock, not in this pool.
    pub fn bridge_mint(env: Env, commitment: BytesN<32>) -> Result<u32, ObscuraError> {
        let bridge: Address = env
            .storage()
            .instance()
            .get(&DataKey::Bridge)
            .ok_or(ObscuraError::BridgeNotSet)?;
        bridge.require_auth();

        let index = merkle::insert(&env, &commitment);
        BridgeMintEvent { index, commitment }.publish(&env);
        Ok(index)
    }

    /// The configured bridge contract address, if `set_bridge` has been called.
    pub fn bridge(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Bridge)
    }

    /// Bridge: withdraw from Obscura to a classic Stellar account.
    ///
    /// SHARED.md §7 — `withdraw` public inputs, in declared order:
    ///   [0] merkle_root  [1] nullifier  [2] recipient_hash  [3] amount  [4] asset_id
    pub fn withdraw(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        recipient: Address,
        amount: i128,
        asset: Address,
    ) -> Result<(), ObscuraError> {
        let f = parse_fields(&env, &public_inputs, 5)?;
        let root = f.get(0).unwrap();
        let nullifier = f.get(1).unwrap();
        let pub_recipient_hash = f.get(2).unwrap();
        let pub_amount = f.get(3).unwrap();
        let pub_asset_id = f.get(4).unwrap();

        if !merkle::is_known_root(&env, &root) {
            return Err(ObscuraError::UnknownRoot);
        }
        if is_spent(&env, &nullifier) {
            return Err(ObscuraError::NullifierUsed);
        }
        if amount <= 0 {
            return Err(ObscuraError::InvalidAmount);
        }
        // Bind the SAC transfer amount to the amount proven public in the circuit,
        // so a valid proof cannot be replayed against a different transfer amount.
        if pub_amount.to_array() != amount_to_field(amount) {
            return Err(ObscuraError::AmountMismatch);
        }
        // Bind the recipient/asset Addresses to the values the ZK proof commits to.
        // Without this a valid proof for one asset could draw a different pool-held
        // asset, or be redirected to a different recipient (SHARED §4/§7).
        if recipient_hash_of(&env, &recipient) != pub_recipient_hash {
            return Err(ObscuraError::RecipientMismatch);
        }
        if asset_id_of(&env, &asset) != pub_asset_id {
            return Err(ObscuraError::AssetMismatch);
        }
        verify(&env, DataKey::WithdrawVf, &public_inputs, &proof)?;

        mark_spent(&env, &nullifier);
        let token = token::Client::new(&env, &asset);
        let to: MuxedAddress = recipient.clone().into();
        token.transfer(&env.current_contract_address(), &to, &amount);
        WithdrawEvent {
            nullifier,
            recipient,
            asset,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Pay: private transfer. Consumes two input notes (nullifiers) and inserts two
    /// output note commitments.
    ///
    /// SHARED.md §7 — `transfer` public inputs, in declared order:
    ///   [0] merkle_root [1] nullifier_0 [2] nullifier_1
    ///   [3] out_commitment_0 [4] out_commitment_1 [5] ext_data_hash
    ///
    /// `memos` are opaque, per-output encrypted note payloads (sealed to the output owner's
    /// viewing key), aligned with the two output commitments. The contract treats them as
    /// untrusted transport and just re-emits them in `TransferEvent`; a recipient scans
    /// those events, trial-decrypts, and only accepts a note whose commitment matches an
    /// emitted output — so a forged/tampered memo can never mint balance (note discovery).
    pub fn transfer(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        memos: Vec<Bytes>,
    ) -> Result<(), ObscuraError> {
        let f = parse_fields(&env, &public_inputs, 6)?;
        let root = f.get(0).unwrap();
        let nullifier_0 = f.get(1).unwrap();
        let nullifier_1 = f.get(2).unwrap();
        let out_commitment_0 = f.get(3).unwrap();
        let out_commitment_1 = f.get(4).unwrap();

        if !merkle::is_known_root(&env, &root) {
            return Err(ObscuraError::UnknownRoot);
        }
        if nullifier_0 == nullifier_1 {
            return Err(ObscuraError::DuplicateNullifier);
        }
        if is_spent(&env, &nullifier_0) || is_spent(&env, &nullifier_1) {
            return Err(ObscuraError::NullifierUsed);
        }
        verify(&env, DataKey::TransferVf, &public_inputs, &proof)?;

        mark_spent(&env, &nullifier_0);
        mark_spent(&env, &nullifier_1);
        let index_0 = merkle::insert(&env, &out_commitment_0);
        let index_1 = merkle::insert(&env, &out_commitment_1);

        let mut nullifiers = Vec::new(&env);
        nullifiers.push_back(nullifier_0);
        nullifiers.push_back(nullifier_1);
        let mut commitments = Vec::new(&env);
        commitments.push_back(out_commitment_0);
        commitments.push_back(out_commitment_1);
        let mut indices = Vec::new(&env);
        indices.push_back(index_0);
        indices.push_back(index_1);
        TransferEvent {
            nullifiers,
            commitments,
            indices,
            memos,
        }
        .publish(&env);
        Ok(())
    }

    /// Swap: place a hidden order. Locks a balance note (nullifier), registers the
    /// opaque order commitment in the active set, and inserts the change note if any.
    ///
    /// SHARED.md §7 — `place_order` public inputs, in declared order:
    ///   [0] merkle_root [1] nullifier [2] order_commitment
    ///   [3] change_commitment [4] locked_asset_id
    pub fn place_order(env: Env, proof: Bytes, public_inputs: Bytes) -> Result<(), ObscuraError> {
        let f = parse_fields(&env, &public_inputs, 5)?;
        let root = f.get(0).unwrap();
        let nullifier = f.get(1).unwrap();
        let order_commitment = f.get(2).unwrap();
        let change_commitment = f.get(3).unwrap();

        if !merkle::is_known_root(&env, &root) {
            return Err(ObscuraError::UnknownRoot);
        }
        if is_spent(&env, &nullifier) {
            return Err(ObscuraError::NullifierUsed);
        }
        if order_active(&env, &order_commitment) {
            return Err(ObscuraError::DuplicateOrder);
        }
        verify(&env, DataKey::OrderVf, &public_inputs, &proof)?;

        mark_spent(&env, &nullifier);
        add_order(&env, &order_commitment);
        if !is_zero(&change_commitment) {
            merkle::insert(&env, &change_commitment);
        }
        OrderPlacedEvent {
            order_commitment,
            change_commitment,
        }
        .publish(&env);
        Ok(())
    }

    /// Swap: match two compatible orders. Removes both orders, inserts the two
    /// settlement notes, re-registers any residual orders, and inserts any refund
    /// notes. The circuit proves compatibility / fair pricing; the contract only
    /// manages the active-order set and the note tree.
    ///
    /// SHARED.md §7 — `match_orders` public inputs, in declared order:
    ///   [0] order_commitment_a [1] order_commitment_b
    ///   [2] fill_note_buyer [3] fill_note_seller
    ///   [4] residual_order_a [5] residual_order_b
    ///   [6] refund_note_a [7] refund_note_b
    /// `leaf_memos` are sealed note payloads for the inserted leaves (fills, then any non-zero
    /// refunds, in that order); `residual_memos` deliver each non-zero residual order's secret
    /// to its owner. Both are untrusted transport, bound by count to the actual outputs and
    /// re-emitted in `OrderMatchedEvent` — a memo can never mint balance (its commitment must
    /// be a real emitted output), it only lets the owner discover what it already received.
    pub fn match_orders(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        leaf_memos: Vec<Bytes>,
        residual_memos: Vec<Bytes>,
    ) -> Result<(), ObscuraError> {
        let f = parse_fields(&env, &public_inputs, 8)?;
        let order_a = f.get(0).unwrap();
        let order_b = f.get(1).unwrap();
        let fill_buyer = f.get(2).unwrap();
        let fill_seller = f.get(3).unwrap();
        let residual_a = f.get(4).unwrap();
        let residual_b = f.get(5).unwrap();
        let refund_a = f.get(6).unwrap();
        let refund_b = f.get(7).unwrap();

        if order_a == order_b {
            return Err(ObscuraError::DuplicateOrder);
        }
        if !order_active(&env, &order_a) || !order_active(&env, &order_b) {
            return Err(ObscuraError::OrderNotActive);
        }

        // Bind the memo lists to the actual outputs (2 fills + non-zero refunds; non-zero
        // residuals) so the matcher can't misalign or omit a delivery.
        let expected_leaves =
            2 + (!is_zero(&refund_a)) as u32 + (!is_zero(&refund_b)) as u32;
        let expected_residuals = (!is_zero(&residual_a)) as u32 + (!is_zero(&residual_b)) as u32;
        if leaf_memos.len() != expected_leaves || residual_memos.len() != expected_residuals {
            return Err(ObscuraError::InvalidPublicInputs);
        }

        verify(&env, DataKey::MatchVf, &public_inputs, &proof)?;

        remove_order(&env, &order_a);
        remove_order(&env, &order_b);

        // Tree leaves: the two fills, then any non-zero refunds — in this exact order.
        let mut leaf_commitments: Vec<BytesN<32>> = Vec::new(&env);
        let mut leaf_indices: Vec<u32> = Vec::new(&env);
        for c in [Some(fill_buyer), Some(fill_seller), opt_nonzero(refund_a), opt_nonzero(refund_b)] {
            if let Some(c) = c {
                let idx = merkle::insert(&env, &c);
                leaf_commitments.push_back(c);
                leaf_indices.push_back(idx);
            }
        }

        // Residual orders re-enter the active set (their funds stay locked in them).
        let mut residual_commitments = Vec::new(&env);
        if !is_zero(&residual_a) {
            add_order(&env, &residual_a);
            residual_commitments.push_back(residual_a);
        }
        if !is_zero(&residual_b) {
            add_order(&env, &residual_b);
            residual_commitments.push_back(residual_b);
        }

        OrderMatchedEvent {
            order_a,
            order_b,
            leaf_commitments,
            leaf_indices,
            leaf_memos,
            residual_commitments,
            residual_memos,
        }
        .publish(&env);
        Ok(())
    }

    /// Swap: cancel an open order, returning the locked funds as a new balance note.
    ///
    /// SHARED.md §7 — `cancel_order` public inputs, in declared order:
    ///   [0] order_commitment [1] refund_commitment [2] refund_asset_id
    pub fn cancel_order(env: Env, proof: Bytes, public_inputs: Bytes) -> Result<(), ObscuraError> {
        let f = parse_fields(&env, &public_inputs, 3)?;
        let order_commitment = f.get(0).unwrap();
        let refund_commitment = f.get(1).unwrap();

        if !order_active(&env, &order_commitment) {
            return Err(ObscuraError::OrderNotActive);
        }
        verify(&env, DataKey::CancelVf, &public_inputs, &proof)?;

        remove_order(&env, &order_commitment);
        merkle::insert(&env, &refund_commitment);
        OrderCancelledEvent {
            order_commitment,
            refund: refund_commitment,
        }
        .publish(&env);
        Ok(())
    }

    // =======================================================================
    // Lending (LENDING_SPEC). Collateral amounts are PUBLIC so a stale position
    // can be seized with no keeper; debt is PRIVATE and never stored here.
    // =======================================================================

    /// One-time, admin-gated registration of the seven lending verifiers and the
    /// initial risk parameters. A setter rather than constructor args: the pool
    /// was deployed with a 6-arg constructor and widening it to 13 would break
    /// the existing deploy script for no benefit.
    pub fn set_lending_verifiers(
        env: Env,
        admin: Address,
        position_open_vf: Address,
        borrow_vf: Address,
        repay_vf: Address,
        withdraw_collateral_vf: Address,
        attest_vf: Address,
        supply_vf: Address,
        redeem_vf: Address,
    ) -> Result<(), ObscuraError> {
        admin.require_auth();
        let s = env.storage().instance();
        match s.get::<DataKey, Address>(&DataKey::Admin) {
            Some(existing) if existing != admin => return Err(ObscuraError::Unauthorized),
            None => s.set(&DataKey::Admin, &admin),
            _ => {}
        }
        s.set(&DataKey::PositionOpenVf, &position_open_vf);
        s.set(&DataKey::BorrowVf, &borrow_vf);
        s.set(&DataKey::RepayVf, &repay_vf);
        s.set(&DataKey::WithdrawCollateralVf, &withdraw_collateral_vf);
        s.set(&DataKey::AttestVf, &attest_vf);
        s.set(&DataKey::SupplyVf, &supply_vf);
        s.set(&DataKey::RedeemVf, &redeem_vf);
        Ok(())
    }

    /// Admin-set governance risk parameters. All of these reach the circuits as
    /// public inputs, so changing them recompiles nothing.
    pub fn set_risk_params(
        env: Env,
        admin: Address,
        params: RiskParams,
    ) -> Result<(), ObscuraError> {
        admin.require_auth();
        match env.storage().instance().get::<DataKey, Address>(&DataKey::Admin) {
            Some(existing) if existing != admin => return Err(ObscuraError::Unauthorized),
            None => env.storage().instance().set(&DataKey::Admin, &admin),
            _ => {}
        }
        env.storage().instance().set(&DataKey::RiskParams, &params);
        Ok(())
    }

    /// PLACEHOLDER price feed. Pushing prices makes `admin` a TRUSTED party: a
    /// wrong price can get a healthy position seized, or let an underwater one
    /// attest. Replacing this with Reflector means changing only
    /// `lending::oracle_price`; the staleness gate is unaffected.
    pub fn set_price(
        env: Env,
        admin: Address,
        asset: Address,
        price: i128,
    ) -> Result<(), ObscuraError> {
        admin.require_auth();
        match env.storage().instance().get::<DataKey, Address>(&DataKey::Admin) {
            Some(existing) if existing != admin => return Err(ObscuraError::Unauthorized),
            None => env.storage().instance().set(&DataKey::Admin, &admin),
            _ => {}
        }
        if price <= 0 {
            return Err(ObscuraError::InvalidAmount);
        }
        let asset_id = asset_id_of(&env, &asset);
        env.storage().persistent().set(
            &DataKey::Price(asset_id),
            &PriceData {
                price,
                ledger: env.ledger().sequence(),
            },
        );
        Ok(())
    }

    pub fn open_position(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        collateral_asset: Address,
        collateral_amount: i128,
    ) -> Result<(), ObscuraError> {
        lending::open_position(&env, proof, public_inputs, collateral_asset, collateral_amount)
    }

    pub fn borrow(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        old_position: BytesN<32>,
        debt_asset: Address,
        borrow_amount: i128,
        memo: Bytes,
    ) -> Result<(), ObscuraError> {
        lending::borrow(
            &env,
            proof,
            public_inputs,
            old_position,
            debt_asset,
            borrow_amount,
            memo,
        )
    }

    pub fn repay(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        old_position: BytesN<32>,
        debt_asset: Address,
        repay_amount: i128,
    ) -> Result<(), ObscuraError> {
        lending::repay(&env, proof, public_inputs, old_position, debt_asset, repay_amount)
    }

    pub fn withdraw_collateral(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        old_position: BytesN<32>,
        new_collateral_amount: i128,
        memo: Bytes,
    ) -> Result<(), ObscuraError> {
        lending::withdraw_collateral(
            &env,
            proof,
            public_inputs,
            old_position,
            new_collateral_amount,
            memo,
        )
    }

    /// Refresh a position's deadline by proving it is still above the liquidation
    /// threshold. Returns the new deadline.
    pub fn attest_solvency(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
    ) -> Result<u32, ObscuraError> {
        lending::attest_solvency(&env, proof, public_inputs)
    }

    /// Seize a position whose deadline elapsed. Needs no proof — the collateral
    /// figure is public, which is the whole point of the design.
    pub fn liquidate_stale(
        env: Env,
        liquidator: Address,
        position: BytesN<32>,
    ) -> Result<i128, ObscuraError> {
        lending::liquidate_stale(&env, liquidator, position)
    }

    pub fn supply(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        asset: Address,
        amount: i128,
        memo: Bytes,
    ) -> Result<(), ObscuraError> {
        lending::supply(&env, proof, public_inputs, asset, amount, memo)
    }

    pub fn redeem(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        asset: Address,
        amount: i128,
        memos: Vec<Bytes>,
    ) -> Result<(), ObscuraError> {
        lending::redeem(&env, proof, public_inputs, asset, amount, memos)
    }

    /// Read a live position. Collateral is public; debt is absent because the
    /// contract does not know it.
    pub fn get_position(env: Env, commitment: BytesN<32>) -> Option<Position> {
        lending::get_position(&env, &commitment)
    }

    /// Per-asset reserve state, accrued to the current ledger.
    pub fn get_reserve(env: Env, asset: Address) -> Reserve {
        let id = asset_id_of(&env, &asset);
        lending::reserve_accrued(&env, &id)
    }

    pub fn get_risk_params(env: Env) -> RiskParams {
        lending::risk_params(&env)
    }

    pub fn get_price(env: Env, asset: Address) -> Result<i128, ObscuraError> {
        let id = asset_id_of(&env, &asset);
        lending::oracle_price(&env, &id)
    }

    pub fn get_last_root(env: Env) -> BytesN<32> {
        merkle::last_root(&env)
    }

    pub fn is_known_root(env: Env, root: BytesN<32>) -> bool {
        merkle::is_known_root(&env, &root)
    }

    pub fn is_spent(env: Env, nullifier: BytesN<32>) -> bool {
        is_spent(&env, &nullifier)
    }

    pub fn is_active_order(env: Env, commitment: BytesN<32>) -> bool {
        order_active(&env, &commitment)
    }

    /// Canonical `Address -> Field` used to bind on-chain SAC/recipient Addresses to
    /// the field elements the ZK circuit commits to. Mirrors the SDK's `addressToField`
    /// byte-for-byte: take the raw 32-byte key (ed25519 pubkey for `G…`, contract-id
    /// hash for `C…`) interpreted big-endian and reduced mod the BN254 scalar modulus.
    pub fn address_to_field(env: Env, address: Address) -> BytesN<32> {
        address_to_field(&env, &address)
    }

    /// `asset_id` for a SAC `asset`: `0` for the configured native-XLM SAC, else
    /// `hash2(address_to_field(asset), 0)` (SHARED §4).
    pub fn asset_id_of(env: Env, asset: Address) -> BytesN<32> {
        asset_id_of(&env, &asset)
    }

    /// `recipient_hash = hash2(address_to_field(recipient), 0)` (SHARED §7).
    pub fn recipient_hash_of(env: Env, recipient: Address) -> BytesN<32> {
        recipient_hash_of(&env, &recipient)
    }
}

/// Cross-contract call to the per-circuit UltraHonk verifier. Public inputs FIRST,
/// then proof, exactly per SHARED.md §6 (mirrors the reference mixer).
fn verify(
    env: &Env,
    vf_key: DataKey,
    public_inputs: &Bytes,
    proof: &Bytes,
) -> Result<(), ObscuraError> {
    if proof.len() as usize != PROOF_BYTES {
        return Err(ObscuraError::VerificationFailed);
    }
    let verifier: Address = env
        .storage()
        .instance()
        .get(&vf_key)
        .ok_or(ObscuraError::VerifierNotSet)?;
    let mut args: Vec<Val> = Vec::new(env);
    args.push_back(public_inputs.into_val(env));
    args.push_back(proof.into_val(env));
    env.try_invoke_contract::<(), InvokeError>(&verifier, &Symbol::new(env, "verify_proof"), args)
        .map_err(|_| ObscuraError::VerificationFailed)?
        .map_err(|_| ObscuraError::VerificationFailed)
}

/// Parse `public_inputs` as `n` consecutive 32-byte big-endian field elements.
fn parse_fields(
    env: &Env,
    public_inputs: &Bytes,
    n: u32,
) -> Result<Vec<BytesN<32>>, ObscuraError> {
    if public_inputs.len() != n * 32 {
        return Err(ObscuraError::InvalidPublicInputs);
    }
    let mut out = Vec::new(env);
    let mut i = 0u32;
    while i < n {
        let mut field = [0u8; 32];
        public_inputs
            .slice(i * 32..i * 32 + 32)
            .copy_into_slice(&mut field);
        out.push_back(BytesN::from_array(env, &field));
        i += 1;
    }
    Ok(out)
}

/// 32-byte big-endian canonical field encoding of a non-negative `amount` (< 2^127).
fn amount_to_field(amount: i128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..32].copy_from_slice(&amount.to_be_bytes());
    out
}

/// Canonical `Address -> Field`, byte-identical to the SDK's `addressToField`
/// (`sdk/src/stellar.ts`): the raw 32-byte key of the address — the ed25519 public key
/// for `G…` accounts, the contract-id hash for `C…` contracts — interpreted big-endian
/// and reduced mod the BN254 scalar modulus `r`.
///
/// The raw 32 bytes are recovered from the address' XDR: `Address` serializes to
/// `ScVal::Address(ScAddress)`, whose account (`…Account/PublicKey/Ed25519`) and
/// contract (`…Contract/Hash`) encodings both END with the 32-byte key, so the trailing
/// 32 bytes of `to_xdr` are exactly the key the SDK obtains via `StrKey.decode*`.
fn address_to_field(env: &Env, address: &Address) -> BytesN<32> {
    let xdr = address.clone().to_xdr(env);
    let len = xdr.len();
    let mut raw = [0u8; 32];
    xdr.slice(len - 32..len).copy_into_slice(&mut raw);

    let modulus = <BnScalar as Field>::modulus(env);
    let reduced = U256::from_be_bytes(env, &Bytes::from_array(env, &raw)).rem_euclid(&modulus);
    let mut out = [0u8; 32];
    reduced.to_be_bytes().copy_into_slice(&mut out);
    BytesN::from_array(env, &out)
}

fn zero_field(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

/// `recipient_hash = hash2(address_to_field(recipient), 0)` (SHARED §7).
fn recipient_hash_of(env: &Env, recipient: &Address) -> BytesN<32> {
    merkle::poseidon2_hash2(env, &address_to_field(env, recipient), &zero_field(env))
}

/// `asset_id` for a SAC `asset`: the native-XLM SAC maps to the canonical native
/// `asset_id = 0` (SHARED §4); every other SAC maps to `hash2(address_to_field(asset), 0)`.
fn asset_id_of(env: &Env, asset: &Address) -> BytesN<32> {
    if let Some(native) = env
        .storage()
        .instance()
        .get::<DataKey, Address>(&DataKey::NativeAsset)
    {
        if &native == asset {
            return zero_field(env);
        }
    }
    merkle::poseidon2_hash2(env, &address_to_field(env, asset), &zero_field(env))
}

fn is_zero(b: &BytesN<32>) -> bool {
    b.to_array() == [0u8; 32]
}

/// `Some(c)` unless `c` is the zero field (a zero commitment means the output is absent).
fn opt_nonzero(c: BytesN<32>) -> Option<BytesN<32>> {
    if is_zero(&c) {
        None
    } else {
        Some(c)
    }
}

fn is_spent(env: &Env, nullifier: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Nullifier(nullifier.clone()))
}

fn mark_spent(env: &Env, nullifier: &BytesN<32>) {
    env.storage()
        .persistent()
        .set(&DataKey::Nullifier(nullifier.clone()), &true);
}

fn order_active(env: &Env, commitment: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Order(commitment.clone()))
}

fn add_order(env: &Env, commitment: &BytesN<32>) {
    env.storage()
        .persistent()
        .set(&DataKey::Order(commitment.clone()), &true);
}

fn remove_order(env: &Env, commitment: &BytesN<32>) {
    env.storage()
        .persistent()
        .remove(&DataKey::Order(commitment.clone()));
}
