#![cfg(test)]

extern crate std;
use std::vec::Vec as StdVec;

use soroban_poseidon::{poseidon2_hash, Field};
use soroban_sdk::{
    contract, contracterror, contractimpl,
    crypto::BnScalar,
    testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec as SorobanVec, U256,
};

use crate::merkle::TREE_DEPTH;
use crate::types::{DataKey, ObscuraError};
use crate::{ObscuraPool, ObscuraPoolClient};

const PROOF_BYTES: usize = 456 * 32;

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum MockErr {
    Rejected = 1,
}

#[contract]
pub struct MockVerifierOk;

#[contractimpl]
impl MockVerifierOk {
    pub fn verify_proof(_e: Env, _public_inputs: Bytes, _proof: Bytes) -> Result<(), MockErr> {
        Ok(())
    }
}

#[contract]
pub struct MockVerifierFail;

#[contractimpl]
impl MockVerifierFail {
    pub fn verify_proof(_e: Env, _public_inputs: Bytes, _proof: Bytes) -> Result<(), MockErr> {
        Err(MockErr::Rejected)
    }
}

fn be(x: u64) -> [u8; 32] {
    let mut a = [0u8; 32];
    a[24..32].copy_from_slice(&x.to_be_bytes());
    a
}

fn f(env: &Env, x: u64) -> BytesN<32> {
    BytesN::from_array(env, &be(x))
}

fn zero(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

/// Parse a 64-char (optionally `0x`-prefixed) hex string into a 32-byte array.
fn hex32(s: &str) -> [u8; 32] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let b = s.as_bytes();
    assert_eq!(b.len(), 64, "hex32 expects 64 hex chars");
    let mut out = [0u8; 32];
    let mut i = 0usize;
    while i < 32 {
        let hi = (b[i * 2] as char).to_digit(16).unwrap() as u8;
        let lo = (b[i * 2 + 1] as char).to_digit(16).unwrap() as u8;
        out[i] = (hi << 4) | lo;
        i += 1;
    }
    out
}

fn proof(env: &Env) -> Bytes {
    Bytes::from_slice(env, &[0u8; PROOF_BYTES])
}

fn pub_inputs(env: &Env, fields: &[BytesN<32>]) -> Bytes {
    let mut b = Bytes::new(env);
    for field in fields {
        b.extend_from_array(&field.to_array());
    }
    b
}

struct Ctx {
    env: Env,
    client: ObscuraPoolClient<'static>,
    pool: Address,
    asset: Address,
    native: Address,
    user: Address,
}

fn setup(ok: bool) -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let verifier = if ok {
        env.register(MockVerifierOk, ())
    } else {
        env.register(MockVerifierFail, ())
    };
    // Stand-in native-XLM SAC; distinct from `asset` so the two asset_id paths
    // (native -> 0 vs. hash2(addr_field, 0)) are both exercised.
    let native = Address::generate(&env);
    let pool = env.register(
        ObscuraPool,
        (
            verifier.clone(),
            verifier.clone(),
            verifier.clone(),
            verifier.clone(),
            verifier.clone(),
            native.clone(),
        ),
    );
    let client = ObscuraPoolClient::new(&env, &pool);

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let asset = sac.address();
    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &asset).mint(&user, &1_000i128);

    Ctx {
        env,
        client,
        pool,
        asset,
        native,
        user,
    }
}

// --- Independent frontier-root reference (mirrors the SHARED §5 algorithm) ---

fn ref_hash2(env: &Env, a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let modulus = <BnScalar as Field>::modulus(env);
    let mut inputs = SorobanVec::new(env);
    inputs.push_back(U256::from_be_bytes(env, &Bytes::from_array(env, a)).rem_euclid(&modulus));
    inputs.push_back(U256::from_be_bytes(env, &Bytes::from_array(env, b)).rem_euclid(&modulus));
    let out = poseidon2_hash::<4, BnScalar>(env, &inputs);
    let mut o = [0u8; 32];
    out.to_be_bytes().copy_into_slice(&mut o);
    o
}

fn ref_zero(env: &Env, level: u32) -> [u8; 32] {
    let mut z = [0u8; 32];
    for _ in 0..level {
        let zz = z;
        z = ref_hash2(env, &zz, &zz);
    }
    z
}

fn ref_root(env: &Env, leaves: &[[u8; 32]], depth: u32) -> [u8; 32] {
    let mut frontier: StdVec<Option<[u8; 32]>> = std::vec![None; depth as usize];
    let mut root = ref_zero(env, depth);
    for (i, leaf) in leaves.iter().enumerate() {
        let idx = i as u32;
        let mut cur = *leaf;
        for level in 0..depth {
            let bit = (idx >> level) & 1;
            if bit == 0 {
                frontier[level as usize] = Some(cur);
                cur = ref_hash2(env, &cur, &ref_zero(env, level));
            } else {
                let left = frontier[level as usize]
                    .unwrap_or_else(|| ref_zero(env, level));
                cur = ref_hash2(env, &left, &cur);
            }
        }
        root = cur;
    }
    root
}

#[test]
fn merkle_root_matches_reference() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let v = Address::generate(&env);
    let pool = env.register(
        ObscuraPool,
        (
            v.clone(),
            v.clone(),
            v.clone(),
            v.clone(),
            v.clone(),
            v.clone(),
        ),
    );

    let mut leaves: StdVec<[u8; 32]> = StdVec::new();
    for i in 0u64..8 {
        leaves.push(ref_hash2(&env, &be(i), &be(i + 100)));
    }

    for (n, leaf) in leaves.iter().enumerate() {
        let leaf_bytes = BytesN::from_array(&env, leaf);
        env.as_contract(&pool, || {
            crate::merkle::insert(&env, &leaf_bytes);
        });
        let onchain = env.as_contract(&pool, || crate::merkle::last_root(&env));
        let expected = ref_root(&env, &leaves[0..=n], TREE_DEPTH);
        assert_eq!(onchain, BytesN::from_array(&env, &expected));
    }
}

#[test]
fn full_flow_deposit_order_match_withdraw() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;

    let idx = c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    assert_eq!(idx, 0);
    assert_eq!(TokenClient::new(env, &ctx.asset).balance(&ctx.pool), 1_000);

    let root0 = c.get_last_root();
    assert!(c.is_known_root(&root0));

    // place order O0 with a change note
    let (nf0, order0, change0, locked) = (f(env, 0x10), f(env, 0xA0), f(env, 0xCA), f(env, 1));
    c.place_order(
        &proof(env),
        &pub_inputs(env, &[root0.clone(), nf0.clone(), order0.clone(), change0, locked.clone()]),
    );
    assert!(c.is_active_order(&order0));
    assert!(c.is_spent(&nf0));

    // place order O1 with no change
    let root1 = c.get_last_root();
    let (nf1, order1) = (f(env, 0x11), f(env, 0xB0));
    c.place_order(
        &proof(env),
        &pub_inputs(env, &[root1, nf1, order1.clone(), zero(env), locked]),
    );
    assert!(c.is_active_order(&order1));

    // match O0 x O1 — two fills, no refunds/residuals → 2 leaf memos, 0 residual memos.
    let (fill_b, fill_s) = (f(env, 0xF1), f(env, 0xF2));
    let leaf_memos = SorobanVec::from_array(env, [Bytes::new(env), Bytes::new(env)]);
    let residual_memos: SorobanVec<Bytes> = SorobanVec::new(env);
    c.match_orders(
        &proof(env),
        &pub_inputs(
            env,
            &[
                order0.clone(),
                order1.clone(),
                fill_b,
                fill_s,
                zero(env),
                zero(env),
                zero(env),
                zero(env),
            ],
        ),
        &leaf_memos,
        &residual_memos,
    );
    assert!(!c.is_active_order(&order0));
    assert!(!c.is_active_order(&order1));
    // The match event carries both fill leaves + their indices + aligned memos.
    let root_after_match = c.get_last_root();
    assert!(c.is_known_root(&root_after_match));

    // withdraw 600 to a fresh recipient
    let recipient = Address::generate(env);
    let root = c.get_last_root();
    let nf_w = f(env, 0x20);
    let rh = c.recipient_hash_of(&recipient);
    let aid = c.asset_id_of(&ctx.asset);
    c.withdraw(
        &proof(env),
        &pub_inputs(env, &[root, nf_w.clone(), rh, f(env, 600), aid]),
        &recipient,
        &600i128,
        &ctx.asset,
    );
    assert_eq!(TokenClient::new(env, &ctx.asset).balance(&recipient), 600);
    assert_eq!(TokenClient::new(env, &ctx.asset).balance(&ctx.pool), 400);
    assert!(c.is_spent(&nf_w));
}

#[test]
fn withdraw_double_spend_rejected() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    let root = c.get_last_root();
    let recipient = Address::generate(env);
    let nf = f(env, 0x42);
    let pi = pub_inputs(
        env,
        &[
            root,
            nf,
            c.recipient_hash_of(&recipient),
            f(env, 100),
            c.asset_id_of(&ctx.asset),
        ],
    );

    c.withdraw(&proof(env), &pi, &recipient, &100i128, &ctx.asset);
    assert_eq!(
        c.try_withdraw(&proof(env), &pi, &recipient, &100i128, &ctx.asset),
        Err(Ok(ObscuraError::NullifierUsed))
    );
}

#[test]
fn withdraw_unknown_root_rejected() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    let recipient = Address::generate(env);
    let bad_root = f(env, 0xDEAD);
    let pi = pub_inputs(env, &[bad_root, f(env, 1), f(env, 0x99), f(env, 100), f(env, 1)]);
    assert_eq!(
        c.try_withdraw(&proof(env), &pi, &recipient, &100i128, &ctx.asset),
        Err(Ok(ObscuraError::UnknownRoot))
    );
}

#[test]
fn withdraw_amount_mismatch_rejected() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    let root = c.get_last_root();
    let recipient = Address::generate(env);
    // public amount says 100, but the SAC transfer arg says 900
    let pi = pub_inputs(env, &[root, f(env, 1), f(env, 0x99), f(env, 100), f(env, 1)]);
    assert_eq!(
        c.try_withdraw(&proof(env), &pi, &recipient, &900i128, &ctx.asset),
        Err(Ok(ObscuraError::AmountMismatch))
    );
}

#[test]
fn withdraw_verification_failure_rejected() {
    let ctx = setup(false); // failing mock verifier
    let env = &ctx.env;
    let c = &ctx.client;
    c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    let root = c.get_last_root();
    let recipient = Address::generate(env);
    // Correct recipient_hash / asset_id so the call clears the binding checks and
    // fails specifically at proof verification.
    let pi = pub_inputs(
        env,
        &[
            root,
            f(env, 1),
            c.recipient_hash_of(&recipient),
            f(env, 100),
            c.asset_id_of(&ctx.asset),
        ],
    );
    assert_eq!(
        c.try_withdraw(&proof(env), &pi, &recipient, &100i128, &ctx.asset),
        Err(Ok(ObscuraError::VerificationFailed))
    );
}

#[test]
fn transfer_consumes_two_nullifiers_and_inserts_two_notes() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    let root = c.get_last_root();
    let (nf0, nf1, out0, out1) = (f(env, 0x31), f(env, 0x32), f(env, 0xD0), f(env, 0xD1));
    let pi = pub_inputs(env, &[root, nf0.clone(), nf1.clone(), out0, out1, f(env, 0xE0)]);

    let memos = soroban_sdk::Vec::<soroban_sdk::Bytes>::new(env);
    c.transfer(&proof(env), &pi, &memos);
    assert!(c.is_spent(&nf0));
    assert!(c.is_spent(&nf1));

    // replay rejected (nullifiers spent)
    assert_eq!(
        c.try_transfer(&proof(env), &pi, &memos),
        Err(Ok(ObscuraError::NullifierUsed))
    );
}

#[test]
fn transfer_rejects_duplicate_nullifiers() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    let root = c.get_last_root();
    let nf = f(env, 0x55);
    let pi = pub_inputs(env, &[root, nf.clone(), nf, f(env, 0xD0), f(env, 0xD1), f(env, 0xE0)]);
    let memos = soroban_sdk::Vec::<soroban_sdk::Bytes>::new(env);
    assert_eq!(
        c.try_transfer(&proof(env), &pi, &memos),
        Err(Ok(ObscuraError::DuplicateNullifier))
    );
}

#[test]
fn order_lifecycle_place_then_cancel() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    let root = c.get_last_root();
    let order = f(env, 0xA1);

    c.place_order(
        &proof(env),
        &pub_inputs(env, &[root, f(env, 0x70), order.clone(), zero(env), f(env, 1)]),
    );
    assert!(c.is_active_order(&order));

    c.cancel_order(
        &proof(env),
        &pub_inputs(env, &[order.clone(), f(env, 0x4F), f(env, 1)]),
    );
    assert!(!c.is_active_order(&order));
}

#[test]
fn match_rejects_inactive_order() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    let pi = pub_inputs(
        env,
        &[
            f(env, 0xA0),
            f(env, 0xB0),
            f(env, 0xF1),
            f(env, 0xF2),
            zero(env),
            zero(env),
            zero(env),
            zero(env),
        ],
    );
    let leaf_memos = SorobanVec::from_array(env, [Bytes::new(env), Bytes::new(env)]);
    let residual_memos: SorobanVec<Bytes> = SorobanVec::new(env);
    assert_eq!(
        c.try_match_orders(&proof(env), &pi, &leaf_memos, &residual_memos),
        Err(Ok(ObscuraError::OrderNotActive))
    );
}

#[test]
fn match_rejects_memo_count_mismatch() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    let locked = f(env, 1);

    let root0 = c.get_last_root();
    c.place_order(
        &proof(env),
        &pub_inputs(env, &[root0, f(env, 0x10), f(env, 0xA0), zero(env), locked.clone()]),
    );
    let root1 = c.get_last_root();
    c.place_order(
        &proof(env),
        &pub_inputs(env, &[root1, f(env, 0x11), f(env, 0xB0), zero(env), locked]),
    );

    // Two fills (no refunds/residuals) expects exactly 2 leaf memos + 0 residual memos.
    let pi = pub_inputs(
        env,
        &[
            f(env, 0xA0),
            f(env, 0xB0),
            f(env, 0xF1),
            f(env, 0xF2),
            zero(env),
            zero(env),
            zero(env),
            zero(env),
        ],
    );
    let bad_leaf_memos = SorobanVec::from_array(env, [Bytes::new(env)]); // only 1, expected 2
    let residual_memos: SorobanVec<Bytes> = SorobanVec::new(env);
    assert_eq!(
        c.try_match_orders(&proof(env), &pi, &bad_leaf_memos, &residual_memos),
        Err(Ok(ObscuraError::InvalidPublicInputs))
    );
}

#[test]
fn place_order_unknown_root_rejected() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    let pi = pub_inputs(
        env,
        &[f(env, 0xBAD), f(env, 1), f(env, 0xA0), zero(env), f(env, 1)],
    );
    assert_eq!(
        c.try_place_order(&proof(env), &pi),
        Err(Ok(ObscuraError::UnknownRoot))
    );
}

/// Cross-implementation golden test: the on-chain `address_to_field` /
/// `asset_id_of` / `recipient_hash_of` must equal the SDK's `addressToField` /
/// `assetIdFromAddress` / `recipientHash` (sdk/src/stellar.ts) for the SAME StrKey
/// addresses. The golden constants below were generated from `sdk/dist` via:
///
///   node -e "import('./sdk/dist/index.js').then(m => {
///     const a = 'C...'|'G...';
///     console.log(m.fieldToHex(m.addressToField(a)),
///                 m.fieldToHex(m.assetIdFromAddress(a)),
///                 m.fieldToHex(m.recipientHash(a)));
///   })"
///
/// If the on-chain XDR extraction, big-endian interpretation, or mod-r reduction ever
/// diverges from the SDK, this assertion fails — so the binding cannot silently be
/// against the wrong field.
#[test]
fn address_to_field_matches_sdk_golden() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let v = Address::generate(&env);
    let pool = env.register(
        ObscuraPool,
        (
            v.clone(),
            v.clone(),
            v.clone(),
            v.clone(),
            v.clone(),
            v.clone(),
        ),
    );
    let c = ObscuraPoolClient::new(&env, &pool);

    // Contract address whose raw id = 32 × 0x22 (< r ⇒ reduction is a no-op).
    let cid = Address::from_str(&env, "CARCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEVQO");
    assert_eq!(
        c.address_to_field(&cid),
        BytesN::from_array(
            &env,
            &hex32("2222222222222222222222222222222222222222222222222222222222222222")
        )
    );
    let cid_id = BytesN::from_array(
        &env,
        &hex32("303fd488009b794a65badcb57f5b44cb6729b056bc1bd9bb9ebe50a36b0ae44d"),
    );
    assert_eq!(c.asset_id_of(&cid), cid_id);
    assert_eq!(c.recipient_hash_of(&cid), cid_id);

    // Account address whose raw ed25519 pubkey exceeds r ⇒ exercises the mod-r path.
    let acc = Address::from_str(&env, "GDIEVMRSOQV3JKZ2CNUL2RQV4TTNAISKW4NAC25PQUQKGMWJO6DTOAE7");
    assert_eq!(
        c.address_to_field(&acc),
        BytesN::from_array(
            &env,
            &hex32("0eb97866ef65340458d251e3401083722f52a995331ba96a7598cce309778733")
        )
    );
    let acc_id = BytesN::from_array(
        &env,
        &hex32("21f8e0d055c2cd25ec77811fa4c87c29e79a20a9645712a69e1f7be7c920d5df"),
    );
    assert_eq!(c.asset_id_of(&acc), acc_id);
    assert_eq!(c.recipient_hash_of(&acc), acc_id);
}

#[test]
fn native_asset_id_is_zero() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    // The configured native-XLM SAC maps to the canonical native asset_id 0 (SHARED §4)…
    assert_eq!(c.asset_id_of(&ctx.native), zero(env));
    // …whereas any other SAC derives a non-zero asset_id.
    assert_ne!(c.asset_id_of(&ctx.asset), zero(env));
}

#[test]
fn withdraw_asset_mismatch_rejected() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    let root = c.get_last_root();
    let recipient = Address::generate(env);
    // recipient_hash binds, but the public asset_id (here: 0/native) does not match the
    // SAC `asset` actually being drawn — the core soundness gap this fix closes.
    let pi = pub_inputs(
        env,
        &[
            root,
            f(env, 1),
            c.recipient_hash_of(&recipient),
            f(env, 100),
            zero(env),
        ],
    );
    assert_eq!(
        c.try_withdraw(&proof(env), &pi, &recipient, &100i128, &ctx.asset),
        Err(Ok(ObscuraError::AssetMismatch))
    );
}

#[test]
fn withdraw_recipient_mismatch_rejected() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    c.deposit(&ctx.user, &ctx.asset, &1_000i128, &f(env, 0xC0));
    let root = c.get_last_root();
    let recipient = Address::generate(env);
    // asset_id binds, but the public recipient_hash does not derive from `recipient`.
    let pi = pub_inputs(
        env,
        &[
            root,
            f(env, 1),
            f(env, 0x99),
            f(env, 100),
            c.asset_id_of(&ctx.asset),
        ],
    );
    assert_eq!(
        c.try_withdraw(&proof(env), &pi, &recipient, &100i128, &ctx.asset),
        Err(Ok(ObscuraError::RecipientMismatch))
    );
}

#[test]
fn rejects_malformed_public_inputs_length() {
    let ctx = setup(true);
    let env = &ctx.env;
    let c = &ctx.client;
    let recipient = Address::generate(env);
    let short = Bytes::from_slice(env, &[0u8; 31]);
    assert_eq!(
        c.try_withdraw(&proof(env), &short, &recipient, &1i128, &ctx.asset),
        Err(Ok(ObscuraError::InvalidPublicInputs))
    );
}

// --- Bridge: set_bridge + bridge_mint (BRIDGE_SPEC §3/§7) ---

/// A pool registered with a single stand-in verifier address, plus a fresh
/// `admin` and `bridge`. Auth is left under the caller's control so each test can
/// assert the admin/bridge gating precisely.
fn bridge_setup() -> (Env, ObscuraPoolClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let v = Address::generate(&env);
    let pool = env.register(
        ObscuraPool,
        (
            v.clone(),
            v.clone(),
            v.clone(),
            v.clone(),
            v.clone(),
            v.clone(),
        ),
    );
    let c = ObscuraPoolClient::new(&env, &pool);
    let admin = Address::generate(&env);
    let bridge = Address::generate(&env);
    (env, c, pool, admin, bridge)
}

#[test]
fn set_bridge_admin_gated_and_only_once() {
    let (env, c, _pool, admin, bridge) = bridge_setup();

    // Admin gating: without the admin's authorisation the call is rejected.
    assert!(c.try_set_bridge(&admin, &bridge).is_err());

    // With the admin's authorisation it succeeds and records the bridge address.
    env.mock_all_auths();
    c.set_bridge(&admin, &bridge);
    assert_eq!(c.bridge(), Some(bridge.clone()));

    // One-time: a second call is rejected even by the same admin…
    assert_eq!(
        c.try_set_bridge(&admin, &bridge),
        Err(Ok(ObscuraError::BridgeAlreadySet))
    );
    // …and by anyone else.
    let other = Address::generate(&env);
    assert_eq!(
        c.try_set_bridge(&other, &bridge),
        Err(Ok(ObscuraError::BridgeAlreadySet))
    );
}

#[test]
fn set_bridge_rejects_wrong_admin() {
    let (env, c, pool, admin, bridge) = bridge_setup();
    env.mock_all_auths();
    // Pre-establish a governance admin (as merged binding work would). `set_bridge`
    // must then reuse it and reject any other admin.
    env.as_contract(&pool, || {
        env.storage().instance().set(&DataKey::Admin, &admin);
    });
    let attacker = Address::generate(&env);
    assert_eq!(
        c.try_set_bridge(&attacker, &bridge),
        Err(Ok(ObscuraError::Unauthorized))
    );
    // The established admin can still configure it.
    c.set_bridge(&admin, &bridge);
    assert_eq!(c.bridge(), Some(bridge));
}

#[test]
fn bridge_mint_requires_bridge_set() {
    let (env, c, _pool, _admin, _bridge) = bridge_setup();
    env.mock_all_auths();
    // No bridge configured yet -> BridgeNotSet (checked before auth).
    assert_eq!(
        c.try_bridge_mint(&f(&env, 1)),
        Err(Ok(ObscuraError::BridgeNotSet))
    );
}

#[test]
fn bridge_mint_inserts_commitment_and_advances_root() {
    let (env, c, pool, admin, bridge) = bridge_setup();
    env.mock_all_auths();
    c.set_bridge(&admin, &bridge);

    let root_before = c.get_last_root();
    let commitment = f(&env, 0xBEEF);
    let idx = c.bridge_mint(&commitment);
    assert_eq!(idx, 0);

    // Exactly one event from the mint: the `bridge_mint` topic, the leaf index as
    // a topic, and the commitment in the data map. Asserted immediately, since
    // `events().all()` only reflects the most recent contract invocation.
    assert_eq!(env.events().all().events().len(), 1);
    assert_eq!(
        env.events().all(),
        soroban_sdk::vec![
            &env,
            (
                pool.clone(),
                (Symbol::new(&env, "bridge_mint"), 0u32).into_val(&env),
                soroban_sdk::map![&env, (Symbol::new(&env, "commitment"), commitment.clone())]
                    .into_val(&env),
            ),
        ]
    );

    // The bridged note advanced the tree: new root, recorded in history.
    let root_after = c.get_last_root();
    assert_ne!(root_before, root_after);
    assert!(c.is_known_root(&root_after));

    // A second bridged note advances the index and the root again.
    let idx2 = c.bridge_mint(&f(&env, 0xF00D));
    assert_eq!(idx2, 1);
    assert_ne!(c.get_last_root(), root_after);
}

#[test]
fn bridge_mint_rejected_for_non_bridge_caller() {
    let (env, c, pool, admin, bridge) = bridge_setup();
    env.mock_all_auths();
    c.set_bridge(&admin, &bridge);

    // Authorise only an attacker (not the configured bridge) for the call: the
    // contract requires the bridge's auth, so the invocation is rejected.
    let attacker = Address::generate(&env);
    let commitment = f(&env, 0xBAD1);
    let res = c
        .mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &pool,
                fn_name: "bridge_mint",
                args: (commitment.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_bridge_mint(&commitment);
    assert!(res.is_err());

    // The rejected call inserted nothing: a subsequent authorised mint still
    // takes leaf index 0 (the tree never advanced).
    env.mock_all_auths();
    assert_eq!(c.bridge_mint(&commitment), 0);
}
