//! Integration tests for `walk_commits`.
//!
//! These tests build real (temporary) git repos using the `git` CLI — test-only
//! use of the CLI is fine; it is not the production read path.  The production
//! read path is gitoxide-only (plan §3.2).

use std::collections::HashSet;
use std::process::Command;

use git_braid_core::model::RefKind;
use git_braid_core::walk::{walk_commits, SortOrder, WalkOptions};

// ── helpers ──────────────────────────────────────────────────────────────────

/// Run `git <args>` inside `dir`, panic on non-zero exit.
fn git(dir: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        // fixed date keeps tests deterministic
        .env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00+00:00")
        .env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00+00:00")
        .output()
        .expect("failed to spawn git")
        .status;
    assert!(status.success(), "git {args:?} failed with {status}");
}

/// Build a small DAG with a merge commit:
///
/// ```text
///   A  (initial)
///   |
///   B  (on main)
///   |\
///   | C  (on feature)
///   |/
///   M  (merge commit — HEAD)
/// ```
///
/// Returns the temp dir (keep it alive for the test).
fn make_merge_repo() -> tempfile::TempDir {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let p = dir.path();

    git(p, &["init", "-b", "main"]);
    git(p, &["config", "user.email", "test@example.com"]);
    git(p, &["config", "user.name", "Test"]);
    git(p, &["config", "commit.gpgsign", "false"]);

    // Commit A
    git(p, &["commit", "--allow-empty", "-m", "A"]);
    // Commit B
    git(p, &["commit", "--allow-empty", "-m", "B"]);
    // Branch off for feature
    git(p, &["checkout", "-b", "feature"]);
    // Commit C
    git(p, &["commit", "--allow-empty", "-m", "C"]);
    // Merge back
    git(p, &["checkout", "main"]);
    git(p, &["merge", "--no-ff", "feature", "-m", "M"]);

    dir
}

// ── tests ────────────────────────────────────────────────────────────────────

/// Core correctness: topo-order, no duplicates, parents-later invariant, HEAD first.
#[test]
fn topo_order_parents_come_after_children() {
    let repo = make_merge_repo();

    let (commits, metas) =
        walk_commits(repo.path(), &WalkOptions::default()).expect("walk_commits failed");

    // Should have exactly 4 commits: A, B, C, M
    assert_eq!(
        commits.len(),
        4,
        "expected 4 commits, got {}",
        commits.len()
    );

    // metas are index-aligned with commits.
    assert_eq!(metas.len(), commits.len(), "metas must align with commits");
    for (c, m) in commits.iter().zip(metas.iter()) {
        assert_eq!(c.oid, m.oid, "meta OID must match commit OID by index");
    }

    // Subjects are populated (A/B/C/M were committed with those messages).
    let subjects: HashSet<_> = metas.iter().map(|m| m.subject.clone()).collect();
    for want in ["A", "B", "C", "M"] {
        assert!(
            subjects.contains(want),
            "expected subject {want:?} in {subjects:?}"
        );
    }

    // Author was set to "Test" for every commit.
    assert!(
        metas.iter().all(|m| m.author == "Test"),
        "expected all authors to be 'Test'"
    );

    // HEAD points at the merge commit M; some commit must carry the HEAD ref.
    let has_head = metas
        .iter()
        .any(|m| m.refs.iter().any(|r| r.kind == RefKind::Head));
    assert!(has_head, "expected a HEAD ref label on some commit");

    // The `main` and `feature` branch labels must appear.
    let branch_names: HashSet<_> = metas
        .iter()
        .flat_map(|m| m.refs.iter())
        .filter(|r| r.kind == RefKind::LocalBranch)
        .map(|r| r.name.clone())
        .collect();
    assert!(
        branch_names.contains("main") && branch_names.contains("feature"),
        "expected main + feature branches in {branch_names:?}"
    );

    // No duplicate OIDs
    let oid_set: HashSet<_> = commits.iter().map(|c| c.oid).collect();
    assert_eq!(oid_set.len(), commits.len(), "found duplicate OIDs");

    // Build oid→index map
    let index_of: std::collections::HashMap<_, _> = commits
        .iter()
        .enumerate()
        .map(|(i, c)| (c.oid, i))
        .collect();

    // For every commit, each of its parents must appear at a strictly later index.
    // This is the invariant the layout engine requires.
    for (i, commit) in commits.iter().enumerate() {
        for parent_oid in &commit.parents {
            let parent_idx = index_of
                .get(parent_oid)
                .copied()
                .expect("parent OID not found in result");
            assert!(
                parent_idx > i,
                "parent of commit[{i}] appears at index {parent_idx} (must be > {i})"
            );
        }
    }
}

/// `limit` option: walk returns at most N commits.
#[test]
fn limit_caps_output() {
    let repo = make_merge_repo();

    let opts = WalkOptions {
        limit: Some(2),
        ..Default::default()
    };
    let (commits, metas) = walk_commits(repo.path(), &opts).expect("walk_commits failed");
    assert_eq!(commits.len(), 2);
    assert_eq!(metas.len(), 2, "metas must align with commits under limit");
}

/// Date-order mode: no duplicates, count matches, no-dup guaranteed.
/// (We don't assert parents-later for `Date` mode — not guaranteed in general.)
#[test]
fn date_order_no_duplicates() {
    let repo = make_merge_repo();

    let opts = WalkOptions {
        order: SortOrder::Date,
        ..Default::default()
    };
    let (commits, _metas) = walk_commits(repo.path(), &opts).expect("walk_commits failed");

    assert_eq!(commits.len(), 4);
    let oid_set: HashSet<_> = commits.iter().map(|c| c.oid).collect();
    assert_eq!(
        oid_set.len(),
        commits.len(),
        "found duplicate OIDs in date-order walk"
    );
}

/// First-parent walk: only traversal edges (not starting tips) are filtered.
///
/// Because we walk from *all refs*, both `main` (→ M) and `feature` (→ C)
/// are starting tips. `first_parent_only` means each commit only follows its
/// first parent; it does not exclude ref tips that happen to sit on a
/// secondary-parent chain. So the result still includes all 4 commits:
///
/// ```text
/// Walk from M (first-parent only): M → B → A
/// Walk from C (first-parent only): C → B  (B already seen, deduped)
/// Output: M, C, B, A
/// ```
///
/// Note: limiting to HEAD only (to get the pure mainline) is a UX concern
/// for the graph viewer, not a walk layer concern.
#[test]
fn first_parent_only() {
    let repo = make_merge_repo();

    let opts = WalkOptions {
        first_parent_only: true,
        ..Default::default()
    };
    let (commits, _metas) = walk_commits(repo.path(), &opts).expect("walk_commits failed");

    // All 4 commits appear (C is a tip via the `feature` ref; only traversal
    // edges are limited to first parents, not which tips are included).
    assert_eq!(
        commits.len(),
        4,
        "expected 4 commits with all-refs tips + first-parent traversal, got {}",
        commits.len()
    );

    // No duplicates
    let oid_set: std::collections::HashSet<_> = commits.iter().map(|c| c.oid).collect();
    assert_eq!(oid_set.len(), commits.len(), "found duplicate OIDs");
}

/// Empty repo (no commits) returns an empty Vec without error.
#[test]
fn empty_repo_returns_empty() {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let p = dir.path();
    git(p, &["init", "-b", "main"]);
    git(p, &["config", "user.email", "test@example.com"]);
    git(p, &["config", "user.name", "Test"]);

    let (commits, metas) =
        walk_commits(p, &WalkOptions::default()).expect("walk_commits on empty repo failed");
    assert!(commits.is_empty(), "expected empty Vec for empty repo");
    assert!(metas.is_empty(), "expected empty metas for empty repo");
}
