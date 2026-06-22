//! Binary serialization of [`RowLayout`] batches for the host ↔ webview protocol.
//!
//! # Wire format overview (plan §3.5)
//!
//! The host sends commit data to the webview as a flat `ArrayBuffer` rather than
//! JSON, eliminating per-object GC pressure and string parsing in the renderer.
//!
//! Layout:
//! ```text
//! [Header 16 bytes]
//! [StringPool: length-prefixed UTF-8 strings]
//! [CommitRow × N: fixed-width structs, castable to typed arrays]
//! [SegmentRow × M: Segment data, indexed from CommitRow]
//! ```
//!
//! The webview side (`web/renderer/canvas.ts`) reads this with `DataView` /
//! typed-array views — zero deserialization overhead.
//!
//! # Status
//!
//! **Stub** — Phase 0/1 implementation target. Signatures are provisional;
//! the exact wire format will be finalised when the renderer is built.

use crate::model::RowLayout;

/// Serialise a batch of rows into a flat binary buffer.
///
/// `string_pool` entries are author names / commit messages, referenced by
/// index from the row structs.
///
/// # Status
///
/// **Unimplemented** — returns `todo!()`.
pub fn encode_batch(_rows: &[RowLayout], _string_pool: &[&str]) -> Vec<u8> {
    todo!("encode_batch — implement alongside webview renderer (Phase 0/1)")
}

/// Decode a binary buffer back into rows (used in tests / host-side round-trips).
///
/// # Status
///
/// **Unimplemented** — returns `todo!()`.
pub fn decode_batch(_buf: &[u8]) -> Result<Vec<RowLayout>, DecodeError> {
    todo!("decode_batch — implement alongside encode_batch")
}

/// Errors that can occur during buffer decoding.
#[derive(Debug)]
pub enum DecodeError {
    TooShort,
    BadMagic,
    UnsupportedVersion(u8),
    Malformed(String),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooShort => write!(f, "buffer too short"),
            Self::BadMagic => write!(f, "bad magic bytes"),
            Self::UnsupportedVersion(v) => write!(f, "unsupported version {v}"),
            Self::Malformed(s) => write!(f, "malformed buffer: {s}"),
        }
    }
}

impl std::error::Error for DecodeError {}
