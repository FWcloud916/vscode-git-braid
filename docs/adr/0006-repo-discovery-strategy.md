# ADR 0006 — Repository discovery strategy (M3 Slice 4)

**Date:** 2026-06-22  
**Status:** Accepted

---

## Context

M3 Slice 4 adds multi-repo support. Two decisions were needed:

1. **How to discover which git repositories exist in the open workspace.**
2. **How to switch repositories when the graph panel is already open.**

---

## Decision 1 — Discovery: scan workspace folders via gitoxide

**Chosen:** scan `workspace.workspaceFolders` and validate each via
`gix::discover` (gitoxide's upward `.git` search), exposed as
`discover_repo` in the Rust core and as `discoverRepo` in the napi binding.

**Rejected:** consume the VS Code built-in Git extension API
(`getExtension('vscode.git')`), which provides a live `repositories` list and
handles nested/sibling repos robustly.

**Why gitoxide scan:**

- Stays fully on the gitoxide read path — no `extensionDependencies: ["vscode.git"]`.
  Adding a built-in extension dependency would bloat the activation chain and couple
  the extension to VS Code's Git internals.
- Handles the most common case: workspace folders that *are* repos or are
  subdirectories of repos. `gix::discover` walks upward from the folder path to find
  the `.git` directory, fixing the Slice-1 regression where a workspace folder that
  was a *subdirectory* of a repo failed the first batch with a raw error.
- Scope constraint: the project plan explicitly defers monorepo / nested-repo
  hardening to **Phase 4+** ("multi-worktree, monorepo 強化"). The `vscode.git` API
  adds real value precisely for those edge cases — we're deliberately not tackling
  them yet.

**Known limitation / upgrade path:** sibling repos and repos that are not under any
workspace folder will not be discovered. The Phase-4 upgrade path is to swap the
discovery backend to the `vscode.git` API, which maintains a live repo list
including nested repos opened via SCM. The `resolveRepos()` / `pickRepo()` contract
in `extension.ts` is intentionally thin so the backend can be replaced without
changing the command layer.

---

## Decision 2 — Repo switch: recreate the panel

**Chosen:** on switch, dispose the current `WebviewBridge` and create a new one
with the new repo path. The webview resets naturally — the new panel sends `ready`,
which triggers `_sendConfig` + `_sendInitialBatch` for the new repo.

**Rejected:** make `_repoPath` mutable and add a host→webview `reset`/`repoChanged`
message so the webview clears its row buffer and `loadedCount` in-place.

**Why recreate:**

- Zero new protocol messages. The `ready → config → initialBatch` reset path is
  already tested end-to-end (Slices 1–3 all depend on it).
- State-clearing complexity: the reuse-with-reset path must synchronously zero
  `loadedCount`, `inFlight`, `reachedEnd`, `pendingReveal`, `matches`,
  `currentMatchIdx`, and `_rows` in the webview — missing any one of these causes
  subtle paging bugs. The recreate path gets all of this for free.
- UX: a brief reload flash on an intentional repo switch is acceptable. The panel
  opens at its previous `ViewColumn`, so the layout does not change.
- The `retainContextWhenHidden` webview option makes *hiding* the panel cheap;
  only an explicit `dispose` recreates it.

**Upgrade path:** if UX research reveals the reload flash is disruptive, the reuse
path can be added as a follow-up without touching any of the discovery or settings
code added in this slice.

---

## Consequences

- `discoverRepo` is a pure Rust → napi adapter with no business logic (consistent
  with the "no business logic in napi" constraint from ADR 0004).
- `extension.ts` gains three private helpers (`resolveRepos`, `pickRepo`,
  `openRepo`) that form a clear separation between discovery, presentation, and
  lifecycle — a natural seam for the Phase-4 Git-API upgrade.
- `web/format.ts` is introduced as a separate module so `formatRelative` can be
  unit-tested in vitest's node environment without pulling in the browser-only
  `web/index.ts` entry point (which references `window` at module scope).
