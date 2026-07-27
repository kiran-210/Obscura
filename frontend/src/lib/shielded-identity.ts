/**
 * Deriving the shielded spending key from a Stellar wallet.
 *
 * A shielded balance belongs to a secret spending key — not to a public Stellar
 * account. To make that key *recoverable* and *per-wallet* (rather than a random
 * value trapped in one browser), we derive it from a signature the wallet produces
 * over a fixed, domain-separated message:
 *
 *     spendingKey = toField( SHA-256( walletSignature(DERIVATION_MESSAGE) ) )
 *
 * Stellar signatures are ed25519 and therefore deterministic (RFC 8032), so the same
 * wallet always yields the same key — the shielded balance follows the wallet across
 * browsers and devices. Deriving from the *signature* (which requires the secret key)
 * rather than the public address is essential: the address is public, so an
 * address-derived key would let anyone recompute your nullifiers.
 *
 * The derived key is cached per address so only the first connect prompts a signature.
 * If the wallet cannot sign messages (or the user declines), we fall back to a random
 * browser-local key so the app still works — just not portable.
 */
import { toField, type Field } from '@wraith/sdk'
import { signMessageWithKit } from './wallet-kit'
import { peekCachedSpendingKey, randomSpendingKey, setActiveAddress, setSpendingKey } from './note-store'

const DERIVATION_MESSAGE = [
  'Wraith Shielded Wallet',
  '',
  'Sign to unlock your private spending key on this device.',
  'This signature stays in your browser and reveals nothing on-chain.',
  '',
  'Version: 1',
].join('\n')

export interface ShieldedIdentity {
  key: Field
  /** True when derived from a wallet signature (recoverable); false for the local fallback. */
  portable: boolean
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer-backed view so it satisfies `BufferSource`.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return new Uint8Array(digest)
}

function toBigIntBE(bytes: Uint8Array): bigint {
  let value = 0n
  for (const b of bytes) value = (value << 8n) | BigInt(b)
  return value
}

// De-dupe concurrent derivations for the same address (React StrictMode double-invoke,
// rapid re-renders) so the wallet is only ever prompted once.
const inflight = new Map<string, Promise<ShieldedIdentity>>()

/**
 * Resolve the shielded spending key for a Stellar address and activate it in the
 * note store. Uses the cached key when present; otherwise derives one from a wallet
 * signature (falling back to a random browser-local key on failure).
 */
export function resolveShieldedIdentity(address: string): Promise<ShieldedIdentity> {
  const existing = inflight.get(address)
  if (existing) return existing

  const task = (async (): Promise<ShieldedIdentity> => {
    setActiveAddress(address)

    const cached = peekCachedSpendingKey(address)
    if (cached) {
      setSpendingKey(cached)
      return { key: cached, portable: true }
    }

    try {
      const signature = await signMessageWithKit(DERIVATION_MESSAGE, address)
      const hashed = await sha256(new TextEncoder().encode(signature))
      const key = toField(toBigIntBE(hashed))
      setSpendingKey(key)
      return { key, portable: true }
    } catch (err) {
      console.warn('Wallet message-signing unavailable; using a browser-local shielded key.', err)
      const key = randomSpendingKey()
      setSpendingKey(key)
      return { key, portable: false }
    }
  })().finally(() => inflight.delete(address))

  inflight.set(address, task)
  return task
}
