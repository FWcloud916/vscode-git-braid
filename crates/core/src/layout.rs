//! Graph layout engine — assigns each commit a lane and colour, and produces
//! the line segments between rows.
//!
//! # Contract
//!
//! ```text
//! layout(commits, boundary) → (rows, next_boundary)
//! ```
//!
//! This is a **pure function**: given the same `(commits, boundary)` it always
//! produces byte-for-byte identical output. No threading, no randomness, no
//! external state.
//!
//! # Critical invariants (do not break)
//!
//! These are the safety properties that make virtualised rendering and incremental
//! loading correct. See `docs/specs/layout-spec.md` §5 for the full list.
//!
//! 1. **Every parent edge is connected**: for any commit whose parent is in the
//!    window, a continuous lane path exists from commit to parent.
//!
//! 2. **No mid-life lane shift**: a lane's index is fixed from allocation to
//!    termination. Diagonal lines appear *only* at the moment of creation
//!    (`MergeOut`) or termination (`ConvergeIn`). Compaction is **disabled**.
//!
//! 3. **Lane width is bounded by concurrent branch count**, not by total commit
//!    count.
//!
//! 4. **Determinism**: identical input → identical output, byte for byte.
//!
//! 5. **Append-only stability** *(most critical for incremental loading)*:
//!    `layout(commits[..N])` rows 0..N must equal `layout(commits[..N+k])` rows
//!    0..N for any k ≥ 0.
//!
//! 6. **First-parent straight**: a commit's lane is inherited by its first parent
//!    (the main-line stays in the same column).

use crate::model::{
    BoundaryState, ColorId, CommitIn, LaneEntry, Oid, RowFlags, RowLayout, SegKind, Segment,
};
use smallvec::SmallVec;
use std::collections::HashMap;

/// Number of colours in the default palette.
///
/// Colour allocation: `ColorId = next_color % PALETTE_SIZE`, then `next_color += 1`.
/// This gives deterministic, rotation-based colour assignment (spec §8).
///
/// Must stay in sync with the `PALETTE` array in `web/renderer/canvas.ts`.
pub const PALETTE_SIZE: u32 = 8;

// ─── Internal working state ───────────────────────────────────────────────────

/// Mutable state threaded through the layout main loop.
///
/// Only `lanes` and `next_color` are snapshotted into [`BoundaryState`] at the
/// end; `waiting_index` is derived from `lanes` on construction and never
/// serialised (spec §11).
struct LayoutState {
    /// `lanes[i]` = active-lane slot at column *i*.
    /// `None` → slot is free; `Some(e)` → lane is active, waiting for `e.waiting_for`.
    lanes: Vec<Option<LaneEntry>>,
    /// Reverse map: OID → lane indices currently waiting for it.
    /// Rebuilt from `lanes` in O(L); never part of `BoundaryState`.
    waiting_index: HashMap<Oid, SmallVec<[u16; 2]>>,
    /// Monotonically-increasing counter for colour allocation (spec §8).
    next_color: u32,
}

impl LayoutState {
    /// Construct from an optional [`BoundaryState`].
    ///
    /// `None` → fresh state (empty lanes, counter = 0).
    /// `Some(b)` → restore the lane snapshot and rebuild `waiting_index` in O(L).
    fn from_boundary(boundary: Option<BoundaryState>) -> Self {
        let (lanes, next_color) = match boundary {
            Some(bs) => (bs.lanes, bs.next_color),
            None => (Vec::new(), 0),
        };
        let mut waiting_index: HashMap<Oid, SmallVec<[u16; 2]>> =
            HashMap::with_capacity(lanes.len());
        for (idx, slot) in lanes.iter().enumerate() {
            if let Some(entry) = slot {
                waiting_index
                    .entry(entry.waiting_for)
                    .or_default()
                    .push(idx as u16);
            }
        }
        Self {
            lanes,
            waiting_index,
            next_color,
        }
    }

    /// Allocate the next colour in round-robin order (spec §8 main rule).
    ///
    /// Adjacent-colour avoidance is intentionally **disabled** in M1 to ensure
    /// the colour sequence exactly matches the golden tests (spec §13).
    fn alloc_color(&mut self) -> ColorId {
        let c = (self.next_color % PALETTE_SIZE) as ColorId;
        self.next_color += 1;
        c
    }

    /// Return the index of the leftmost `None` slot, pushing a new one if needed.
    fn leftmost_empty_lane(&mut self) -> u16 {
        for (i, slot) in self.lanes.iter().enumerate() {
            if slot.is_none() {
                return i as u16;
            }
        }
        self.lanes.push(None);
        (self.lanes.len() - 1) as u16
    }

    /// Snapshot the current state into a serialisable [`BoundaryState`].
    fn into_boundary(self) -> BoundaryState {
        BoundaryState {
            lanes: self.lanes,
            next_color: self.next_color,
        }
    }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/// Compute the graph layout for a slice of topologically-ordered commits.
///
/// `boundary` is `None` on the first call (fresh graph) or the [`BoundaryState`]
/// returned by the previous call when loading the next incremental batch.
///
/// # Algorithm overview
///
/// Single-pass top-down scan, O(n · L) where L = maximum concurrent active-lane
/// count. Maintains an *active-lane* vector: each occupied slot "waits for" a
/// specific commit OID.
///
/// **Eager convergence** (deviates from spec §7 prose; required for invariant 5):
/// When processing commit C at `commit_lane` with first parent P₀, if a lane
/// with *lower* index is already waiting for P₀, C's lane emits a `ConvergeIn`
/// immediately in *C's own gap-below* and terminates. This ensures the row output
/// is final as soon as it is produced — no look-ahead or back-patching needed.
///
/// See `docs/specs/layout-spec.md` §6–§9 and `tests/golden.rs` for the worked
/// example that pins every behavioural choice.
pub fn layout(
    commits: &[CommitIn],
    boundary: Option<BoundaryState>,
) -> (Vec<RowLayout>, BoundaryState) {
    let mut st = LayoutState::from_boundary(boundary);
    let mut rows: Vec<RowLayout> = Vec::with_capacity(commits.len());

    for c in commits {
        // ── 1. Incoming lanes ────────────────────────────────────────────────
        // All slots currently waiting for this commit's OID.
        let incoming: SmallVec<[u16; 2]> =
            st.waiting_index.get(&c.oid).cloned().unwrap_or_default();

        // ── 2. Commit lane and colour ────────────────────────────────────────
        let (commit_lane, color) = if incoming.is_empty() {
            // Tip: no child in the window points here → allocate a fresh lane.
            let lane = st.leftmost_empty_lane();
            let color = st.alloc_color();
            (lane, color)
        } else {
            // Converge at the leftmost (min-index) incoming lane (spec §6 step 2).
            let lane = *incoming.iter().min().unwrap();
            let color = st.lanes[lane as usize].as_ref().unwrap().color;
            (lane, color)
        };

        // ── 3. Row flags (append-stable: only from parent count) ─────────────
        //
        // M1 sets only IS_MERGE and IS_ROOT — both are pure functions of the
        // commit's own parent list, independent of what other commits are loaded.
        // PARENT_OFFSCREEN and IS_TIP depend on window membership and are not
        // set here; they can be layered on top by a decoration pass later.
        let flags = if c.parents.len() >= 2 {
            RowFlags::IS_MERGE
        } else if c.parents.is_empty() {
            RowFlags::IS_ROOT
        } else {
            RowFlags::empty()
        };

        // Mark this commit as resolved — all incoming lanes are accounted for.
        st.waiting_index.remove(&c.oid);

        // ── 4. Terminate non-min incoming lanes (multi-child convergence) ────
        // Every lane in `incoming` other than `commit_lane` merges into it here.
        let mut sc_segs: SmallVec<[Segment; 4]> = SmallVec::new();
        for &j in &incoming {
            if j != commit_lane {
                let j_color = st.lanes[j as usize].as_ref().unwrap().color;
                sc_segs.push(Segment {
                    from_lane: j,
                    to_lane: commit_lane,
                    color: j_color,
                    kind: SegKind::ConvergeIn,
                });
                st.lanes[j as usize] = None;
            }
        }

        // ── 5. Handle parents ────────────────────────────────────────────────
        let mut merge_out_segs: SmallVec<[Segment; 4]> = SmallVec::new();
        // Tracks only lanes NEWLY opened in this step (the `else` branch below).
        // Existing lanes that are merely the *target* of a MergeOut diagonal are
        // NOT new — they must still receive a Straight segment to remain visible.
        let mut new_lane_ids: SmallVec<[u16; 2]> = SmallVec::new();

        if c.parents.is_empty() {
            // IS_ROOT: commit_lane terminates with no continuation.
            st.lanes[commit_lane as usize] = None;
        } else {
            // — First parent (invariant 6: first-parent straight) ————————————
            let p0 = c.parents[0];

            // Eager convergence: if a *lower-index* lane is already waiting for
            // p0, fold commit_lane into it immediately (see function-level docs).
            let eager_target: Option<u16> = st
                .waiting_index
                .get(&p0)
                .and_then(|ws| ws.iter().copied().filter(|&j| j < commit_lane).min());

            if let Some(target) = eager_target {
                sc_segs.push(Segment {
                    from_lane: commit_lane,
                    to_lane: target,
                    color,
                    kind: SegKind::ConvergeIn,
                });
                st.lanes[commit_lane as usize] = None;
            } else {
                // Continue commit_lane toward p0 (the common case).
                st.lanes[commit_lane as usize] = Some(LaneEntry {
                    waiting_for: p0,
                    color,
                });
                st.waiting_index.entry(p0).or_default().push(commit_lane);
            }

            // — Extra parents (P₁..Pₖ) — each spawns a MergeOut diagonal ─────
            for &pk in &c.parents[1..] {
                // Re-use an existing lane if one already waits for pk (dedup);
                // otherwise open the leftmost free slot.
                let existing: Option<u16> = st
                    .waiting_index
                    .get(&pk)
                    .and_then(|ws| ws.iter().copied().min());

                if let Some(ex_lane) = existing {
                    // Point the MergeOut at the existing lane — do NOT add it to
                    // `new_lane_ids`; that lane was not born here and must still
                    // receive a Straight segment in the gap below.
                    let ex_color = st.lanes[ex_lane as usize].as_ref().unwrap().color;
                    merge_out_segs.push(Segment {
                        from_lane: commit_lane,
                        to_lane: ex_lane,
                        color: ex_color,
                        kind: SegKind::MergeOut,
                    });
                } else {
                    let new_lane = st.leftmost_empty_lane();
                    let new_color = st.alloc_color();
                    st.lanes[new_lane as usize] = Some(LaneEntry {
                        waiting_for: pk,
                        color: new_color,
                    });
                    st.waiting_index.entry(pk).or_default().push(new_lane);
                    merge_out_segs.push(Segment {
                        from_lane: commit_lane,
                        to_lane: new_lane,
                        color: new_color,
                        kind: SegKind::MergeOut,
                    });
                    // Track this truly-new lane so it is excluded from Straights below.
                    new_lane_ids.push(new_lane);
                }
            }
        }

        // ── 6. Straight segments for all other continuing lanes ──────────────
        // Every active lane that was NOT just born in this gap gets a Straight.
        // We exclude only `new_lane_ids` (truly new lanes opened above) — NOT the
        // targets of MergeOut diagonals that point at pre-existing lanes.
        let mut straight_segs: SmallVec<[Segment; 4]> = SmallVec::new();
        for (j, slot) in st.lanes.iter().enumerate() {
            let j = j as u16;
            let Some(entry) = slot else { continue };
            if new_lane_ids.contains(&j) {
                // This lane was born in this gap; it is already described by its
                // MergeOut and must not also get a Straight.
                continue;
            }
            straight_segs.push(Segment {
                from_lane: j,
                to_lane: j,
                color: entry.color,
                kind: SegKind::Straight,
            });
        }

        // Assemble final segment list (golden §9 pins the ordering):
        //   Part A — ConvergeIn + Straight, sorted by from_lane ascending.
        //   Part B — MergeOut, in creation order, appended after Part A.
        sc_segs.extend(straight_segs);
        sc_segs.sort_by_key(|s| s.from_lane);
        sc_segs.extend(merge_out_segs);

        rows.push(RowLayout {
            oid: c.oid,
            lane: commit_lane,
            color,
            segments: sc_segs,
            flags,
        });
    }

    (rows, st.into_boundary())
}
