/**
 * BLS12-381 point decompression round-trips.
 *
 * The load-bearing assertion: decompressing the COMPRESSED G1 generator yields a
 * byte string identical to the `EthLightClient` contract's own `G1_GENERATOR`
 * constant (contracts/eth-light-client/src/verify.rs) — i.e. our `@noble/curves`
 * output is byte-for-byte the `be(x)||be(y)` layout the Soroban host (and the
 * zkcrypto `bls12_381` crate the on-chain test vectors are built with) expects.
 * If this ever diverged, every `update_header` would fail the pairing check.
 */
import { describe, expect, it } from "vitest";
import { compressG1, compressG2, decompressCommittee, decompressG1, decompressG2 } from "../src/beacon.js";

// Canonical BLS12-381 generators (ETH2 / zcash serialization).
const G1_COMPRESSED =
  "0x97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb";
// Exactly the `G1_GENERATOR` constant in contracts/eth-light-client/src/verify.rs.
const G1_UNCOMPRESSED_CONTRACT =
  "0x17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1";

const G2_COMPRESSED =
  "0x93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8";
const G2_UNCOMPRESSED =
  "0x13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801";

describe("BLS G1 decompression", () => {
  it("decompresses the compressed G1 generator to the contract's exact G1_GENERATOR bytes", () => {
    const out = decompressG1(G1_COMPRESSED);
    expect(out).toBe(G1_UNCOMPRESSED_CONTRACT);
    expect((out.length - 2) / 2).toBe(96);
  });

  it("round-trips compress(decompress(x)) === x for G1", () => {
    expect(compressG1(decompressG1(G1_COMPRESSED))).toBe(G1_COMPRESSED);
  });

  it("rejects a wrong-length G1 input", () => {
    expect(() => decompressG1("0x1234")).toThrow(/48 bytes/);
  });
});

describe("BLS G2 decompression", () => {
  it("decompresses the compressed G2 generator to its 192-byte uncompressed form", () => {
    const out = decompressG2(G2_COMPRESSED);
    expect(out).toBe(G2_UNCOMPRESSED);
    expect((out.length - 2) / 2).toBe(192);
  });

  it("round-trips compress(decompress(x)) === x for G2", () => {
    expect(compressG2(decompressG2(G2_COMPRESSED))).toBe(G2_COMPRESSED);
  });

  it("rejects a wrong-length G2 input", () => {
    expect(() => decompressG2(G1_COMPRESSED)).toThrow(/96 bytes/);
  });
});

describe("committee decompression", () => {
  it("decompresses 512 pubkeys to 96-byte uncompressed each", () => {
    const committee = decompressCommittee(Array.from({ length: 512 }, () => G1_COMPRESSED));
    expect(committee).toHaveLength(512);
    for (const pk of committee) expect((pk.length - 2) / 2).toBe(96);
    expect(committee[0]).toBe(G1_UNCOMPRESSED_CONTRACT);
  });

  it("rejects a committee that is not exactly 512 pubkeys", () => {
    expect(() => decompressCommittee([G1_COMPRESSED])).toThrow(/512/);
  });
});
