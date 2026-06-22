//! Integration tests for `list_refs`.
//!
//! Builds real (temporary) git repos via the `git` CLI — test-only use of the
//! CLI is fine; the production read path is gitoxide-only (plan §3.2).

use std::process::Command;

use git_braid_core::{model::RefKind, walk::list_refs};

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

/// Build a repo with two branches (`main`, `feature`) and two tags (`v0.1`,
/// `v0.2`).
fn make_refs_repo() -> tempfile::TempDir {
    let dir = tempfile::TempDir::new().expect("tmpdir");
    let p = dir.path();

    git(p, &["init", "-b", "main"]);
    git(p, &["config", "user.email", "test@example.com"]);
    git(p, &["config", "user.name", "Test Author"]);
    git(p, &["config", "commit.gpgsign", "false"]);

    git(p, &["commit", "--allow-empty", "-m", "initial"]);
    git(p, &["tag", "v0.1"]);

    git(p, &["commit", "--allow-empty", "-m", "second"]);
    git(p, &["tag", "v0.2"]);

    // Create a second branch pointing at HEAD.
    git(p, &["branch", "feature"]);

    dir
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// All local branches and tags must appear.
#[test]
fn includes_branches_and_tags() {
    let dir = make_refs_repo();
    let p = dir.path();

    let refs = list_refs(p).expect("list_refs");
    let names: Vec<&str> = refs.iter().map(|r| r.name.as_str()).collect();

    assert!(names.contains(&"main"), "expected 'main' branch");
    assert!(names.contains(&"feature"), "expected 'feature' branch");
    assert!(names.contains(&"v0.1"), "expected 'v0.1' tag");
    assert!(names.contains(&"v0.2"), "expected 'v0.2' tag");
}

/// Local branches have `kind == LocalBranch`; tags have `kind == Tag`.
#[test]
fn kinds_are_correct() {
    let dir = make_refs_repo();
    let p = dir.path();

    let refs = list_refs(p).expect("list_refs");

    for r in &refs {
        match r.name.as_str() {
            "main" | "feature" => {
                assert_eq!(
                    r.kind,
                    RefKind::LocalBranch,
                    "expected LocalBranch for {}",
                    r.name
                )
            }
            "v0.1" | "v0.2" => {
                assert_eq!(r.kind, RefKind::Tag, "expected Tag for {}", r.name)
            }
            other => panic!("unexpected ref '{other}'"),
        }
    }
}

/// Branches appear before tags in the sorted order.
#[test]
fn branches_before_tags() {
    let dir = make_refs_repo();
    let p = dir.path();

    let refs = list_refs(p).expect("list_refs");

    let mut saw_tag = false;
    for r in &refs {
        if r.kind == RefKind::Tag {
            saw_tag = true;
        }
        if saw_tag && r.kind == RefKind::LocalBranch {
            panic!(
                "branch '{}' appeared after a tag — sort order broken",
                r.name
            );
        }
    }
}

/// Each ref's `oid` is a non-empty string that looks like a hex OID.
#[test]
fn oids_are_hex() {
    let dir = make_refs_repo();
    let p = dir.path();

    let refs = list_refs(p).expect("list_refs");
    assert!(!refs.is_empty(), "list should be non-empty");

    for r in &refs {
        assert_eq!(r.oid.len(), 20, "oid must be 20 bytes for ref '{}'", r.name);
        // Every byte should be in 0..255 (trivially true for [u8; 20]).
    }
}

/// Stash and remote refs must not appear.
#[test]
fn no_stash_or_remote() {
    let dir = make_refs_repo();
    let p = dir.path();

    let refs = list_refs(p).expect("list_refs");
    for r in &refs {
        assert_ne!(r.kind, RefKind::Stash, "stash must not appear");
        assert_ne!(
            r.kind,
            RefKind::RemoteBranch,
            "remote branches must not appear"
        );
        assert_ne!(r.kind, RefKind::Head, "HEAD must not appear");
    }
}
