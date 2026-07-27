/**
 * Encrypted note/order delivery (note discovery).
 *
 * The sealed-box transport now lives in `@obscura/sdk` (note-crypto), so the wallet and the
 * off-chain matcher encrypt/decrypt identically — one source of truth, no drift. This module
 * is a thin re-export kept so existing frontend imports (`./note-crypto`) stay stable.
 */
export {
  deriveEncKeypair,
  seal,
  open,
  encryptNote,
  decryptNote,
  encryptOrder,
  decryptOrder,
  encodeReceiveCode,
  decodeReceiveCode,
  memoToHex,
  hexToBytes,
  type NotePayload,
  type OrderPayload,
  type EncKeypair,
  type ReceiveCode,
} from '@obscura/sdk'
