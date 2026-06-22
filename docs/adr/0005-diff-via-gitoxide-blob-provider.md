# ADR-0005 — Diff via gitoxide blob provider (not `git show`)

**Date:** 2026-06-22  
**Status:** Accepted

---

## Context

M3 Slice 2 adds a changed-file list to the commit detail panel, with the ability
to click a file and open VS Code's built-in side-by-side diff viewer. Two
approaches were considered:

**A. gitoxide blob provider (chosen)**  
Enumerate changed files via `gix::Tree::changes()` (tree-diff) and serve blob
content through a custom `TextDocumentContentProvider` backed by
`repo.find_object(oid).data`. The provider is registered under a custom
`gitbraid:` scheme so VS Code's built-in diff (`vscode.diff`) can open both
sides without reading the filesystem.

**B. `git show` / `git diff-tree` subprocess**  
Shell out to `git` for both file enumeration (`git diff-tree --name-status`) and
blob content (`git show <oid>:<path>`). Results arrive as strings; parse and hand
to `vscode.diff`.

## Decision

**Option A — gitoxide blob provider.**

## Reasons

1. **Read-path rule (CLAUDE.md §2):** "Never spawn git for reads." Option B
   directly violates this constraint; Option A stays on the pure-gitoxide path.

2. **Performance:** gitoxide reads blobs directly from the ODB pack file without
   spawning a process. For a typical commit with dozens of changed files each
   clicked in sequence, avoiding process-spawn overhead is measurable.

3. **Clean-room:** `git show`'s output format is specific to its version and
   locale; parsing it creates a coupling to git's UI layer. Gitoxide's
   programmatic API has a stable, typed contract.

## Trade-offs accepted

- Enables the `blob-diff` gix feature, which transitively pulls `imara-diff`,
  `gix-filter`, `gix-worktree`, and `gix-attributes` into the dependency tree.
  This is an unavoidable cost to reach `Tree::changes()`.

- Rename detection is **OFF** (`track_rewrites(None)`): renames show as
  delete + add. This avoids blob similarity reads (faster, safe on blobless
  clones). Rename display can be added in a later slice.

- The `gitbraid:` content provider serves text decoded as UTF-8. Binary files
  will display as garbled text in the diff viewer. Binary file handling
  (show "binary file changed" instead of content) is deferred to a later slice.

## Consequences

- `Cargo.toml` workspace gix feature set gains `"blob-diff"`.
- `src/diffProvider.ts` — new file, `GitBraidContentProvider` registered once
  on extension `activate()`.
- `bindings/napi/src/lib.rs` — `FileChange` struct, `get_blob` fn, `files`
  field on `CommitDetail`.
- URI scheme: `gitbraid:/<file-path>?repo=<fsPath>&oid=<blobOidHex>`. The path
  component gives VS Code the file extension for language-mode inference.
