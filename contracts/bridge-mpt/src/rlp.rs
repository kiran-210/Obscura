//! Minimal RLP decoder, just enough to parse Ethereum Merkle-Patricia-Trie
//! nodes and the account leaf RLP `[nonce, balance, storageRoot, codeHash]`.
//!
//! Reference: https://ethereum.org/en/developers/docs/data-structures-and-encoding/rlp/
//!
//! We decode borrowing from a `&[u8]` buffer (the bytes of one MPT node, already
//! copied out of a Soroban `Bytes`). No allocation of the payload happens here;
//! we only allocate a small `Vec` of item descriptors.

extern crate alloc;
use alloc::vec::Vec;

use crate::mpt::MptError;

/// A single decoded RLP item, borrowing from the input buffer.
///
/// * `Str` — a byte string. `content` is the *decoded* payload (header stripped).
///   For MPT this is a 32-byte child hash, an HP-encoded path, an account/storage
///   value, etc.
/// * `List` — a (possibly nested) list. `raw` is the *full* encoding including the
///   list header, so it can be re-decoded with [`decode_list`] (used for inline
///   MPT child nodes that are embedded rather than hash-referenced).
#[derive(Clone, Copy)]
pub enum Item<'a> {
    Str(&'a [u8]),
    List(&'a [u8]),
}

impl<'a> Item<'a> {
    /// Returns the string payload, or an error if the item is a list.
    pub fn as_str(&self) -> Result<&'a [u8], MptError> {
        match self {
            Item::Str(s) => Ok(s),
            Item::List(_) => Err(MptError::RlpError),
        }
    }
}

/// Read a big-endian length from `n` bytes. Rejects > 4-byte lengths (no MPT node
/// is anywhere near 4 GiB; this keeps the type `usize`-safe).
fn read_len(buf: &[u8], n: usize) -> Result<usize, MptError> {
    if n == 0 || n > 4 || buf.len() < n {
        return Err(MptError::RlpError);
    }
    let mut len = 0usize;
    for i in 0..n {
        len = (len << 8) | (buf[i] as usize);
    }
    // Canonical RLP forbids a leading zero in the length-of-length encoding.
    if buf[0] == 0 {
        return Err(MptError::RlpError);
    }
    Ok(len)
}

/// Parse exactly one RLP item at the start of `buf`.
/// Returns the item and the number of bytes consumed.
pub fn parse_one(buf: &[u8]) -> Result<(Item<'_>, usize), MptError> {
    if buf.is_empty() {
        return Err(MptError::RlpError);
    }
    let b = buf[0];
    match b {
        // Single byte in [0x00, 0x7f] encodes itself.
        0x00..=0x7f => Ok((Item::Str(&buf[0..1]), 1)),
        // Short string: 0..=55 bytes.
        0x80..=0xb7 => {
            let len = (b - 0x80) as usize;
            let end = 1 + len;
            if buf.len() < end {
                return Err(MptError::RlpError);
            }
            // Canonical RLP: a 1-byte string < 0x80 must use the single-byte form.
            if len == 1 && buf[1] < 0x80 {
                return Err(MptError::RlpError);
            }
            Ok((Item::Str(&buf[1..end]), end))
        }
        // Long string: length-of-length in (b - 0xb7).
        0xb8..=0xbf => {
            let ll = (b - 0xb7) as usize;
            let len = read_len(&buf[1..], ll)?;
            if len < 56 {
                return Err(MptError::RlpError); // must use short form
            }
            let start = 1 + ll;
            let end = start + len;
            if buf.len() < end {
                return Err(MptError::RlpError);
            }
            Ok((Item::Str(&buf[start..end]), end))
        }
        // Short list.
        0xc0..=0xf7 => {
            let len = (b - 0xc0) as usize;
            let end = 1 + len;
            if buf.len() < end {
                return Err(MptError::RlpError);
            }
            Ok((Item::List(&buf[0..end]), end))
        }
        // Long list.
        0xf8..=0xff => {
            let ll = (b - 0xf7) as usize;
            let len = read_len(&buf[1..], ll)?;
            if len < 56 {
                return Err(MptError::RlpError);
            }
            let start = 1 + ll;
            let end = start + len;
            if buf.len() < end {
                return Err(MptError::RlpError);
            }
            Ok((Item::List(&buf[0..end]), end))
        }
    }
}

/// Returns the payload slice of a list (header stripped) and asserts the whole
/// `buf` is exactly that one list with no trailing bytes.
fn list_payload(buf: &[u8]) -> Result<&[u8], MptError> {
    if buf.is_empty() {
        return Err(MptError::RlpError);
    }
    let b = buf[0];
    let (start, len) = match b {
        0xc0..=0xf7 => (1usize, (b - 0xc0) as usize),
        0xf8..=0xff => {
            let ll = (b - 0xf7) as usize;
            let len = read_len(&buf[1..], ll)?;
            (1 + ll, len)
        }
        _ => return Err(MptError::RlpError), // not a list
    };
    let end = start + len;
    if buf.len() != end {
        return Err(MptError::RlpError); // trailing garbage / truncated
    }
    Ok(&buf[start..end])
}

/// Decode a complete RLP list `buf` into its items.
///
/// Used both for MPT nodes (which are always lists: 17-item branch or 2-item
/// extension/leaf) and for the account-leaf value `[nonce, balance, storageRoot,
/// codeHash]`.
pub fn decode_list(buf: &[u8]) -> Result<Vec<Item<'_>>, MptError> {
    let payload = list_payload(buf)?;
    let mut items = Vec::new();
    let mut off = 0usize;
    while off < payload.len() {
        let (item, used) = parse_one(&payload[off..])?;
        items.push(item);
        off += used;
    }
    Ok(items)
}
