/**
 * `@obscura/matcher` — off-chain order-matching service for the Obscura ZK dark pool.
 *
 * Wires together the three building blocks:
 *   - {@link MatchingEngine} (engine.ts): in-memory book + price-time matching that mirrors
 *     the `match_orders` circuit's economics;
 *   - {@link assembleMatchInputs} / {@link proveMatch} (prover.ts): build the circuit inputs
 *     and the 8 public-input fields (SHARED sec 7) and produce a proof via an injectable
 *     prover (the SDK's `NoirProver` for real proofs; {@link MockMatchProver} for dev);
 *   - {@link MatchSubmitter} (submitter.ts): build / submit `obscura-pool.match_orders`.
 *
 * Exposes a tiny HTTP API (node:http):
 *   POST /orders   submit an order (JSON body)         -> 201 { commitment, sequence }
 *   GET  /orders   open-order commitments only         -> 200 { count, commitments }
 *   GET  /health   liveness                            -> 200 { ok, orders }
 *
 * and a background loop that periodically `findMatches()` -> prove -> (submit | dry-run).
 *
 * Trust model: the matcher SEES order details but CANNOT steal funds — settlement notes are
 * ZK-enforced by the circuit (see README). By default proving is mocked and submission is a
 * dry-run, so running this with no circuit / no network is safe.
 */
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MatchingEngine, OrderValidationError } from "./engine.js";
import { buildMatchMemos } from "./memo.js";
import { MockMatchProver, proveMatch, type MatchBlindings, type MatchProver } from "./prover.js";
import { MatchSubmitter, resolveContractId, type DeploymentsLike, type LiveSubmitOptions } from "./submitter.js";
import type { Match, SubmittedOrder } from "./types.js";

export * from "./types.js";
export * from "./engine.js";
export * from "./memo.js";
export * from "./prover.js";
export * from "./submitter.js";

/** Coerce a JSON value (string | number | bigint) into a bigint, or throw. */
function toBigInt(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return BigInt(value.trim());
    } catch {
      /* fallthrough */
    }
  }
  throw new OrderValidationError(`${label} must be an integer (number or string): got ${String(value)}`);
}

/** Parse an untrusted JSON object into a {@link SubmittedOrder} (engine still re-validates). */
export function parseOrder(body: Record<string, unknown>): SubmittedOrder {
  const side = body.side;
  if (side !== "buy" && side !== "sell") {
    throw new OrderValidationError(`side must be "buy" or "sell": got ${String(side)}`);
  }
  // Delivery: the live intake requires a receive code so the matcher can seal settlement
  // memos to the owner (on-chain, self-custodial). Reject orders that can't be settled to.
  const receiveCode = String(body.receiveCode ?? "");
  if (receiveCode === "") {
    throw new OrderValidationError("receiveCode is required so the matcher can deliver your settlement notes");
  }
  return {
    commitment: String(body.commitment ?? ""),
    side,
    price: toBigInt(body.price, "price"),
    amount: toBigInt(body.amount, "amount"),
    assetBase: String(body.assetBase ?? ""),
    assetQuote: String(body.assetQuote ?? ""),
    ownerKey: String(body.ownerKey ?? ""),
    nonce: String(body.nonce ?? ""),
    receiveCode,
    ...(body.baseCode ? { baseCode: String(body.baseCode) } : {}),
    ...(body.quoteCode ? { quoteCode: String(body.quoteCode) } : {}),
  };
}

/** Load and parse a `deployments.json` file, or return undefined if absent/unreadable. */
export function loadDeployments(path: string): DeploymentsLike | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DeploymentsLike;
  } catch {
    return undefined;
  }
}

/** A minimal logger; defaults to console. */
export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/** Configuration for {@link MatcherService}. */
export interface MatcherServiceConfig {
  /** Order book + matching engine (a fresh one is created if omitted). */
  engine?: MatchingEngine;
  /** Prover used by the background loop (defaults to {@link MockMatchProver}). */
  prover?: MatchProver;
  /** Submitter for `match_orders` (omit for log-only matching). */
  submitter?: MatchSubmitter | null;
  /** "dry-run" (build op, never send — default) or "live" (RPC submit). */
  mode?: "dry-run" | "live";
  /** Options for live submission (required when `mode === "live"`). */
  live?: LiveSubmitOptions;
  /** Background match-loop interval in ms (default 2000). 0 disables the loop. */
  intervalMs?: number;
  /** Remove matched orders from the book after processing (default true). */
  removeOnMatch?: boolean;
  /** Optional deterministic blindings for proving (tests). */
  blindings?: Partial<MatchBlindings>;
  logger?: Logger;
}

/** Orchestrates the engine, the prove/submit pipeline, the HTTP API, and the match loop. */
export class MatcherService {
  readonly engine: MatchingEngine;
  readonly prover: MatchProver;
  readonly submitter: MatchSubmitter | null;
  readonly mode: "dry-run" | "live";
  private readonly intervalMs: number;
  private readonly removeOnMatch: boolean;
  private readonly blindings?: Partial<MatchBlindings>;
  private readonly live?: LiveSubmitOptions;
  private readonly log: Logger;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(config: MatcherServiceConfig = {}) {
    this.engine = config.engine ?? new MatchingEngine();
    this.prover = config.prover ?? new MockMatchProver();
    this.submitter = config.submitter ?? null;
    this.mode = config.mode ?? "dry-run";
    this.intervalMs = config.intervalMs ?? 2000;
    this.removeOnMatch = config.removeOnMatch ?? true;
    if (config.blindings) this.blindings = config.blindings;
    if (config.live) this.live = config.live;
    this.log = config.logger ?? console;
  }

  /** Process every currently-crossable match once: assemble -> prove -> (submit | dry-run). */
  async runOnce(): Promise<{ processed: number; matches: Match[] }> {
    const matches = this.engine.findMatches();
    let processed = 0;
    for (const match of matches) {
      try {
        const { proof, assembled } = await proveMatch(match, this.prover, this.blindings);
        // Seal the settlement notes + residual orders to their owners for on-chain delivery.
        const memos = buildMatchMemos(match, assembled);
        if (this.submitter) {
          if (this.mode === "live") {
            if (!this.live) throw new Error("mode 'live' requires `live` submit options");
            const hash = await this.submitter.submit(proof, this.live, memos);
            this.log.info(`[match] submitted ${match.a.commitment} x ${match.b.commitment} -> ${hash}`);
          } else {
            this.submitter.buildOperation(proof, memos); // validate encoding without sending
            this.log.info(
              `[match] dry-run ${match.a.commitment} x ${match.b.commitment} ` +
                `(fill=${match.fill}, exec=${match.execPrice}, quote=${match.quoteFilled})`,
            );
          }
        } else {
          this.log.info(
            `[match] ${match.a.commitment} x ${match.b.commitment} ` +
              `(fill=${match.fill}, exec=${match.execPrice}, quote=${match.quoteFilled})`,
          );
        }
        if (this.removeOnMatch) {
          this.engine.remove(match.a.commitment);
          this.engine.remove(match.b.commitment);
        }
        processed++;
      } catch (err) {
        this.log.error(`[match] failed for ${match.a.commitment} x ${match.b.commitment}:`, err);
      }
    }
    return { processed, matches };
  }

  /** Start the background match loop (no-op if intervalMs is 0). */
  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      if (this.ticking) return; // skip overlapping ticks
      this.ticking = true;
      void this.runOnce().finally(() => {
        this.ticking = false;
      });
    }, this.intervalMs);
    // Don't keep the process alive solely for the loop.
    this.timer.unref?.();
  }

  /** Stop the background match loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** node:http request handler for the order API. */
  readonly handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // CORS: the browser wallet submits orders cross-origin (localhost:5173 → :8787).
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && (url === "/health" || url === "/")) {
      return sendJson(res, 200, { ok: true, orders: this.engine.size, mode: this.mode });
    }
    if (method === "GET" && url === "/orders") {
      // Privacy: expose commitments only, never order details.
      return sendJson(res, 200, { count: this.engine.size, commitments: this.engine.getCommitments() });
    }
    if (method === "POST" && url === "/orders") {
      return void readBody(req)
        .then((raw) => {
          const body = JSON.parse(raw) as Record<string, unknown>;
          const order = this.engine.submit(parseOrder(body));
          sendJson(res, 201, { commitment: order.commitment, sequence: order.sequence });
        })
        .catch((err: unknown) => {
          const status = err instanceof OrderValidationError ? 400 : 400;
          sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
        });
    }
    sendJson(res, 404, { error: `no route ${method} ${url}` });
  };

  /** Create an HTTP server bound to this service's {@link handler}. */
  createServer(): Server {
    return createHttpServer(this.handler);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // bigints aren't JSON-serializable; stringify them.
  const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Entry point: start the HTTP server + match loop from environment configuration. */
export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const deploymentsPath =
    process.env.OBSCURA_DEPLOYMENTS ?? fileURLToPath(new URL("../../deployments.json", import.meta.url));
  const deployments = loadDeployments(deploymentsPath);

  let submitter: MatchSubmitter | null = null;
  try {
    const contractId = resolveContractId({ deployments });
    const networkPassphrase = deployments?.networkPassphrase;
    submitter = new MatchSubmitter({ contractId, ...(networkPassphrase ? { networkPassphrase } : {}) });
  } catch {
    // No contract configured: run in log-only matching mode.
  }

  const mode = process.env.OBSCURA_SUBMIT === "live" ? "live" : "dry-run";

  // Real proving: point MATCH_CIRCUIT at the compiled match_orders.json (needs the bb.js CRS
  // at runtime). Without it, proving is mocked and submission is a dry-run (safe offline).
  let prover: MatchProver | undefined;
  const circuitPath = process.env.MATCH_CIRCUIT;
  if (circuitPath) {
    const { NoirProver } = await import("@obscura/sdk");
    prover = new NoirProver(JSON.parse(readFileSync(circuitPath, "utf8")));
  }

  // Live submission: needs the funded matcher key (server secret) + an RPC endpoint.
  let live: LiveSubmitOptions | undefined;
  if (mode === "live") {
    const sourceSecret = process.env.OBSCURA_MATCHER_SECRET;
    if (!sourceSecret) throw new Error("OBSCURA_SUBMIT=live requires OBSCURA_MATCHER_SECRET (a funded S… key)");
    live = { rpcUrl: process.env.OBSCURA_RPC_URL ?? "https://soroban-testnet.stellar.org", sourceSecret };
  }

  const service = new MatcherService({
    submitter,
    mode,
    ...(prover ? { prover } : {}),
    ...(live ? { live } : {}),
    intervalMs: Number(process.env.MATCH_INTERVAL_MS ?? 2000),
  });

  service.start();
  const server = service.createServer();
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[matcher] listening on :${port} (mode=${mode}, contract=${submitter?.contractId ?? "none"}, ` +
        `prover=${prover ? "NoirProver" : "mock"})`,
    );
  });
}

// Auto-start when executed directly (not when imported).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
