//! BLS12-381 sync-committee signature verification using the Soroban CAP-0059
//! host functions (`g1_add`, `hash_to_g2`, `pairing_check`, subgroup checks).
//!
//! Aggregation strategy (BRIDGE_SPEC §5.3): start from the precomputed all-512
//! aggregate and SUBTRACT non-signers (point negation + add). Real finality
//! updates have ~100% participation, so this is typically a handful of adds
//! instead of ~342.
//!
//! All points are UNCOMPRESSED here. Pubkeys come from the trusted seed; the
//! signature is decompressed off-chain by the (untrusted) relayer — the pairing
//! check binds it to the message, so a wrong decompression cannot pass.

use soroban_sdk::{
    crypto::bls12_381::{Bls12381G1Affine, Bls12381G2Affine},
    Bytes, BytesN, Env, Vec,
};

/// Sync committee size (Altair).
pub const COMMITTEE_SIZE: u32 = 512;

/// RFC 9380 ciphersuite / domain-separation tag for Ethereum consensus BLS
/// signatures (minimal-pubkey-size, proof-of-possession). `hash_to_g2` uses it.
pub const ETH2_SIG_DST: &[u8] = b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";

/// Uncompressed BLS12-381 G1 generator: be(x) || be(y).
const G1_GENERATOR: [u8; 96] = [
    0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c, 0x4f, 0xa9, 0xac, 0x0f,
    0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05, 0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58,
    0x6c, 0x55, 0xe8, 0x3f, 0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
    0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed, 0x74, 0x1d, 0x8a, 0xe4,
    0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6, 0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed,
    0xd0, 0x3c, 0xc7, 0x44, 0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
];

/// Count the set bits in a 64-byte (512-bit) little-endian bitfield.
pub fn count_participation(bits: &[u8; 64]) -> u32 {
    let mut c = 0u32;
    for b in bits.iter() {
        c += b.count_ones();
    }
    c
}

/// Read the `idx`-th uncompressed (96-byte) committee pubkey out of the packed
/// committee bytes.
fn read_pubkey(env: &Env, committee: &Bytes, idx: u32) -> Bls12381G1Affine {
    let start = idx * 96;
    let mut buf = [0u8; 96];
    committee.slice(start..start + 96).copy_into_slice(&mut buf);
    Bls12381G1Affine::from_array(env, &buf)
}

/// Aggregate the participating committee pubkeys = `committee_agg` minus the
/// non-signers. `committee` is the packed 512*96 uncompressed pubkeys;
/// `committee_agg` is the precomputed sum of all 512; `bits` selects signers.
pub fn aggregate_signers(
    env: &Env,
    committee: &Bytes,
    committee_agg: &BytesN<96>,
    bits: &[u8; 64],
) -> Bls12381G1Affine {
    let bls = env.crypto().bls12_381();
    let mut agg = Bls12381G1Affine::from_bytes(committee_agg.clone());
    let mut idx = 0u32;
    for byte_i in 0..64usize {
        let byte = bits[byte_i];
        // Fast path: whole byte set -> all 8 members signed, nothing to subtract.
        if byte == 0xff {
            idx += 8;
            continue;
        }
        for bit in 0..8u32 {
            if (byte >> bit) & 1 == 0 {
                // non-signer: agg = agg + (-pubkey)
                let pk = read_pubkey(env, committee, idx);
                agg = bls.g1_add(&agg, &(-pk));
            }
            idx += 1;
        }
    }
    agg
}

/// `FastAggregateVerify`: 2-pairing check `e(agg_pk, H(m)) == e(G1, sig)`.
/// Returns true iff the signature is valid for `signing_root` under `agg_pk`.
pub fn fast_aggregate_verify(
    env: &Env,
    agg_pk: &Bls12381G1Affine,
    signing_root: &BytesN<32>,
    signature: &Bls12381G2Affine,
) -> bool {
    let bls = env.crypto().bls12_381();

    let dst = Bytes::from_slice(env, ETH2_SIG_DST);
    let msg = Bytes::from_array(env, &signing_root.to_array());
    let h_m = bls.hash_to_g2(&msg, &dst);

    // e(agg_pk, H(m)) * e(-G1, sig) == 1
    let g1 = Bls12381G1Affine::from_array(env, &G1_GENERATOR);
    let neg_g1 = -g1;

    let mut g1s: Vec<Bls12381G1Affine> = Vec::new(env);
    g1s.push_back(agg_pk.clone());
    g1s.push_back(neg_g1);

    let mut g2s: Vec<Bls12381G2Affine> = Vec::new(env);
    g2s.push_back(h_m);
    g2s.push_back(signature.clone());

    bls.pairing_check(g1s, g2s)
}

/// Subgroup check for a G1 point (used on the final aggregate).
pub fn g1_in_subgroup(env: &Env, p: &Bls12381G1Affine) -> bool {
    env.crypto().bls12_381().g1_is_in_subgroup(p)
}

/// Subgroup check for a G2 point (used on the untrusted signature).
pub fn g2_in_subgroup(env: &Env, p: &Bls12381G2Affine) -> bool {
    env.crypto().bls12_381().g2_is_in_subgroup(p)
}
