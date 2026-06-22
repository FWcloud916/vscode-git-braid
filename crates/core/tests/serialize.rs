//! Tests for the binary serialisation round-trip.
//!
//! Verifies that `decode_batch(encode_batch(rows, pool))` returns rows that
//! are byte-for-byte identical to the input.

use git_braid_core::{
    model::{CommitIn, RowFlags, RowLayout, SegKind, Segment},
    serialize::{decode_batch, encode_batch, DecodeError},
};
use smallvec::smallvec;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn oid(first_byte: u8) -> [u8; 20] {
    let mut o = [0u8; 20];
    o[0] = first_byte;
    o
}

fn seg(from: u16, to: u16, color: u8, kind: SegKind) -> Segment {
    Segment {
        from_lane: from,
        to_lane: to,
        color,
        kind,
    }
}

/// Run `encode_batch` → `decode_batch` and assert equality.
fn round_trip(rows: Vec<RowLayout>, pool: &[&str]) -> Vec<RowLayout> {
    let buf = encode_batch(&rows, pool);
    let decoded = decode_batch(&buf).expect("decode_batch should succeed");
    assert_eq!(rows, decoded, "round-trip mismatch");
    decoded
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[test]
fn round_trip_empty() {
    round_trip(vec![], &[]);
}

#[test]
fn round_trip_single_root() {
    let rows = vec![RowLayout {
        oid: oid(1),
        lane: 0,
        color: 0,
        segments: smallvec![],
        flags: RowFlags::IS_ROOT,
    }];
    round_trip(rows, &[]);
}

#[test]
fn round_trip_spec_section_9() {
    // The full golden §9 rows (F → {E,C} → D / C → B → A).
    // Reuse the exact expected table from tests/golden.rs.
    let c0: u8 = 0;
    let c1: u8 = 1;
    let rows = vec![
        RowLayout {
            oid: oid(6), // F
            lane: 0,
            color: c0,
            segments: smallvec![
                seg(0, 0, c0, SegKind::Straight),
                seg(0, 1, c1, SegKind::MergeOut),
            ],
            flags: RowFlags::IS_MERGE,
        },
        RowLayout {
            oid: oid(5), // E
            lane: 0,
            color: c0,
            segments: smallvec![
                seg(0, 0, c0, SegKind::Straight),
                seg(1, 1, c1, SegKind::Straight),
            ],
            flags: RowFlags::empty(),
        },
        RowLayout {
            oid: oid(4), // D
            lane: 0,
            color: c0,
            segments: smallvec![
                seg(0, 0, c0, SegKind::Straight),
                seg(1, 1, c1, SegKind::Straight),
            ],
            flags: RowFlags::empty(),
        },
        RowLayout {
            oid: oid(3), // C
            lane: 1,
            color: c1,
            segments: smallvec![
                seg(0, 0, c0, SegKind::Straight),
                seg(1, 0, c1, SegKind::ConvergeIn),
            ],
            flags: RowFlags::empty(),
        },
        RowLayout {
            oid: oid(2), // B
            lane: 0,
            color: c0,
            segments: smallvec![seg(0, 0, c0, SegKind::Straight)],
            flags: RowFlags::empty(),
        },
        RowLayout {
            oid: oid(1), // A
            lane: 0,
            color: c0,
            segments: smallvec![],
            flags: RowFlags::IS_ROOT,
        },
    ];
    round_trip(rows, &[]);
}

#[test]
fn round_trip_with_string_pool() {
    // String pool entries are preserved in the encoding; decode ignores them
    // but the buffer must still be valid so subsequent fields align correctly.
    let rows = vec![RowLayout {
        oid: oid(42),
        lane: 3,
        color: 5,
        segments: smallvec![seg(3, 3, 5, SegKind::Straight)],
        flags: RowFlags::empty(),
    }];
    round_trip(rows, &["Alice", "fix: resolve NaN crash"]);
}

#[test]
fn decode_error_too_short() {
    assert!(matches!(decode_batch(b""), Err(DecodeError::TooShort)));
    assert!(matches!(decode_batch(b"BRAI"), Err(DecodeError::TooShort)));
}

#[test]
fn decode_error_bad_magic() {
    let mut buf = vec![0u8; 16];
    buf[0..4].copy_from_slice(b"FAKE");
    buf[4] = 1; // version
    assert!(matches!(decode_batch(&buf), Err(DecodeError::BadMagic)));
}

#[test]
fn decode_error_unsupported_version() {
    let mut buf = vec![0u8; 16];
    buf[0..4].copy_from_slice(b"BRAI");
    buf[4] = 99; // future version
    assert!(matches!(
        decode_batch(&buf),
        Err(DecodeError::UnsupportedVersion(99))
    ));
}

#[test]
fn encode_then_layout_round_trip() {
    // Integration: layout → encode → decode → same rows.
    use git_braid_core::layout::layout;

    let commits = vec![
        CommitIn {
            oid: oid(6),
            parents: smallvec![oid(5), oid(3)],
        },
        CommitIn {
            oid: oid(5),
            parents: smallvec![oid(4)],
        },
        CommitIn {
            oid: oid(4),
            parents: smallvec![oid(2)],
        },
        CommitIn {
            oid: oid(3),
            parents: smallvec![oid(2)],
        },
        CommitIn {
            oid: oid(2),
            parents: smallvec![oid(1)],
        },
        CommitIn {
            oid: oid(1),
            parents: smallvec![],
        },
    ];

    let (rows, _) = layout(&commits, None);
    round_trip(rows, &[]);
}
