use poseidon::poseidon2::Poseidon2;

// Emits Obscura golden vectors used by the SDK tests:
//   * Poseidon2 hash vectors (arities 2, 4, 7)  -> test/poseidon.golden.json
//   * zeros[0..20] empty-subtree constants       -> src/constants.ts
//   * incremental Merkle roots                   -> test/merkle.golden.json
//
// Run:  cd test/golden-gen && source ../../../env.sh && nargo test --show-output
//
// Poseidon2 here is noir-lang/poseidon v0.2.0 (BN254, t=4, RATE=3,
// IV = in_len * 2^64, output = state[0]) -- byte-for-byte identical to
// soroban-poseidon poseidon2_hash::<4, BnScalar> and to the in-circuit hashes.

global DEPTH: u32 = 20;

fn h2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

fn zeros_arr() -> [Field; 21] {
    let mut z: [Field; 21] = [0; 21];
    for i in 0..DEPTH {
        z[i + 1] = h2(z[i], z[i]);
    }
    z
}

// Frontier / filled_subtrees incremental insertion (SHARED.md sec 5 / SPEC sec 4.5).
// Returns the tree root after inserting leaves[0..N] left-to-right.
fn build_root<let N: u32>(leaves: [Field; N]) -> Field {
    let z = zeros_arr();
    let mut filled: [Field; 20] = [0; 20];
    let mut root: Field = z[DEPTH];
    for idx in 0..N {
        let mut current = leaves[idx];
        let mut index = idx;
        for level in 0..DEPTH {
            if index % 2 == 0 {
                filled[level] = current;
                current = h2(current, z[level]);
            } else {
                current = h2(filled[level], current);
            }
            index = index / 2;
        }
        root = current;
    }
    root
}

fn main() {}

#[test]
fn print_golden_vectors() {
    let h2_12 = Poseidon2::hash([1, 2], 2);
    let h2_00 = Poseidon2::hash([0, 0], 2);
    let h4 = Poseidon2::hash([1, 2, 3, 4], 4);
    let h7 = Poseidon2::hash([1, 2, 3, 4, 5, 6, 7], 7);
    println(f"hash2_1_2={h2_12}");
    println(f"hash2_0_0={h2_00}");
    println(f"hash4_1_2_3_4={h4}");
    println(f"hash7_1_7={h7}");
}

#[test]
fn print_zeros() {
    let z = zeros_arr();
    for i in 0..21 {
        let v = z[i];
        println(f"zero_{i}={v}");
    }
}

#[test]
fn print_note_and_order_vectors() {
    // Balance note: asset_id=5, amount=1000, spending_key=42, blinding=7
    let owner_key = h2(42, 0);
    let viewing_key = h2(42, 1);
    let commitment = Poseidon2::hash([5, 1000, owner_key, 7], 4);
    let nullifier = h2(commitment, 42);
    println(f"owner_key_42={owner_key}");
    println(f"viewing_key_42={viewing_key}");
    println(f"note_commitment={commitment}");
    println(f"note_nullifier={nullifier}");

    // Order: side=1(sell), price=25_000_000, amount=1000, base=5, quote=9, nonce=123
    let order_commitment =
        Poseidon2::hash([1, 25000000, 1000, 5, 9, owner_key, 123], 7);
    println(f"order_commitment={order_commitment}");
}

#[test]
fn print_merkle_roots() {
    let empty = zeros_arr()[DEPTH];
    let r1 = build_root([1]);
    let r2 = build_root([1, 2]);
    let r3 = build_root([1, 2, 3]);
    let r4 = build_root([1, 2, 3, 4]);
    println(f"root_empty={empty}");
    println(f"root_1={r1}");
    println(f"root_1_2={r2}");
    println(f"root_1_2_3={r3}");
    println(f"root_1_2_3_4={r4}");
}
