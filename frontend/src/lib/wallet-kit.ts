/**
 * Shared Stellar Wallets Kit instance.
 *
 * A SINGLE kit instance powers both the Connect button (via `useWallet`) and the
 * live signing path (`real-sdk.ts`), so the selected wallet stays consistent across
 * the app.
 *
 * We register only the **Testnet-capable** SEP-43 wallets — Freighter, xBull, Albedo,
 * Rabet. `allowAllModules()` also probes mainnet-only wallets (Lobstr, HOT, Klever)
 * whose on-load availability checks slow the connect probe (the "keeps connecting"
 * symptom) and which cannot sign on Stellar Testnet anyway. Hardware (Ledger/Trezor)
 * and WalletConnect (needs a `projectId`) are likewise omitted; add their modules
 * if/when those are required.
 */
import {
  AlbedoModule,
  FREIGHTER_ID,
  FreighterModule,
  RabetModule,
  StellarWalletsKit,
  WalletNetwork,
  xBullModule,
} from '@creit.tech/stellar-wallets-kit'
import { NETWORK_PASSPHRASE } from './config'

const STORAGE_KEY = 'obscura:selected-wallet-id'

/** Read the persisted wallet id (null in private mode / first visit). */
export function readStoredWalletId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** Remember the user's wallet choice so a reload reconnects to the same wallet. */
export function persistWalletId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // localStorage may be unavailable (private mode); persistence is best-effort.
  }
}

/** Forget the persisted wallet choice (on explicit disconnect). */
export function clearStoredWalletId(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore — see persistWalletId.
  }
}

/**
 * The app-wide kit instance. Create EXACTLY ONE (the kit warns that multiple
 * instances produce unexpected results). Defaults to the last-used wallet, falling
 * back to Freighter.
 */
export const kit: StellarWalletsKit = new StellarWalletsKit({
  network: WalletNetwork.TESTNET,
  selectedWalletId: readStoredWalletId() ?? FREIGHTER_ID,
  modules: [new FreighterModule(), new xBullModule(), new AlbedoModule(), new RabetModule()],
})

export { FREIGHTER_ID, WalletNetwork }

/**
 * Resolve the active wallet address through the kit, restoring the persisted wallet
 * selection first so a page reload keeps signing with the same wallet. Throws a
 * clear error when no wallet is connected / has approved access.
 */
export async function getKitAddress(): Promise<string> {
  const stored = readStoredWalletId()
  if (stored) kit.setWallet(stored)
  const { address } = await kit.getAddress()
  if (!address) {
    throw new Error('No wallet connected. Connect a Stellar wallet (Testnet) first.')
  }
  return address
}

/**
 * Sign a transaction XDR with the connected wallet and return the signed XDR string.
 * The kit returns `{ signedTxXdr }`; callers feed it back into `TransactionBuilder`.
 */
export async function signWithKit(xdr: string, address: string): Promise<string> {
  const { signedTxXdr } = await kit.signTransaction(xdr, {
    address,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
  return signedTxXdr
}

/**
 * Sign an arbitrary message with the connected wallet. Used to derive the shielded
 * spending key from a signature (see `lib/shielded-identity`). Throws if the wallet
 * does not support message signing or the user declines — callers should fall back.
 */
export async function signMessageWithKit(message: string, address: string): Promise<string> {
  const stored = readStoredWalletId()
  if (stored) kit.setWallet(stored)
  const { signedMessage } = await kit.signMessage(message, {
    address,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
  return signedMessage
}
