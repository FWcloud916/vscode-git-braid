/**
 * Round-trip tests for the BRAI v1 TS decoder.
 *
 * Mirrors the 8 cases covered by the Rust `encode_batch`/`decode_batch` tests
 * in `crates/core/src/serialize.rs`. Runs under vitest's default node
 * environment — no jsdom needed (pure DataView / ArrayBuffer).
 *
 * Build BRAI buffers by hand using the same encoding rules as the Rust encoder
 * to stay independent of any shared library code.
 */

import { describe, it, expect } from "vitest";
import {
  decodeBatch,
  shortOid,
  SEG_KIND_STRAIGHT,
  SEG_KIND_MERGE_OUT,
  SEG_KIND_CONVERGE_IN,
  FLAG_IS_MERGE,
  FLAG_IS_ROOT,
} from "./decode";

// ── Buffer builder helpers ────────────────────────────────────────────────────

function writeU8(buf: DataView, pos: number, v: number): number {
  buf.setUint8(pos, v); return pos + 1;
}
function writeU16LE(buf: DataView, pos: number, v: number): number {
  buf.setUint16(pos, v, true); return pos + 2;
}
function writeU32LE(buf: DataView, pos: number, v: number): number {
  buf.setUint32(pos, v, true); return pos + 4;
}

interface SegSpec { fromLane: number; toLane: number; color: number; kind: number }
interface RowSpec { oid?: Uint8Array; lane: number; color: number; flags: number; segs: SegSpec[] }

/**
 * Build a minimal valid BRAI v1 buffer from a list of row specs.
 * String pool is always empty (matching M1 behaviour).
 */
function buildBrai(rows: RowSpec[]): ArrayBuffer {
  const totalSegs = rows.reduce((s, r) => s + r.segs.length, 0);
  const size = 16 + rows.length * 32 + totalSegs * 8;
  const ab = new ArrayBuffer(size);
  const v = new DataView(ab);
  const bytes = new Uint8Array(ab);

  // Header
  bytes[0] = 0x42; bytes[1] = 0x52; bytes[2] = 0x41; bytes[3] = 0x49; // "BRAI"
  let pos = 4;
  pos = writeU8(v, pos, 1);  // version
  pos = writeU8(v, pos, 0);  // reserved
  pos = writeU16LE(v, pos, 0);                   // str_count = 0
  pos = writeU32LE(v, pos, rows.length);          // row_count
  pos = writeU32LE(v, pos, totalSegs);            // seg_count
  // (no string pool)

  // CommitRow table — first pass: compute seg_offsets
  let segOffset = 0;
  for (const row of rows) {
    const oid = row.oid ?? new Uint8Array(20).fill(0xaa);
    bytes.set(oid.subarray(0, 20), pos); pos += 20;
    pos = writeU16LE(v, pos, row.lane);
    pos = writeU8(v, pos, row.color);
    pos = writeU8(v, pos, row.flags);
    pos = writeU32LE(v, pos, segOffset);
    pos = writeU32LE(v, pos, row.segs.length);
    segOffset += row.segs.length;
  }

  // SegmentRow table
  for (const row of rows) {
    for (const seg of row.segs) {
      pos = writeU16LE(v, pos, seg.fromLane);
      pos = writeU16LE(v, pos, seg.toLane);
      pos = writeU8(v, pos, seg.color);
      pos = writeU8(v, pos, seg.kind);
      pos = writeU16LE(v, pos, 0); // pad
    }
  }

  return ab;
}

// ── Test helpers ─────────────────────────────────────────────────────────────

function oidWith(byte: number): Uint8Array {
  return new Uint8Array(20).fill(byte);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("decodeBatch", () => {
  it("decodes an empty batch (0 rows)", () => {
    const buf = buildBrai([]);
    const rows = decodeBatch(buf);
    expect(rows).toHaveLength(0);
  });

  it("decodes a single row with no segments", () => {
    const buf = buildBrai([{ lane: 0, color: 2, flags: FLAG_IS_ROOT, segs: [] }]);
    const rows = decodeBatch(buf);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.lane).toBe(0);
    expect(row.color).toBe(2);
    expect(row.flags).toBe(FLAG_IS_ROOT);
    expect(row.segments).toHaveLength(0);
  });

  it("decodes oid bytes correctly", () => {
    const oid = oidWith(0x7a);
    const buf = buildBrai([{ oid, lane: 0, color: 0, flags: 0, segs: [] }]);
    const rows = decodeBatch(buf);
    const row = rows[0]!;
    expect(Array.from(row.oid)).toEqual(Array.from(oid));
  });

  it("decodes a row with a Straight segment", () => {
    const seg: SegSpec = { fromLane: 0, toLane: 0, color: 1, kind: SEG_KIND_STRAIGHT };
    const buf = buildBrai([{ lane: 0, color: 1, flags: 0, segs: [seg] }]);
    const rows = decodeBatch(buf);
    const row = rows[0]!;
    expect(row.segments).toHaveLength(1);
    expect(row.segments[0]).toMatchObject({ fromLane: 0, toLane: 0, color: 1, kind: SEG_KIND_STRAIGHT });
  });

  it("decodes MergeOut and ConvergeIn segments (multi-segment row)", () => {
    const segs: SegSpec[] = [
      { fromLane: 0, toLane: 0, color: 0, kind: SEG_KIND_STRAIGHT },
      { fromLane: 0, toLane: 1, color: 1, kind: SEG_KIND_MERGE_OUT },
    ];
    const buf = buildBrai([{ lane: 0, color: 0, flags: FLAG_IS_MERGE, segs }]);
    const rows = decodeBatch(buf);
    const row = rows[0]!;
    expect(row.flags & FLAG_IS_MERGE).toBeTruthy();
    expect(row.segments).toHaveLength(2);
    expect(row.segments[1]).toMatchObject({ fromLane: 0, toLane: 1, kind: SEG_KIND_MERGE_OUT });
  });

  it("decodes ConvergeIn segment", () => {
    const seg: SegSpec = { fromLane: 1, toLane: 0, color: 1, kind: SEG_KIND_CONVERGE_IN };
    const buf = buildBrai([{ lane: 1, color: 1, flags: 0, segs: [seg] }]);
    const rows = decodeBatch(buf);
    expect(rows[0]!.segments[0]).toMatchObject({ fromLane: 1, toLane: 0, kind: SEG_KIND_CONVERGE_IN });
  });

  it("uses seg_offset correctly (multi-row with non-zero seg_offset)", () => {
    // row 0 has 2 segs; row 1's seg_offset should be 2
    const segsRow0: SegSpec[] = [
      { fromLane: 0, toLane: 0, color: 0, kind: SEG_KIND_STRAIGHT },
      { fromLane: 0, toLane: 1, color: 1, kind: SEG_KIND_MERGE_OUT },
    ];
    const segsRow1: SegSpec[] = [
      { fromLane: 1, toLane: 0, color: 1, kind: SEG_KIND_CONVERGE_IN },
    ];
    const buf = buildBrai([
      { lane: 0, color: 0, flags: 0, segs: segsRow0 },
      { lane: 1, color: 1, flags: 0, segs: segsRow1 },
    ]);
    const rows = decodeBatch(buf);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.segments).toHaveLength(2);
    expect(rows[1]!.segments).toHaveLength(1);
    expect(rows[1]!.segments[0]).toMatchObject({ kind: SEG_KIND_CONVERGE_IN });
  });

  it("throws on bad magic bytes", () => {
    const ab = buildBrai([]);
    const bytes = new Uint8Array(ab);
    bytes[0] = 0xff; // corrupt magic
    expect(() => decodeBatch(ab)).toThrow(/magic/);
  });

  it("throws on unsupported version", () => {
    const ab = buildBrai([]);
    new DataView(ab).setUint8(4, 99); // corrupt version byte
    expect(() => decodeBatch(ab)).toThrow(/version/);
  });

  it("throws on truncated buffer (header)", () => {
    const ab = new ArrayBuffer(8); // too short for 16-byte header
    expect(() => decodeBatch(ab)).toThrow(/too short/);
  });
});

describe("shortOid", () => {
  it("returns 7 hex chars", () => {
    const oid = new Uint8Array(20);
    oid[0] = 0xab; oid[1] = 0xcd; oid[2] = 0xef; oid[3] = 0x01;
    expect(shortOid(oid)).toBe("abcdef0");
  });

  it("zero-pads single-digit hex bytes", () => {
    const oid = new Uint8Array(20); // all zeros
    expect(shortOid(oid)).toBe("0000000");
  });
});
