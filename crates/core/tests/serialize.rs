//! Tests for the BRAI v2 binary serialisation round-trip.
//!
//! Verifies that `decode_batch(encode_batch(rows, metas))` returns rows and
//! metadata that are byte-for-byte equivalent to the input.

use git_braid_core::{
    model::{CommitIn, CommitMeta, RefKind, RefLabel, RowFlags, RowLayout, SegKind, Segment},
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

/// Empty metadata for a row whose OID first byte is `b`.
fn empty_meta(b: u8) -> CommitMeta {
    CommitMeta {
        oid: oid(b),
        subject: String::new(),
        author: String::new(),
        commit_time: 0,
        refs: smallvec![],
    }
}

/// Build aligned empty metas for a set of rows.
fn empty_metas(rows: &[RowLayout]) -> Vec<CommitMeta> {
    rows.iter()
        .map(|r| CommitMeta {
            oid: r.oid,
            subject: String::new(),
            author: String::new(),
            commit_time: 0,
            refs: smallvec![],
        })
        .collect()
}

/// Run `encode_batch` → `decode_batch` and assert both rows and metas match.
fn round_trip(rows: Vec<RowLayout>, metas: Vec<CommitMeta>) -> (Vec<RowLayout>, Vec<CommitMeta>) {
    let buf = encode_batch(&rows, &metas);
    let (drows, dmetas) = decode_batch(&buf).expect("decode_batch should succeed");
    assert_eq!(rows, drows, "row round-trip mismatch");
    assert_eq!(metas, dmetas, "meta round-trip mismatch");
    (drows, dmetas)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[test]
fn round_trip_empty() {
    round_trip(vec![], vec![]);
}

#[test]
fn round_trip_single_root_empty_meta() {
    let rows = vec![RowLayout {
        oid: oid(1),
        lane: 0,
        color: 0,
        segments: smallvec![],
        flags: RowFlags::IS_ROOT,
    }];
    let metas = vec![empty_meta(1)];
    round_trip(rows, metas);
}

#[test]
fn round_trip_with_metadata() {
    let rows = vec![
        RowLayout {
            oid: oid(2),
            lane: 0,
            color: 0,
            segments: smallvec![seg(0, 0, 0, SegKind::Straight)],
            flags: RowFlags::IS_TIP,
        },
        RowLayout {
            oid: oid(1),
            lane: 0,
            color: 0,
            segments: smallvec![],
            flags: RowFlags::IS_ROOT,
        },
    ];
    let metas = vec![
        CommitMeta {
            oid: oid(2),
            subject: "fix: resolve NaN crash".to_string(),
            author: "Alice".to_string(),
            commit_time: 1_700_000_000,
            refs: smallvec![
                RefLabel {
                    name: "main".to_string(),
                    kind: RefKind::LocalBranch,
                },
                RefLabel {
                    name: "HEAD".to_string(),
                    kind: RefKind::Head,
                },
            ],
        },
        CommitMeta {
            oid: oid(1),
            subject: "initial commit".to_string(),
            author: "Bob".to_string(),
            commit_time: 1_699_000_000,
            refs: smallvec![RefLabel {
                name: "v1.0".to_string(),
                kind: RefKind::Tag,
            }],
        },
    ];
    round_trip(rows, metas);
}

/// Same author in multiple rows must be deduplicated into one string pool entry.
#[test]
fn string_pool_dedup() {
    let rows = vec![
        RowLayout {
            oid: oid(3),
            lane: 0,
            color: 0,
            segments: smallvec![],
            flags: RowFlags::empty(),
        },
        RowLayout {
            oid: oid(2),
            lane: 0,
            color: 0,
            segments: smallvec![],
            flags: RowFlags::empty(),
        },
        RowLayout {
            oid: oid(1),
            lane: 0,
            color: 0,
            segments: smallvec![],
            flags: RowFlags::empty(),
        },
    ];
    let metas = vec![
        CommitMeta {
            oid: oid(3),
            subject: "c".to_string(),
            author: "Alice".to_string(),
            commit_time: 3,
            refs: smallvec![],
        },
        CommitMeta {
            oid: oid(2),
            subject: "b".to_string(),
            author: "Alice".to_string(),
            commit_time: 2,
            refs: smallvec![],
        },
        CommitMeta {
            oid: oid(1),
            subject: "a".to_string(),
            author: "Alice".to_string(),
            commit_time: 1,
            refs: smallvec![],
        },
    ];

    let buf = encode_batch(&rows, &metas);
    // str_count is the u16 LE at header bytes [6..8].
    let str_count = u16::from_le_bytes([buf[6], buf[7]]);
    // Pool = {"c","b","a","Alice"} → 4 unique strings (Alice deduped across 3 rows).
    assert_eq!(str_count, 4, "expected 4 unique strings, got {str_count}");

    round_trip(rows, metas);
}

/// RefRow round-trip across the full RefKind range.
#[test]
fn ref_table_all_kinds() {
    let rows = vec![RowLayout {
        oid: oid(7),
        lane: 0,
        color: 0,
        segments: smallvec![],
        flags: RowFlags::empty(),
    }];
    let metas = vec![CommitMeta {
        oid: oid(7),
        subject: "x".to_string(),
        author: "Y".to_string(),
        commit_time: 42,
        refs: smallvec![
            RefLabel {
                name: "local".to_string(),
                kind: RefKind::LocalBranch,
            },
            RefLabel {
                name: "origin/local".to_string(),
                kind: RefKind::RemoteBranch,
            },
            RefLabel {
                name: "v2".to_string(),
                kind: RefKind::Tag,
            },
            RefLabel {
                name: "HEAD".to_string(),
                kind: RefKind::Head,
            },
            RefLabel {
                name: "stash".to_string(),
                kind: RefKind::Stash,
            },
        ],
    }];
    round_trip(rows, metas);
}

#[test]
fn round_trip_spec_section_9() {
    // The full golden §9 rows (F → {E,C} → D / C → B → A), metadata empty.
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
    let metas = empty_metas(&rows);
    round_trip(rows, metas);
}

#[test]
fn header_is_20_bytes() {
    // An empty batch is exactly the 20-byte header with no body.
    let buf = encode_batch(&[], &[]);
    assert_eq!(buf.len(), 20, "v2 header must be 20 bytes");
    assert_eq!(&buf[0..4], b"BRAI");
    assert_eq!(buf[4], 2, "version byte must be 2");
}

#[test]
fn decode_error_too_short() {
    assert!(matches!(decode_batch(b""), Err(DecodeError::TooShort)));
    assert!(matches!(decode_batch(b"BRAI"), Err(DecodeError::TooShort)));
    // 19 bytes: one short of the 20-byte header.
    assert!(matches!(
        decode_batch(&[0u8; 19]),
        Err(DecodeError::TooShort)
    ));
}

#[test]
fn decode_error_bad_magic() {
    let mut buf = vec![0u8; 20];
    buf[0..4].copy_from_slice(b"FAKE");
    buf[4] = 2; // version
    assert!(matches!(decode_batch(&buf), Err(DecodeError::BadMagic)));
}

#[test]
fn decode_error_unsupported_version() {
    let mut buf = vec![0u8; 20];
    buf[0..4].copy_from_slice(b"BRAI");
    buf[4] = 99; // future version
    assert!(matches!(
        decode_batch(&buf),
        Err(DecodeError::UnsupportedVersion(99))
    ));
    // v1 is no longer supported by the v2 decoder.
    buf[4] = 1;
    assert!(matches!(
        decode_batch(&buf),
        Err(DecodeError::UnsupportedVersion(1))
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
    let metas = empty_metas(&rows);
    round_trip(rows, metas);
}
