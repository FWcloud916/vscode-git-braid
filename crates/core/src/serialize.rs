//! Binary serialization of [`RowLayout`] batches for the host ↔ webview protocol.
//!
//! # Wire format (v1)
//!
//! ```text
//! ┌─ Header (16 bytes) ────────────────────────────────────────────────────┐
//! │  [0..4]   magic       b"BRAI"                                          │
//! │  [4]      version     u8 = 1                                           │
//! │  [5]      reserved    u8 = 0                                           │
//! │  [6..8]   str_count   u16 LE — entries in StringPool                   │
//! │  [8..12]  row_count   u32 LE — entries in CommitRow table              │
//! │  [12..16] seg_count   u32 LE — entries in SegmentRow table             │
//! └────────────────────────────────────────────────────────────────────────┘
//! ┌─ StringPool ────────────────────────────────────────────────────────────┐
//! │  For each string:  [len: u32 LE][UTF-8 bytes: len bytes]               │
//! └────────────────────────────────────────────────────────────────────────┘
//! ┌─ CommitRow × row_count (32 bytes each) ─────────────────────────────────┐
//! │  oid:        [u8; 20]                                                   │
//! │  lane:       u16 LE                                                     │
//! │  color:      u8                                                         │
//! │  flags:      u8   (RowFlags bitfield)                                   │
//! │  seg_offset: u32 LE — first segment index in SegmentRow table           │
//! │  seg_count:  u32 LE — number of segments for this row                   │
//! └────────────────────────────────────────────────────────────────────────┘
//! ┌─ SegmentRow × seg_count (8 bytes each) ─────────────────────────────────┐
//! │  from_lane: u16 LE                                                      │
//! │  to_lane:   u16 LE                                                      │
//! │  color:     u8                                                          │
//! │  kind:      u8   (SegKind: Straight=0, MergeOut=1, ConvergeIn=2)        │
//! │  _pad:      u16 = 0                                                     │
//! └────────────────────────────────────────────────────────────────────────┘
//! ```
//!
//! Fixed-width rows allow the webview to consume commit data with `DataView` /
//! typed-array views without JSON deserialization (plan §3.5).
//!
//! # Stability
//!
//! The v1 format is provisional. Once the Canvas renderer is built (M2), the
//! layout may be revised and the version byte incremented.

use crate::model::{RowFlags, RowLayout, SegKind, Segment};
use smallvec::SmallVec;

/// Magic bytes at the start of every valid buffer.
const MAGIC: &[u8; 4] = b"BRAI";
/// Current wire-format version.
const VERSION: u8 = 1;

// ─── Encoding ────────────────────────────────────────────────────────────────

/// Serialise a batch of layout rows into a flat binary buffer.
///
/// `string_pool` holds auxiliary strings (author names, commit messages)
/// referenced by future `CommitRow` fields not yet present in [`RowLayout`].
/// Pass `&[]` when there are no strings; the slot is reserved for M3+.
pub fn encode_batch(rows: &[RowLayout], string_pool: &[&str]) -> Vec<u8> {
    let total_segs: usize = rows.iter().map(|r| r.segments.len()).sum();

    // Pre-calculate exact size to avoid reallocations.
    let string_bytes: usize = string_pool
        .iter()
        .map(|s| 4 /* len prefix */ + s.len())
        .sum();
    let capacity = 16 + string_bytes + rows.len() * 32 + total_segs * 8;
    let mut buf = Vec::with_capacity(capacity);

    // Header
    buf.extend_from_slice(MAGIC);
    buf.push(VERSION);
    buf.push(0); // reserved
    buf.extend_from_slice(&(string_pool.len() as u16).to_le_bytes());
    buf.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    buf.extend_from_slice(&(total_segs as u32).to_le_bytes());

    // StringPool
    for s in string_pool {
        buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
        buf.extend_from_slice(s.as_bytes());
    }

    // CommitRow table — two-pass: first write row headers (with cumulative
    // seg_offset), then write all SegmentRow data below.
    let mut seg_offset: u32 = 0;
    for row in rows {
        let seg_count = row.segments.len() as u32;
        buf.extend_from_slice(&row.oid); // 20
        buf.extend_from_slice(&row.lane.to_le_bytes()); //  2
        buf.push(row.color); //  1
        buf.push(row.flags.bits()); //  1
        buf.extend_from_slice(&seg_offset.to_le_bytes()); //  4
        buf.extend_from_slice(&seg_count.to_le_bytes()); //  4
                                                         // = 32 bytes per row
        seg_offset += seg_count;
    }

    // SegmentRow table
    for row in rows {
        for seg in &row.segments {
            buf.extend_from_slice(&seg.from_lane.to_le_bytes()); // 2
            buf.extend_from_slice(&seg.to_lane.to_le_bytes()); // 2
            buf.push(seg.color); // 1
            buf.push(seg.kind as u8); // 1
            buf.extend_from_slice(&[0u8; 2]); // 2 pad
                                              // = 8 bytes per segment
        }
    }

    debug_assert_eq!(buf.len(), capacity);
    buf
}

// ─── Decoding ────────────────────────────────────────────────────────────────

/// Deserialise a buffer produced by [`encode_batch`].
///
/// The string pool entries are discarded (they are not part of [`RowLayout`]).
/// Returns an error on malformed input rather than panicking.
pub fn decode_batch(buf: &[u8]) -> Result<Vec<RowLayout>, DecodeError> {
    // ── Header ──────────────────────────────────────────────────────────────
    if buf.len() < 16 {
        return Err(DecodeError::TooShort);
    }
    if &buf[0..4] != MAGIC {
        return Err(DecodeError::BadMagic);
    }
    let version = buf[4];
    if version != VERSION {
        return Err(DecodeError::UnsupportedVersion(version));
    }
    // buf[5] reserved
    let str_count = u16::from_le_bytes([buf[6], buf[7]]) as usize;
    let row_count = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]) as usize;
    // buf[12..16]: seg_count (unused during decode — we recompute from rows)

    let mut pos = 16usize;

    // ── StringPool (skip — not stored in RowLayout) ──────────────────────
    for _ in 0..str_count {
        if pos + 4 > buf.len() {
            return Err(DecodeError::TooShort);
        }
        let len = u32::from_le_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]) as usize;
        pos = pos.checked_add(4 + len).ok_or(DecodeError::TooShort)?;
        if pos > buf.len() {
            return Err(DecodeError::TooShort);
        }
    }

    // ── CommitRow table ──────────────────────────────────────────────────
    let commit_rows_start = pos;
    let commit_section_len = row_count
        .checked_mul(32)
        .ok_or_else(|| DecodeError::Malformed("row_count overflow".into()))?;
    if pos + commit_section_len > buf.len() {
        return Err(DecodeError::TooShort);
    }

    // Parse all row headers first (OID, lane, color, flags, seg_offset, seg_count).
    struct RowMeta {
        oid: [u8; 20],
        lane: u16,
        color: u8,
        flags: RowFlags,
        seg_offset: u32,
        seg_count: u32,
    }
    let mut metas: Vec<RowMeta> = Vec::with_capacity(row_count);
    for i in 0..row_count {
        let b = commit_rows_start + i * 32;
        let mut oid = [0u8; 20];
        oid.copy_from_slice(&buf[b..b + 20]);
        let lane = u16::from_le_bytes([buf[b + 20], buf[b + 21]]);
        let color = buf[b + 22];
        let flags = RowFlags::from_bits_truncate(buf[b + 23]);
        let seg_offset = u32::from_le_bytes([buf[b + 24], buf[b + 25], buf[b + 26], buf[b + 27]]);
        let seg_count = u32::from_le_bytes([buf[b + 28], buf[b + 29], buf[b + 30], buf[b + 31]]);
        metas.push(RowMeta {
            oid,
            lane,
            color,
            flags,
            seg_offset,
            seg_count,
        });
    }

    // ── SegmentRow table ─────────────────────────────────────────────────
    let seg_rows_start = commit_rows_start + commit_section_len;
    let total_segs: usize = metas.iter().map(|m| m.seg_count as usize).sum();
    let seg_section_len = total_segs
        .checked_mul(8)
        .ok_or_else(|| DecodeError::Malformed("seg_count overflow".into()))?;
    if seg_rows_start + seg_section_len > buf.len() {
        return Err(DecodeError::TooShort);
    }

    // ── Assemble RowLayouts ──────────────────────────────────────────────
    let mut rows: Vec<RowLayout> = Vec::with_capacity(row_count);
    for m in &metas {
        let mut segments: SmallVec<[Segment; 4]> = SmallVec::new();
        for j in 0..m.seg_count as usize {
            let b = seg_rows_start + (m.seg_offset as usize + j) * 8;
            if b + 8 > buf.len() {
                return Err(DecodeError::TooShort);
            }
            let from_lane = u16::from_le_bytes([buf[b], buf[b + 1]]);
            let to_lane = u16::from_le_bytes([buf[b + 2], buf[b + 3]]);
            let color = buf[b + 4];
            let kind = match buf[b + 5] {
                0 => SegKind::Straight,
                1 => SegKind::MergeOut,
                2 => SegKind::ConvergeIn,
                v => return Err(DecodeError::Malformed(format!("unknown SegKind {v}"))),
            };
            // buf[b+6..b+8] = _pad, ignored
            segments.push(Segment {
                from_lane,
                to_lane,
                color,
                kind,
            });
        }
        rows.push(RowLayout {
            oid: m.oid,
            lane: m.lane,
            color: m.color,
            segments,
            flags: m.flags,
        });
    }

    Ok(rows)
}

// ─── Error type ──────────────────────────────────────────────────────────────

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
