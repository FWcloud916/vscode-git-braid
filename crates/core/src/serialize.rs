//! Binary serialization of [`RowLayout`] + [`CommitMeta`] batches for the
//! host ↔ webview protocol.
//!
//! # Wire format (v2)
//!
//! ```text
//! ┌─ Header (20 bytes) ─────────────────────────────────────────────────────┐
//! │  [0..4]   magic       b"BRAI"                                           │
//! │  [4]      version     u8 = 2                                            │
//! │  [5]      reserved    u8 = 0                                            │
//! │  [6..8]   str_count   u16 LE — entries in StringPool                    │
//! │  [8..12]  row_count   u32 LE — entries in CommitRow table               │
//! │  [12..16] seg_count   u32 LE — entries in SegmentRow table              │
//! │  [16..20] ref_count   u32 LE — entries in RefRow table                  │
//! └─────────────────────────────────────────────────────────────────────────┘
//! ┌─ StringPool ────────────────────────────────────────────────────────────┐
//! │  For each string:  [len: u32 LE][UTF-8 bytes: len bytes]               │
//! │  Strings are deduplicated in deterministic (row → subject, author,     │
//! │  ref-names) insertion order. u32::MAX = absent/empty.                  │
//! └─────────────────────────────────────────────────────────────────────────┘
//! ┌─ CommitRow × row_count (56 bytes each) ─────────────────────────────────┐
//! │  oid:          [u8; 20]                                                 │
//! │  lane:         u16 LE                                                   │
//! │  color:        u8                                                       │
//! │  flags:        u8   (RowFlags bitfield)                                 │
//! │  seg_offset:   u32 LE — first segment index in SegmentRow table         │
//! │  seg_count:    u32 LE — number of segments for this row                 │
//! │  subject_idx:  u32 LE — StringPool index (u32::MAX if empty)            │
//! │  author_idx:   u32 LE — StringPool index (u32::MAX if empty)            │
//! │  commit_time:  i64 LE — committer time, Unix epoch seconds              │
//! │  ref_offset:   u32 LE — first ref index in RefRow table                 │
//! │  ref_count:    u16 LE — number of refs for this row                     │
//! │  _pad:         u16 = 0                                                  │
//! └─────────────────────────────────────────────────────────────────────────┘
//! ┌─ RefRow × ref_count (8 bytes each) ─────────────────────────────────────┐
//! │  name_idx:   u32 LE — StringPool index                                  │
//! │  kind:       u8   (RefKind: LocalBranch=0 … Stash=4)                    │
//! │  _pad:       [u8; 3] = 0                                                │
//! └─────────────────────────────────────────────────────────────────────────┘
//! ┌─ SegmentRow × seg_count (8 bytes each) ─────────────────────────────────┐
//! │  from_lane: u16 LE                                                      │
//! │  to_lane:   u16 LE                                                      │
//! │  color:     u8                                                          │
//! │  kind:      u8   (SegKind: Straight=0, MergeOut=1, ConvergeIn=2)        │
//! │  _pad:      u16 = 0                                                     │
//! └─────────────────────────────────────────────────────────────────────────┘
//! ```
//!
//! Buffer order: Header · StringPool · CommitRow · RefRow · SegmentRow.
//!
//! Fixed-width rows allow the webview to consume commit data with `DataView` /
//! typed-array views without JSON deserialization (plan §3.5).
//!
//! The geometry bytes (CommitRow `[0..32]`) are identical to v1; v2 only appends
//! metadata fields after them and adds the RefRow table.

use crate::model::{CommitMeta, RefKind, RefLabel, RowFlags, RowLayout, SegKind, Segment};
use smallvec::SmallVec;

/// Magic bytes at the start of every valid buffer.
const MAGIC: &[u8; 4] = b"BRAI";
/// Current wire-format version.
const VERSION: u8 = 2;
/// Header size in bytes.
const HEADER_LEN: usize = 20;
/// Size of one CommitRow on the wire.
const COMMIT_ROW_LEN: usize = 56;
/// Size of one RefRow on the wire.
const REF_ROW_LEN: usize = 8;
/// Size of one SegmentRow on the wire.
const SEG_ROW_LEN: usize = 8;
/// Sentinel index meaning "no string" (empty subject/author).
const STR_ABSENT: u32 = u32::MAX;

// ─── Encoding ────────────────────────────────────────────────────────────────

/// Intern `s` into `pool`, returning its index. Empty strings map to
/// [`STR_ABSENT`] and are never stored. Linear search keeps the pool in
/// deterministic insertion order (layout invariant 4).
fn intern(s: &str, pool: &mut Vec<String>) -> u32 {
    if s.is_empty() {
        return STR_ABSENT;
    }
    if let Some(i) = pool.iter().position(|x| x == s) {
        return i as u32;
    }
    let i = pool.len() as u32;
    pool.push(s.to_string());
    i
}

/// Serialise a batch of layout rows + their metadata into a flat binary buffer.
///
/// `rows` and `metas` must be index-aligned (same length): `metas[i]` is the
/// metadata for `rows[i]`. The geometry comes from `rows`; subject/author/time/
/// refs come from `metas`.
pub fn encode_batch(rows: &[RowLayout], metas: &[CommitMeta]) -> Vec<u8> {
    assert_eq!(
        rows.len(),
        metas.len(),
        "rows and metas must be index-aligned"
    );

    // ── 1. Build the string pool (deterministic, per-row insertion order) ──
    let mut strings: Vec<String> = Vec::new();
    let mut subject_idx: Vec<u32> = Vec::with_capacity(metas.len());
    let mut author_idx: Vec<u32> = Vec::with_capacity(metas.len());
    let mut ref_idxs: Vec<SmallVec<[(u32, u8); 2]>> = Vec::with_capacity(metas.len());

    for meta in metas {
        subject_idx.push(intern(&meta.subject, &mut strings));
        author_idx.push(intern(&meta.author, &mut strings));
        let row_refs = meta
            .refs
            .iter()
            .map(|r| (intern(&r.name, &mut strings), r.kind as u8))
            .collect();
        ref_idxs.push(row_refs);
    }

    // ── 2. Counts and exact buffer size ──────────────────────────────────
    let total_segs: usize = rows.iter().map(|r| r.segments.len()).sum();
    let total_refs: usize = ref_idxs.iter().map(|v| v.len()).sum();
    let string_bytes: usize = strings.iter().map(|s| 4 + s.len()).sum();

    let capacity = HEADER_LEN
        + string_bytes
        + rows.len() * COMMIT_ROW_LEN
        + total_refs * REF_ROW_LEN
        + total_segs * SEG_ROW_LEN;
    let mut buf = Vec::with_capacity(capacity);

    // ── 3. Header ─────────────────────────────────────────────────────────
    buf.extend_from_slice(MAGIC);
    buf.push(VERSION);
    buf.push(0); // reserved
    buf.extend_from_slice(&(strings.len() as u16).to_le_bytes());
    buf.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    buf.extend_from_slice(&(total_segs as u32).to_le_bytes());
    buf.extend_from_slice(&(total_refs as u32).to_le_bytes());

    // ── 4. StringPool ─────────────────────────────────────────────────────
    for s in &strings {
        buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
        buf.extend_from_slice(s.as_bytes());
    }

    // ── 5. CommitRow table ────────────────────────────────────────────────
    let mut seg_offset: u32 = 0;
    let mut ref_offset: u32 = 0;
    for (i, row) in rows.iter().enumerate() {
        let seg_count = row.segments.len() as u32;
        let row_ref_count = ref_idxs[i].len() as u16;
        buf.extend_from_slice(&row.oid); // 20
        buf.extend_from_slice(&row.lane.to_le_bytes()); //  2
        buf.push(row.color); //  1
        buf.push(row.flags.bits()); //  1
        buf.extend_from_slice(&seg_offset.to_le_bytes()); //  4
        buf.extend_from_slice(&seg_count.to_le_bytes()); //  4
        buf.extend_from_slice(&subject_idx[i].to_le_bytes()); //  4
        buf.extend_from_slice(&author_idx[i].to_le_bytes()); //  4
        buf.extend_from_slice(&metas[i].commit_time.to_le_bytes()); //  8
        buf.extend_from_slice(&ref_offset.to_le_bytes()); //  4
        buf.extend_from_slice(&row_ref_count.to_le_bytes()); //  2
        buf.extend_from_slice(&[0u8; 2]); //  2 pad
                                          // = 56 bytes
        seg_offset += seg_count;
        ref_offset += row_ref_count as u32;
    }

    // ── 6. RefRow table ───────────────────────────────────────────────────
    for row_refs in &ref_idxs {
        for (name_idx, kind) in row_refs {
            buf.extend_from_slice(&name_idx.to_le_bytes()); // 4
            buf.push(*kind); // 1
            buf.extend_from_slice(&[0u8; 3]); // 3 pad
                                              // = 8 bytes
        }
    }

    // ── 7. SegmentRow table ───────────────────────────────────────────────
    for row in rows {
        for seg in &row.segments {
            buf.extend_from_slice(&seg.from_lane.to_le_bytes()); // 2
            buf.extend_from_slice(&seg.to_lane.to_le_bytes()); // 2
            buf.push(seg.color); // 1
            buf.push(seg.kind as u8); // 1
            buf.extend_from_slice(&[0u8; 2]); // 2 pad
                                              // = 8 bytes
        }
    }

    debug_assert_eq!(buf.len(), capacity, "capacity pre-calc mismatch");
    buf
}

// ─── Decoding ────────────────────────────────────────────────────────────────

/// Read a `u32` LE at `buf[at..at+4]`. Caller must have bounds-checked.
#[inline]
fn rd_u32(buf: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]])
}

/// Read a `u16` LE at `buf[at..at+2]`. Caller must have bounds-checked.
#[inline]
fn rd_u16(buf: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([buf[at], buf[at + 1]])
}

/// Deserialise a buffer produced by [`encode_batch`].
///
/// Returns `(rows, metas)`, index-aligned, reconstructing both geometry and
/// metadata (subject/author/time/refs). Errors on malformed input rather than
/// panicking.
pub fn decode_batch(buf: &[u8]) -> Result<(Vec<RowLayout>, Vec<CommitMeta>), DecodeError> {
    // ── Header ──────────────────────────────────────────────────────────────
    if buf.len() < HEADER_LEN {
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
    let str_count = rd_u16(buf, 6) as usize;
    let row_count = rd_u32(buf, 8) as usize;
    // buf[12..16]: seg_count (recomputed from rows)
    // buf[16..20]: ref_count (recomputed from rows)

    let mut pos = HEADER_LEN;

    // ── StringPool ───────────────────────────────────────────────────────
    let mut pool: Vec<String> = Vec::with_capacity(str_count);
    for _ in 0..str_count {
        if pos + 4 > buf.len() {
            return Err(DecodeError::TooShort);
        }
        let len = rd_u32(buf, pos) as usize;
        let start = pos + 4;
        let end = start.checked_add(len).ok_or(DecodeError::TooShort)?;
        if end > buf.len() {
            return Err(DecodeError::TooShort);
        }
        let s = std::str::from_utf8(&buf[start..end])
            .map_err(|e| DecodeError::Malformed(format!("invalid UTF-8 in string pool: {e}")))?;
        pool.push(s.to_string());
        pos = end;
    }

    /// Resolve a StringPool index to an owned String. `STR_ABSENT` → empty.
    fn resolve(pool: &[String], idx: u32) -> Result<String, DecodeError> {
        if idx == STR_ABSENT {
            return Ok(String::new());
        }
        pool.get(idx as usize)
            .cloned()
            .ok_or_else(|| DecodeError::Malformed(format!("string index {idx} out of range")))
    }

    // ── CommitRow table ──────────────────────────────────────────────────
    let commit_rows_start = pos;
    let commit_section_len = row_count
        .checked_mul(COMMIT_ROW_LEN)
        .ok_or_else(|| DecodeError::Malformed("row_count overflow".into()))?;
    if commit_rows_start + commit_section_len > buf.len() {
        return Err(DecodeError::TooShort);
    }

    struct RowMeta {
        oid: [u8; 20],
        lane: u16,
        color: u8,
        flags: RowFlags,
        seg_offset: u32,
        seg_count: u32,
        subject_idx: u32,
        author_idx: u32,
        commit_time: i64,
        ref_offset: u32,
        ref_count: u16,
    }
    let mut row_metas: Vec<RowMeta> = Vec::with_capacity(row_count);
    for i in 0..row_count {
        let b = commit_rows_start + i * COMMIT_ROW_LEN;
        let mut oid = [0u8; 20];
        oid.copy_from_slice(&buf[b..b + 20]);
        row_metas.push(RowMeta {
            oid,
            lane: rd_u16(buf, b + 20),
            color: buf[b + 22],
            flags: RowFlags::from_bits_truncate(buf[b + 23]),
            seg_offset: rd_u32(buf, b + 24),
            seg_count: rd_u32(buf, b + 28),
            subject_idx: rd_u32(buf, b + 32),
            author_idx: rd_u32(buf, b + 36),
            commit_time: i64::from_le_bytes(buf[b + 40..b + 48].try_into().unwrap()),
            ref_offset: rd_u32(buf, b + 48),
            ref_count: rd_u16(buf, b + 52),
            // buf[b+54..b+56] = _pad
        });
    }

    // ── RefRow table ─────────────────────────────────────────────────────
    let ref_rows_start = commit_rows_start + commit_section_len;
    let total_refs: usize = row_metas.iter().map(|m| m.ref_count as usize).sum();
    let ref_section_len = total_refs
        .checked_mul(REF_ROW_LEN)
        .ok_or_else(|| DecodeError::Malformed("ref_count overflow".into()))?;
    if ref_rows_start + ref_section_len > buf.len() {
        return Err(DecodeError::TooShort);
    }

    // ── SegmentRow table ─────────────────────────────────────────────────
    let seg_rows_start = ref_rows_start + ref_section_len;
    let total_segs: usize = row_metas.iter().map(|m| m.seg_count as usize).sum();
    let seg_section_len = total_segs
        .checked_mul(SEG_ROW_LEN)
        .ok_or_else(|| DecodeError::Malformed("seg_count overflow".into()))?;
    if seg_rows_start + seg_section_len > buf.len() {
        return Err(DecodeError::TooShort);
    }

    // ── Assemble RowLayout + CommitMeta ──────────────────────────────────
    let mut rows: Vec<RowLayout> = Vec::with_capacity(row_count);
    let mut metas: Vec<CommitMeta> = Vec::with_capacity(row_count);
    for m in &row_metas {
        // Segments
        let mut segments: SmallVec<[Segment; 4]> = SmallVec::new();
        for j in 0..m.seg_count as usize {
            let b = seg_rows_start + (m.seg_offset as usize + j) * SEG_ROW_LEN;
            if b + SEG_ROW_LEN > buf.len() {
                return Err(DecodeError::TooShort);
            }
            let kind = match buf[b + 5] {
                0 => SegKind::Straight,
                1 => SegKind::MergeOut,
                2 => SegKind::ConvergeIn,
                v => return Err(DecodeError::Malformed(format!("unknown SegKind {v}"))),
            };
            segments.push(Segment {
                from_lane: rd_u16(buf, b),
                to_lane: rd_u16(buf, b + 2),
                color: buf[b + 4],
                kind,
            });
        }

        // Refs
        let mut refs: SmallVec<[RefLabel; 2]> = SmallVec::new();
        for j in 0..m.ref_count as usize {
            let b = ref_rows_start + (m.ref_offset as usize + j) * REF_ROW_LEN;
            let name_idx = rd_u32(buf, b);
            let kind = match buf[b + 4] {
                0 => RefKind::LocalBranch,
                1 => RefKind::RemoteBranch,
                2 => RefKind::Tag,
                3 => RefKind::Head,
                4 => RefKind::Stash,
                v => return Err(DecodeError::Malformed(format!("unknown RefKind {v}"))),
            };
            refs.push(RefLabel {
                name: resolve(&pool, name_idx)?,
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
        metas.push(CommitMeta {
            oid: m.oid,
            subject: resolve(&pool, m.subject_idx)?,
            author: resolve(&pool, m.author_idx)?,
            commit_time: m.commit_time,
            refs,
        });
    }

    Ok((rows, metas))
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
