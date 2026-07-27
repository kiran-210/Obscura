#![cfg(test)]

use super::types::DataKey;
use super::*;
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, vec, Address, Bytes, BytesN, Env, Vec,
};

// --- Mock RISC Zero verifier: accepts any (seal, image_id, journal_digest). ---
// The real proof verification is exercised on-chain against the deployed verifier
// `CANYRGD…` (integration test); here we test OUR chaining / SSZ / storage logic.
#[contract]
pub struct AcceptVerifier;

#[contractimpl]
impl AcceptVerifier {
    pub fn verify(_env: Env, _seal: Bytes, _image_id: BytesN<32>, _journal_digest: BytesN<32>) {}
}

// Real Boundless `signal-on-stellar` vectors (one chained transition). `JOURNAL`'s
// `pre_state` equals `INITIAL_STATE`; its `post_state.finalized` is `BEACON_ROOT`
// at slot 0xceb400 = 13546496.
const INITIAL_STATE: &str = "00000000000000000000000000000000000000000000000000000000000675a0d87a8b0faf867d9521ddb155f3c58b9523367444ac5b8822169c06cd71233ee6000000000000000000000000000000000000000000000000000000000006759f7f3d03a51f303b1f1855592276e609c932cc0f91518ca4d959c38685e9f90a69";
const JOURNAL: &str = "00000000000000000000000000000000000000000000000000000000000675a0d87a8b0faf867d9521ddb155f3c58b9523367444ac5b8822169c06cd71233ee6000000000000000000000000000000000000000000000000000000000006759f7f3d03a51f303b1f1855592276e609c932cc0f91518ca4d959c38685e9f90a6900000000000000000000000000000000000000000000000000000000000675a130da8e4de5b3733b25e850b7dd457886862f7657e3ad0d54246b76ac9676396300000000000000000000000000000000000000000000000000000000000675a0d87a8b0faf867d9521ddb155f3c58b9523367444ac5b8822169c06cd71233ee60000000000000000000000000000000000000000000000000000000000ceb400";
const FINALIZED_SLOT: u64 = 0x0ceb400;
const POST_FINAL_ROOT: &str = "d87a8b0faf867d9521ddb155f3c58b9523367444ac5b8822169c06cd71233ee6";

fn decode32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}
fn decode128(s: &str) -> [u8; 128] {
    hex::decode(s).unwrap().try_into().unwrap()
}
fn decode288(s: &str) -> [u8; 288] {
    hex::decode(s).unwrap().try_into().unwrap()
}

fn deploy(env: &Env, initial: [u8; 128]) -> EthSignalClientClient<'_> {
    let verifier = env.register(AcceptVerifier, ());
    let image_id = BytesN::from_array(env, &[0xAAu8; 32]);
    let initial_state = BytesN::from_array(env, &initial);
    let admin = Address::generate(env);
    let id = env.register(
        EthSignalClient,
        (verifier, image_id, initial_state, admin),
    );
    EthSignalClientClient::new(env, &id)
}

#[test]
fn receive_advances_state_on_real_journal() {
    let env = Env::default();
    let client = deploy(&env, decode128(INITIAL_STATE));

    let seal = Bytes::from_array(&env, &[0x73, 0xc4, 0x57, 0xba]);
    let journal = BytesN::<288>::from_array(&env, &decode288(JOURNAL));

    assert_eq!(client.receive(&seal, &journal), true);

    // The finalized beacon root for its slot is now readable.
    assert_eq!(
        client.beacon_root(&FINALIZED_SLOT),
        Some(BytesN::from_array(&env, &decode32(POST_FINAL_ROOT)))
    );
    // The trusted state advanced to the journal's post_state (bytes [128..256]).
    let post_128: [u8; 128] = decode288(JOURNAL)[128..256].try_into().unwrap();
    assert_eq!(
        client.current_state(),
        BytesN::<128>::from_array(&env, &post_128)
    );
    // No execution root yet — that needs prove_execution.
    assert_eq!(client.state_root_at(&28_372_822), None);
}

#[test]
fn receive_rejects_non_successor() {
    let env = Env::default();
    // Seed a state that is NOT the journal's pre_state (flip one byte).
    let mut bad = decode128(INITIAL_STATE);
    bad[100] ^= 0xff;
    let client = deploy(&env, bad);

    let seal = Bytes::from_array(&env, &[0u8; 4]);
    let journal = BytesN::<288>::from_array(&env, &decode288(JOURNAL));

    match client.try_receive(&seal, &journal) {
        Err(Ok(e)) => assert_eq!(e, SignalError::NotSuccessor),
        other => panic!("expected NotSuccessor, got {:?}", other),
    }
}

// --- prove_execution: synthetic but cryptographically self-consistent. ---

fn hp(env: &Env, l: &BytesN<32>, r: &BytesN<32>) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.extend_from_array(&l.to_array());
    b.extend_from_array(&r.to_array());
    env.crypto().sha256(&b).to_bytes()
}

/// Re-walk a Merkle branch (mirror of `ssz::verify_merkle_branch`) to derive the
/// root a given (leaf, branch, index) reconstructs — used to fabricate a valid
/// `body_root` for the test.
fn walk(env: &Env, leaf: &BytesN<32>, branch: &Vec<BytesN<32>>, index: u64) -> BytesN<32> {
    let mut node = leaf.clone();
    let mut i = 0u32;
    while i < branch.len() {
        let sib = branch.get(i).unwrap();
        node = if (index >> i) & 1 == 1 {
            hp(env, &sib, &node)
        } else {
            hp(env, &node, &sib)
        };
        i += 1;
    }
    node
}

fn sample_execution(env: &Env) -> ExecutionPayloadHeader {
    let z = BytesN::from_array(env, &[0u8; 32]);
    ExecutionPayloadHeader {
        parent_hash: z.clone(),
        fee_recipient: BytesN::from_array(env, &[0u8; 20]),
        state_root: BytesN::from_array(env, &[7u8; 32]),
        receipts_root: z.clone(),
        logs_bloom: Bytes::from_array(env, &[0u8; 256]),
        prev_randao: z.clone(),
        block_number: 28_372_822,
        gas_limit: 30_000_000,
        gas_used: 21_000,
        timestamp: 1_700_000_000,
        extra_data: Bytes::new(env),
        base_fee_per_gas: z.clone(),
        block_hash: z.clone(),
        transactions_root: z.clone(),
        withdrawals_root: z.clone(),
        blob_gas_used: 0,
        excess_blob_gas: 0,
    }
}

#[test]
fn prove_execution_records_state_root() {
    let env = Env::default();
    let client = deploy(&env, decode128(INITIAL_STATE));

    let exec = sample_execution(&env);
    let exec_root = ssz::execution_payload_root(&env, &exec);

    // 4-sibling execution_branch (depth 4) of zeros; index 9 (EXECUTION_SUBTREE_INDEX).
    let z = BytesN::from_array(&env, &[0u8; 32]);
    let branch: Vec<BytesN<32>> = vec![&env, z.clone(), z.clone(), z.clone(), z.clone()];
    let body_root = walk(&env, &exec_root, &branch, EXECUTION_SUBTREE_INDEX);

    let header = BeaconHeader {
        slot: FINALIZED_SLOT,
        proposer_index: 1,
        parent_root: z.clone(),
        state_root: z.clone(),
        body_root: body_root.clone(),
    };
    let beacon_root = ssz::beacon_header_root(&env, &header);

    // Seed the Signal-proven beacon root (normally written by `receive`).
    let id = client.address.clone();
    env.as_contract(&id, || {
        env.storage()
            .persistent()
            .set(&DataKey::BeaconRoot(FINALIZED_SLOT), &beacon_root);
    });

    client.prove_execution(&FINALIZED_SLOT, &header, &exec, &branch);

    assert_eq!(
        client.state_root_at(&exec.block_number),
        Some(exec.state_root.clone())
    );
    let (head_block, head_root) = client.head();
    assert_eq!(head_block, exec.block_number);
    assert_eq!(head_root, exec.state_root);
}

#[test]
fn prove_execution_unknown_slot() {
    let env = Env::default();
    let client = deploy(&env, decode128(INITIAL_STATE));

    let exec = sample_execution(&env);
    let z = BytesN::from_array(&env, &[0u8; 32]);
    let branch: Vec<BytesN<32>> = vec![&env, z.clone(), z.clone(), z.clone(), z.clone()];
    let header = BeaconHeader {
        slot: 999,
        proposer_index: 0,
        parent_root: z.clone(),
        state_root: z.clone(),
        body_root: z.clone(),
    };

    match client.try_prove_execution(&999u64, &header, &exec, &branch) {
        Err(Ok(e)) => assert_eq!(e, SignalError::UnknownSlot),
        other => panic!("expected UnknownSlot, got {:?}", other),
    }
}
