/** Operation building for update_header / post_root / bridge_in (no network). */
import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { LightClientSubmitter } from "../src/lightclient.js";
import { BridgeInSubmitter } from "../src/inclusion.js";
import { minimalUpdate } from "./fixtures.js";
import type { Hex } from "viem";

const LC_ID = "CD7EF4GG32IPVS2PGD2LMXEO3TPEWBZRUCBBSPXQ236CD6TMF5S4UUZR";
const BRIDGE_ID = "CBKB3P72CTZAGODIKMQRLUJ2INHQULK5J66N6QQR7GCHGDUFCTUPJ6M3";

/** Extract { fn, argc } from a contract-invoke operation. */
function invokeInfo(op: xdr.Operation): { fn: string; argc: number } {
  expect(op.body().switch().name).toBe("invokeHostFunction");
  const ic = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
  return { fn: ic.functionName().toString(), argc: ic.args().length };
}

describe("LightClientSubmitter", () => {
  const lc = new LightClientSubmitter({ contractId: LC_ID });

  it("builds update_header(update) with a single struct arg", () => {
    const op = lc.updateHeaderOp(minimalUpdate());
    expect(invokeInfo(op)).toEqual({ fn: "update_header", argc: 1 });
    // The single arg is the LightClientUpdate map.
    const arg = op.body().invokeHostFunctionOp().hostFunction().invokeContract().args()[0]!;
    expect(arg.switch().name).toBe("scvMap");
    expect(op.toXDR("base64")).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("builds post_root(admin, block_number, state_root) with 3 args", () => {
    const op = lc.postRootOp({
      admin: "GAGEXK4SPRFYJMR3HXYXMCDBEWBFO4BHJP4XWO3L43HJU366UWPY4MKX",
      blockNumber: 123n,
      stateRoot: `0x${"ab".repeat(32)}` as Hex,
    });
    expect(invokeInfo(op)).toEqual({ fn: "post_root", argc: 3 });
  });
});

describe("BridgeInSubmitter", () => {
  it("builds bridge_in with 6 args in BRIDGE_SPEC §7 order", () => {
    const bridge = new BridgeInSubmitter({ contractId: BRIDGE_ID });
    const op = bridge.bridgeInOp({
      blockNumber: 11_173_338n,
      commitment: `0x${"0e".repeat(32)}` as Hex,
      token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Hex,
      amount: 1_000_000n,
      accountProof: [`0x${"ab".repeat(40)}` as Hex],
      storageProof: [`0x${"cd".repeat(40)}` as Hex],
    });
    const info = invokeInfo(op);
    expect(info).toEqual({ fn: "bridge_in", argc: 6 });
    const args = op.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
    expect(args[0]!.switch().name).toBe("scvU64"); // block_number
    expect(args[1]!.switch().name).toBe("scvBytes"); // commitment
    expect(args[2]!.switch().name).toBe("scvBytes"); // token
    expect(args[3]!.switch().name).toBe("scvI128"); // amount
    expect(args[4]!.switch().name).toBe("scvVec"); // account_proof
    expect(args[5]!.switch().name).toBe("scvVec"); // storage_proof
  });
});
