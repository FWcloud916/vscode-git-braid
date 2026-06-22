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

use crate::model::{BoundaryState, CommitIn, RowLayout};

/// Compute the graph layout for a slice of topologically-ordered commits.
///
/// `boundary` is `None` on the first call (fresh graph) or the `BoundaryState`
/// returned by the previous call when loading the next batch.
///
/// # Panics
///
/// Currently unimplemented — returns `todo!()` until M1.
///
/// # Example
///
/// ```rust,ignore
/// // See tests/golden.rs for a worked example matching layout-spec.md §9.
/// let (rows, next) = layout(&commits, None);
/// ```
pub fn layout(
    commits: &[CommitIn],
    boundary: Option<BoundaryState>,
) -> (Vec<RowLayout>, BoundaryState) {
    // M1 implementation target.
    // Algorithm skeleton: docs/specs/layout-spec.md §6 (core algorithm) and §7 (segment generation).
    let _ = (commits, boundary);
    todo!("layout engine — implement in M1 (see docs/specs/layout-spec.md §6)")
}

/// Number of colours in the default palette.
///
/// Colour allocation: `ColorId = next_color % PALETTE_SIZE`, then `next_color += 1`.
/// This gives deterministic, rotation-based colour assignment (spec §8).
pub const PALETTE_SIZE: u32 = 8;
