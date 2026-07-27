/**
 * Shared Soroban submission plumbing: build -> prepare (footprint) -> sign ->
 * send a single invoke operation, and read a contract view by simulation.
 *
 * Used by both the light-client and bridge-in submitters. The live path needs a
 * funded signer + reachable RPC and is therefore **integration-only** (never hit
 * by the unit tests); building the operations themselves is pure and is tested.
 */
import {
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

/** Options for a live Soroban submission. */
export interface LiveSubmitOptions {
  /** Soroban RPC URL, e.g. https://soroban-testnet.stellar.org. */
  rpcUrl: string;
  /** Secret seed ("S...") of the fee-paying / submitting account. */
  sourceSecret: string;
  /** Network passphrase (defaults to Testnet). */
  networkPassphrase?: string;
  /** Transaction timeout in seconds (default 60). */
  timeoutSeconds?: number;
}

/** Build, prepare, sign, and send a single-operation invoke transaction. Returns the tx hash. */
export async function submitInvoke(
  operation: xdr.Operation,
  opts: LiveSubmitOptions,
): Promise<string> {
  const networkPassphrase = opts.networkPassphrase ?? Networks.TESTNET;
  const keypair = Keypair.fromSecret(opts.sourceSecret);
  const server = new rpc.Server(opts.rpcUrl);
  const source = await server.getAccount(keypair.publicKey());

  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(operation)
    .setTimeout(opts.timeoutSeconds ?? 60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`Soroban submission failed: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }
  return sent.hash;
}

/** Options for a read-only contract simulation. */
export interface ViewOptions {
  rpcUrl: string;
  /** Any account id ("G...") to source the simulated tx (no signature/fees needed). */
  sourceAccount: string;
  networkPassphrase?: string;
}

/**
 * Read a contract view function via simulation (no fees, no signature). Returns
 * the decoded native value. Integration-only (needs a reachable RPC).
 */
export async function simulateView(
  contractId: string,
  method: string,
  opts: ViewOptions,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  const networkPassphrase = opts.networkPassphrase ?? Networks.TESTNET;
  const server = new rpc.Server(opts.rpcUrl);
  const source = await server.getAccount(opts.sourceAccount);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate ${method} failed: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  return retval ? scValToNative(retval) : undefined;
}
