//! Golden tests for the layout engine.
//!
//! Each test encodes a fixed DAG and the expected output from `docs/specs/layout-spec.md §9`.
//! Tests are marked `#[ignore]` until the layout engine is implemented (M1).
//!
//! To run once implemented:
//!   cargo test --package git-braid-core -- --ignored

use git_braid_core::model::{ColorId, CommitIn, RowFlags, RowLayout, SegKind, Segment};
use smallvec::smallvec;

// ─── OID constants ───────────────────────────────────────────────────────────

const A: [u8; 20] = {
    let mut o = [0u8; 20];
    o[0] = 1;
    o
};
const B: [u8; 20] = {
    let mut o = [0u8; 20];
    o[0] = 2;
    o
};
const C: [u8; 20] = {
    let mut o = [0u8; 20];
    o[0] = 3;
    o
};
const D: [u8; 20] = {
    let mut o = [0u8; 20];
    o[0] = 4;
    o
};
const E: [u8; 20] = {
    let mut o = [0u8; 20];
    o[0] = 5;
    o
};
const F: [u8; 20] = {
    let mut o = [0u8; 20];
    o[0] = 6;
    o
};

// ─── Golden case: spec §9 ────────────────────────────────────────────────────

/// DAG from layout-spec.md §9:
///
/// ```text
/// F → {E, C}   (merge: first-parent E, second-parent C)
/// E → {D}
/// D → {B}
/// C → {B}
/// B → {A}
/// A → {}       (root)
/// ```
///
/// Expected layout (newest first):
///
/// | row | commit | lane | color | segments below                            |
/// |-----|--------|------|-------|-------------------------------------------|
/// |   0 |   F    |  0   |  c0   | Straight 0→0 c0, MergeOut 0→1 c1        |
/// |   1 |   E    |  0   |  c0   | Straight 0→0 c0, Straight 1→1 c1        |
/// |   2 |   D    |  0   |  c0   | Straight 0→0 c0, Straight 1→1 c1        |
/// |   3 |   C    |  1   |  c1   | Straight 0→0 c0, ConvergeIn 1→0 c1      |
/// |   4 |   B    |  0   |  c0   | Straight 0→0 c0                          |
/// |   5 |   A    |  0   |  c0   | (none — root, lane terminated)            |
#[test]
#[ignore = "pending layout engine implementation (M1) — see docs/specs/layout-spec.md §9"]
fn golden_spec_section_9() {
    let commits = vec![
        CommitIn {
            oid: F,
            parents: smallvec![E, C],
        },
        CommitIn {
            oid: E,
            parents: smallvec![D],
        },
        CommitIn {
            oid: D,
            parents: smallvec![B],
        },
        CommitIn {
            oid: C,
            parents: smallvec![B],
        },
        CommitIn {
            oid: B,
            parents: smallvec![A],
        },
        CommitIn {
            oid: A,
            parents: smallvec![],
        },
    ];

    let c0: ColorId = 0;
    let c1: ColorId = 1;

    let expected = vec![
        RowLayout {
            oid: F,
            lane: 0,
            color: c0,
            segments: smallvec![
                Segment {
                    from_lane: 0,
                    to_lane: 0,
                    color: c0,
                    kind: SegKind::Straight
                },
                Segment {
                    from_lane: 0,
                    to_lane: 1,
                    color: c1,
                    kind: SegKind::MergeOut
                },
            ],
            flags: RowFlags::IS_MERGE,
        },
        RowLayout {
            oid: E,
            lane: 0,
            color: c0,
            segments: smallvec![
                Segment {
                    from_lane: 0,
                    to_lane: 0,
                    color: c0,
                    kind: SegKind::Straight
                },
                Segment {
                    from_lane: 1,
                    to_lane: 1,
                    color: c1,
                    kind: SegKind::Straight
                },
            ],
            flags: RowFlags::empty(),
        },
        RowLayout {
            oid: D,
            lane: 0,
            color: c0,
            segments: smallvec![
                Segment {
                    from_lane: 0,
                    to_lane: 0,
                    color: c0,
                    kind: SegKind::Straight
                },
                Segment {
                    from_lane: 1,
                    to_lane: 1,
                    color: c1,
                    kind: SegKind::Straight
                },
            ],
            flags: RowFlags::empty(),
        },
        RowLayout {
            oid: C,
            lane: 1,
            color: c1,
            segments: smallvec![
                Segment {
                    from_lane: 0,
                    to_lane: 0,
                    color: c0,
                    kind: SegKind::Straight
                },
                Segment {
                    from_lane: 1,
                    to_lane: 0,
                    color: c1,
                    kind: SegKind::ConvergeIn
                },
            ],
            flags: RowFlags::empty(),
        },
        RowLayout {
            oid: B,
            lane: 0,
            color: c0,
            segments: smallvec![Segment {
                from_lane: 0,
                to_lane: 0,
                color: c0,
                kind: SegKind::Straight
            },],
            flags: RowFlags::empty(),
        },
        RowLayout {
            oid: A,
            lane: 0,
            color: c0,
            segments: smallvec![],
            flags: RowFlags::IS_ROOT,
        },
    ];

    let (rows, _next_boundary) = git_braid_core::layout::layout(&commits, None);
    assert_eq!(
        rows, expected,
        "layout output does not match spec §9 golden table"
    );
}

/// Verify append-only stability (spec invariant 5):
/// `layout(commits[..N])` rows 0..N == `layout(commits[..N+k])` rows 0..N
#[test]
#[ignore = "pending layout engine implementation (M1)"]
fn invariant_append_only_stability() {
    let commits = vec![
        CommitIn {
            oid: F,
            parents: smallvec![E, C],
        },
        CommitIn {
            oid: E,
            parents: smallvec![D],
        },
        CommitIn {
            oid: D,
            parents: smallvec![B],
        },
        CommitIn {
            oid: C,
            parents: smallvec![B],
        },
        CommitIn {
            oid: B,
            parents: smallvec![A],
        },
        CommitIn {
            oid: A,
            parents: smallvec![],
        },
    ];

    for split in 1..commits.len() {
        let (rows_prefix, _) = git_braid_core::layout::layout(&commits[..split], None);
        let (rows_full, _) = git_braid_core::layout::layout(&commits, None);
        assert_eq!(
            rows_prefix,
            rows_full[..split],
            "append-only stability violated at split={split}",
        );
    }
}

/// Verify boundary-state continuation produces the same result as one-shot layout.
#[test]
#[ignore = "pending layout engine implementation (M1)"]
fn invariant_boundary_continuation() {
    let commits = vec![
        CommitIn {
            oid: F,
            parents: smallvec![E, C],
        },
        CommitIn {
            oid: E,
            parents: smallvec![D],
        },
        CommitIn {
            oid: D,
            parents: smallvec![B],
        },
        CommitIn {
            oid: C,
            parents: smallvec![B],
        },
        CommitIn {
            oid: B,
            parents: smallvec![A],
        },
        CommitIn {
            oid: A,
            parents: smallvec![],
        },
    ];

    let split = 3;
    let (rows_full, _) = git_braid_core::layout::layout(&commits, None);

    let (rows_batch1, boundary) = git_braid_core::layout::layout(&commits[..split], None);
    let (rows_batch2, _) = git_braid_core::layout::layout(&commits[split..], Some(boundary));

    let rows_batched: Vec<_> = rows_batch1.into_iter().chain(rows_batch2).collect();
    assert_eq!(
        rows_full, rows_batched,
        "boundary continuation produced different rows than one-shot layout"
    );
}
