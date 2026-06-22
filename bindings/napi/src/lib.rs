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
    walk::{
        discover_repo as core_discover_repo, find_commits as core_find_commits,
        list_refs as core_list_refs, walk_commits, walk_range as core_walk_range, SortOrder,
        WalkOptions,
    },
};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// Resolve `path` to its git repository's worktree root.
///
/// Walks parent directories upward (via gitoxide's discovery logic) until a
/// `.git` directory is found. Returns the canonical worktree root as a string,
/// or `null` if `path` is not inside a git repository.
///
/// This is a **read-path** helper — gitoxide is used, no `git` subprocess is
/// spawned.
#[napi]
pub fn discover_repo(path: String) -> Option<String> {
    core_discover_repo(std::path::Path::new(&path)).map(|p| p.to_string_lossy().into_owned())
}

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

/// A single file-level change introduced by a commit (vs its first parent).
///
/// `status` is `"A"` (added), `"M"` (modified), or `"D"` (deleted).
/// `old_oid` / `new_oid` are full 40-char hex blob OIDs; the missing side of an
/// add/delete is an empty string `""`.  Rename detection is disabled; renames
/// appear as a deletion + an addition.
///
/// napi-rs maps snake_case → camelCase in TypeScript.
#[napi(object)]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub old_oid: String,
    pub new_oid: String,
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
    /// Files changed by this commit relative to its first parent (tree-diff,
    /// rename detection OFF). Sorted by path for determinism.
    pub files: Vec<FileChange>,
}

/// Populate `files` by diffing `lhs_tree` → `rhs_tree`.
/// Rename detection is disabled — faster and safe for blobless clones.
fn collect_diff_files(
    lhs_tree: &gix::Tree<'_>,
    rhs_tree: &gix::Tree<'_>,
    files: &mut Vec<FileChange>,
) -> napi::Result<()> {
    use gix::bstr::ByteSlice;
    use gix::object::tree::diff::{Action, Change};

    lhs_tree
        .changes()
        .map_err(|e| napi::Error::from_reason(format!("tree changes: {e}")))?
        .options(|o: &mut gix::diff::Options| {
            o.track_rewrites(None);
        })
        .for_each_to_obtain_tree(rhs_tree, |change| {
            let fc = match change {
                Change::Addition { location, id, .. } => FileChange {
                    path: location.to_str_lossy().into_owned(),
                    status: "A".to_string(),
                    old_oid: String::new(),
                    new_oid: id.detach().to_hex().to_string(),
                },
                Change::Deletion { location, id, .. } => FileChange {
                    path: location.to_str_lossy().into_owned(),
                    status: "D".to_string(),
                    old_oid: id.detach().to_hex().to_string(),
                    new_oid: String::new(),
                },
                Change::Modification {
                    location,
                    previous_id,
                    id,
                    ..
                } => FileChange {
                    path: location.to_str_lossy().into_owned(),
                    status: "M".to_string(),
                    old_oid: previous_id.detach().to_hex().to_string(),
                    new_oid: id.detach().to_hex().to_string(),
                },
                // Rewrites are disabled — this arm is unreachable in practice.
                Change::Rewrite { .. } => {
                    return Ok::<_, std::convert::Infallible>(Action::Continue)
                }
            };
            files.push(fc);
            Ok::<_, std::convert::Infallible>(Action::Continue)
        })
        .map_err(|e| napi::Error::from_reason(format!("tree diff: {e}")))?;
    Ok(())
}

/// Fetch full detail for a single commit by OID hex string.
///
/// `oid_hex` is the full 40-character hex SHA-1.
/// Returns author/committer name, email, timestamps, full message, and the
/// list of files changed vs the first parent (tree-diff; rename detection off).
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

    // Collect metadata as owned values before the tree-diff borrows.
    let detail_oid = oid.to_hex().to_string();
    let detail_parents: Vec<String> = data.parents().map(|p| p.to_hex().to_string()).collect();
    let detail_author_name = author.name.to_str_lossy().into_owned();
    let detail_author_email = author.email.to_str_lossy().into_owned();
    let detail_author_time = author.time.seconds as f64;
    let detail_committer_name = committer.name.to_str_lossy().into_owned();
    let detail_committer_email = committer.email.to_str_lossy().into_owned();
    let detail_commit_time = committer.time.seconds as f64;
    let detail_message = data.message.to_str_lossy().into_owned();

    // Collect the first parent OID while `data` is still alive (ObjectId is Copy).
    let parent_oid: Option<gix::ObjectId> = data.parents().next();
    drop(data);

    // ── Tree-diff vs first parent (or empty tree for root commits) ────────────
    // diff direction: parent → commit  ≡  "what this commit introduced"
    let commit_tree = commit
        .tree()
        .map_err(|e| napi::Error::from_reason(format!("commit tree: {e}")))?;

    let mut files: Vec<FileChange> = Vec::new();

    if let Some(p_oid) = parent_oid {
        let parent_obj = repo
            .find_object(p_oid)
            .map_err(|e| napi::Error::from_reason(format!("parent find: {e}")))?;
        let parent_commit = parent_obj
            .try_into_commit()
            .map_err(|_| napi::Error::from_reason("parent is not a commit".to_string()))?;
        let parent_tree = parent_commit
            .tree()
            .map_err(|e| napi::Error::from_reason(format!("parent tree: {e}")))?;
        collect_diff_files(&parent_tree, &commit_tree, &mut files)?;
    } else {
        // Root commit: diff empty tree → commit tree → every file is an addition.
        let empty = repo.empty_tree();
        collect_diff_files(&empty, &commit_tree, &mut files)?;
    }

    // Sort by path for determinism.
    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(CommitDetail {
        oid: detail_oid,
        parents: detail_parents,
        author_name: detail_author_name,
        author_email: detail_author_email,
        author_time: detail_author_time,
        committer_name: detail_committer_name,
        committer_email: detail_committer_email,
        commit_time: detail_commit_time,
        message: detail_message,
        files,
    })
}

/// Read the raw bytes of a git blob by OID hex string.
///
/// Returns the blob's raw bytes as a `Buffer`.
/// If `oid_hex` is an empty string, returns an empty `Buffer` — this is the
/// convention for the "missing side" of an addition or deletion in the diff
/// view (so the `gitbraid:` content provider can serve an empty document).
///
/// The read path is gitoxide-only — no `git` subprocess is spawned.
#[napi]
pub fn get_blob(repo_path: String, oid_hex: String) -> napi::Result<Buffer> {
    if oid_hex.is_empty() {
        return Ok(Buffer::from(Vec::<u8>::new()));
    }

    let path = std::path::Path::new(&repo_path);
    let repo = gix::open(path).map_err(|e| napi::Error::from_reason(format!("open repo: {e}")))?;

    let oid = gix::ObjectId::from_hex(oid_hex.trim().as_bytes())
        .map_err(|e| napi::Error::from_reason(format!("invalid OID '{oid_hex}': {e}")))?;

    let obj = repo
        .find_object(oid)
        .map_err(|e| napi::Error::from_reason(format!("find_object: {e}")))?;

    Ok(Buffer::from(obj.detach().data))
}

/// A single search hit from [`find_commits`].
///
/// napi-rs maps snake_case → camelCase in TypeScript (`row_index` → `rowIndex`,
/// `commit_time` → `commitTime`).
#[napi(object)]
pub struct FindMatch {
    /// Full 40-char lowercase hex OID of the matching commit.
    pub oid: String,
    /// Zero-based row index in the date-order walk — aligns with the paged graph.
    pub row_index: u32,
    /// First line of the commit message (subject).
    pub subject: String,
    /// Author display name.
    pub author: String,
    /// Committer time as Unix epoch seconds.
    pub commit_time: f64,
}

/// Search the full commit history for commits whose subject, author name, or OID
/// hex prefix matches `query` (case-insensitive substring / prefix).
///
/// `max_results` caps the number of hits returned (pass 0 for a built-in cap of
/// 1 000). Returns matches in ascending row-index order.
///
/// **Row-index contract:** the returned `row_index` values align with the rows
/// produced by `get_graph_batch` **only** when both use the same walk order
/// (`SortOrder::Date`, no limit). Changing the paging walk options breaks alignment.
///
/// The read path is gitoxide-only — no `git` subprocess is spawned.
#[napi]
pub fn find_commits(
    repo_path: String,
    query: String,
    max_results: u32,
) -> napi::Result<Vec<FindMatch>> {
    let path = std::path::Path::new(&repo_path);

    // MUST match the WalkOptions used in get_graph_batch (lines 61-72).
    let opts = WalkOptions {
        order: SortOrder::Date,
        limit: None,
        first_parent_only: false,
    };

    let cap = if max_results == 0 {
        1_000
    } else {
        max_results as usize
    };

    let core_matches = core_find_commits(path, &query, &opts, cap)
        .map_err(|e| napi::Error::from_reason(format!("find_commits: {e}")))?;

    Ok(core_matches
        .into_iter()
        .map(|m| FindMatch {
            oid: m.oid.iter().fold(String::with_capacity(40), |mut s, b| {
                use std::fmt::Write as _;
                let _ = write!(s, "{b:02x}");
                s
            }),
            row_index: m.row_index,
            subject: m.subject,
            author: m.author,
            commit_time: m.commit_time as f64,
        })
        .collect())
}

// ── Release-notes: ref listing ────────────────────────────────────────────────

/// A single ref (branch or tag) for the release-notes range picker.
///
/// `kind` is [`git_braid_core::model::RefKind`] as its `u8` discriminant:
/// `0` = LocalBranch, `2` = Tag.
///
/// napi-rs maps snake_case → camelCase: `kind` stays `kind`, `oid` stays `oid`.
#[napi(object)]
pub struct RefInfo {
    /// Display name (e.g. `"main"`, `"v1.0.0"`).
    pub name: String,
    /// `RefKind` discriminant: 0=LocalBranch, 2=Tag.
    pub kind: u8,
    /// Full 40-char lowercase hex OID of the commit this ref points at.
    pub oid: String,
}

/// List all local branches and tags in `repo_path`, sorted branches-first
/// then alphabetically.
///
/// Stash, remote branches, and HEAD are excluded — the picker shows only refs
/// a user would naturally specify as range boundaries.
///
/// The read path is gitoxide-only — no `git` subprocess is spawned.
#[napi]
pub fn list_refs(repo_path: String) -> napi::Result<Vec<RefInfo>> {
    let path = std::path::Path::new(&repo_path);

    let core_refs =
        core_list_refs(path).map_err(|e| napi::Error::from_reason(format!("list_refs: {e}")))?;

    Ok(core_refs
        .into_iter()
        .map(|r| RefInfo {
            name: r.name,
            kind: r.kind as u8,
            oid: r.oid.iter().fold(String::with_capacity(40), |mut s, b| {
                use std::fmt::Write as _;
                let _ = write!(s, "{b:02x}");
                s
            }),
        })
        .collect())
}

// ── Release-notes: range walk ─────────────────────────────────────────────────

/// One commit in a `from..to` range walk, for release-notes generation.
///
/// When `includeDiffStat` was `false` on the originating `walkRange` call,
/// `filesChanged`, `insertions`, and `deletions` are all `0`.
///
/// napi-rs maps snake_case → camelCase: `author_name` → `authorName`,
/// `commit_time` → `commitTime`, `files_changed` → `filesChanged`.
#[napi(object)]
pub struct RangeCommit {
    /// Full 40-char lowercase hex OID.
    pub oid: String,
    /// First line of the commit message.
    pub subject: String,
    /// Author display name.
    pub author_name: String,
    /// Committer time as Unix epoch seconds.
    pub commit_time: f64,
    /// Files changed vs first parent. 0 when diffstat is disabled.
    pub files_changed: u32,
    /// Lines added vs first parent (approximation). 0 when diffstat is disabled.
    pub insertions: u32,
    /// Lines removed vs first parent (approximation). 0 when diffstat is disabled.
    pub deletions: u32,
}

/// Walk commits in `from_rev..to_rev` (newest first).
///
/// `from_rev` — ref name, OID hex, or rev-spec; pass `null` / `undefined` for
/// the full ancestry of `to_rev`. `to_rev` — same format, e.g. `"HEAD"`.
/// `include_diff_stat` — when `true` each commit's `filesChanged`,
/// `insertions`, and `deletions` are populated (approximate newline counts).
///
/// The read path is gitoxide-only — no `git` subprocess is spawned.
#[napi]
pub fn walk_range(
    repo_path: String,
    from_rev: Option<String>,
    to_rev: String,
    include_diff_stat: bool,
) -> napi::Result<Vec<RangeCommit>> {
    let path = std::path::Path::new(&repo_path);

    let core_commits = core_walk_range(path, from_rev.as_deref(), &to_rev, include_diff_stat)
        .map_err(|e| napi::Error::from_reason(format!("walk_range: {e}")))?;

    Ok(core_commits
        .into_iter()
        .map(|c| RangeCommit {
            oid: c.oid.iter().fold(String::with_capacity(40), |mut s, b| {
                use std::fmt::Write as _;
                let _ = write!(s, "{b:02x}");
                s
            }),
            subject: c.subject,
            author_name: c.author_name,
            commit_time: c.commit_time as f64,
            files_changed: c.files_changed,
            insertions: c.insertions,
            deletions: c.deletions,
        })
        .collect())
}
