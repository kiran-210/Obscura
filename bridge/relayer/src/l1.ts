/**
 * Out feed: Stellar `bridge_out` authorization -> L1 settlement.
 *
 * When a user burns a bridged note on Soroban (`ObscuraBridge.bridge_out`), the
 * contract emits an unlock authorization carrying the original L1 `commitment`
 * and the chosen `l1_recipient`. The relayer (running the **governor** key, for
 * the hackathon — BRIDGE_SPEC §4/§8) calls `ObscuraBridgeL1.unlock(commitment,
 * to)` to release the escrow. Future work verifies the Stellar proof on L1 so the
 * settlement is trustless too.
 *
 * Also exposes L1 `Locked`-event watching that drives the inclusion feed.
 *
 * NOTE: the exact `bridge_out` event schema is finalized in the bridge contract
 * branch (feat/bridge-contract). {@link parseBridgeOutEvent} is written
 * defensively against the documented shape (a `commitment` BytesN<32> + an
 * `l1_recipient` BytesN<20>) and is easy to retarget. The L1 `Locked` event and
 * `unlock`/`locks` ABI are pinned by `bridge/l1/src/ObscuraBridgeL1.sol`.
 */
import {
  getAddress,
  parseAbiItem,
  type Address as EvmAddress,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from "viem";

/** Minimal ABI for the L1 lock contract (matches ObscuraBridgeL1.sol). */
export const OBSCURA_BRIDGE_L1_ABI = [
  {
    type: "function",
    name: "unlock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "commitment", type: "bytes32" },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "locks",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint96" },
    ],
  },
  {
    type: "event",
    name: "Locked",
    inputs: [
      { name: "commitment", type: "bytes32", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Unlocked",
    inputs: [
      { name: "commitment", type: "bytes32", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export const LOCKED_EVENT = parseAbiItem(
  "event Locked(bytes32 indexed commitment, address token, uint256 amount)",
);

/** A decoded L1 lock record (read from `locks(commitment)`). */
export interface LockRecord {
  token: EvmAddress;
  amount: bigint;
}

/** Read `locks[commitment]` from L1 (token + amount). Integration-only. */
export async function readLock(
  client: PublicClient,
  bridgeL1: EvmAddress,
  commitment: Hex,
): Promise<LockRecord> {
  const [token, amount] = (await client.readContract({
    address: bridgeL1,
    abi: OBSCURA_BRIDGE_L1_ABI,
    functionName: "locks",
    args: [commitment],
  })) as [EvmAddress, bigint];
  return { token, amount };
}

/** Call `ObscuraBridgeL1.unlock(commitment, to)` with the governor wallet. Returns the tx hash. */
export async function unlockOnL1(
  wallet: WalletClient,
  bridgeL1: EvmAddress,
  commitment: Hex,
  to: EvmAddress,
): Promise<Hex> {
  const account = wallet.account;
  if (!account) throw new Error("wallet client has no account (governor key not configured)");
  return wallet.writeContract({
    account,
    chain: wallet.chain ?? null,
    address: bridgeL1,
    abi: OBSCURA_BRIDGE_L1_ABI,
    functionName: "unlock",
    args: [commitment, getAddress(to)],
  });
}

/** A parsed `Locked` event the inclusion feed acts on. */
export interface LockedEvent {
  commitment: Hex;
  token: EvmAddress;
  amount: bigint;
  blockNumber: bigint;
  transactionHash: Hex;
}

/** Decode a viem `Locked` log into a {@link LockedEvent}. */
export function parseLockedLog(
  log: Log<bigint, number, false, typeof LOCKED_EVENT>,
): LockedEvent {
  const { commitment, token, amount } = log.args as {
    commitment: Hex;
    token: EvmAddress;
    amount: bigint;
  };
  return {
    commitment,
    token,
    amount,
    blockNumber: log.blockNumber ?? 0n,
    transactionHash: log.transactionHash ?? ("0x" as Hex),
  };
}

/** Handle for stopping a watch loop. */
export interface Watcher {
  stop(): void;
}

/**
 * Watch L1 `Locked` events from `bridgeL1`, invoking `onLocked` for each. Uses
 * viem's `watchEvent` (RPC-polled). Integration-only. Returns a stop handle.
 */
export function watchLocked(
  client: PublicClient,
  bridgeL1: EvmAddress,
  onLocked: (ev: LockedEvent) => void | Promise<void>,
  opts: { pollingIntervalMs?: number; fromBlock?: bigint } = {},
): Watcher {
  const unwatch = client.watchEvent({
    address: bridgeL1,
    event: LOCKED_EVENT,
    ...(opts.pollingIntervalMs !== undefined ? { pollingInterval: opts.pollingIntervalMs } : {}),
    ...(opts.fromBlock !== undefined ? { fromBlock: opts.fromBlock } : {}),
    onLogs: (logs) => {
      for (const log of logs as Log<bigint, number, false, typeof LOCKED_EVENT>[]) {
        void Promise.resolve(onLocked(parseLockedLog(log))).catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[l1] onLocked handler failed:", err);
        });
      }
    },
  });
  return { stop: unwatch };
}

// ---------------------------------------------------------------------------
// Stellar bridge_out -> L1 unlock
// ---------------------------------------------------------------------------

/** A parsed `bridge_out` authorization. */
export interface BridgeOutEvent {
  /** Original L1 lock commitment (32-byte hex). */
  commitment: Hex;
  /** L1 recipient address (20-byte hex). */
  l1Recipient: EvmAddress;
}

/** Topic symbol the ObscuraBridge `bridge_out` event is published under (configurable). */
export const BRIDGE_OUT_TOPIC = "bridge_out";

function bytesToHexMaybe(v: unknown): Hex | undefined {
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString("hex")}` as Hex;
  if (Buffer.isBuffer(v)) return `0x${v.toString("hex")}` as Hex;
  if (typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v)) return v as Hex;
  return undefined;
}

/**
 * Parse a Soroban-decoded `bridge_out` event value into a {@link BridgeOutEvent}.
 *
 * Accepts either a map-like object with `commitment` + `l1_recipient` keys, or a
 * tuple/array whose elements are a 32-byte and a 20-byte byte string. Defensive
 * because the precise schema is owned by feat/bridge-contract; throws if it can't
 * find a 32-byte commitment and a 20-byte recipient.
 */
export function parseBridgeOutEvent(value: unknown): BridgeOutEvent {
  let commitment: Hex | undefined;
  let recipient: Hex | undefined;

  const consider = (raw: unknown, keyHint?: string): void => {
    const hex = bytesToHexMaybe(raw);
    if (!hex) return;
    const byteLen = (hex.length - 2) / 2;
    if (keyHint === "commitment" || (commitment === undefined && byteLen === 32)) {
      if (byteLen === 32) commitment = hex;
    }
    if (keyHint === "l1_recipient" || keyHint === "recipient" || (recipient === undefined && byteLen === 20)) {
      if (byteLen === 20) recipient = hex;
    }
  };

  if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) consider(v, k);
  } else if (Array.isArray(value)) {
    for (const v of value) consider(v);
  } else {
    consider(value);
  }

  if (!commitment) throw new Error("bridge_out event: no 32-byte commitment found");
  if (!recipient) throw new Error("bridge_out event: no 20-byte l1_recipient found");
  return { commitment, l1Recipient: getAddress(recipient) };
}

/**
 * Poll the Soroban RPC for `ObscuraBridge` `bridge_out` events and invoke
 * `onEvent` for each. Integration-only (needs a reachable Soroban RPC). Returns a
 * stop handle. The event decoding uses {@link parseBridgeOutEvent}.
 */
export function watchBridgeOut(
  args: {
    rpcUrl: string;
    contractId: string;
    topic?: string;
    pollingIntervalMs?: number;
    startLedger?: number;
  },
  onEvent: (ev: BridgeOutEvent) => void | Promise<void>,
): Watcher {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interval = args.pollingIntervalMs ?? 5_000;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const { rpc, scValToNative, xdr, nativeToScVal } = await import("@stellar/stellar-sdk");
      const server = new rpc.Server(args.rpcUrl);
      const startLedger =
        args.startLedger ?? Math.max(1, (await server.getLatestLedger()).sequence - 1000);
      const topicSym = nativeToScVal(args.topic ?? BRIDGE_OUT_TOPIC, { type: "symbol" });
      const res = await server.getEvents({
        startLedger,
        filters: [
          {
            type: "contract",
            contractIds: [args.contractId],
            topics: [[topicSym.toXDR("base64")]],
          },
        ],
      });
      for (const ev of res.events ?? []) {
        try {
          // `value` is an xdr.ScVal in recent SDKs, or a base64 string in older ones.
          const valueXdr = (ev as { value: unknown }).value;
          const scv =
            typeof valueXdr === "string"
              ? xdr.ScVal.fromXDR(valueXdr, "base64")
              : (valueXdr as ReturnType<typeof xdr.ScVal.fromXDR>);
          await Promise.resolve(onEvent(parseBridgeOutEvent(scValToNative(scv))));
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[l1] bridge_out event parse/handle failed:", err);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[l1] watchBridgeOut poll failed:", err);
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), interval);
    }
  };

  void tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
