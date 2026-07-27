/**
 * Testnet faucet: mint permissionless mock tokens (USDC/ETH/BTC/XRP) to the connected
 * wallet so they can be deposited. The user signs the mint themselves — no admin, no
 * backend. Testnet only (the faucet tokens have an open `mint`).
 */
import { Address, Contract, nativeToScVal, rpc, TransactionBuilder } from '@stellar/stellar-sdk'
import { buildTransaction } from '@wraith/sdk'
import { NETWORK_PASSPHRASE, SOROBAN_RPC_URL } from './config'
import { getKitAddress, signWithKit } from './wallet-kit'

async function awaitConfirmation(server: rpc.Server, hash: string): Promise<void> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const res = await server.getTransaction(hash)
    if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) return
      throw new Error(`Faucet mint failed on-chain (${res.status}).`)
    }
    if (Date.now() > deadline) throw new Error('Timed out awaiting the faucet mint.')
    await new Promise((r) => setTimeout(r, 2000))
  }
}

/** Mint `amount` base units of a faucet token to the connected wallet. Returns the tx hash. */
export async function faucetMint(tokenSac: string, amount: bigint): Promise<string> {
  const to = await getKitAddress()
  const server = new rpc.Server(SOROBAN_RPC_URL)
  const account = await server.getAccount(to)
  const op = new Contract(tokenSac).call(
    'mint',
    new Address(to).toScVal(),
    nativeToScVal(amount, { type: 'i128' }),
  )
  const tx = buildTransaction(account, op, { networkPassphrase: NETWORK_PASSPHRASE, timeoutSeconds: 60 })
  const prepared = await server.prepareTransaction(tx)
  const signedXdr = await signWithKit(prepared.toXDR(), to)
  const sent = await server.sendTransaction(TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE))
  if (sent.status === 'ERROR') {
    throw new Error(`Faucet mint submission failed: ${JSON.stringify(sent.errorResult ?? sent.status)}`)
  }
  await awaitConfirmation(server, sent.hash)
  return sent.hash
}
