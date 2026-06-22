//! napi-rs bindings that expose `git-braid-core` to the TypeScript extension host.
//!
//! # Architecture (plan §3.4)
//!
//! This crate is compiled to a platform-native `.node` addon loaded by Node.js
//! inside the VS Code Extension Host process. It acts as a thin adapter:
//!
//! - Receives JS values (paths, options) from TypeScript.
//! - Delegates all real work to `git_braid_core`.
//! - Returns JS values (binary `Buffer` / plain objects) to TypeScript.
//!
//! **No business logic lives here** — keep this file as a translation layer only.
//!
//! # Prebuild matrix (plan §3.4 / §9 risk)
//!
//! The `.node` files are prebuilt in CI for:
//! - `darwin-arm64` (Apple Silicon — dev machine)
//! - `darwin-x64`   (Intel Mac)
//! - `linux-x64-gnu`
//! - `win32-x64-msvc`
//!
//! See `.github/workflows/build-napi.yml`.

#![deny(clippy::all)]

use git_braid_core::{
    layout::layout,
    serialize::encode_batch,
    walk::{walk_commits, WalkOptions},
};
use napi_derive::napi;

/// Request a batch of commit graph rows from the Rust core.
///
/// # Arguments
///
/// * `repo_path` — absolute path to the git worktree or `.git` directory.
/// * `offset`    — number of commits already loaded (for incremental paging).
/// * `limit`     — maximum number of commits to return in this batch.
///
/// # Returns
///
/// A `Buffer` containing the binary-encoded batch (see `crates/core/src/serialize.rs`).
/// The webview reads this with `DataView` / typed-array views without JSON parsing.
///
/// # Paging (M1 implementation)
///
/// M1 re-walks `offset + limit` commits on every call and slices the layout result.
/// This is correct but not optimal for large repos.
///
/// TODO(M2): accept a serialised `BoundaryState` token so the host can resume layout
/// from the previous batch boundary instead of recomputing from the repository root.
#[napi]
pub fn get_graph_batch(repo_path: String, offset: u32, limit: u32) -> napi::Result<Vec<u8>> {
    let path = std::path::Path::new(&repo_path);

    // Walk enough commits to cover the requested window.
    // saturating_add guards against (offset + limit) overflowing usize.
    let walk_limit = (offset as usize).saturating_add(limit as usize);
    let opts = WalkOptions {
        limit: if walk_limit > 0 {
            Some(walk_limit)
        } else {
            None
        },
        ..Default::default()
    };

    let commits = walk_commits(path, &opts)
        .map_err(|e| napi::Error::from_reason(format!("walk_commits: {e}")))?;

    // Compute layout for all walked commits (O(n·L) where L = concurrent branch count).
    let (rows, _boundary) = layout(&commits, None);

    // Slice to the requested window; silently clamp if offset is past the end.
    let start = (offset as usize).min(rows.len());
    let batch = &rows[start..];

    Ok(encode_batch(batch, &[]))
}
