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
/// A `Buffer` containing the binary-encoded batch (see `serialize.rs`).
///
/// # Status
///
/// **Stub** — returns an empty buffer until M0/M1 are implemented.
#[napi]
pub fn get_graph_batch(
    _repo_path: String,
    _offset: u32,
    _limit: u32,
) -> napi::Result<Vec<u8>> {
    // TODO(M1): call git_braid_core::walk_commits + layout + encode_batch
    Ok(Vec::new())
}
