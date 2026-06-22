//! Git object-database walk: reads commits via gitoxide and produces a
//! topologically-ordered [`CommitIn`] sequence for the layout engine.
//!
//! # Design (plan §3.2 — read/write split)
//!
//! This module owns the **hot read path**: it reads `.git` object storage
//! directly via `gix` (gitoxide), *without spawning a git subprocess*.
//! Write operations (checkout, merge, …) live in `gitActions.ts` (TS layer)
//! and shell out to the `git` CLI.
//!
//! # Ordering policy (plan §4.3)
//!
//! Two modes, switchable via [`SortOrder`]:
//! - [`SortOrder::TopoDate`]: topological order, ties broken by author date
//!   (matches `git log --topo-order`).
//! - [`SortOrder::Date`]: pure author date order (matches `git log --date-order`).
//!
//! # Status
//!
//! **Stub** — M0 implementation target. Signature is final; body is `todo!()`.

use crate::model::CommitIn;

/// Which ordering policy to apply to the commit walk.
#[derive(Debug, Clone, Copy, Default)]
pub enum SortOrder {
    #[default]
    TopoDate,
    Date,
}

/// Options controlling the log walk.
#[derive(Debug, Clone, Default)]
pub struct WalkOptions {
    pub order: SortOrder,
    /// Maximum number of commits to return (`None` = unlimited).
    pub limit: Option<usize>,
    /// If `true`, only follow first-parent edges (hides merge branches).
    pub first_parent_only: bool,
}

/// Walk the commit graph of a git repository and return a topologically-ordered
/// list of commits, newest first.
///
/// `repo_path` should be the path to the `.git` directory or the worktree root
/// (gitoxide resolves both).
///
/// # Errors
///
/// Returns an error if the path is not a valid git repository or if ODB access
/// fails.
///
/// # Status
///
/// **Unimplemented (M0)** — returns `todo!()`.
pub fn walk_commits(
    _repo_path: &std::path::Path,
    _opts: &WalkOptions,
) -> Result<Vec<CommitIn>, Box<dyn std::error::Error>> {
    // M0 implementation target.
    // Use gix::open() → repo.rev_walk() → topo/date sort → CommitIn conversion.
    todo!("walk_commits — implement in M0 (see docs/specs/layout-spec.md §3 and crates/core/src/walk.rs)")
}
