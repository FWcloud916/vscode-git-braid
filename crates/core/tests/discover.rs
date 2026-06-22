//! Integration tests for `discover_repo`.
//!
//! Builds real temporary git repos using the `git` CLI (test-only use of the
//! CLI is fine; the production read path is gitoxide-only).

use std::process::Command;

use git_braid_core::walk::discover_repo;

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Run `git <args>` inside `dir` using a fixed author identity so commits are
/// reproducible regardless of the test machine's global git config.
fn git(dir: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Test Author")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test Author")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00+00:00")
        .env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00+00:00")
        .output()
        .expect("failed to spawn git")
        .status;
    assert!(status.success(), "git {args:?} failed with {status}");
}

/// Create a minimal non-bare git repo with one empty commit and return the
/// temp dir (caller must keep it alive).
fn make_repo() -> tempfile::TempDir {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let p = dir.path();
    git(p, &["init", "-b", "main"]);
    git(p, &["config", "user.email", "test@example.com"]);
    git(p, &["config", "user.name", "Test Author"]);
    git(p, &["config", "commit.gpgsign", "false"]);
    git(p, &["commit", "--allow-empty", "-m", "init"]);
    dir
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// Discovering the repo root itself should return that same root.
#[test]
fn discover_root_returns_root() {
    let dir = make_repo();
    let root = dir.path().canonicalize().unwrap();

    let found = discover_repo(&root).expect("should discover root");
    // Canonicalise both sides: macOS may prepend /private to /tmp paths.
    assert_eq!(
        found.canonicalize().unwrap(),
        root,
        "discover_repo(root) should return root"
    );
}

/// Discovering from a subdirectory should walk up and return the same root.
#[test]
fn discover_subdir_walks_up() {
    let dir = make_repo();
    let root = dir.path().canonicalize().unwrap();

    // Create a nested subdirectory inside the worktree.
    let sub = root.join("a").join("b");
    std::fs::create_dir_all(&sub).unwrap();

    let found = discover_repo(&sub).expect("should discover from subdir");
    assert_eq!(
        found.canonicalize().unwrap(),
        root,
        "discover_repo(subdir) should walk up to root"
    );
}

/// A directory with no git repo (and no git repo anywhere above it) returns None.
#[test]
fn non_repo_returns_none() {
    // We need a directory that is definitely NOT inside any git repo.
    // Use a path under /tmp (outside the project) and ensure it exists.
    let tmp = tempfile::TempDir::new().expect("tmpdir");
    // Double-check: if somehow /tmp is inside a git repo, this test would be
    // vacuously wrong, but that can't happen in CI.
    let result = discover_repo(tmp.path());
    assert!(
        result.is_none(),
        "discover_repo in a non-repo dir should return None, got {result:?}"
    );
}
