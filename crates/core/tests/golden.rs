//! Golden tests for the layout engine.
//!
//! Each test encodes a fixed DAG and the expected output from `docs/specs/layout-spec.md §9`.
//!
//! Run with the rest of the suite:
//!   cargo test --package git-braid-core

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

/// Regression test: multiple merge commits all sharing the same second parent
/// must each produce a Straight segment on the shared-parent lane in their
/// gap-below. Previously the lane was incorrectly skipped because its index
/// appeared in `new_merge_targets` even though it was an existing lane.
///
/// DAG (newest first, date-order):
///
/// ```text
/// A → {A_prev, M}   (merge: branch-A merged M)
/// B → {B_prev, M}   (merge: branch-B merged M)
/// C → {C_prev, M}   (merge: branch-C merged M)
/// M → {M_prev}      (the shared master commit)
/// ```
///
/// A_prev, B_prev, C_prev, M_prev are offscreen (not in this window).
///
/// Expected: in every gap above M, lane 0 (M's lane) must carry a Straight
/// segment so the visual line from A/B/C back to M is unbroken.
#[test]
fn shared_second_parent_lane_gets_straight() {
    // OIDs
    let m: [u8; 20] = {
        let mut o = [0u8; 20];
        o[0] = 0x0a;
        o
    };
    let a: [u8; 20] = {
        let mut o = [0u8; 20];
        o[0] = 0x0b;
        o
    };
    let b: [u8; 20] = {
        let mut o = [0u8; 20];
        o[0] = 0x0c;
        o
    };
    let c: [u8; 20] = {
        let mut o = [0u8; 20];
        o[0] = 0x0d;
        o
    };
    // Offscreen parents — referenced but not in this window.
    let m_prev: [u8; 20] = {
        let mut o = [0u8; 20];
        o[0] = 0x10;
        o
    };
    let a_prev: [u8; 20] = {
        let mut o = [0u8; 20];
        o[0] = 0x11;
        o
    };
    let b_prev: [u8; 20] = {
        let mut o = [0u8; 20];
        o[0] = 0x12;
        o
    };
    let c_prev: [u8; 20] = {
        let mut o = [0u8; 20];
        o[0] = 0x13;
        o
    };

    let commits = vec![
        CommitIn {
            oid: a,
            parents: smallvec![a_prev, m],
        },
        CommitIn {
            oid: b,
            parents: smallvec![b_prev, m],
        },
        CommitIn {
            oid: c,
            parents: smallvec![c_prev, m],
        },
        CommitIn {
            oid: m,
            parents: smallvec![m_prev],
        },
    ];

    let (rows, _) = git_braid_core::layout::layout(&commits, None);

    // M must sit in lane 0 (it is the first tip, or the shared-parent lane).
    // Actually: A is processed first as a tip → lane 0 for A's first-parent chain.
    // M's lane is opened for the second-parent connection. Let's just assert the
    // key property: every row that precedes M must have a Straight segment whose
    // from_lane == to_lane for M's lane (the lane that converges on M).

    // Find which lane M lives in.
    let m_row = rows.iter().find(|r| r.oid == m).expect("M must be in rows");
    let m_lane = m_row.lane;

    // Row 0 (A) *opens* M's lane via a MergeOut — no Straight on m_lane expected
    // there (the lane is born in that gap).
    // Rows 1 and 2 (B, C) come after the lane exists; they point their second
    // parent at the EXISTING lane, so M's lane must receive a Straight in each.
    let straight_on_m_lane = |row: &RowLayout| {
        row.segments
            .iter()
            .any(|s| s.kind == SegKind::Straight && s.from_lane == m_lane && s.to_lane == m_lane)
    };
    assert!(
        straight_on_m_lane(&rows[1]),
        "row 1 (B) is missing Straight on lane {m_lane} (M's lane)"
    );
    assert!(
        straight_on_m_lane(&rows[2]),
        "row 2 (C) is missing Straight on lane {m_lane} (M's lane)"
    );
}
