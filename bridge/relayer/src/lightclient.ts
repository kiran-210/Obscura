/**
 * Header feed -> `EthLightClient` Soroban contract.
 *
 * Builds (and optionally live-submits) `update_header(update)` — the trustless
 * path — and `post_root(admin, block, state_root)` — the admin-gated, NON-
 * trustless fallback (BRIDGE_SPEC §5). The relayer is untrusted transport: a
 * header is accepted on-chain only if > 2/3 of the seeded sync committee signed
 * it (BLS pairing check) and the SSZ branches verify. Building the operations is
 * pure and unit-tested; the live submit path is integration-only.
 */
import { Contract, Networks, xdr } from "@stellar/stellar-sdk";
import { encodeLightClientUpdate, scvAddress, scvBytesHex, scvU64 } from "./scval.js";
import { simulateView, submitInvoke, type LiveSubmitOptions, type ViewOptions } from "./soroban.js";
import type { LightClientUpdateData } from "./types.js";
import type { Hex } from "viem";

/** Builds / submits operations against a deployed `EthLightClient` contract. */
export class LightClientSubmitter {
  readonly contract: Contract;
  readonly contractId: string;
  readonly networkPassphrase: string;

  constructor(opts: { contractId: string; networkPassphrase?: string }) {
    this.contractId = opts.contractId;
    this.contract = new Contract(opts.contractId);
    this.networkPassphrase = opts.networkPassphrase ?? Networks.TESTNET;
  }

  /** Build `update_header(update)` (trustless path). No network. */
  updateHeaderOp(update: LightClientUpdateData): xdr.Operation {
    return this.contract.call("update_header", encodeLightClientUpdate(update));
  }

  /** Build `post_root(admin, block_number, state_root)` (fallback path, NOT trustless). No network. */
  postRootOp(args: { admin: string; blockNumber: bigint | number; stateRoot: Hex }): xdr.Operation {
    return this.contract.call(
      "post_root",
      scvAddress(args.admin),
      scvU64(args.blockNumber),
      scvBytesHex(args.stateRoot),
    );
  }

  /** Live-submit `update_header`. Integration-only. Returns the tx hash. */
  async submitUpdateHeader(update: LightClientUpdateData, opts: LiveSubmitOptions): Promise<string> {
    return submitInvoke(this.updateHeaderOp(update), {
      networkPassphrase: this.networkPassphrase,
      ...opts,
    });
  }

  /** Live-submit `post_root` (fallback). Integration-only. Returns the tx hash. */
  async submitPostRoot(
    args: { admin: string; blockNumber: bigint | number; stateRoot: Hex },
    opts: LiveSubmitOptions,
  ): Promise<string> {
    return submitInvoke(this.postRootOp(args), {
      networkPassphrase: this.networkPassphrase,
      ...opts,
    });
  }

  /**
   * Read the contract's trusted head `(block_number, state_root)` via simulation.
   * Integration-only. The bridge-in proof must be taken at a block the head (or a
   * recorded root) covers.
   */
  async readHead(opts: ViewOptions): Promise<{ blockNumber: bigint; stateRoot: Hex }> {
    const head = (await simulateView(this.contractId, "head", {
      networkPassphrase: this.networkPassphrase,
      ...opts,
    })) as [bigint | number, Uint8Array];
    const [block, root] = head;
    return {
      blockNumber: BigInt(block),
      stateRoot: `0x${Buffer.from(root).toString("hex")}` as Hex,
    };
  }
}
