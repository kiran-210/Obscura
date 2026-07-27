#![cfg(test)]
//! Integration tests for `ObscuraBridge`.
//!
//! Two complementary strategies prove the inbound flow end-to-end *in-process*:
//!
//! 1. **Full `bridge_in` path** is driven through a **synthetic single-leaf MPT**
//!    built in-test from the real `keccak256` host fn + RLP, for the bridge's own
//!    `locks[commitment]` slot-0 mapping. Because the contract derives the slot as
//!    `keccak256(commitment ‖ bytes32(0))`, no recorded mainnet/Sepolia proof can
//!    target it (keccak pre-image), so we mint a self-consistent proof that
//!    exercises the real `bridge_mpt::verify_storage`, the decode, the replay
//!    guard, the mock light client, and the mock pool together.
//!
//! 2. **The REAL Sepolia vector** (WETH9 `balanceOf` at block 11173387 — a
//!    `mapping` slot with the *same shape* as `locks`, copied verbatim from
//!    `bridge-mpt/src/vectors.rs`) is run through the exact same
//!    `verify_storage` + `decode_lock_value` code path `bridge_in` uses, proving
//!    the MPT + decode integration against real chain data.

extern crate std;
use std::vec::Vec as StdVec;

use soroban_sdk::{
    contract, contracterror, contractimpl, symbol_short, Bytes, BytesN, Env,
    Vec as SorobanVec,
};

use crate::types::BridgeError;
use crate::{ObscuraBridge, ObscuraBridgeClient};

// ===========================================================================
// hex helpers
// ===========================================================================

fn unhex(s: &str) -> StdVec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    assert!(s.len() % 2 == 0, "odd hex length");
    let b = s.as_bytes();
    let mut out = StdVec::with_capacity(s.len() / 2);
    let hexval = |c: u8| -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => panic!("bad hex char"),
        }
    };
    let mut i = 0;
    while i < b.len() {
        out.push((hexval(b[i]) << 4) | hexval(b[i + 1]));
        i += 2;
    }
    out
}

fn b32(env: &Env, s: &str) -> BytesN<32> {
    let v = unhex(s);
    assert_eq!(v.len(), 32);
    let mut a = [0u8; 32];
    a.copy_from_slice(&v);
    BytesN::from_array(env, &a)
}

fn addr20(s: &str) -> [u8; 20] {
    let v = unhex(s);
    let mut a = [0u8; 20];
    a.copy_from_slice(&v);
    a
}

fn proof_vec(env: &Env, nodes: &[&str]) -> SorobanVec<Bytes> {
    let mut p = SorobanVec::new(env);
    for n in nodes {
        p.push_back(Bytes::from_slice(env, &unhex(n)));
    }
    p
}

fn keccak(env: &Env, data: &[u8]) -> [u8; 32] {
    env.crypto().keccak256(&Bytes::from_slice(env, data)).to_array()
}

// ===========================================================================
// minimal RLP / HP encoders — used only to mint a synthetic single-leaf trie
// ===========================================================================

fn minimal_be(mut n: usize) -> StdVec<u8> {
    if n == 0 {
        return StdVec::new();
    }
    let mut tmp = StdVec::new();
    while n > 0 {
        tmp.push((n & 0xff) as u8);
        n >>= 8;
    }
    tmp.reverse();
    tmp
}

fn rlp_str(s: &[u8]) -> StdVec<u8> {
    let mut out = StdVec::new();
    if s.len() == 1 && s[0] < 0x80 {
        out.push(s[0]);
    } else if s.len() <= 55 {
        out.push(0x80 + s.len() as u8);
        out.extend_from_slice(s);
    } else {
        let lb = minimal_be(s.len());
        out.push(0xb7 + lb.len() as u8);
        out.extend_from_slice(&lb);
        out.extend_from_slice(s);
    }
    out
}

fn rlp_list(items: &[StdVec<u8>]) -> StdVec<u8> {
    let mut payload = StdVec::new();
    for it in items {
        payload.extend_from_slice(it);
    }
    let mut out = StdVec::new();
    if payload.len() <= 55 {
        out.push(0xc0 + payload.len() as u8);
    } else {
        let lb = minimal_be(payload.len());
        out.push(0xf7 + lb.len() as u8);
        out.extend_from_slice(&lb);
    }
    out.extend_from_slice(&payload);
    out
}

/// RLP of an integer: strip leading zero bytes, then encode as a string.
fn rlp_uint(word: &[u8]) -> StdVec<u8> {
    let mut i = 0;
    while i < word.len() && word[i] == 0 {
        i += 1;
    }
    rlp_str(&word[i..])
}

/// Hex-prefix encoding of a full 64-nibble key as a leaf (even length): `0x20`
/// followed by the 32-byte key.
fn hp_leaf(key: &[u8; 32]) -> StdVec<u8> {
    let mut v = StdVec::with_capacity(33);
    v.push(0x20);
    v.extend_from_slice(key);
    v
}

/// Build a synthetic, cryptographically-valid 1-account / 1-slot MPT proving
/// `account(bridge_addr).storage[storage_slot] == word` under the returned
/// `state_root`. Mirrors the real Ethereum leaf encoding exactly (the storage
/// leaf value is `RLP(RLP(uint))`, the account leaf value is `RLP(account_rlp)`),
/// so it verifies through the production `bridge_mpt::verify_storage`.
fn synth_proof(
    env: &Env,
    bridge_addr: &[u8; 20],
    storage_slot: &[u8; 32],
    word: &[u8; 32],
) -> (BytesN<32>, SorobanVec<Bytes>, SorobanVec<Bytes>) {
    // --- storage trie: single leaf at keccak(storage_slot) ---
    let slot_key = keccak(env, storage_slot);
    let value_inner = rlp_uint(word); // RLP(uint) — the trie value
    let storage_leaf = rlp_list(&[rlp_str(&hp_leaf(&slot_key)), rlp_str(&value_inner)]);
    let storage_root = keccak(env, &storage_leaf);

    // --- account trie: single leaf at keccak(bridge_addr) ---
    let nonce = rlp_uint(&[1u8]);
    let balance = rlp_uint(&[]); // 0
    let code_hash = [0xccu8; 32];
    let account_rlp = rlp_list(&[
        nonce,
        balance,
        rlp_str(&storage_root),
        rlp_str(&code_hash),
    ]);
    let addr_key = keccak(env, bridge_addr);
    let account_leaf = rlp_list(&[rlp_str(&hp_leaf(&addr_key)), rlp_str(&account_rlp)]);
    let state_root = keccak(env, &account_leaf);

    let mut ap = SorobanVec::new(env);
    ap.push_back(Bytes::from_slice(env, &account_leaf));
    let mut sp = SorobanVec::new(env);
    sp.push_back(Bytes::from_slice(env, &storage_leaf));
    (BytesN::from_array(env, &state_root), ap, sp)
}

/// Storage slot of `locks[commitment]` exactly as `ObscuraBridge::bridge_in`
/// derives it: `keccak256(commitment ‖ bytes32(0))`.
fn locks_slot_bytes(env: &Env, commitment: &[u8; 32]) -> [u8; 32] {
    let mut pre = [0u8; 64];
    pre[0..32].copy_from_slice(commitment);
    keccak(env, &pre)
}

/// Pack `LockRecord { address token; uint96 amount; }` into a 32-byte word per
/// BRIDGE_SPEC §4 (token low 20 bytes, amount high 12 bytes).
fn pack_lock(token: &[u8; 20], amount: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    let amt = amount.to_be_bytes(); // 16 bytes; uint96 lives in the low 12
    w[0..12].copy_from_slice(&amt[4..16]);
    w[12..32].copy_from_slice(token);
    w
}

// ===========================================================================
// mock collaborators
// ===========================================================================

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum MockErr {
    Rejected = 1,
}

/// Mock `EthLightClient`: returns the seeded `state_root` for the seeded block.
#[contract]
pub struct MockLightClient;

#[contractimpl]
impl MockLightClient {
    pub fn __constructor(env: Env, block_number: u64, state_root: BytesN<32>) {
        let s = env.storage().instance();
        s.set(&symbol_short!("blk"), &block_number);
        s.set(&symbol_short!("root"), &state_root);
    }

    pub fn state_root_at(env: Env, block_number: u64) -> Option<BytesN<32>> {
        let s = env.storage().instance();
        let known: u64 = s.get(&symbol_short!("blk")).unwrap();
        if block_number == known {
            s.get(&symbol_short!("root"))
        } else {
            None
        }
    }
}

/// Mock `ObscuraPool`: records minted commitments; reports all roots as known.
#[contract]
pub struct MockPool;

#[contractimpl]
impl MockPool {
    pub fn bridge_mint(env: Env, commitment: BytesN<32>) -> u32 {
        let s = env.storage().instance();
        let count: u32 = s.get(&symbol_short!("count")).unwrap_or(0);
        s.set(&symbol_short!("count"), &(count + 1));
        s.set(&symbol_short!("last"), &commitment);
        count // returned leaf index
    }

    pub fn mint_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0)
    }

    pub fn last_minted(env: Env) -> BytesN<32> {
        env.storage().instance().get(&symbol_short!("last")).unwrap()
    }

    pub fn is_known_root(_env: Env, _root: BytesN<32>) -> bool {
        true
    }
}

/// Mock pool variant whose tree knows no roots (for the `bridge_out` root check).
#[contract]
pub struct MockPoolNoRoots;

#[contractimpl]
impl MockPoolNoRoots {
    pub fn is_known_root(_env: Env, _root: BytesN<32>) -> bool {
        false
    }
}

/// Mock withdraw verifier — accepts any proof.
#[contract]
pub struct MockVerifierOk;

#[contractimpl]
impl MockVerifierOk {
    pub fn verify_proof(_e: Env, _public_inputs: Bytes, _proof: Bytes) -> Result<(), MockErr> {
        Ok(())
    }
}

/// Mock withdraw verifier — rejects any proof.
#[contract]
pub struct MockVerifierFail;

#[contractimpl]
impl MockVerifierFail {
    pub fn verify_proof(_e: Env, _public_inputs: Bytes, _proof: Bytes) -> Result<(), MockErr> {
        Err(MockErr::Rejected)
    }
}

const L1_CHAIN_ID: u32 = 11155111; // Sepolia
const BLOCK: u64 = 11173387;

/// Register a `ObscuraBridge` wired to fresh mocks, returning the client + the
/// mock pool address (for asserting mints) + the commitment/token/amount used.
struct InCtx {
    env: Env,
    client: ObscuraBridgeClient<'static>,
    pool: soroban_sdk::Address,
    commitment: BytesN<32>,
    token: BytesN<20>,
    amount: i128,
    account_proof: SorobanVec<Bytes>,
    storage_proof: SorobanVec<Bytes>,
}

fn setup_bridge_in() -> InCtx {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let commitment_arr = [0x11u8; 32];
    let token_arr = [0x42u8; 20];
    let amount: i128 = 1_000_000_000_000_000; // 1e15 wei, fits uint96
    let l1_bridge = [0xABu8; 20];

    let slot = locks_slot_bytes(&env, &commitment_arr);
    let word = pack_lock(&token_arr, amount as u128);
    let (state_root, account_proof, storage_proof) =
        synth_proof(&env, &l1_bridge, &slot, &word);

    let lc = env.register(MockLightClient, (BLOCK, state_root));
    let pool = env.register(MockPool, ());
    let vf = env.register(MockVerifierOk, ());
    let bridge = env.register(
        ObscuraBridge,
        (
            lc,
            pool.clone(),
            L1_CHAIN_ID,
            BytesN::from_array(&env, &l1_bridge),
            vf,
        ),
    );
    let client = ObscuraBridgeClient::new(&env, &bridge);

    InCtx {
        commitment: BytesN::from_array(&env, &commitment_arr),
        token: BytesN::from_array(&env, &token_arr),
        amount,
        account_proof,
        storage_proof,
        client,
        pool,
        env,
    }
}

// ===========================================================================
// bridge_in
// ===========================================================================

#[test]
fn bridge_in_happy_path_mints_and_decodes() {
    let c = setup_bridge_in();
    c.client.bridge_in(
        &BLOCK,
        &c.commitment,
        &c.token,
        &c.amount,
        &c.account_proof,
        &c.storage_proof,
    );

    // The mock pool recorded exactly the bridged commitment.
    let pc = MockPoolClient::new(&c.env, &c.pool);
    assert_eq!(pc.mint_count(), 1);
    assert_eq!(pc.last_minted(), c.commitment);
    assert!(c.client.is_bridged(&c.commitment));
}

#[test]
fn bridge_in_rejects_replay() {
    let c = setup_bridge_in();
    c.client.bridge_in(
        &BLOCK,
        &c.commitment,
        &c.token,
        &c.amount,
        &c.account_proof,
        &c.storage_proof,
    );
    let res = c.client.try_bridge_in(
        &BLOCK,
        &c.commitment,
        &c.token,
        &c.amount,
        &c.account_proof,
        &c.storage_proof,
    );
    assert_eq!(res, Err(Ok(BridgeError::AlreadyBridged)));
    // Still only one mint.
    assert_eq!(MockPoolClient::new(&c.env, &c.pool).mint_count(), 1);
}

#[test]
fn bridge_in_rejects_wrong_amount() {
    let c = setup_bridge_in();
    let res = c.client.try_bridge_in(
        &BLOCK,
        &c.commitment,
        &c.token,
        &(c.amount + 1),
        &c.account_proof,
        &c.storage_proof,
    );
    assert_eq!(res, Err(Ok(BridgeError::AmountMismatch)));
}

#[test]
fn bridge_in_rejects_wrong_token() {
    let c = setup_bridge_in();
    let wrong = BytesN::from_array(&c.env, &[0x99u8; 20]);
    let res = c.client.try_bridge_in(
        &BLOCK,
        &c.commitment,
        &wrong,
        &c.amount,
        &c.account_proof,
        &c.storage_proof,
    );
    assert_eq!(res, Err(Ok(BridgeError::TokenMismatch)));
}

#[test]
fn bridge_in_rejects_unknown_block() {
    let c = setup_bridge_in();
    let res = c.client.try_bridge_in(
        &(BLOCK + 1), // the mock light client knows only BLOCK
        &c.commitment,
        &c.token,
        &c.amount,
        &c.account_proof,
        &c.storage_proof,
    );
    assert_eq!(res, Err(Ok(BridgeError::UnknownBlock)));
}

#[test]
fn bridge_in_rejects_tampered_proof() {
    let c = setup_bridge_in();
    // Corrupt the storage leaf so keccak(node) != storage_root.
    let mut bad = SorobanVec::new(&c.env);
    let mut leaf = [0u8; 256];
    let original = c.storage_proof.get(0).unwrap();
    let n = original.len() as usize;
    original.copy_into_slice(&mut leaf[..n]);
    leaf[n / 2] ^= 0xff;
    bad.push_back(Bytes::from_slice(&c.env, &leaf[..n]));

    let res = c.client.try_bridge_in(
        &BLOCK,
        &c.commitment,
        &c.token,
        &c.amount,
        &c.account_proof,
        &bad,
    );
    assert_eq!(res, Err(Ok(BridgeError::ProofInvalid)));
}

// ===========================================================================
// REAL Sepolia vector reuse (verify_storage + decode, the bridge_in core).
// Copied verbatim from bridge-mpt/src/vectors.rs (WETH9 balanceOf @ 11173387).
// ===========================================================================

const STATE_ROOT: &str = "75311b213ba9bd9c43a5edd9b47ab966ac7f2a58801f9a49f92132f295b5db31";
const WETH_ADDR: &str = "fff9976782d46cc05630d1f6ebab18b2324d6b14";
const SLOT_BALANCE: &str = "66a55c08167a08e5a426c60c30570e086017f237f4a1771fa3123af6f458a482";
const VALUE_BALANCE: &str = "00000000000000000000000000000000000000000000006d7cb29bd24898acb7";

const ACCOUNT_PROOF: &[&str] = &[
    "f90211a0b9aa6e96ede3737f8625713655fcc3d751cdedc403d86dc1f8576e86583c9512a07929a33db0122beed7ff050b637140a95aead3bfa61c245918884f86c7fd629fa04351d4bd997b0ef405c2af6027a9aa3bcec31ab55ba53b48f420c9064d7beb48a082a933d74b024840b86450845ade0b9b9b99cda0270608a26d014aa1fcc4ea18a04c99994d1bf2b3b58d9b30fa8e0224b2ab559ea0a46c937b6af58256b2a1c054a0863648db09e102da1d7347a01eb8ffc9ce40b1cef9902dee5e2b401b0ecb9feaa07f3043f9942f6de236facd2322bc4bed19796a64b8efac3cf6a5263e8030f3a6a0c6faee5378745789a39741f5a85b0bdd218ead3ae945d3418d7a454d3764d33ba0347bc0043f75cd6b4e16060f27779619839b6fc53c682667b5591d67b6a4efaaa05a886392805da96b8bb714fb2256af74c3c4593163cf3e88e6932896f2d69658a0c5e25a1a403f07ff4274075e1c7917a1e671809990391a2fd07de6aa84af1fc8a0b48911e2d9076a39f6e953c4fbba320fcebcc4ea1b4c4f74d47148b3cf466f5fa0c54e3ab753d29616336094a0e977c9663351dec468a2819204ce6fca175c3592a0080dafa6e4640bbf8317206bba09dbfd4858ca82b085112a615dc5e4445fa31aa01c5f0a75250f6e6fa5bfa2882c35f10c48ea0c7bc9dba96000dc5a3bab780c29a0b6b43fcd84c76ac492c1a184bfa1aaa8da51fdeaf8c94cdebda62ab8366fa81d80",
    "f90211a063b306f62c43ebf13a576be8954e6a4b9b8255c9e3a64be7a7dc5d019dea4b14a06a8f1c19d49a5231680d550097069b73f80a8ca7d2740af5103d7ab0be590c3da0652590218d008a5bfaadca600a12d770bb59bb695e4d6a6104947236f8de328aa075b0e57551b32e8cb25f300af26b95df004a94bd07a3b507bc88f5985f98dfb1a0ddb5743b9511e0c0de9ab78c673c1a9ef860945d046a6aa965ed71a7948375d1a0a3ad03d4db13da992a1483aaccd98486340dd6b48826dd6a90b676cd52d71206a02fb487d8e0091677ac2da9b9eff46035d4726f3182714f97c59f09b1961734dfa05b5e92dd8560033587862c13faca78030f56a7e85e2b3a3c0accf4ee9f211caaa04dbba4701f8948f55e9fc4e94bed4cac6a1cc6358ab288f85f341d61567d60c5a0c199a19ba61aea1ca6b4b2319443f1731f917cf8f7a25d96d6b3ff2fbca5f171a078e961abaa125178798ac0e3304380b85b7fb9656fa7c7a82f8064b59c22f8c1a0d5d2448d3c6d6fffe527b42578673a8becb25c94511a4dee1f12eb65816eb39ba0ed85a6b286bd8244b40d9c415522e025c7d275c6be7e788cc61e543512be3484a0f34edcc10bc5a176608ffb1e80df047ec575ae8aeafea812952a176f016e98bda0059005a06fcefa3d74a31e2e5806cf7934e8e9e17013fbd77dd720ff826b92c5a005ba9953361742c923784328273d1dfc47839bb27323be9ba8c1ba9920381f8880",
    "f90211a0a94c23ae8982cb19de1ee784838f7c3e215ca33113b4639097ac4c2b57d76feaa07527f4519c61822492bdbb4c9f12c2ead0b9433089e00ee28a247f0627b819daa07f9fb4c7968cb03e91ebebd8426440270a677aa3a54b3499ba59cd220601097aa0dd0d8254d8bde038fc47c6d408bf5c8cbf4b9d6b7b9575580100ffe05b9ad977a0af634cc2e067aa8a07da93dfb55e8d4264b8793af8a0575b367d63704ea9140aa051f01e14445822f19c4359fb27f1ec6ecb5cf1fdf131492f6749dc52a2e49af5a001b539fbb246a3dbeb60892bf6ab1ff701e9f521681102de5eeb1f982b2e7aa5a05556eb9c25760eb3322e6b571127e01f45cad28e9305718b211d67c8858bbf12a0c94e438b319981e146ed9706b4411dd7bd734d25d6bf86aa21e17627ffabeefda0acce8be44871380fa9f48e9974a3a69cd3d05bc7764e6fac29de743b0295f49ba031c87abcf5970aae0f65b7cf6d9fb53a4d7cbf1277a7c82a364198b741967d93a03fd8b22d1ea47fd48e19ace3528c07f972fcf8961329d0e80d1e583560f592d9a0b322facb742919c0a2efaa1ed8824a9bd67815cc1adf220c6e989249dfc9cc29a05e6f50a47f5c4b30d16427401387882fa03c27a1f33b429d8840f17b676183d2a0a624c9e52404302dd24420a31a91b2818e9dce148a0de25cdf3fda2a100bb8e9a0de451202f9195d663c0df32e3e02a2ccee35326c443108fa7fe6cdeb7105f73180",
    "f90211a012e1e089f12d45123d8ef2567a8cb38cda5e5e73d0c8b1b05cda484e3e756c61a00477cf40863ad29c909a1b56525ceeb33210fb1b8ae9011641af8ca00aefe9a3a0a2427c6d9992cbd95318aa515ebdbe9f2bba2415850cd2c9cc441965c1033a94a0140a8a2b399208a8b1c62a59a25e26ad40a0c59d5a6d363d21d99f54c3153b84a034f0a785c970303061ef32c619c5ae926058378922e37ea2851409755a1cc869a0ef29db2185e9930cb3a2b0593b8c319674ecdd670d22165e1f4d9fa74f9ceb8ba04da4f492c84be91a411b2caf760f412b84c34443c6a140ec4edd726847c0a445a03bddc534163acdeaac300cc9cef8631db952efabe2dea92bea544f210f46a5f5a00bf453f8282a276da6a19356cea3c7f35c26b385c700522bcbb59c2df4a358f1a08f77415d67e3b7f65931f6096ec04af70fdcf4086765b5c49c4f47516fbb2cd6a01bbcb8a894538b0ce9e6bfce2195824d22dc52f9f7c7ba199e385c22e3efe7e8a07552635803ea7498dc98ff157667cdcb385b92a384a7945a0fb6c889e4d7c8c3a02e2b9a0357d0d2c73ce0ee1c3a7809dceac09cf85a331b977bb95ec7f5689804a0ac3cfaab96cbddada2817742c086d6b2097cb525ddc8c5bd422410ab9cb2210fa000d41f38db0b87214e50d3315d27c84a25c5bc8cdd9d50bf3ebeb572cb178c27a0696f7021c65fc9b9d9c92f68246e76b57d46d19cb4db187f631baf4e87f1bdc780",
    "f90211a0684f55e7fb37fa7221fffb4017987551b5cefc024279f65fce1906da46c299d5a0b83b7ad6ca7557ae78af00e92998e8ae86db69ec15398d68124aa80558a92f3da03086aea669a3cefd150d44478ae633575cf81280dba64761ad742f6aa4055a3aa057a0b97a579ccb5a6655dd1fe8a91f3054fd9c87dce6c001a3f704b113d6ea0da0cb20336d6626f97052d68304432bd64c17459be0fcf630b165757f0852cf07b4a0d6cfd01ab655291fcdc6eb305607e059d6d22ec81c70e6a9eef71522b2312ad2a0363e1384ae0586ca03db5a07a50fc9e79a7534a4809f0bcd518b83f9f7bb6751a0bccf503afb2bfc5afe0feb286343d88fbb1af3d7b5fb106192ca5219f70f7002a064a50604bacbd244b23e071e3c9ebf1917fe4de659118d3e4864607d7dbadff1a08de01e6c327630ca7f2d59a350b2c92db94b1513736a78b7bdd050893b194d12a08cd3315aea573f6529dbb33ee98dffa42d437ac9d02dbb0b018a019cd62f8984a028c271fe16817e3a2f4bd9b82d946bd3a068300cf00bb46737a0b26f80fcad7da091d1bb2a44603fd5965f0c192957c0fd23d4a1ed2266afb46e34c5538195f566a007ab12fa72023f7179d53a33256a4366a4a3cdcdd2feceecc1e1ebb9a390d341a0fd87077f583b5404004b189e650ef7f36a85d2bd75fdd268e8fd7db997d555dda0035a58cdcb02988a83cabbcc72b5ce227c8f35a92f9493483e25c7c4423c967180",
    "f90211a0319bc9463e126301993fc3d9b8519ebcc1bd683593aa144177b85aacec77b7f1a0191db97840f4942b09c0c465b0b858ca7c078a6d8eaaa69431dee0d431676339a0e6508d7caeb801b56d296d762b2e884a6700c14a837a2540ade53cccc58d8c40a01a894ed646fc9b04987ddbf027ddafae5bf768801760fd230fe71b4ab3b02318a04040cf7b68a3db1d79efae980d43328fea77e5a509ad7685d9f362eb651e1a91a059d67855a002638bdc42df963ad16af7aa5bd94e19500e5dded563579791a2eda05ae3c8d25240fd1fc635a6bb5dbde37461599d562805bddda7d6b3a111bbf47aa0401a88bcf0eaf8cb5ed8b6686fb1568a9f4c0041be968139b594891b800a04f9a07a076c1b8bc0d554a84cb9c989815896bfbd5e23a8132ba52ecdfab25406a909a0d447b80fa2bc2805cfc547a2e7474020aac9e18ed09cabe0a28dfc01b0844655a0aae4b21b862fb62c43992c08417f8450075f7adc8e10c82570aa7548eae5b03da02e066f2f1096aa65e98ba31aff76f7ee13163d90d2d660f15c22353a89014d38a0b42bcb30c5ade78056a1a224e6dba04733f4275d992ecb57da24358dda167445a0986644da02d1e0a6564fd8eafbd674296eae190a8738f09e3ddbff23c404caa1a0a3b92e49192cb148ae587e991ad64777c770ac3bbf2ba8d90b458d7e28765de9a08ef3e063c59aa0e3cfd2fe65af8f8195fd406585dd80135570e862f556f7d6b980",
    "f8d1a081d1e0fb8919b34275536e9967733a55976fcfb5c29597b119b7fa106b7de6f9a021c9d104b3eeb5d290b2c928fed9ef985b4eee3691122a74ef4e7bb01bbeda68808080808080a0369df9a6fbfdd5b2c8af2a1ec1660ca8e2cc634a22e099eff973f465a9c2ea7f80808080a0aa9895ea7649be356ddadc37173a6477554eca17e74a0bcf766cefc75e4aba57a0e139c3f5b3731b4573a66cbccf89d386c1fbaf4d5901f5767d1c703cc12ebf1fa002cb2f0216bd1e947d87015c28a13304d87aac9a604e3895fc6483753eca49cf80",
    "f851808080a0b8c55686ca0b4522b5d011d7b2d40d1a021191524c9cb1d30cc76c18f13b79cf8080a08be47a58a01d4ab2f9e29b719ddd426497ea54a95c14a3828b2b59f476bb1d7980808080808080808080",
    "f8709d201aed64e06d2a1e1a37f4f9d7044bdf9f58a21f389044ecfa831d3509b850f84e018a2c96ea6f31f1c2109a8ea0a28b82c450e33ca64666ff5a82bc018c991f0a473025a290654cc7dbd112c2f6a0c864e10689f2da18833652a3b075d43106e87f0f90d95ee64f6f0b33bc026083",
];

const STORAGE_PROOF_BALANCE: &[&str] = &[
    "f90211a0d1c9b8a4d43831c66673b39a4bea1ada880156d600870450cc212ba899e1cebca0a0ac74b312d9a23c937755792470c767993f6de728e4aa0c634c792c7a0f0a1ca0a27d8afa31e7bcacab21845962e0a33ced2ea78065eb4ccb797bde7ce7ab8c38a02a40462931027ef8eeb4044bfc05f956894e2702badd2296edc7395089a136b4a0f3865db5a7bba055e598ed9e56bc2145edf61c7a3fed78cba820ea51020af402a02b11dc48e092b69fa76a7e132f9d44ce5561806d956262ec76741cbe840763d4a06a0a283f7c19f9488a7ff258078486ccfdf60ed3c74d804ec4f7751925687297a04278d9c90441c500e0849d07c6d9d9264d4f10aa9f8b24ac040421c034ef3fc8a06c17094a69ba985124589a1a2a30ea1fe8c282056b9b56a78bb4584a5cf25bb3a0792135139c6de77afd480c5660ba1f50de8796eb06c956e23be06f3d943831f4a08cd5a117d4ed40ffd2f78a5ed1f5ffe98e02018fbc6e2f0e60b8c366abf3d5faa0812cc14a0ab17256a1852599f706eda845b3fcd910d14446dd5a778192a24f90a06ffbc1cd251e59f63ac4c412627d0fdee18bc432c23e85a96b85b054b07aac3ba08ba3b7216645e023f850a03db917334287934d0bffbb7902fb9d5abab5b35323a085aef218ad9c7a360c99b412a97358b7110673a4e0da9f262e06a9037d4e45a5a08ea75c5179fab78fd8b2fed87b278d63e30b2237cde8fb9fd3373bde30f8cc1680",
    "f90211a01c7b2988cce4f4716315613293af8f1754f703c0a3f8f2496aa9fb5b0deb1255a074ec9d90ffba53eaa3f87a733b0b9662ce4e7b88ed5c5b21ab368a339c0f3974a051056125821947749f2dfaf4745c523f2d1c33ad3f0d7ea4125ae26f3d1efb44a0d4c50899cd8a55eca8e58e13de25282b231a52ea60b1b960ea2c948f23f02ceba0a73ff13eb94ed04e4b88616c642a8facdccf1dc687864ffe8a462ad4ce5d581ba088938e7043f2cac556db7bbad77a35ec93f415e9379571e675fcd5ed6379271da01dbea4bca753797b2cd435b8cdd432a1b16e65df21176686ab9aa6fdc4bd5739a07258e77910d7b93ba00966c037f8840ce79067a197a48615259ca30dd6a9c58ea0dddd2ad1d3af419aa035d4ecd9d28c07094aee7dce25811917c28c218a9e4169a02b27e15636d86ec270ebcc3a66b915d55dfef01e5773c3a2a42d0a3c6cf3ac30a0d9fd660df1b4177992080c6c31abc52cf26e908f01a024418ccbb88b6b33c41da0c5e70c8af77624a628972fd7456c38697c7a932e722375bd31b564a3adbaffcca0624d543f73cf2e074d8b66dc88fff66e711361d457b7d2302cf6d2f89280d8c8a0de8ea398572db9a40bf472a02d89c33411ad6ccd05e3585d8e9109f73ae4cb63a01e96b91808977ce5476768926577a434f844c9f2d9fc32cfefe804d1d9590e83a0f3e54b38c12cf29300c809efdb2e3d46b4dbf04dbd79285e070510171ec9f8fc80",
    "f90211a018361d209d04f90f98881b10e18e6a074bb18445ef751b6ebc75c1d39de0aff1a0eb6c7160aaa212104777bf082c7d88cc2a90aa501be734e0aa2dc02c03bfd9caa0e27f9cfc675c2325ed207c7e17f8d9996c24c052e942ec219f7d416e3af0a87ba088dd7c8803b13866947f0db93b48e8185e2958a985480092e9f362dd027dc962a0b049f3a007748de2ba0649ccd96dfdb49a93da68d7485214273895f172505167a08a4c4d8a18e866fc5befafd17f84d3f6d1ccc842d688d8b7bd3e67bb377fdb10a02cae2c688d538768ee7d0d4f9cff35c083dac7692179efb9aee29e6ce8b2188ca0329aec55b47ebac574098d2f6cf6db042bcea231e3bc90140dfd92ca4b35cb02a0602cded14b36551bf1c0f8020a629553a756277f5621742ed41b4d46a61fd03ca0e858a576323308aaa529a032028b79f019d11017798b55ecf51336107516da78a0e55cb25036e717ee695fe2c6bcb116e908a876c9546cfda7017dd184c9043a2fa04c780b0b055fa51c04925afba2709899511dfeae23565f71d00389b78b1bc5c9a04234ba082b94008ca3c1ebc42f0ad06061d9d382046db11fe1d3338d6ee33f85a015759e875399d1af3c71e4a9efd40f2308883755791275521b130f22f96ce0c6a0273ba3e9825a2b4385ef71601337f3f5df18f9fb017fd0807e1b050f9597248ba05a1823eca5d88ddc299911c4194ad982ea770d67ca6f3ede4cd051f8464bc73480",
    "f90211a0d8e692a689e3b09aa1628e4cbab650c079da2b0282c57e027e89624faa812036a02554977f1184cbb73c6161ceac204903088c3222b41b409452f24b24409f679da0551ed2f06f1392469e408ef0b96268090b5959f9a98112b4dd43d78a56368112a027dd430a482a1b6389008425f2462ccb329f4af981543a3cb257f486cc172635a0cc57ad3f6ae3321b86e3b8e9e0c3afe11aee7d2b33b985253a1d1f6ce9c1e21fa0e0c89b605fd43b3d8c7c7f07af767d8c4ec15514111e941817f10a478cf40d42a0e0520b757cb7b267afd94982bc6e7c742c1e9fa6b6fb60b0d2f4b9d1029fea8ca090bd1ca7a0c36974909fccdbbbbbff0b0dbdf99975003c98133c66eae957f814a04909ceff0a40fc5073faa6697f27997f841027192f2599e607399410a8cd1a8fa034bc72b9b839cb8ee87eb0feb0917e91a8e546248b5cbae03f7f54a427eac10ea00cc00ae3e69926df4c687d592dcab0737eb5258cbaf161c17501b7a49deea639a0d73de28b6f31350975cd470f0a2dbd87cabc3d09bb8098af128061b429689d71a01da081855471bf625febafabc7dac1bd290b67aa4b2e5371d882261ddba446fda099514b36ce8032b6748bd2fa2cd78a638a6314cf3e6c3689674e9ec0680bcf3ba00b21866dc58e4f2dee9116a24a44b20fc2a64c3ab752d43d2499dc73b1519bdba006071fd9072b142e963cf7de0bdd093f0bf40fb88f6c4585a7de40571fc29a4080",
    "f8b180a02dc333ad2bd76bdd60e867384501ab9a6d74392d53293586241c9edb478e19db80a0ac3db6038c4c20d6fe93acbf0fd2ef6c0dd5b7d95ea0c0838973a76624befadea09bc595f56294b78ec738e28993aae1c81dcf8118447c4049c0a91c154fabcf9e8080808080a003d4cc446988fb4455009e39f30442bde70470aade30116d1032cc1aa95186e1a0e68f54d4910728fc7f4dde2c886d76eb66d3c2c254505d80675b182a1df9b54a8080808080",
    "ea9e3913f779dae5560d1b11fad38bcf50d36524721e4d0e8d50dadc29524ad58a896d7cb29bd24898acb7",
];

#[test]
fn real_sepolia_vector_verify_storage_and_decode() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();

    let state_root = b32(&env, STATE_ROOT);
    let addr = addr20(WETH_ADDR);
    let slot = b32(&env, SLOT_BALANCE);
    let account_proof = proof_vec(&env, ACCOUNT_PROOF);
    let storage_proof = proof_vec(&env, STORAGE_PROOF_BALANCE);

    // Same in-process verifier call bridge_in makes.
    let word = bridge_mpt::verify_storage(
        &env,
        &state_root,
        &addr,
        &slot,
        &account_proof,
        &storage_proof,
    )
    .expect("real Sepolia proof must verify");
    assert_eq!(word, b32(&env, VALUE_BALANCE));

    // Same decode bridge_in applies to the proven word.
    let (token, amount) = crate::decode_lock_value(&env, &word);
    let expected = b32(&env, VALUE_BALANCE).to_array();
    let mut tok = [0u8; 20];
    tok.copy_from_slice(&expected[12..32]);
    assert_eq!(token, BytesN::from_array(&env, &tok));
    // The balance's high 12 bytes are zero, so the LockRecord `amount` decodes 0.
    assert_eq!(amount, 0i128);
}

// ===========================================================================
// bridge_out
// ===========================================================================

/// Build withdraw `public_inputs` (5 fields): root, nullifier, recipient_hash,
/// amount, asset_id — with `recipient_hash` bound to `l1_recipient`.
fn withdraw_inputs(
    env: &Env,
    l1_recipient: &BytesN<20>,
    nullifier: &[u8; 32],
    amount: i128,
) -> Bytes {
    let recipient_hash = crate::recipient_hash_of_l1(env, l1_recipient).to_array();
    let mut pi = StdVec::new();
    pi.extend_from_slice(&[0xAAu8; 32]); // merkle_root (mock pool: any root known)
    pi.extend_from_slice(nullifier);
    pi.extend_from_slice(&recipient_hash);
    let mut amt = [0u8; 32];
    amt[16..32].copy_from_slice(&amount.to_be_bytes());
    pi.extend_from_slice(&amt);
    pi.extend_from_slice(&[0u8; 32]); // asset_id
    Bytes::from_slice(env, &pi)
}

fn setup_bridge_out(
    verifier_ok: bool,
    roots_known: bool,
) -> (Env, ObscuraBridgeClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let lc = env.register(MockLightClient, (BLOCK, BytesN::from_array(&env, &[0u8; 32])));
    let pool = if roots_known {
        env.register(MockPool, ())
    } else {
        env.register(MockPoolNoRoots, ())
    };
    let vf = if verifier_ok {
        env.register(MockVerifierOk, ())
    } else {
        env.register(MockVerifierFail, ())
    };
    let bridge = env.register(
        ObscuraBridge,
        (
            lc,
            pool,
            L1_CHAIN_ID,
            BytesN::from_array(&env, &[0u8; 20]),
            vf,
        ),
    );
    let client = ObscuraBridgeClient::new(&env, &bridge);
    (env, client)
}

#[test]
fn bridge_out_happy_path_spends_and_emits() {
    let (env, client) = setup_bridge_out(true, true);
    let l1_recipient = BytesN::from_array(&env, &[0x99u8; 20]);
    let nullifier_arr = [0x77u8; 32];
    let pi = withdraw_inputs(&env, &l1_recipient, &nullifier_arr, 500);
    let proof = Bytes::from_slice(&env, &[0u8; 64]);

    client.bridge_out(&proof, &pi, &l1_recipient);

    let nullifier = BytesN::from_array(&env, &nullifier_arr);
    assert!(client.is_spent(&nullifier));

    // Replay rejected.
    let res = client.try_bridge_out(&proof, &pi, &l1_recipient);
    assert_eq!(res, Err(Ok(BridgeError::NullifierUsed)));
}

#[test]
fn bridge_out_rejects_recipient_mismatch() {
    let (env, client) = setup_bridge_out(true, true);
    let bound = BytesN::from_array(&env, &[0x99u8; 20]);
    let pi = withdraw_inputs(&env, &bound, &[0x77u8; 32], 500);
    let proof = Bytes::from_slice(&env, &[0u8; 64]);

    // Attempt to redirect to a different L1 recipient than the proof authorizes.
    let attacker = BytesN::from_array(&env, &[0x11u8; 20]);
    let res = client.try_bridge_out(&proof, &pi, &attacker);
    assert_eq!(res, Err(Ok(BridgeError::RecipientMismatch)));
}

#[test]
fn bridge_out_rejects_bad_proof() {
    let (env, client) = setup_bridge_out(false, true);
    let l1_recipient = BytesN::from_array(&env, &[0x99u8; 20]);
    let pi = withdraw_inputs(&env, &l1_recipient, &[0x77u8; 32], 500);
    let proof = Bytes::from_slice(&env, &[0u8; 64]);

    let res = client.try_bridge_out(&proof, &pi, &l1_recipient);
    assert_eq!(res, Err(Ok(BridgeError::ProofVerifyFailed)));
}

#[test]
fn bridge_out_rejects_unknown_root() {
    let (env, client) = setup_bridge_out(true, false);
    let l1_recipient = BytesN::from_array(&env, &[0x99u8; 20]);
    let pi = withdraw_inputs(&env, &l1_recipient, &[0x77u8; 32], 500);
    let proof = Bytes::from_slice(&env, &[0u8; 64]);

    let res = client.try_bridge_out(&proof, &pi, &l1_recipient);
    assert_eq!(res, Err(Ok(BridgeError::UnknownRoot)));
}

#[test]
fn bridge_out_rejects_malformed_public_inputs() {
    let (env, client) = setup_bridge_out(true, true);
    let l1_recipient = BytesN::from_array(&env, &[0x99u8; 20]);
    let pi = Bytes::from_slice(&env, &[0u8; 96]); // 3 fields, not 5
    let proof = Bytes::from_slice(&env, &[0u8; 64]);

    let res = client.try_bridge_out(&proof, &pi, &l1_recipient);
    assert_eq!(res, Err(Ok(BridgeError::InvalidPublicInputs)));
}
