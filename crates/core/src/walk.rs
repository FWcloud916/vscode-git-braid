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
//! - [`SortOrder::TopoDate`]: topological order, ties broken by committer date
//!   (matches `git log --topo-order`). Uses [`gix::traverse::commit::topo::Sorting::TopoOrder`].
//! - [`SortOrder::Date`]: topological order with pure committer-date priority
//!   (matches `git log --date-order`). Uses [`gix::traverse::commit::topo::Sorting::DateOrder`].
//!
//! Both modes guarantee the layout invariant: **every parent appears later in
//! the returned slice than its children**. This is the fundamental contract the
//! layout engine depends on, and why we use the dedicated topo traversal rather
//! than a plain breadth-first rev-walk (which would not guarantee it).

use std::collections::{HashMap, HashSet};

use gix::bstr::{BStr, ByteSlice};

use crate::model::{CommitIn, CommitMeta, Oid, RangeCommit, RefInfo, RefKind, RefLabel};

/// Which ordering policy to apply to the commit walk.
#[derive(Debug, Clone, Copy, Default)]
pub enum SortOrder {
    /// Topological order, ties broken by committer date — `git log --topo-order`.
    #[default]
    TopoDate,
    /// Topological order with committer-date priority — `git log --date-order`.
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
/// Tips: all refs (branches, tags, remotes) + HEAD are used as starting points,
/// deduped. This gives a full picture of the braided history across all branches.
///
/// `repo_path` should be the path to the `.git` directory or the worktree root
/// (gitoxide resolves both).
///
/// # Ordering contract
///
/// The returned slice guarantees: for any commit at index `i`, all of its
/// parents appear at some index `j > i`. This is the invariant required by
/// [`crate::layout::layout`].
///
/// # Returns
///
/// A tuple of `(commits, metas)` where `metas[i]` is the per-commit metadata
/// (subject / author / time / refs) for `commits[i]` — index-aligned.
/// `CommitIn` stays geometry-pure; all human-facing fields live in `CommitMeta`.
///
/// # Errors
///
/// Returns an error if the path is not a valid git repository or if ODB access
/// fails.
pub fn walk_commits(
    repo_path: &std::path::Path,
    opts: &WalkOptions,
) -> Result<(Vec<CommitIn>, Vec<CommitMeta>), Box<dyn std::error::Error>> {
    let repo = gix::open(repo_path)?;

    // ── Build OID → refs map and resolve HEAD ───────────────────────────────

    let mut ref_map: HashMap<Oid, smallvec::SmallVec<[RefLabel; 2]>> = HashMap::new();
    {
        let refs_platform = repo.references()?;
        for r in refs_platform.all()? {
            let mut r = match r {
                Ok(r) => r,
                Err(_) => continue,
            };
            let Some((kind, name)) = classify_ref(r.name().as_bstr()) else {
                continue;
            };
            let Ok(commit_id) = r.peel_to_commit() else {
                continue;
            };
            let oid = oid_to_fixed20(&commit_id.id);
            ref_map
                .entry(oid)
                .or_default()
                .push(RefLabel { name, kind });
        }
    }

    // Attach a synthetic "HEAD" label to whatever commit HEAD points at.
    // `head_id()` fails on an unborn HEAD (fresh repo) — skip gracefully.
    if let Ok(head_id) = repo.head_id() {
        let oid = oid_to_fixed20(&head_id.detach());
        ref_map.entry(oid).or_default().push(RefLabel {
            name: "HEAD".to_string(),
            kind: RefKind::Head,
        });
    }

    // ── Collect tips: all refs + HEAD, deduped ──────────────────────────────

    let mut seen: HashSet<gix::ObjectId> = HashSet::new();
    let mut tips: Vec<gix::ObjectId> = Vec::new();

    // HEAD first — covers detached HEAD and the current branch tip.
    // May fail on an unborn HEAD (fresh repo, no commits yet); skip gracefully.
    if let Ok(head_id) = repo.head_id() {
        let id = head_id.detach();
        if seen.insert(id) {
            tips.push(id);
        }
    }

    // Iterate all refs (branches, tags, remotes, etc.).
    // Skip broken refs; skip refs that don't peel to a commit (e.g. tree tags).
    {
        let refs_platform = repo.references()?;
        for r in refs_platform.all()? {
            let mut r = match r {
                Ok(r) => r,
                Err(_) => continue,
            };
            let commit_id = match r.peel_to_commit() {
                Ok(c) => c.id,
                Err(_) => continue,
            };
            if seen.insert(commit_id) {
                tips.push(commit_id);
            }
        }
    }

    if tips.is_empty() {
        // Empty repo or no commits reachable from any ref.
        return Ok((Vec::new(), Vec::new()));
    }

    // ── Map SortOrder → topo Sorting ────────────────────────────────────────

    let sorting = match opts.order {
        SortOrder::TopoDate => gix::traverse::commit::topo::Sorting::TopoOrder,
        SortOrder::Date => gix::traverse::commit::topo::Sorting::DateOrder,
    };

    // ── Build and run topological traversal ─────────────────────────────────
    //
    // `Builder::new` borrows `repo.objects` for the lifetime of the walk;
    // both are in this stack frame so lifetimes work out.

    let mut builder = gix::traverse::commit::topo::Builder::new(&repo.objects)
        .with_tips(tips)
        .sorting(sorting);

    if opts.first_parent_only {
        builder = builder.parents(gix::traverse::commit::Parents::First);
    }

    let walk = builder.build()?;

    // ── Collect with optional limit ─────────────────────────────────────────
    //
    // The walk borrows `repo.objects`; keep the gix OIDs in a parallel Vec so we
    // can re-fetch each object for metadata *after* the walk is dropped (the
    // metadata pass below needs `&repo`, which conflicts with the walk borrow).

    let limit = opts.limit.unwrap_or(usize::MAX);
    let mut gix_oids: Vec<gix::ObjectId> = Vec::new();
    let mut commit_ins: Vec<CommitIn> = Vec::new();

    for item in walk {
        let info = item?;
        gix_oids.push(info.id);
        commit_ins.push(CommitIn {
            oid: oid_to_fixed20(&info.id),
            parents: info.parent_ids.iter().map(oid_to_fixed20).collect(),
        });
        if commit_ins.len() >= limit {
            break;
        }
    }
    // `walk` dropped here — the `repo.objects` borrow is released.

    // ── Metadata second pass ────────────────────────────────────────────────

    let mut metas: Vec<CommitMeta> = Vec::with_capacity(commit_ins.len());
    for (i, gix_oid) in gix_oids.iter().enumerate() {
        let obj = repo.find_object(*gix_oid)?;
        let commit = obj.try_into_commit()?;
        let data = commit.decode()?;

        let author = data.author().name.to_str_lossy().into_owned();
        let commit_time = data.committer().time.seconds;
        let subject = data
            .message
            .split(|&b| b == b'\n')
            .next()
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .unwrap_or_default();

        let oid = commit_ins[i].oid;
        let refs = ref_map.get(&oid).cloned().unwrap_or_default();

        metas.push(CommitMeta {
            oid,
            subject,
            author,
            commit_time,
            refs,
        });
    }

    Ok((commit_ins, metas))
}

// ── Find ─────────────────────────────────────────────────────────────────────

/// A single search hit returned by [`find_commits`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FindMatch {
    /// The 20-byte OID of the matching commit.
    pub oid: Oid,
    /// Zero-based index of this commit in the date-order walk.
    ///
    /// **Stability contract:** this index equals the row index that
    /// [`walk_commits`] assigns when called with the same [`WalkOptions`].
    /// Callers that need the index to align with a paged graph **must** call
    /// [`find_commits`] with `opts.order = `[`SortOrder::Date`]` and
    /// `opts.limit = None` — the same options that `get_graph_batch` uses.
    pub row_index: u32,
    /// First line of the commit message (subject).
    pub subject: String,
    /// Author display name.
    pub author: String,
    /// Committer time as Unix epoch seconds.
    pub commit_time: i64,
}

/// Case-insensitive substring search over every commit's subject, author name,
/// and OID hex prefix.
///
/// # Stability contract
///
/// `opts` **must** match the options used by `get_graph_batch`
/// (`order: Date`, `limit: None`) for the returned `row_index` values to
/// align with the paged graph. Changing either option breaks the alignment.
///
/// # Cost
///
/// This performs a full-history walk (one `walk_commits` pass with `limit: None`),
/// decoding every commit's subject and author. For typical repos (< 100k commits)
/// this is fast enough for a user-initiated query; a future slice can cache the
/// walk result to avoid the re-decode.
///
/// # Returns
///
/// Matches in ascending `row_index` order, capped at `max_results`.
/// Returns an empty `Vec` for a blank or whitespace-only query.
pub fn find_commits(
    repo_path: &std::path::Path,
    query: &str,
    opts: &WalkOptions,
    max_results: usize,
) -> Result<Vec<FindMatch>, Box<dyn std::error::Error>> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let (_commits, metas) = walk_commits(repo_path, opts)?;

    let mut results: Vec<FindMatch> = Vec::new();
    for (i, m) in metas.iter().enumerate() {
        if results.len() >= max_results {
            break;
        }

        let hit = m.subject.to_lowercase().contains(&q)
            || m.author.to_lowercase().contains(&q)
            || oid_to_hex(&m.oid).starts_with(&q);

        if hit {
            results.push(FindMatch {
                oid: m.oid,
                row_index: i as u32,
                subject: m.subject.clone(),
                author: m.author.clone(),
                commit_time: m.commit_time,
            });
        }
    }

    Ok(results)
}

// ── List refs (release-notes range picker) ────────────────────────────────────

/// List all local branches and tags, sorted branches-first then alphabetically.
///
/// Stash, remote branches, and HEAD are excluded — the picker shows only the
/// refs a user would naturally specify as `from`/`to` range boundaries.
///
/// This is a **read-path** operation — gitoxide only; no `git` subprocess.
pub fn list_refs(repo_path: &std::path::Path) -> Result<Vec<RefInfo>, Box<dyn std::error::Error>> {
    let repo = gix::open(repo_path)?;
    let mut result: Vec<RefInfo> = Vec::new();

    let refs_platform = repo.references()?;
    for r in refs_platform.all()? {
        let mut r = match r {
            Ok(r) => r,
            Err(_) => continue,
        };
        let Some((kind, name)) = classify_ref(r.name().as_bstr()) else {
            continue;
        };
        // Only expose local branches and tags to the picker.
        if !matches!(kind, RefKind::LocalBranch | RefKind::Tag) {
            continue;
        }
        let Ok(commit_id) = r.peel_to_commit() else {
            continue;
        };
        let oid = oid_to_fixed20(&commit_id.id);
        result.push(RefInfo { name, kind, oid });
    }

    // Sort: local branches before tags, alphabetically within each group.
    result.sort_by(|a, b| {
        let ka: u8 = match a.kind {
            RefKind::LocalBranch => 0,
            RefKind::Tag => 1,
            _ => 2,
        };
        let kb: u8 = match b.kind {
            RefKind::LocalBranch => 0,
            RefKind::Tag => 1,
            _ => 2,
        };
        ka.cmp(&kb).then_with(|| a.name.cmp(&b.name))
    });

    Ok(result)
}

// ── Range walk (release-notes commit list) ────────────────────────────────────

/// Walk commits reachable from `to_rev` but **not** from `from_rev`
/// (`from_rev..to_rev` in git notation), newest first.
///
/// `from_rev` — any ref name, full OID, or rev-spec accepted by
/// `gix::Repository::rev_parse_single`. Pass `None` for full ancestry of
/// `to_rev`.
/// `to_rev` — same format; typically `"HEAD"` or a tag name.
///
/// When `include_diff_stat` is `true` each commit carries an **approximation**
/// of the files changed, lines added, and lines removed vs its first parent.
/// The counts are derived from newline-counting of blob content (fast,
/// deterministic), not a full Myers/Histogram line-diff. This is precise enough
/// for a release-notes prompt and avoids fetching the full diff algorithm API
/// surface. When `false` those three fields are 0.
///
/// **Read-path only** — gitoxide; no `git` subprocess.
pub fn walk_range(
    repo_path: &std::path::Path,
    from_rev: Option<&str>,
    to_rev: &str,
    include_diff_stat: bool,
) -> Result<Vec<RangeCommit>, Box<dyn std::error::Error>> {
    let repo = gix::open(repo_path)?;

    // Resolve `to_rev` → OID.
    let to_oid = repo.rev_parse_single(to_rev.trim())?.object()?.id;

    // Resolve `from_rev` → OID, if provided.
    let from_oid: Option<gix::ObjectId> = match from_rev {
        Some(rev) => Some(repo.rev_parse_single(rev.trim())?.object()?.id),
        None => None,
    };

    // Build topological walk using the `revision` feature's topo builder.
    // `with_ends` implements the `from..to` exclusion (verified: gix 0.70
    // docs.rs `topo::Builder::with_ends`).
    let mut builder = gix::traverse::commit::topo::Builder::new(&repo.objects)
        .with_tips([to_oid])
        .sorting(gix::traverse::commit::topo::Sorting::DateOrder);
    if let Some(f) = from_oid {
        builder = builder.with_ends([f]);
    }

    let walk = builder.build()?;

    // First pass: collect OIDs (walk borrows repo.objects; drop walk before
    // the metadata pass so we can call repo.find_object again).
    let mut gix_oids: Vec<gix::ObjectId> = Vec::new();
    for item in walk {
        gix_oids.push(item?.id);
    }
    // Walk is dropped here — repo.objects borrow released.

    // Post-filter: gix `with_ends` excludes ancestors of the end commit but
    // not the end commit itself when it happens to be the tip as well (edge
    // case: from == to). Matching git's `^A B` semantics, `from` must never
    // appear in the output regardless of how the traversal landed.
    if let Some(f) = from_oid {
        gix_oids.retain(|oid| *oid != f);
    }

    // Second pass: metadata + optional diffstat.
    let mut result: Vec<RangeCommit> = Vec::with_capacity(gix_oids.len());
    for gix_oid in &gix_oids {
        let obj = repo.find_object(*gix_oid)?;
        let commit = obj.try_into_commit()?;
        let data = commit.decode()?;

        let subject = data
            .message
            .split(|&b| b == b'\n')
            .next()
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .unwrap_or_default();
        let author_name = data.author().name.to_str_lossy().into_owned();
        let commit_time = data.committer().time.seconds;
        // Copy parent OID before dropping `data` (ObjectId is Copy).
        let parent_oid: Option<gix::ObjectId> = data.parents().next();
        drop(data); // release borrow on `commit`

        let (files_changed, insertions, deletions) = if include_diff_stat {
            // Tree-diff vs first parent (or empty tree for root commits).
            let commit_tree = commit.tree()?;
            let (mut fc, mut ins, mut del) = (0u32, 0u32, 0u32);
            if let Some(p_oid) = parent_oid {
                let parent_obj = repo.find_object(p_oid)?;
                let parent_commit = parent_obj.try_into_commit()?;
                let parent_tree = parent_commit.tree()?;
                diffstat_trees(
                    &parent_tree,
                    &commit_tree,
                    &repo,
                    &mut fc,
                    &mut ins,
                    &mut del,
                )?;
            } else {
                let empty = repo.empty_tree();
                diffstat_trees(&empty, &commit_tree, &repo, &mut fc, &mut ins, &mut del)?;
            }
            (fc, ins, del)
        } else {
            (0, 0, 0)
        };

        result.push(RangeCommit {
            oid: oid_to_fixed20(gix_oid),
            subject,
            author_name,
            commit_time,
            files_changed,
            insertions,
            deletions,
        });
    }

    Ok(result)
}

/// Tree-diff two trees and accumulate diffstat into the provided counters.
///
/// Insertions and deletions are approximated by counting newlines in the new
/// and old blob data respectively. For added files, the new blob's line count
/// becomes insertions; for deleted files, the old blob's becomes deletions;
/// for modified files, both sides are counted (so a 1-line change in a
/// 500-line file reports ~500 ins + ~500 del — an over-count, but sufficient
/// for a release-notes prompt).
fn diffstat_trees(
    lhs: &gix::Tree<'_>,
    rhs: &gix::Tree<'_>,
    repo: &gix::Repository,
    files_changed: &mut u32,
    insertions: &mut u32,
    deletions: &mut u32,
) -> Result<(), Box<dyn std::error::Error>> {
    use gix::object::tree::diff::{Action, Change};

    // Collect OID pairs first; avoid blob fetches inside the closure to dodge
    // any potential borrow conflicts with the tree-diff iterator.
    struct Entry {
        old_oid: Option<gix::ObjectId>,
        new_oid: Option<gix::ObjectId>,
    }
    let mut entries: Vec<Entry> = Vec::new();

    lhs.changes()?
        .options(|o: &mut gix::diff::Options| {
            o.track_rewrites(None);
        })
        .for_each_to_obtain_tree(rhs, |change| {
            let entry = match &change {
                Change::Addition { id, .. } => Entry {
                    old_oid: None,
                    new_oid: Some(id.detach()),
                },
                Change::Deletion { id, .. } => Entry {
                    old_oid: Some(id.detach()),
                    new_oid: None,
                },
                Change::Modification {
                    previous_id, id, ..
                } => Entry {
                    old_oid: Some(previous_id.detach()),
                    new_oid: Some(id.detach()),
                },
                // Rewrites are disabled; this arm is unreachable in practice.
                Change::Rewrite { .. } => {
                    return Ok::<_, std::convert::Infallible>(Action::Continue)
                }
            };
            entries.push(entry);
            Ok::<_, std::convert::Infallible>(Action::Continue)
        })?;

    *files_changed = entries.len() as u32;

    // Fetch blobs and count lines (tree-diff borrow released above).
    for entry in &entries {
        if let Some(oid) = entry.new_oid {
            if let Ok(obj) = repo.find_object(oid) {
                *insertions += count_lines(&obj.data);
            }
        }
        if let Some(oid) = entry.old_oid {
            if let Ok(obj) = repo.find_object(oid) {
                *deletions += count_lines(&obj.data);
            }
        }
    }

    Ok(())
}

/// Count lines in a byte slice by counting `\n` characters.
/// A non-empty slice with no trailing newline counts as at least 1 line.
fn count_lines(data: &[u8]) -> u32 {
    if data.is_empty() {
        return 0;
    }
    data.iter().filter(|&&b| b == b'\n').count() as u32 + 1
}

// ── Repository discovery ─────────────────────────────────────────────────────

/// Resolve `path` (a worktree, `.git` directory, or **any subdirectory** of a
/// worktree) to the repository's canonical worktree root.
///
/// Returns `None` if `path` is not inside a git repository.
/// For bare repositories, the `.git` directory path is returned instead of a
/// worktree root (bare repos have no worktree).
///
/// This is a **read-path** operation — gitoxide's upward directory walk is
/// used; no `git` subprocess is spawned.
pub fn discover_repo(path: &std::path::Path) -> Option<std::path::PathBuf> {
    let repo = gix::discover(path).ok()?;
    // `work_dir()` is `None` for bare repos — fall back to the git directory.
    Some(
        repo.work_dir()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| repo.git_dir().to_path_buf()),
    )
}

/// Classify a full ref name (e.g. `refs/heads/main`) into its [`RefKind`] and
/// display name. Returns `None` for non-UTF-8 ref names (skipped).
fn classify_ref(full_name: &BStr) -> Option<(RefKind, String)> {
    let s = full_name.to_str().ok()?;
    if s == "refs/stash" {
        Some((RefKind::Stash, "stash".to_string()))
    } else if let Some(n) = s.strip_prefix("refs/heads/") {
        Some((RefKind::LocalBranch, n.to_string()))
    } else if let Some(n) = s.strip_prefix("refs/remotes/") {
        Some((RefKind::RemoteBranch, n.to_string()))
    } else if let Some(n) = s.strip_prefix("refs/tags/") {
        Some((RefKind::Tag, n.to_string()))
    } else {
        Some((RefKind::LocalBranch, s.to_string()))
    }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/// Convert a fixed-20 `Oid` to a lowercase hex string.
fn oid_to_hex(oid: &Oid) -> String {
    oid.iter().fold(String::with_capacity(40), |mut s, b| {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// Convert a gix `ObjectId` (20-byte SHA-1 or 32-byte SHA-256) to our
/// fixed-size `Oid = [u8; 20]`.
///
/// For SHA-256 repos only the first 20 bytes are used as the layout key;
/// the full OID is stored separately in the OID table (MVP trade-off,
/// see `model.rs`).
#[inline]
fn oid_to_fixed20(id: &gix::ObjectId) -> Oid {
    let bytes = id.as_bytes();
    let mut out = [0u8; 20];
    let n = bytes.len().min(20);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}
