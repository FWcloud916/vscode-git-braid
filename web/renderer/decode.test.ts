/**
 * Round-trip tests for the BRAI v2 TS decoder.
 *
 * Mirrors the cases covered by the Rust `encode_batch`/`decode_batch` tests
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
  REF_KIND_LOCAL_BRANCH,
  REF_KIND_TAG,
  REF_KIND_HEAD,
} from "./decode";

// ── Buffer builder ─────────────────────────────────────────────────────────────

interface SegSpec { fromLane: number; toLane: number; color: number; kind: number }
interface RefSpec { name: string; kind: number }
interface RowSpec {
  oid?: Uint8Array;
  lane: number; color: number; flags: number;
  segs: SegSpec[];
  subject?: string; author?: string; commitTime?: number;
  refs?: RefSpec[];
}

const ABSENT_IDX = 0xffffffff;

/**
 * Build a minimal valid BRAI v2 buffer from a list of row specs.
 * Strings are interned into a deduped pool in encounter order
 * (per row: subject, author, then ref names) — matching the Rust encoder.
 */
function buildBrai(rows: RowSpec[]): ArrayBuffer {
  const strPool: string[] = [];
  function intern(s: string | undefined): number {
    if (!s) return ABSENT_IDX;
    const i = strPool.indexOf(s);
    if (i !== -1) return i;
    strPool.push(s);
    return strPool.length - 1;
  }

  const rowMeta = rows.map(r => ({
    subjectIdx: intern(r.subject),
    authorIdx:  intern(r.author),
    refIdxs:    (r.refs ?? []).map(ref => ({ nameIdx: intern(ref.name), kind: ref.kind })),
  }));

  const te = new TextEncoder();
  const encodedStrings = strPool.map(s => te.encode(s));
  const strBytes = encodedStrings.reduce((s, e) => s + 4 + e.length, 0);
  const totalSegs = rows.reduce((s, r) => s + r.segs.length, 0);
  const totalRefs = rows.reduce((s, r) => s + (r.refs?.length ?? 0), 0);
  const size = 20 + strBytes + rows.length * 56 + totalRefs * 8 + totalSegs * 8;

  const ab = new ArrayBuffer(size);
  const v = new DataView(ab);
  const bytes = new Uint8Array(ab);

  // Header (20 B)
  bytes[0] = 0x42; bytes[1] = 0x52; bytes[2] = 0x41; bytes[3] = 0x49; // "BRAI"
  let pos = 4;
  v.setUint8(pos++, 2);                                  // version = 2
  v.setUint8(pos++, 0);                                  // reserved
  v.setUint16(pos, strPool.length, true); pos += 2;      // str_count
  v.setUint32(pos, rows.length, true);    pos += 4;      // row_count
  v.setUint32(pos, totalSegs, true);      pos += 4;      // seg_count
  v.setUint32(pos, totalRefs, true);      pos += 4;      // ref_count

  // StringPool
  for (const encoded of encodedStrings) {
    v.setUint32(pos, encoded.length, true); pos += 4;
    bytes.set(encoded, pos); pos += encoded.length;
  }

  // CommitRow table (56 B each)
  let segOffset = 0, refOffset = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const m = rowMeta[i]!;
    const oid = r.oid ?? new Uint8Array(20).fill(0xaa);
    bytes.set(oid.subarray(0, 20), pos); pos += 20;       // oid
    v.setUint16(pos, r.lane, true);  pos += 2;            // lane
    v.setUint8(pos++, r.color);                           // color
    v.setUint8(pos++, r.flags);                          // flags
    v.setUint32(pos, segOffset, true);     pos += 4;      // seg_offset
    v.setUint32(pos, r.segs.length, true); pos += 4;      // seg_count
    v.setUint32(pos, m.subjectIdx, true);  pos += 4;      // subject_idx
    v.setUint32(pos, m.authorIdx, true);   pos += 4;      // author_idx
    const t = r.commitTime ?? 0;                          // commit_time i64 LE
    v.setUint32(pos, t & 0xffffffff, true); pos += 4;
    v.setUint32(pos, Math.floor(t / 0x100000000) & 0xffffffff, true); pos += 4;
    v.setUint32(pos, refOffset, true);       pos += 4;    // ref_offset
    v.setUint16(pos, m.refIdxs.length, true); pos += 2;   // ref_count
    v.setUint16(pos, 0, true); pos += 2;                  // _pad
    segOffset += r.segs.length;
    refOffset += m.refIdxs.length;
  }

  // RefRow table (8 B each)
  for (const m of rowMeta) {
    for (const { nameIdx, kind } of m.refIdxs) {
      v.setUint32(pos, nameIdx, true); pos += 4;
      v.setUint8(pos++, kind);
      v.setUint8(pos++, 0); v.setUint8(pos++, 0); v.setUint8(pos++, 0); // pad
    }
  }

  // SegmentRow table (8 B each)
  for (const r of rows) {
    for (const seg of r.segs) {
      v.setUint16(pos, seg.fromLane, true); pos += 2;
      v.setUint16(pos, seg.toLane, true);   pos += 2;
      v.setUint8(pos++, seg.color);
      v.setUint8(pos++, seg.kind);
      v.setUint16(pos, 0, true); pos += 2; // pad
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
    expect(row.subject).toBe("");
    expect(row.author).toBe("");
    expect(row.refs).toHaveLength(0);
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

  // ── v2 metadata tests ────────────────────────────────────────────────────

  it("decodes subject and author from string pool", () => {
    const buf = buildBrai([
      { lane: 0, color: 0, flags: 0, segs: [], subject: "fix: the bug", author: "Eric Fang" },
    ]);
    const row = decodeBatch(buf)[0]!;
    expect(row.subject).toBe("fix: the bug");
    expect(row.author).toBe("Eric Fang");
  });

  it("decodes commitTime correctly", () => {
    const buf = buildBrai([
      { lane: 0, color: 0, flags: 0, segs: [], commitTime: 1_700_000_000 },
    ]);
    expect(decodeBatch(buf)[0]!.commitTime).toBe(1_700_000_000);
  });

  it("decodes refs (branch, tag, HEAD)", () => {
    const buf = buildBrai([
      {
        lane: 0, color: 0, flags: 0, segs: [],
        refs: [
          { name: "main", kind: REF_KIND_LOCAL_BRANCH },
          { name: "v1.0.0", kind: REF_KIND_TAG },
          { name: "HEAD", kind: REF_KIND_HEAD },
        ],
      },
    ]);
    const row = decodeBatch(buf)[0]!;
    expect(row.refs).toHaveLength(3);
    expect(row.refs[0]).toMatchObject({ name: "main", kind: REF_KIND_LOCAL_BRANCH });
    expect(row.refs[1]).toMatchObject({ name: "v1.0.0", kind: REF_KIND_TAG });
    expect(row.refs[2]).toMatchObject({ name: "HEAD", kind: REF_KIND_HEAD });
  });

  it("uses ref_offset correctly across multiple rows", () => {
    const buf = buildBrai([
      { lane: 0, color: 0, flags: 0, segs: [], refs: [
        { name: "main", kind: REF_KIND_LOCAL_BRANCH },
        { name: "HEAD", kind: REF_KIND_HEAD },
      ] },
      { lane: 0, color: 0, flags: 0, segs: [], refs: [
        { name: "feature", kind: REF_KIND_LOCAL_BRANCH },
      ] },
    ]);
    const rows = decodeBatch(buf);
    expect(rows[0]!.refs.map(r => r.name)).toEqual(["main", "HEAD"]);
    expect(rows[1]!.refs.map(r => r.name)).toEqual(["feature"]);
  });

  it("deduplicates string pool entries (same author in two rows → same string)", () => {
    const buf = buildBrai([
      { lane: 0, color: 0, flags: 0, segs: [], author: "Eric Fang", subject: "a" },
      { lane: 0, color: 0, flags: 0, segs: [], author: "Eric Fang", subject: "b" },
    ]);
    const rows = decodeBatch(buf);
    expect(rows[0]!.author).toBe("Eric Fang");
    expect(rows[1]!.author).toBe("Eric Fang");
    expect(rows[0]!.subject).toBe("a");
    expect(rows[1]!.subject).toBe("b");
  });

  it("decodes non-ASCII (multi-byte UTF-8) strings", () => {
    const buf = buildBrai([
      { lane: 0, color: 0, flags: 0, segs: [], subject: "修复缺陷 — café", author: "張三" },
    ]);
    const row = decodeBatch(buf)[0]!;
    expect(row.subject).toBe("修复缺陷 — café");
    expect(row.author).toBe("張三");
  });

  // ── Error handling ─────────────────────────────────────────────────────────

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

  it("throws on version 1", () => {
    const ab = buildBrai([]);
    new DataView(ab).setUint8(4, 1); // v1 is no longer supported
    expect(() => decodeBatch(ab)).toThrow(/version/);
  });

  it("throws on truncated buffer (header)", () => {
    const ab = new ArrayBuffer(12); // too short for 20-byte header
    expect(() => decodeBatch(ab)).toThrow(/too short/);
  });

  it("throws on truncated commit table (56-byte row)", () => {
    const ab = buildBrai([{ lane: 0, color: 0, flags: 0, segs: [] }]);
    // Truncate one byte off the end of the 56-byte commit row.
    const truncated = ab.slice(0, ab.byteLength - 1);
    expect(() => decodeBatch(truncated)).toThrow(/commit table truncated/);
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
