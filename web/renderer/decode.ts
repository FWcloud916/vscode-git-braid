/**
 * BRAI v1 binary batch decoder.
 *
 * Mirrors `decode_batch` from `crates/core/src/serialize.rs` using DataView
 * (little-endian). Runs in the webview's browser context with no Node.js APIs.
 *
 * # Wire format (v1) — summary
 *
 *   Header (16 B): magic[4] version[1] reserved[1] str_count[2] row_count[4] seg_count[4]
 *   StringPool:    for each string: len[4] utf8[len]
 *   CommitRow×N:   oid[20] lane[2] color[1] flags[1] seg_offset[4] seg_count[4]   = 32 B
 *   SegmentRow×M:  from_lane[2] to_lane[2] color[1] kind[1] pad[2]                 = 8 B
 *
 * All multi-byte integers are little-endian.
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

/** Decoded geometry for one commit row. */
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
}

// ── Decoder ──────────────────────────────────────────────────────────────────

const BRAI_MAGIC = 0x42524149; // "BRAI" as big-endian u32
const BRAI_VERSION = 1;

/**
 * Decode a BRAI v1 binary batch into an array of `DecodedRow`.
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
  if (buffer.byteLength < 16) {
    throw new Error("BRAI: buffer too short for header");
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
  // [12..16] = seg_count (informational; we recompute from per-row seg_count fields)

  let pos = 16;

  // ── StringPool (skip — not stored in DecodedRow) ────────────────────────
  for (let i = 0; i < strCount; i++) {
    if (pos + 4 > buffer.byteLength) {
      throw new Error("BRAI: string pool header truncated");
    }
    const len = view.getUint32(pos, true);
    pos += 4 + len;
    if (pos > buffer.byteLength) {
      throw new Error("BRAI: string pool body truncated");
    }
  }

  // ── CommitRow table ─────────────────────────────────────────────────────
  const commitRowsStart = pos;
  const commitSectionLen = rowCount * 32;
  if (pos + commitSectionLen > buffer.byteLength) {
    throw new Error("BRAI: commit table truncated");
  }

  // Two-pass: parse row metas first, then assemble segments below.
  interface RowMeta {
    oid: Uint8Array;
    lane: number;
    color: number;
    flags: number;
    segOffset: number;
    segCount: number;
  }

  const metas: RowMeta[] = new Array<RowMeta>(rowCount);
  for (let i = 0; i < rowCount; i++) {
    const b = commitRowsStart + i * 32;
    metas[i] = {
      oid: new Uint8Array(buffer, b, 20),
      lane:      view.getUint16(b + 20, true),
      color:     view.getUint8 (b + 22),
      flags:     view.getUint8 (b + 23),
      segOffset: view.getUint32(b + 24, true),
      segCount:  view.getUint32(b + 28, true),
    };
  }

  // ── SegmentRow table ────────────────────────────────────────────────────
  const segRowsStart = commitRowsStart + commitSectionLen;
  // Validate that the segment section fits.
  let totalSegs = 0;
  for (let i = 0; i < rowCount; i++) {
    totalSegs += metas[i]?.segCount ?? 0;
  }
  if (segRowsStart + totalSegs * 8 > buffer.byteLength) {
    throw new Error("BRAI: segment table truncated");
  }

  // ── Assemble DecodedRows ────────────────────────────────────────────────
  const rows: DecodedRow[] = new Array<DecodedRow>(rowCount);
  for (let i = 0; i < rowCount; i++) {
    const m = metas[i];
    if (m === undefined) continue; // should not happen; guards noUncheckedIndexedAccess
    const segments: DecodedSegment[] = new Array<DecodedSegment>(m.segCount);
    for (let j = 0; j < m.segCount; j++) {
      const b = segRowsStart + (m.segOffset + j) * 8;
      if (b + 8 > buffer.byteLength) {
        throw new Error(`BRAI: segment [row=${i} seg=${j}] out of bounds`);
      }
      segments[j] = {
        fromLane: view.getUint16(b,     true),
        toLane:   view.getUint16(b + 2, true),
        color:    view.getUint8 (b + 4),
        kind:     view.getUint8 (b + 5),
        // [b+6..b+8] = padding, ignored
      };
    }
    rows[i] = {
      oid:      m.oid,
      lane:     m.lane,
      color:    m.color,
      flags:    m.flags,
      segments,
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
