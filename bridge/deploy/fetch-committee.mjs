/**
 * Deploy-time helper: fetch the current Sepolia sync-committee bootstrap + the
 * live finality update, and emit the artifacts needed to seed `EthLightClient`:
 *
 *   committee.json   -> JSON array of 512 hex strings (96-byte UNCOMPRESSED G1
 *                       pubkeys, NO 0x prefix) for `--committee-file-path`
 *   seed-meta.json   -> { period, signatureSlot, genesisRoot, forkVersion,
 *                         aggregatePubkey, anchorRoot, anchorSlot, executionBlock,
 *                         executionStateRoot }
 *
 * Run:  node bridge/deploy/fetch-committee.mjs
 * Env:  SEPOLIA_BEACON_API (required)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  fetchBootstrap,
  fetchFinalizedRoot,
  fetchFinalityUpdate,
} from "../relayer/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const beacon = process.env.SEPOLIA_BEACON_API;
if (!beacon) {
  console.error("set SEPOLIA_BEACON_API");
  process.exit(1);
}

const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);

async function genesisAndFork() {
  const base = beacon.replace(/\/$/, "");
  const ctrl1 = new AbortController();
  const t1 = setTimeout(() => ctrl1.abort(), 20_000);
  const g = await fetch(`${base}/eth/v1/beacon/genesis`, { signal: ctrl1.signal }).then((r) => r.json());
  clearTimeout(t1);
  const ctrl2 = new AbortController();
  const t2 = setTimeout(() => ctrl2.abort(), 20_000);
  const f = await fetch(`${base}/eth/v1/beacon/states/head/fork`, { signal: ctrl2.signal }).then((r) => r.json());
  clearTimeout(t2);
  return {
    genesisRoot: strip(g.data.genesis_validators_root),
    forkVersion: strip(f.data.current_version),
  };
}

const root = await fetchFinalizedRoot(beacon, { timeoutMs: 20_000 });
const bs = await fetchBootstrap(beacon, root, { timeoutMs: 30_000 });
const upd = await fetchFinalityUpdate(beacon, { timeoutMs: 20_000 });
const { genesisRoot, forkVersion } = await genesisAndFork();

const SLOTS_PER_PERIOD = 8192n;
const sigPeriod = upd.signatureSlot / SLOTS_PER_PERIOD;

if (bs.committee.length !== 512) {
  console.error(`expected 512 pubkeys, got ${bs.committee.length}`);
  process.exit(1);
}
if (sigPeriod !== bs.period) {
  console.error(
    `PERIOD MISMATCH: bootstrap period ${bs.period} != finality signature period ${sigPeriod}. ` +
      `Near a period boundary — re-run shortly.`,
  );
  process.exit(2);
}

const committee = bs.committee.map(strip); // 512 hex strings, no 0x
writeFileSync(join(here, "committee.json"), JSON.stringify(committee));

const meta = {
  period: bs.period.toString(),
  anchorRoot: root,
  anchorSlot: bs.header.slot.toString(),
  signatureSlot: upd.signatureSlot.toString(),
  signaturePeriod: sigPeriod.toString(),
  genesisRoot,
  forkVersion,
  aggregatePubkey: strip(bs.aggregatePubkey),
  executionBlock: upd.finalizedExecution.blockNumber.toString(),
  executionStateRoot: upd.finalizedExecution.stateRoot,
  committeeSize: committee.length,
  firstPubkey: committee[0],
};
writeFileSync(join(here, "seed-meta.json"), JSON.stringify(meta, null, 2));

console.log(JSON.stringify(meta, null, 2));
console.log(`\nwrote committee.json (${committee.length} pubkeys) + seed-meta.json`);
