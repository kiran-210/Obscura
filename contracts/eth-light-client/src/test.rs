#![cfg(test)]
extern crate std;
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Vec};

use crate::test_vectors as tv;
use crate::types::{BeaconHeader, ExecutionPayloadHeader, LightClientUpdate};
use crate::{EthLightClient, EthLightClientClient};

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

fn bytesn<const N: usize>(env: &Env, s: &str) -> BytesN<N> {
    let v = hex::decode(s).expect("hex");
    assert_eq!(v.len(), N, "bad len for {}", s);
    let mut a = [0u8; N];
    a.copy_from_slice(&v);
    BytesN::from_array(env, &a)
}

fn bytes(env: &Env, s: &str) -> Bytes {
    Bytes::from_slice(env, &hex::decode(s).expect("hex"))
}

fn branch(env: &Env, items: &[&str]) -> Vec<BytesN<32>> {
    let mut v = Vec::new(env);
    for s in items {
        v.push_back(bytesn::<32>(env, s));
    }
    v
}

/// Decompress an Ethereum 48-byte compressed G1 pubkey into the 96-byte
/// uncompressed form the Soroban host expects (what the relayer does off-chain).
fn decompress_g1(c: &[u8; 48]) -> [u8; 96] {
    let p = Option::<bls12_381::G1Affine>::from(bls12_381::G1Affine::from_compressed(c))
        .expect("valid G1");
    p.to_uncompressed()
}

fn decompress_g2(c: &[u8; 96]) -> [u8; 192] {
    let p = Option::<bls12_381::G2Affine>::from(bls12_381::G2Affine::from_compressed(c))
        .expect("valid G2");
    p.to_uncompressed()
}

/// The real Sepolia sync committee (512 pubkeys), decompressed to uncompressed G1.
fn real_committee(env: &Env) -> Vec<BytesN<96>> {
    let raw = hex::decode(tv::COMMITTEE_COMPRESSED).expect("hex");
    assert_eq!(raw.len(), 512 * 48);
    let mut v = Vec::new(env);
    for i in 0..512 {
        let mut c = [0u8; 48];
        c.copy_from_slice(&raw[i * 48..i * 48 + 48]);
        v.push_back(BytesN::from_array(env, &decompress_g1(&c)));
    }
    v
}

fn real_signature(env: &Env) -> BytesN<192> {
    let raw = hex::decode(tv::SIGNATURE_COMPRESSED).expect("hex");
    let mut c = [0u8; 96];
    c.copy_from_slice(&raw);
    BytesN::from_array(env, &decompress_g2(&c))
}

fn real_update(env: &Env) -> LightClientUpdate {
    LightClientUpdate {
        attested_header: BeaconHeader {
            slot: tv::ATT_SLOT,
            proposer_index: tv::ATT_PROPOSER,
            parent_root: bytesn(env, tv::ATT_PARENT_ROOT),
            state_root: bytesn(env, tv::ATT_STATE_ROOT),
            body_root: bytesn(env, tv::ATT_BODY_ROOT),
        },
        finalized_header: BeaconHeader {
            slot: tv::FIN_SLOT,
            proposer_index: tv::FIN_PROPOSER,
            parent_root: bytesn(env, tv::FIN_PARENT_ROOT),
            state_root: bytesn(env, tv::FIN_STATE_ROOT),
            body_root: bytesn(env, tv::FIN_BODY_ROOT),
        },
        finality_branch: branch(env, tv::FINALITY_BRANCH),
        finalized_execution: ExecutionPayloadHeader {
            parent_hash: bytesn(env, tv::EXE_PARENT_HASH),
            fee_recipient: bytesn(env, tv::EXE_FEE_RECIPIENT),
            state_root: bytesn(env, tv::EXE_STATE_ROOT),
            receipts_root: bytesn(env, tv::EXE_RECEIPTS_ROOT),
            logs_bloom: bytes(env, tv::EXE_LOGS_BLOOM),
            prev_randao: bytesn(env, tv::EXE_PREV_RANDAO),
            block_number: tv::EXE_BLOCK_NUMBER,
            gas_limit: tv::EXE_GAS_LIMIT,
            gas_used: tv::EXE_GAS_USED,
            timestamp: tv::EXE_TIMESTAMP,
            extra_data: bytes(env, tv::EXE_EXTRA_DATA),
            base_fee_per_gas: bytesn(env, tv::EXE_BASE_FEE_LE),
            block_hash: bytesn(env, tv::EXE_BLOCK_HASH),
            transactions_root: bytesn(env, tv::EXE_TX_ROOT),
            withdrawals_root: bytesn(env, tv::EXE_WITHDRAWALS_ROOT),
            blob_gas_used: tv::EXE_BLOB_GAS_USED,
            excess_blob_gas: tv::EXE_EXCESS_BLOB_GAS,
        },
        execution_branch: branch(env, tv::EXECUTION_BRANCH),
        sync_committee_bits: bytesn(env, tv::SYNC_BITS),
        sync_committee_signature: real_signature(env),
        signature_slot: tv::SIGNATURE_SLOT,
    }
}

fn register_real(env: &Env) -> (EthLightClientClient<'_>, Address) {
    let admin = Address::generate(env);
    let id = env.register(
        EthLightClient,
        (
            real_committee(env),
            bytesn::<32>(env, tv::GENESIS_VALIDATORS_ROOT),
            bytesn::<4>(env, tv::FORK_VERSION),
            admin.clone(),
        ),
    );
    (EthLightClientClient::new(env, &id), admin)
}

// ----------------------------------------------------------------------------
// Stage A — posted-root fallback + storage/admin/head
// ----------------------------------------------------------------------------

fn dummy_committee(env: &Env) -> Vec<BytesN<96>> {
    // 512 copies of the (real, on-curve) G1 generator — enough for the
    // constructor's in-contract aggregation to succeed for Stage A tests.
    let g1: [u8; 96] = [
        0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c, 0x4f, 0xa9, 0xac,
        0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05, 0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b,
        0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f, 0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb,
        0x22, 0xc6, 0xbb, 0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
        0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6, 0x00, 0xdb, 0x18,
        0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44, 0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa,
        0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
    ];
    let mut v = Vec::new(env);
    for _ in 0..512 {
        v.push_back(BytesN::from_array(env, &g1));
    }
    v
}

fn setup_dummy(env: &Env) -> (EthLightClientClient<'_>, Address) {
    let admin = Address::generate(env);
    let id = env.register(
        EthLightClient,
        (
            dummy_committee(env),
            BytesN::from_array(env, &[1u8; 32]),
            BytesN::from_array(env, &[0x90, 0x00, 0x00, 0x75]),
            admin.clone(),
        ),
    );
    (EthLightClientClient::new(env, &id), admin)
}

#[test]
fn post_root_and_read_back() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup_dummy(&env);

    let root = BytesN::from_array(&env, &[7u8; 32]);
    client.post_root(&admin, &100u64, &root);

    assert_eq!(client.state_root_at(&100u64), Some(root));
    assert_eq!(client.state_root_at(&999u64), None);
}

#[test]
fn head_tracking() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup_dummy(&env);

    let r1 = BytesN::from_array(&env, &[1u8; 32]);
    let r2 = BytesN::from_array(&env, &[2u8; 32]);
    client.post_root(&admin, &50u64, &r1);
    assert_eq!(client.head(), (50u64, r1));

    client.post_root(&admin, &80u64, &r2);
    assert_eq!(client.head(), (80u64, r2.clone()));

    // an older block stays queryable but does not move the head.
    let r0 = BytesN::from_array(&env, &[9u8; 32]);
    client.post_root(&admin, &10u64, &r0);
    assert_eq!(client.head(), (80u64, r2));
    assert_eq!(client.state_root_at(&10u64), Some(r0));
}

#[test]
fn admin_gating() {
    let env = Env::default();
    let (client, _admin) = setup_dummy(&env);

    env.mock_all_auths();
    let attacker = Address::generate(&env);
    let root = BytesN::from_array(&env, &[3u8; 32]);
    let res = client.try_post_root(&attacker, &1u64, &root);
    assert!(res.is_err());
    assert_eq!(client.state_root_at(&1u64), None);
}

// ----------------------------------------------------------------------------
// Stage B — trustless update_header against REAL Sepolia (fulu) data
// ----------------------------------------------------------------------------

#[test]
fn real_finality_update_accepted() {
    let env = Env::default();
    let (client, _admin) = register_real(&env);

    // Verifies on real Sepolia data: slot order, >2/3 participation, BLS
    // aggregate + pairing, finality branch, execution branch.
    client.update_header(&real_update(&env));

    let expected_root = bytesn::<32>(&env, tv::EXE_STATE_ROOT);
    assert_eq!(
        client.state_root_at(&tv::EXE_BLOCK_NUMBER),
        Some(expected_root.clone())
    );
    assert_eq!(client.head(), (tv::EXE_BLOCK_NUMBER, expected_root));
}

#[test]
fn reject_insufficient_participation() {
    let env = Env::default();
    let (client, _admin) = register_real(&env);

    let mut u = real_update(&env);
    u.sync_committee_bits = BytesN::from_array(&env, &[0u8; 64]);
    let res = client.try_update_header(&u);
    assert!(res.is_err(), "all-zero participation must be rejected");
    assert_eq!(client.state_root_at(&tv::EXE_BLOCK_NUMBER), None);
}

#[test]
fn reject_tampered_signature() {
    let env = Env::default();
    let (client, _admin) = register_real(&env);

    // Negate the (valid) G2 signature: still a valid subgroup point, but the
    // wrong value -> the pairing check must fail (clean BadSignature, no trap).
    let raw = hex::decode(tv::SIGNATURE_COMPRESSED).unwrap();
    let mut c = [0u8; 96];
    c.copy_from_slice(&raw);
    let sig =
        Option::<bls12_381::G2Affine>::from(bls12_381::G2Affine::from_compressed(&c)).unwrap();
    let neg = (-sig).to_uncompressed();

    let mut u = real_update(&env);
    u.sync_committee_signature = BytesN::from_array(&env, &neg);
    let res = client.try_update_header(&u);
    assert!(res.is_err(), "negated signature must be rejected");
    assert_eq!(client.state_root_at(&tv::EXE_BLOCK_NUMBER), None);
}

#[test]
fn reject_bad_slot_order() {
    let env = Env::default();
    let (client, _admin) = register_real(&env);

    let mut u = real_update(&env);
    u.attested_header.slot = u.signature_slot; // attested >= signature
    let res = client.try_update_header(&u);
    assert!(res.is_err());
}

#[test]
fn reject_tampered_finality_branch() {
    let env = Env::default();
    let (client, _admin) = register_real(&env);

    let mut u = real_update(&env);
    let mut nodes: Vec<BytesN<32>> = Vec::new(&env);
    for (i, n) in u.finality_branch.iter().enumerate() {
        if i == 0 {
            nodes.push_back(BytesN::from_array(&env, &[0xaa; 32]));
        } else {
            nodes.push_back(n);
        }
    }
    u.finality_branch = nodes;
    let res = client.try_update_header(&u);
    assert!(res.is_err(), "corrupt finality branch must be rejected");
}

#[test]
fn reject_tampered_execution_state_root() {
    let env = Env::default();
    let (client, _admin) = register_real(&env);

    let mut u = real_update(&env);
    // Flip the execution state root: htr changes -> execution_branch fails.
    u.finalized_execution.state_root = BytesN::from_array(&env, &[0xbb; 32]);
    let res = client.try_update_header(&u);
    assert!(
        res.is_err(),
        "tampered execution state root must be rejected"
    );
}

#[test]
fn cost_estimate_update_header() {
    let env = Env::default();
    let (client, _admin) = register_real(&env);
    let update = real_update(&env);

    // reset_default sets the standard network limits (incl. 100M CPU) AND resets
    // the tracker; if update_header exceeded the budget the call would panic, so
    // a successful call here also proves it fits a single transaction.
    env.cost_estimate().budget().reset_default();
    client.update_header(&update);
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let mem = env.cost_estimate().budget().memory_bytes_cost();
    std::println!("update_header CPU instructions (host-fn metered) = {cpu}");
    std::println!("update_header memory bytes = {mem}");
    assert!(cpu < 100_000_000, "must fit the 100M tx budget, got {cpu}");
}

/// The real update above has 100% participation (all-0xff fast path), so it does
/// not exercise the non-signer SUBTRACTION arithmetic. This test does, with a
/// synthetic committee of 512 DISTINCT points p_i = (i+1)*G: it asserts
/// `aggregate_signers` returns `committee_agg - p_i` for the chosen non-signers
/// (so the bit decode, LSB ordering, index slicing, and negation are all correct).
#[test]
fn aggregate_signers_subtracts_non_signers() {
    use crate::verify;
    use soroban_sdk::crypto::bls12_381::Bls12381G1Affine;

    let env = Env::default();
    // This test builds 512 synthetic points (~1000 g1_add) purely to check the
    // aggregation arithmetic — uncap the budget so the scaffolding doesn't trip it.
    env.cost_estimate().budget().reset_unlimited();
    let id = env.register(
        EthLightClient,
        (
            real_committee(&env),
            bytesn::<32>(&env, tv::GENESIS_VALIDATORS_ROOT),
            bytesn::<4>(&env, tv::FORK_VERSION),
            Address::generate(&env),
        ),
    );

    let g: [u8; 96] = [
        0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c, 0x4f, 0xa9, 0xac,
        0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05, 0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b,
        0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f, 0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb,
        0x22, 0xc6, 0xbb, 0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
        0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6, 0x00, 0xdb, 0x18,
        0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44, 0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa,
        0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
    ];

    env.as_contract(&id, || {
        let bls = env.crypto().bls12_381();
        let gen = Bls12381G1Affine::from_array(&env, &g);

        // p_i = (i+1)*G ; pack committee, accumulate full aggregate, keep points.
        let mut points: std::vec::Vec<[u8; 96]> = std::vec::Vec::with_capacity(512);
        let mut packed = Bytes::new(&env);
        let mut cur = gen.clone();
        let mut agg = gen.clone();
        points.push(cur.to_array());
        packed.extend_from_array(&cur.to_array());
        for _ in 1..512 {
            cur = bls.g1_add(&cur, &gen);
            points.push(cur.to_array());
            packed.extend_from_array(&cur.to_array());
            agg = bls.g1_add(&agg, &cur);
        }
        let committee_agg = agg.to_bytes();

        // Non-signers at indices 0, 5, 13 (spans byte 0 and byte 1, distinct bits).
        let non_signers = [0usize, 5, 13];
        let mut bits = [0xffu8; 64];
        for &idx in non_signers.iter() {
            bits[idx / 8] &= !(1 << (idx % 8));
        }

        let got = verify::aggregate_signers(&env, &packed, &committee_agg, &bits);

        let mut expected = Bls12381G1Affine::from_bytes(committee_agg.clone());
        for &idx in non_signers.iter() {
            let p = Bls12381G1Affine::from_array(&env, &points[idx]);
            expected = bls.g1_add(&expected, &(-p));
        }
        assert!(
            got.to_bytes() == expected.to_bytes(),
            "non-signer subtraction"
        );

        // Full participation must return committee_agg unchanged.
        let full = verify::aggregate_signers(&env, &packed, &committee_agg, &[0xffu8; 64]);
        assert!(
            full.to_bytes() == committee_agg,
            "full participation == agg"
        );
    });
}
