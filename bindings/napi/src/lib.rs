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
    walk::{walk_commits, SortOrder, WalkOptions},
};
use napi::bindgen_prelude::Buffer;
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
pub fn get_graph_batch(repo_path: String, offset: u32, limit: u32) -> napi::Result<Buffer> {
    let path = std::path::Path::new(&repo_path);

    // Walk enough commits to cover the requested window.
    // saturating_add guards against (offset + limit) overflowing usize.
    let walk_limit = (offset as usize).saturating_add(limit as usize);
    let opts = WalkOptions {
        // Use date-order (= `git log --date-order`) so branches are interleaved
        // by committer date rather than descending a single first-parent chain.
        // This keeps concurrent active lanes low → compact graph, fewer diagonals.
        order: SortOrder::Date,
        limit: if walk_limit > 0 {
            Some(walk_limit)
        } else {
            None
        },
        ..Default::default()
    };

    let (commits, metas) = walk_commits(path, &opts)
        .map_err(|e| napi::Error::from_reason(format!("walk_commits: {e}")))?;

    // Compute layout for all walked commits (O(n·L) where L = concurrent branch count).
    let (rows, _boundary) = layout(&commits, None);

    // Slice rows and metas identically; silently clamp if offset is past the end.
    let start = (offset as usize).min(rows.len());
    let batch = &rows[start..];
    let batch_metas = &metas[start..];

    Ok(Buffer::from(encode_batch(batch, batch_metas)))
}

/// Full detail of a single commit, for the commit detail panel.
///
/// napi-rs maps the snake_case Rust fields to camelCase in TypeScript
/// (`author_name` → `authorName`, etc.).
#[napi(object)]
pub struct CommitDetail {
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: f64,
    pub committer_name: String,
    pub committer_email: String,
    pub commit_time: f64,
    pub message: String,
}

/// Fetch full detail for a single commit by OID hex string.
///
/// `oid_hex` is the full 40-character hex SHA-1.
/// Returns author/committer name, email, timestamps, and the full message.
/// The changed-file list is added in M3 Slice 2.
#[napi]
pub fn get_commit_detail(repo_path: String, oid_hex: String) -> napi::Result<CommitDetail> {
    use gix::bstr::ByteSlice;

    let path = std::path::Path::new(&repo_path);
    let repo = gix::open(path).map_err(|e| napi::Error::from_reason(format!("open repo: {e}")))?;

    let oid = gix::ObjectId::from_hex(oid_hex.trim().as_bytes())
        .map_err(|e| napi::Error::from_reason(format!("invalid OID '{oid_hex}': {e}")))?;

    let obj = repo
        .find_object(oid)
        .map_err(|e| napi::Error::from_reason(format!("find_object: {e}")))?;
    let commit = obj
        .try_into_commit()
        .map_err(|_| napi::Error::from_reason("object is not a commit".to_string()))?;
    let data = commit
        .decode()
        .map_err(|e| napi::Error::from_reason(format!("decode commit: {e}")))?;

    let author = data.author();
    let committer = data.committer();

    Ok(CommitDetail {
        oid: oid.to_hex().to_string(),
        parents: data.parents().map(|p| p.to_hex().to_string()).collect(),
        author_name: author.name.to_str_lossy().into_owned(),
        author_email: author.email.to_str_lossy().into_owned(),
        author_time: author.time.seconds as f64,
        committer_name: committer.name.to_str_lossy().into_owned(),
        committer_email: committer.email.to_str_lossy().into_owned(),
        commit_time: committer.time.seconds as f64,
        message: data.message.to_str_lossy().into_owned(),
    })
}
