# ADR-0004: Rust for reads, git CLI for writes

**Date:** 2026-06-22
**Status:** Accepted

---

## Context

Git Braid needs to both read git history (for display) and write to the
repository (checkout, merge, rebase, cherry-pick, tag, stash, …).

The read path is performance-critical: loading and rendering 10k–100k commits
must be fast. The write path is correctness-critical: git operations interact
with hooks, submodules, worktrees, config, and many edge cases.

We could use a single library (gitoxide, libgit2, or similar) for both reads
and writes. However:

- **gitoxide write ops** are still maturing as of 2025–2026.
- **Any library** that reimplements write operations risks missing edge cases
  that the official `git` binary handles correctly (e.g. post-checkout hooks,
  sparse checkout, submodule state, `safe.directory`).
- The write operations are **not performance-critical** — a user does not
  rebase a thousand times per second.

---

## Decision

**Read path:** Rust + gitoxide, reading the `.git` ODB directly.
No subprocess spawning on the read path.

**Write path:** TypeScript (`src/gitActions.ts`) shells out to the `git` CLI
via `child_process.spawn`. The Rust core has no write operations.

---

## Consequences

**Positive:**
- Read path performance is maximised (no subprocess overhead).
- Write path correctness is delegated to the authoritative `git` binary.
- The Rust crate stays simpler: pure reads, no write complexity.
- Failure modes are cleaner: git CLI errors come with human-readable messages
  that can be surfaced directly in the UI.

**Negative / trade-offs:**
- Write path requires `git` to be installed on the user's machine (reasonable
  assumption for a git visualiser, but worth noting).
- Two different code paths to maintain.

**Neutral / follow-up:**
- `src/gitActions.ts` must surface `stderr` from git commands in the UI
  (friendly error presentation is a Phase 2 UX concern).
- If a write operation that gitoxide implements is clearly correct and well-tested,
  we can revisit this decision for that specific operation.
