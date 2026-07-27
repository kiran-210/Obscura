/**
 * Relayer configuration, read from the environment (never hardcode secrets).
 *
 * Endpoints / addresses:
 *   SEPOLIA_EXEC_RPC            Sepolia execution JSON-RPC (eth_getProof, events)
 *   SEPOLIA_BEACON_API         Sepolia beacon API (light_client/finality_update)
 *   STELLAR_RPC                Soroban RPC (submit + simulate)
 *   STELLAR_NETWORK_PASSPHRASE Soroban network passphrase (default: Testnet)
 *   LIGHT_CLIENT_CONTRACT      EthLightClient contract id ("C...")
 *   WRAITH_BRIDGE_CONTRACT     WraithBridge contract id ("C...")
 *   BRIDGE_L1_ADDRESS          WraithBridgeL1 address ("0x...")
 *
 * Signers (only needed for the live submit paths):
 *   STELLAR_SIGNER_SECRET      Soroban tx signer seed ("S...") — header/bridge_in
 *   LIGHT_CLIENT_ADMIN_SECRET  admin seed for the post_root fallback ("S...")
 *   GOVERNOR_PRIVATE_KEY       L1 governor key ("0x...") — unlock settlement
 */
import type { Hex } from "viem";

export interface RelayerConfig {
  sepoliaExecRpc?: string;
  sepoliaBeaconApi?: string;
  stellarRpc?: string;
  stellarNetworkPassphrase?: string;
  lightClientContract?: string;
  wraithBridgeContract?: string;
  /** EthSignalClient contract id ("C...") — the Boundless-Signal light client. */
  signalClientContract?: string;
  bridgeL1Address?: Hex;
  stellarSignerSecret?: string;
  lightClientAdminSecret?: string;
  governorPrivateKey?: Hex;
}

function clean(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** Load the relayer config from an env map (defaults to `process.env`). */
export function loadConfig(env: Record<string, string | undefined> = process.env): RelayerConfig {
  const cfg: RelayerConfig = {};
  const exec = clean(env.SEPOLIA_EXEC_RPC);
  if (exec) cfg.sepoliaExecRpc = exec;
  const beacon = clean(env.SEPOLIA_BEACON_API);
  if (beacon) cfg.sepoliaBeaconApi = beacon;
  const stellar = clean(env.STELLAR_RPC);
  if (stellar) cfg.stellarRpc = stellar;
  const pass = clean(env.STELLAR_NETWORK_PASSPHRASE);
  if (pass) cfg.stellarNetworkPassphrase = pass;
  const lc = clean(env.LIGHT_CLIENT_CONTRACT);
  if (lc) cfg.lightClientContract = lc;
  const bridge = clean(env.WRAITH_BRIDGE_CONTRACT);
  if (bridge) cfg.wraithBridgeContract = bridge;
  const signalClient = clean(env.SIGNAL_CLIENT_CONTRACT);
  if (signalClient) cfg.signalClientContract = signalClient;
  const l1 = clean(env.BRIDGE_L1_ADDRESS);
  if (l1) cfg.bridgeL1Address = l1 as Hex;
  const signer = clean(env.STELLAR_SIGNER_SECRET);
  if (signer) cfg.stellarSignerSecret = signer;
  const admin = clean(env.LIGHT_CLIENT_ADMIN_SECRET);
  if (admin) cfg.lightClientAdminSecret = admin;
  const gov = clean(env.GOVERNOR_PRIVATE_KEY);
  if (gov) cfg.governorPrivateKey = gov as Hex;
  return cfg;
}

/** Read a required config field or throw with a helpful message. */
export function require_<K extends keyof RelayerConfig>(
  cfg: RelayerConfig,
  key: K,
  envName: string,
): NonNullable<RelayerConfig[K]> {
  const v = cfg[key];
  if (v === undefined || v === null) {
    throw new Error(`missing required config: set ${envName}`);
  }
  return v as NonNullable<RelayerConfig[K]>;
}
