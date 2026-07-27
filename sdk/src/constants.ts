/**
 * Obscura SDK constants.
 *
 * All values here are cross-component invariants (SHARED.md). Do not change them
 * without changing the Noir circuits and the Soroban contract in lockstep.
 */

/** Price scaling factor for limit prices (10^7). SHARED sec 4 / SPEC sec 7.1. */
export const PRICE_SCALE = 10_000_000n;

/** Incremental Merkle tree depth. SHARED sec 5 / SPEC sec 4.5. */
export const TREE_DEPTH = 20;

/**
 * BN254 (alt_bn128) scalar field modulus `r`. All Field elements are values < r.
 * SHARED sec 2.
 */
export const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Number of bytes in a serialized Field element (32-byte big-endian). */
export const FIELD_BYTES = 32;

/** Native XLM asset id. SHARED sec 4 / SPEC sec 5.3. */
export const NATIVE_ASSET_ID = 0n;

/**
 * Precomputed empty-subtree roots: `zeros[0] = 0`, `zeros[i+1] = hash2(zeros[i], zeros[i])`.
 * SHARED sec 5 / SPEC sec 4.5. `zeros[TREE_DEPTH]` is the root of a fully-empty tree.
 *
 * These literals were generated authoritatively from the pinned Noir `poseidon` v0.2.0
 * lib (test/golden-gen). test/merkle.test.ts re-derives them via src/poseidon.ts and
 * asserts equality, so a JS-Poseidon regression cannot pass silently.
 */
export const ZEROS: readonly bigint[] = [
  0x00n,
  0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1n,
  0x0e34ac2c09f45a503d2908bcb12f1cbae5fa4065759c88d501c097506a8b2290n,
  0x21f9172d72fdcdafc312eee05cf5092980dda821da5b760a9fb8dbdf607c8a20n,
  0x2373ea368857ec7af97e7b470d705848e2bf93ed7bef142a490f2119bcf82d8en,
  0x120157cfaaa49ce3da30f8b47879114977c24b266d58b0ac18b325d878aafddfn,
  0x01c28fe1059ae0237b72334700697bdf465e03df03986fe05200cadeda66bd76n,
  0x2d78ed82f93b61ba718b17c2dfe5b52375b4d37cbbed6f1fc98b47614b0cf21bn,
  0x067243231eddf4222f3911defbba7705aff06ed45960b27f6f91319196ef97e1n,
  0x1849b85f3c693693e732dfc4577217acc18295193bede09ce8b97ad910310972n,
  0x2a775ea761d20435b31fa2c33ff07663e24542ffb9e7b293dfce3042eb104686n,
  0x0f320b0703439a8114f81593de99cd0b8f3b9bf854601abb5b2ea0e8a3dda4a7n,
  0x0d07f6e7a8a0e9199d6d92801fff867002ff5b4808962f9da2ba5ce1bdd26a73n,
  0x1c4954081e324939350febc2b918a293ebcdaead01be95ec02fcbe8d2c1635d1n,
  0x0197f2171ef99c2d053ee1fb5ff5ab288d56b9b41b4716c9214a4d97facc4c4an,
  0x2b9cdd484c5ba1e4d6efcc3f18734b5ac4c4a0b9102e2aeb48521a661d3feee9n,
  0x14f44d672eb357739e42463497f9fdac46623af863eea4d947ca00a497dcdeb3n,
  0x071d7627ae3b2eabda8a810227bf04206370ac78dbf6c372380182dbd3711fe3n,
  0x2fdc08d9fe075ac58cb8c00f98697861a13b3ab6f9d41a4e768f75e477475bf5n,
  0x20165fe405652104dceaeeca92950aa5adc571b8cafe192878cba58ff1be49c5n,
  0x1c8c3ca0b3a3d75850fcd4dc7bf1e3445cd0cfff3ca510630fd90b47e8a24755n,
] as const;

/** Root of a fully-empty depth-20 tree (= ZEROS[TREE_DEPTH]). */
export const EMPTY_ROOT = ZEROS[TREE_DEPTH]!;

/** UltraHonk proof size in bytes (456 x 32). SHARED sec 6. */
export const PROOF_BYTES = 14_592;

/** UltraHonk verification-key size in bytes. SHARED sec 6. */
export const VK_BYTES = 1_760;
