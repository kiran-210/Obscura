/**
 * Inclusion feed -> `WraithBridge` Soroban contract.
 *
 * Given a Wraith note `commitment` (or a watched L1 `Locked` event), the relayer:
 *   1. derives the L1 storage slot of `locks[commitment]`
 *        slot = keccak256(abi.encode(commitment, uint256(0)))   (mapping decl slot 0)
 *   2. calls `eth_getProof(bridgeL1, [slot], block)` on a Sepolia execution RPC,
 *   3. packages `accountProof` + `storageProof[0].proof` as `Bytes[]` (each entry
 *      is one already-RLP-encoded MPT trie node — passed through verbatim),
 *   4. submits `bridge_in(block, commitment, token, amount, accountProof, storageProof)`.
 *
 * The relayer holds no authority: the Soroban MPT verifier re-checks every node
 * (keccak + RLP) against the light client's trusted `state_root`, and re-derives
 * `(token, amount)` from the proven word. Slot derivation, proof packaging, and
 * the lock-word decode are pure + unit-tested; `eth_getProof` and submission are
 * integration-only.
 */
import { Contract, Networks, xdr } from "@stellar/stellar-sdk";
import {
  encodeAbiParameters,
  fromRlp,
  keccak256,
  numberToBytes,
  type Hex,
  type PublicClient,
} from "viem";
import { scvBytesHex, scvI128, scvU64, scvVecBytes } from "./scval.js";
import { submitInvoke, type LiveSubmitOptions } from "./soroban.js";

/**
 * Derive the L1 storage slot for `locks[commitment]` (mapping declared at slot
 * `p`, default 0): `keccak256(abi.encode(bytes32 commitment, uint256 p))`.
 * Matches the Soroban `bridge_in` derivation and the L1 README worked example.
 */
export function deriveStorageSlot(commitment: Hex, declarationSlot: bigint = 0n): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [commitment, declarationSlot],
    ),
  );
}

/**
 * Package eth_getProof MPT nodes into the `Bytes[]` the contract walks. Each node
 * returned by `eth_getProof` is ALREADY an RLP-encoded trie node, so packaging is
 * pass-through; we validate each node is well-formed RLP (throws otherwise) so a
 * malformed proof is caught before submission rather than reverting on-chain.
 */
export function packProofNodes(nodes: Hex[]): Hex[] {
  for (const node of nodes) {
    // fromRlp throws on malformed input; a valid MPT node decodes to a list
    // (branch = 17 items, extension/leaf = 2 items).
    const decoded = fromRlp(node, "hex");
    if (!Array.isArray(decoded)) {
      throw new Error(`proof node is not an RLP list: ${node.slice(0, 18)}...`);
    }
  }
  return nodes;
}

/** Shape of the parts of an `eth_getProof` result the relayer consumes. */
export interface ProofResult {
  accountProof: Hex[];
  storageProof: { key: Hex; value: Hex; proof: Hex[] }[];
}

/** Packaged proof ready for `bridge_in`. */
export interface PackagedProof {
  accountProof: Hex[];
  storageProof: Hex[];
  /** The proven storage value as returned by the node (RLP-stripped quantity). */
  value: Hex;
}

/** Extract + validate the account proof and the first storage proof from an eth_getProof result. */
export function packageProof(proof: ProofResult): PackagedProof {
  const sp = proof.storageProof[0];
  if (!sp) throw new Error("eth_getProof returned no storageProof entry");
  return {
    accountProof: packProofNodes(proof.accountProof),
    storageProof: packProofNodes(sp.proof),
    value: sp.value,
  };
}

/**
 * Decode the packed `LockRecord` storage word (BRIDGE_SPEC §4 / L1 README §2):
 * left-pad the proven value to 32 bytes big-endian, then
 *   token  = low  20 bytes (bits   0..159),  address(0) => native ETH
 *   amount = high 12 bytes (bits 160..255),  uint96
 * The contract re-derives this on-chain; this is a relayer-side sanity check.
 */
export function decodeLockWord(value: Hex | bigint): { token: Hex; amount: bigint } {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) throw new Error("lock word must be non-negative");
  const w = numberToBytes(v, { size: 32 }); // 32-byte big-endian
  const token = (`0x${Buffer.from(w.slice(12)).toString("hex")}`) as Hex; // low 20 bytes
  let amount = 0n;
  for (const b of w.slice(0, 12)) amount = (amount << 8n) | BigInt(b); // high 12 bytes, BE
  return { token, amount };
}

/**
 * Fetch an EIP-1186 proof of `locks[commitment]` at `blockNumber` via a viem
 * public client. Integration-only (hits the execution RPC). Returns the packaged
 * proof + the slot used.
 */
export async function fetchInclusionProof(
  client: PublicClient,
  args: { bridgeL1: Hex; commitment: Hex; blockNumber: bigint },
): Promise<PackagedProof & { slot: Hex }> {
  const slot = deriveStorageSlot(args.commitment);
  const proof = (await client.getProof({
    address: args.bridgeL1,
    storageKeys: [slot],
    blockNumber: args.blockNumber,
  })) as unknown as ProofResult;
  return { ...packageProof(proof), slot };
}

/** Arguments for `bridge_in`. */
export interface BridgeInArgs {
  blockNumber: bigint | number;
  /** 32-byte Wraith note commitment. */
  commitment: Hex;
  /** 20-byte L1 token address (0x00..00 = native ETH). */
  token: Hex;
  amount: bigint;
  /** RLP-encoded account-proof MPT nodes. */
  accountProof: Hex[];
  /** RLP-encoded storage-proof MPT nodes. */
  storageProof: Hex[];
}

/** Builds / submits `bridge_in` operations against a deployed `WraithBridge` contract. */
export class BridgeInSubmitter {
  readonly contract: Contract;
  readonly contractId: string;
  readonly networkPassphrase: string;

  constructor(opts: { contractId: string; networkPassphrase?: string }) {
    this.contractId = opts.contractId;
    this.contract = new Contract(opts.contractId);
    this.networkPassphrase = opts.networkPassphrase ?? Networks.TESTNET;
  }

  /**
   * Build `bridge_in(block_number, commitment, token, amount, account_proof,
   * storage_proof)` (BRIDGE_SPEC §7 argument order). No network.
   */
  bridgeInOp(args: BridgeInArgs): xdr.Operation {
    return this.contract.call(
      "bridge_in",
      scvU64(args.blockNumber),
      scvBytesHex(args.commitment),
      scvBytesHex(args.token),
      scvI128(args.amount),
      scvVecBytes(args.accountProof),
      scvVecBytes(args.storageProof),
    );
  }

  /** Live-submit `bridge_in`. Integration-only. Returns the tx hash. */
  async submitBridgeIn(args: BridgeInArgs, opts: LiveSubmitOptions): Promise<string> {
    return submitInvoke(this.bridgeInOp(args), {
      networkPassphrase: this.networkPassphrase,
      ...opts,
    });
  }
}
