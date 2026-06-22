//! Integration tests for `walk_range`.
//!
//! Builds real (temporary) git repos via the `git` CLI — test-only use of the
//! CLI is fine; the production read path is gitoxide-only (plan §3.2).

use std::process::Command;

use git_braid_core::walk::walk_range;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/// Build a linear repo with four commits and two tags:
///
/// ```
/// A  (tag: v0.1)
/// B
/// C  (tag: v0.2)
/// D  ← HEAD / main
/// ```
fn make_range_repo() -> tempfile::TempDir {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let p = dir.path();

    git(p, &["init", "-b", "main"]);
    git(p, &["config", "user.email", "test@example.com"]);
    git(p, &["config", "user.name", "Test Author"]);
    git(p, &["config", "commit.gpgsign", "false"]);

    // A — initial
    git(p, &["commit", "--allow-empty", "-m", "feat: initial"]);
    git(p, &["tag", "v0.1"]);

    // B
    git(p, &["commit", "--allow-empty", "-m", "fix: bug fix"]);

    // C
    git(p, &["commit", "--allow-empty", "-m", "feat: new feature"]);
    git(p, &["tag", "v0.2"]);

    // D
    git(p, &["commit", "--allow-empty", "-m", "chore: cleanup"]);

    dir
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// `v0.1..HEAD` should return B, C, D (not A).
#[test]
fn range_excludes_from() {
    let dir = make_range_repo();
    let p = dir.path();

    let commits = walk_range(p, Some("v0.1"), "HEAD", false).expect("walk_range");
    assert_eq!(
        commits.len(),
        3,
        "expected 3 commits in v0.1..HEAD, got {commits:#?}"
    );

    let subjects: Vec<&str> = commits.iter().map(|c| c.subject.as_str()).collect();
    assert!(
        subjects.contains(&"fix: bug fix"),
        "expected 'fix: bug fix' in range"
    );
    assert!(
        subjects.contains(&"feat: new feature"),
        "expected 'feat: new feature' in range"
    );
    assert!(
        subjects.contains(&"chore: cleanup"),
        "expected 'chore: cleanup' in range"
    );
    assert!(
        !subjects.contains(&"feat: initial"),
        "'feat: initial' (v0.1) must not appear in range"
    );
}

/// `v0.2..HEAD` should return only D.
#[test]
fn range_narrow() {
    let dir = make_range_repo();
    let p = dir.path();

    let commits = walk_range(p, Some("v0.2"), "HEAD", false).expect("walk_range");
    assert_eq!(
        commits.len(),
        1,
        "expected 1 commit in v0.2..HEAD, got {commits:#?}"
    );
    assert_eq!(commits[0].subject, "chore: cleanup");
}

/// `from = None` means full ancestry of `to`.
#[test]
fn range_full_ancestry() {
    let dir = make_range_repo();
    let p = dir.path();

    let commits = walk_range(p, None, "HEAD", false).expect("walk_range");
    // All 4 commits should be included.
    assert_eq!(
        commits.len(),
        4,
        "expected 4 commits with no 'from', got {commits:#?}"
    );
}

/// An equal range (`v0.1..v0.1`) should return an empty vec.
#[test]
fn empty_range() {
    let dir = make_range_repo();
    let p = dir.path();

    let commits = walk_range(p, Some("v0.1"), "v0.1", false).expect("walk_range");
    assert!(
        commits.is_empty(),
        "equal from/to should be empty, got {commits:#?}"
    );
}

/// Commits are returned newest-first (same as date-order walk).
#[test]
fn newest_first_ordering() {
    let dir = make_range_repo();
    let p = dir.path();

    let commits = walk_range(p, Some("v0.1"), "HEAD", false).expect("walk_range");
    // D has the latest committer time (equal times → subject order).
    // At minimum the last commit in the list should be B (oldest in range).
    assert_eq!(commits.last().unwrap().subject, "fix: bug fix");
}

/// `include_diff_stat = false` leaves diffstat fields at 0.
#[test]
fn diffstat_disabled_fields_zero() {
    let dir = make_range_repo();
    let p = dir.path();

    let commits = walk_range(p, Some("v0.1"), "HEAD", false).expect("walk_range");
    for c in &commits {
        assert_eq!(
            c.files_changed, 0,
            "files_changed must be 0 when diffstat disabled"
        );
        assert_eq!(
            c.insertions, 0,
            "insertions must be 0 when diffstat disabled"
        );
        assert_eq!(c.deletions, 0, "deletions must be 0 when diffstat disabled");
    }
}

/// Build a repo with real file changes and verify diffstat is non-zero.
#[test]
fn diffstat_enabled_nonzero() {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let p = dir.path();

    git(p, &["init", "-b", "main"]);
    git(p, &["config", "user.email", "test@example.com"]);
    git(p, &["config", "user.name", "Test Author"]);
    git(p, &["config", "commit.gpgsign", "false"]);

    // Root commit with a file.
    std::fs::write(p.join("hello.txt"), "line1\nline2\nline3\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-m", "initial with file"]);
    git(p, &["tag", "v0.1"]);

    // A commit that modifies the file.
    std::fs::write(p.join("hello.txt"), "line1\nline2\nline3\nline4\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-m", "add line4"]);

    let commits = walk_range(p, Some("v0.1"), "HEAD", true).expect("walk_range");
    assert_eq!(commits.len(), 1);
    let c = &commits[0];
    assert_eq!(c.subject, "add line4");
    assert_eq!(c.files_changed, 1, "files_changed should be 1");
    // Insertions and deletions come from newline counting — both sides are
    // non-zero for a modification.
    assert!(
        c.insertions > 0,
        "insertions should be > 0 for a modified file"
    );
    assert!(
        c.deletions > 0,
        "deletions should be > 0 for a modified file"
    );
}

/// Root commit diffstat: all lines are insertions, no deletions.
#[test]
fn diffstat_root_commit() {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let p = dir.path();

    git(p, &["init", "-b", "main"]);
    git(p, &["config", "user.email", "test@example.com"]);
    git(p, &["config", "user.name", "Test Author"]);
    git(p, &["config", "commit.gpgsign", "false"]);

    // Only a root commit with content.
    std::fs::write(p.join("readme.txt"), "hello\nworld\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-m", "root"]);

    // Full history walk (from = None).
    let commits = walk_range(p, None, "HEAD", true).expect("walk_range");
    assert_eq!(commits.len(), 1);
    let c = &commits[0];
    assert_eq!(c.files_changed, 1);
    assert!(c.insertions > 0, "root commit should have insertions");
    assert_eq!(c.deletions, 0, "root commit should have no deletions");
}
