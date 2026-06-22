/**
 * BRAI v2 binary batch decoder.
 *
 * Mirrors `decode_batch` from `crates/core/src/serialize.rs` using DataView
 * (little-endian). Runs in the webview's browser context with no Node.js APIs.
 *
 * # Wire format (v2) — summary
 *
 *   Header (20 B): magic[4] version[1] reserved[1] str_count[2] row_count[4]
 *                  seg_count[4] ref_count[4]
 *   StringPool:    for each string: len[4] utf8[len]
 *   CommitRow×N:   oid[20] lane[2] color[1] flags[1] seg_offset[4] seg_count[4]
 *                  subject_idx[4] author_idx[4] commit_time[8] ref_offset[4]
 *                  ref_count[2] pad[2]                                        = 56 B
 *   RefRow×R:      name_idx[4] kind[1] pad[3]                                 = 8 B
 *   SegmentRow×M:  from_lane[2] to_lane[2] color[1] kind[1] pad[2]            = 8 B
 *
 * Buffer order: Header · StringPool · CommitRow · RefRow · SegmentRow.
 * All multi-byte integers are little-endian (except the magic, big-endian).
 * Full spec: `crates/core/src/serialize.rs`.
 */

// ── Public types ─────────────────────────────────────────────────────────────

/** SegKind numeric values matching `crates/core/src/model.rs`. */
export const SEG_KIND_STRAIGHT    = 0;
export const SEG_KIND_MERGE_OUT   = 1;
export const SEG_KIND_CONVERGE_IN = 2;

/** RowFlags bit masks matching `crates/core/src/model.rs`. */
export const FLAG_IS_MERGE         = 0x01;
export const FLAG_IS_ROOT          = 0x02;
export const FLAG_PARENT_OFFSCREEN = 0x04;
export const FLAG_IS_TIP           = 0x08;
export const FLAG_IS_SYNTHETIC     = 0x10;
export const FLAG_IS_STASH         = 0x20;

/** RefKind numeric values matching Rust `RefKind` repr(u8). */
export const REF_KIND_LOCAL_BRANCH  = 0;
export const REF_KIND_REMOTE_BRANCH = 1;
export const REF_KIND_TAG           = 2;
export const REF_KIND_HEAD          = 3;
export const REF_KIND_STASH         = 4;

/** A single line segment in the gap below a commit row. */
export interface DecodedSegment {
  /** Lane at the top of the gap (current-row side). */
  fromLane: number;
  /** Lane at the bottom of the gap (next-row side). */
  toLane: number;
  /** Palette index for this segment's colour. */
  color: number;
  /** Segment kind: 0=Straight, 1=MergeOut, 2=ConvergeIn. */
  kind: number;
}

/** A single decoded ref label attached to a commit. */
export interface DecodedRef {
  /** Display name (branch/tag/stash name, or "HEAD"). */
  name: string;
  /** Ref kind: one of the REF_KIND_* constants. */
  kind: number;
}

/** Decoded geometry + metadata for one commit row. */
export interface DecodedRow {
  /** Raw SHA-1 object id, 20 bytes. Use `shortOid()` for display. */
  oid: Uint8Array;
  /** Zero-based lane (column) index. 0 = leftmost. */
  lane: number;
  /** Palette index for the commit node and first-parent line. */
  color: number;
  /** RowFlags bitfield. */
  flags: number;
  /** Segments in the gap *below* this row. */
  segments: DecodedSegment[];
  /** Commit subject (first line of the message); empty string if absent. */
  subject: string;
  /** Author display name; empty string if absent. */
  author: string;
  /** Commit time as Unix epoch seconds. */
  commitTime: number;
  /** Ref labels attached to this commit; may be empty. */
  refs: DecodedRef[];
}

// ── Decoder ──────────────────────────────────────────────────────────────────

const BRAI_MAGIC = 0x42524149; // "BRAI" as big-endian u32
const BRAI_VERSION = 2;
const HEADER_SIZE = 20;
const COMMIT_ROW_SIZE = 56;
const REF_ROW_SIZE = 8;
const SEG_ROW_SIZE = 8;
const ABSENT_IDX = 0xffffffff; // u32::MAX = absent/empty string

/**
 * Decode a BRAI v2 binary batch into an array of `DecodedRow`.
 *
 * Throws a descriptive `Error` on malformed input (bad magic, wrong version,
 * truncated data). The caller should catch and surface these as console errors.
 *
 * The `oid` field of each row is a view into `buffer`; do not retain rows after
 * the buffer is garbage-collected, or copy `oid` with `oid.slice()`.
 */
export function decodeBatch(buffer: ArrayBuffer): DecodedRow[] {
  const view = new DataView(buffer);

  // ── Header ─────────────────────────────────────────────────────────────
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error("BRAI: buffer too short for v2 header");
  }
  // Read magic as a big-endian u32 so a single comparison catches all 4 bytes.
  if (view.getUint32(0, false) !== BRAI_MAGIC) {
    throw new Error("BRAI: bad magic bytes");
  }
  const version = view.getUint8(4);
  if (version !== BRAI_VERSION) {
    throw new Error(`BRAI: unsupported version ${version}`);
  }
  // byte [5] = reserved
  const strCount = view.getUint16(6, true);
  const rowCount = view.getUint32(8, true);
  // [12..16] = seg_count (informational; recomputed from per-row seg_count)
  // [16..20] = ref_count (informational; recomputed from per-row ref_count)

  let pos = HEADER_SIZE;

  // ── StringPool ──────────────────────────────────────────────────────────
  const stringPool: string[] = new Array<string>(strCount);
  const td = new TextDecoder("utf-8");
  for (let i = 0; i < strCount; i++) {
    if (pos + 4 > buffer.byteLength) {
      throw new Error("BRAI: string pool header truncated");
    }
    const len = view.getUint32(pos, true);
    pos += 4;
    if (pos + len > buffer.byteLength) {
      throw new Error("BRAI: string pool body truncated");
    }
    stringPool[i] = td.decode(new Uint8Array(buffer, pos, len));
    pos += len;
  }

  function getString(idx: number): string {
    if (idx === ABSENT_IDX) return "";
    return stringPool[idx] ?? "";
  }

  // ── CommitRow table ─────────────────────────────────────────────────────
  const commitRowsStart = pos;
  if (commitRowsStart + rowCount * COMMIT_ROW_SIZE > buffer.byteLength) {
    throw new Error("BRAI: commit table truncated");
  }

  interface RowMeta {
    oid: Uint8Array;
    lane: number;
    color: number;
    flags: number;
    segOffset: number;
    segCount: number;
    subjectIdx: number;
    authorIdx: number;
    commitTime: number;
    refOffset: number;
    refCount: number;
  }

  const metas: RowMeta[] = new Array<RowMeta>(rowCount);
  for (let i = 0; i < rowCount; i++) {
    const b = commitRowsStart + i * COMMIT_ROW_SIZE;
    metas[i] = {
      oid:        new Uint8Array(buffer, b, 20),
      lane:       view.getUint16(b + 20, true),
      color:      view.getUint8 (b + 22),
      flags:      view.getUint8 (b + 23),
      segOffset:  view.getUint32(b + 24, true),
      segCount:   view.getUint32(b + 28, true),
      subjectIdx: view.getUint32(b + 32, true),
      authorIdx:  view.getUint32(b + 36, true),
      // commit_time is i64 LE — read as two u32s and combine (safe for the
      // foreseeable future; epoch seconds stay well within ±2^53).
      commitTime: view.getUint32(b + 40, true) + view.getUint32(b + 44, true) * 0x100000000,
      refOffset:  view.getUint32(b + 48, true),
      refCount:   view.getUint16(b + 52, true),
      // [b+54..b+56] = padding, ignored
    };
  }
  pos = commitRowsStart + rowCount * COMMIT_ROW_SIZE;

  // ── RefRow table ──────────────────────────────────────────────────────
  let totalRefs = 0;
  for (let i = 0; i < rowCount; i++) {
    totalRefs += metas[i]?.refCount ?? 0;
  }
  const refRowsStart = pos;
  if (refRowsStart + totalRefs * REF_ROW_SIZE > buffer.byteLength) {
    throw new Error("BRAI: ref table truncated");
  }

  // ── SegmentRow table ────────────────────────────────────────────────────
  const segRowsStart = refRowsStart + totalRefs * REF_ROW_SIZE;
  let totalSegs = 0;
  for (let i = 0; i < rowCount; i++) {
    totalSegs += metas[i]?.segCount ?? 0;
  }
  if (segRowsStart + totalSegs * SEG_ROW_SIZE > buffer.byteLength) {
    throw new Error("BRAI: segment table truncated");
  }

  // ── Assemble DecodedRows ────────────────────────────────────────────────
  const rows: DecodedRow[] = new Array<DecodedRow>(rowCount);
  for (let i = 0; i < rowCount; i++) {
    const m = metas[i];
    if (m === undefined) continue; // guards noUncheckedIndexedAccess

    // Refs
    const refs: DecodedRef[] = new Array<DecodedRef>(m.refCount);
    for (let j = 0; j < m.refCount; j++) {
      const rb = refRowsStart + (m.refOffset + j) * REF_ROW_SIZE;
      refs[j] = {
        name: getString(view.getUint32(rb, true)),
        kind: view.getUint8(rb + 4),
        // [rb+5..rb+8] = padding, ignored
      };
    }

    // Segments
    const segments: DecodedSegment[] = new Array<DecodedSegment>(m.segCount);
    for (let j = 0; j < m.segCount; j++) {
      const sb = segRowsStart + (m.segOffset + j) * SEG_ROW_SIZE;
      if (sb + SEG_ROW_SIZE > buffer.byteLength) {
        throw new Error(`BRAI: segment [row=${i} seg=${j}] out of bounds`);
      }
      segments[j] = {
        fromLane: view.getUint16(sb,     true),
        toLane:   view.getUint16(sb + 2, true),
        color:    view.getUint8 (sb + 4),
        kind:     view.getUint8 (sb + 5),
        // [sb+6..sb+8] = padding, ignored
      };
    }

    rows[i] = {
      oid:        m.oid,
      lane:       m.lane,
      color:      m.color,
      flags:      m.flags,
      segments,
      subject:    getString(m.subjectIdx),
      author:     getString(m.authorIdx),
      commitTime: m.commitTime,
      refs,
    };
  }

  return rows;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return the first 7 hex characters of a 20-byte OID (git short-hash style).
 * Safe with `noUncheckedIndexedAccess`: uses `Array.from` to get a `number[]`.
 */
export function shortOid(oid: Uint8Array): string {
  return Array.from(oid.subarray(0, 4))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 7);
}
