//! Integration tests for `find_commits`.
//!
//! These tests build real (temporary) git repos using the `git` CLI — test-only
//! use of the CLI is fine; it is not the production read path.  The production
//! read path is gitoxide-only (plan §3.2).

use std::process::Command;

use git_braid_core::walk::{find_commits, walk_commits, SortOrder, WalkOptions};

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Run `git <args>` inside `dir` with optional per-invocation author overrides.
fn git_env(dir: &std::path::Path, args: &[&str], author_name: &str, author_email: &str) {
    let status = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", author_name)
        .env("GIT_AUTHOR_EMAIL", author_email)
        .env("GIT_COMMITTER_NAME", author_name)
        .env("GIT_COMMITTER_EMAIL", author_email)
        .env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00+00:00")
        .env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00+00:00")
        .output()
        .expect("failed to spawn git")
        .status;
    assert!(status.success(), "git {args:?} failed with {status}");
}

/// Run `git <args>` with the default test author.
fn git(dir: &std::path::Path, args: &[&str]) {
    git_env(dir, args, "Test Author", "test@example.com");
}

/// Build a small repo with distinct commit subjects and one commit by a
/// different author so we can test author-name searching.
///
/// History (date-order, newest first): D → C → B → A
/// - A: "initial commit"  — author: Test Author
/// - B: "add widget"      — author: Test Author
/// - C: "fix crash in widget" — author: Alice Smith
/// - D: "refactor widget" — author: Test Author
fn make_find_repo() -> tempfile::TempDir {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let p = dir.path();

    git(p, &["init", "-b", "main"]);
    git(p, &["config", "user.email", "test@example.com"]);
    git(p, &["config", "user.name", "Test Author"]);
    git(p, &["config", "commit.gpgsign", "false"]);

    // A — initial
    git(p, &["commit", "--allow-empty", "-m", "initial commit"]);
    // B — widget
    git(p, &["commit", "--allow-empty", "-m", "add widget"]);
    // C — different author
    git_env(
        p,
        &["commit", "--allow-empty", "-m", "fix crash in widget"],
        "Alice Smith",
        "alice@example.com",
    );
    // D — refactor
    git(p, &["commit", "--allow-empty", "-m", "refactor widget"]);

    dir
}

fn date_opts() -> WalkOptions {
    WalkOptions {
        order: SortOrder::Date,
        limit: None,
        ..Default::default()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// Subject substring match (case-insensitive).
#[test]
fn subject_match() {
    let dir = make_find_repo();
    let p = dir.path();
    let opts = date_opts();

    // "widget" appears in B, C, D (not A).
    let hits = find_commits(p, "widget", &opts, 100).expect("find_commits");
    assert_eq!(hits.len(), 3, "expected 3 widget hits, got {hits:#?}");

    // All hits must have "widget" in their subject.
    for h in &hits {
        assert!(
            h.subject.to_lowercase().contains("widget"),
            "hit subject doesn't contain 'widget': {h:?}"
        );
    }
}

/// Case-insensitive search.
#[test]
fn case_insensitive() {
    let dir = make_find_repo();
    let p = dir.path();
    let opts = date_opts();

    let lower = find_commits(p, "initial", &opts, 100).expect("find_commits");
    let upper = find_commits(p, "INITIAL", &opts, 100).expect("find_commits");
    let mixed = find_commits(p, "Initial", &opts, 100).expect("find_commits");

    assert_eq!(lower.len(), 1);
    assert_eq!(upper.len(), 1);
    assert_eq!(mixed.len(), 1);
    assert_eq!(lower[0].row_index, upper[0].row_index);
    assert_eq!(lower[0].row_index, mixed[0].row_index);
}

/// Author name search.
#[test]
fn author_match() {
    let dir = make_find_repo();
    let p = dir.path();
    let opts = date_opts();

    // "alice" matches only commit C.
    let hits = find_commits(p, "alice", &opts, 100).expect("find_commits");
    assert_eq!(hits.len(), 1, "expected 1 alice hit, got {hits:#?}");
    assert_eq!(hits[0].subject, "fix crash in widget");
    assert!(hits[0].author.to_lowercase().contains("alice"));
}

/// OID hex-prefix search.
#[test]
fn oid_prefix_match() {
    let dir = make_find_repo();
    let p = dir.path();
    let opts = date_opts();

    // Walk to get the actual OIDs in order.
    let (_commits, metas) = walk_commits(p, &opts).expect("walk_commits");
    assert!(!metas.is_empty());

    for m in &metas {
        // Convert the first 3 bytes to a 6-char hex prefix.
        let hex: String = m.oid[..3].iter().map(|b| format!("{b:02x}")).collect();

        let hits = find_commits(p, &hex, &opts, 100).expect("find_commits");
        assert!(
            hits.iter().any(|h| h.oid == m.oid),
            "oid prefix '{hex}' didn't match the expected commit {m:?}; hits = {hits:?}"
        );
    }
}

/// **Stability contract:** `row_index` must equal the commit's index in `walk_commits`.
#[test]
fn row_index_aligns_with_walk() {
    let dir = make_find_repo();
    let p = dir.path();
    let opts = date_opts();

    let (_commits, metas) = walk_commits(p, &opts).expect("walk_commits");
    let hits = find_commits(p, "widget", &opts, 100).expect("find_commits");

    for hit in &hits {
        let walk_idx = metas
            .iter()
            .position(|m| m.oid == hit.oid)
            .expect("hit oid not found in walk");
        assert_eq!(
            hit.row_index as usize, walk_idx,
            "row_index mismatch for oid {:?}: find says {}, walk says {}",
            hit.oid, hit.row_index, walk_idx,
        );
    }
}

/// `max_results` caps the number of hits.
#[test]
fn max_results_cap() {
    let dir = make_find_repo();
    let p = dir.path();
    let opts = date_opts();

    // "widget" matches 3 commits; ask for at most 2.
    let hits = find_commits(p, "widget", &opts, 2).expect("find_commits");
    assert_eq!(hits.len(), 2, "expected exactly 2 hits with cap=2");
}

/// Empty or whitespace query returns an empty list.
#[test]
fn empty_query_returns_empty() {
    let dir = make_find_repo();
    let p = dir.path();
    let opts = date_opts();

    let hits = find_commits(p, "", &opts, 100).expect("find_commits");
    assert!(
        hits.is_empty(),
        "empty query should return empty, got {hits:?}"
    );

    let hits2 = find_commits(p, "   ", &opts, 100).expect("find_commits");
    assert!(hits2.is_empty(), "whitespace query should return empty");
}

/// Hits are returned in ascending row_index order (i.e. walk order, newest first).
#[test]
fn results_in_row_index_order() {
    let dir = make_find_repo();
    let p = dir.path();
    let opts = date_opts();

    let hits = find_commits(p, "widget", &opts, 100).expect("find_commits");
    assert!(hits.len() > 1);
    for w in hits.windows(2) {
        assert!(
            w[0].row_index < w[1].row_index,
            "hits not in ascending row_index order: {w:?}"
        );
    }
}
