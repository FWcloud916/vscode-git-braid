# ADR 0007 — Nested/sibling repo discovery + in-panel repo switcher

**Date:** 2026-07-13
**Status:** Accepted
**Supersedes:** the "Known limitation" in `docs/adr/0006-repo-discovery-strategy.md`

---

## Context

ADR 0006 chose an upward-only discovery strategy: `resolveRepos()` walks up
from each workspace folder via `discoverRepo` (gitoxide) until it finds a
`.git` directory. That handles a workspace folder that *is* a repo, or a
*subdirectory* of one — but not a folder that merely *contains* several
sibling repos (e.g. a `~/projects/` folder holding many unrelated checkouts).
Opening such a folder produced "No git repository found", even though dozens
of repos sit one or two levels below it. ADR 0006 explicitly deferred this to
"Phase 4+", flagging the `vscode.git` extension API as the eventual upgrade
path.

This surfaced as a real usability gap once workspaces of that shape were
opened in practice, prompting this ADR ahead of the originally planned phase.

---

## Decision 1 — Discovery: bounded-depth filesystem scan, not the `vscode.git` API

**Chosen:** add a second, downward discovery pass — `collectRepoRoots`
(`src/repoScan.ts`) — that scans each workspace folder up to
`gitBraid.repoScanDepth` levels (default 2) for directories containing a
`.git` entry, resolving each to its canonical root via the existing
`discoverRepo`. This runs *alongside* the unchanged upward pass from ADR 0006,
not instead of it.

**Rejected (again):** depending on the built-in `vscode.git` extension's live
`repositories` list.

**Why the scan, still:**

- Keeps the project fully on the gitoxide/`fs` read path — no
  `extensionDependencies: ["vscode.git"]`, no coupling to VS Code's Git
  internals or its activation timing.
- A bounded-depth scan is simple, deterministic, and testable in isolation
  (`src/repoScan.test.ts` exercises it with an in-memory stub tree — no real
  filesystem or native addon needed).
- Scope stays proportionate: the common case this fixes (a flat-ish folder of
  repos) doesn't need a live, event-driven repo list — a scan on each
  open/switch is cheap and correct enough.

**Known limitation / upgrade path unchanged:** a repo living outside every
workspace folder (e.g. a genuinely separate sibling directory tree, or one
reached only via a symlink — deliberately not followed, to avoid cycles) is
still not discovered. The `vscode.git` API remains the eventual upgrade path
noted in ADR 0006 if that gap matters in practice.

**Scan rules** (see `src/repoScan.ts` for the implementation):
- A directory counts as a repo if it directly contains a `.git` entry (a
  directory for a normal checkout, or a file for a worktree checkout).
- Scanning stops descending as soon as a directory is identified as a repo —
  it never recurses into a repo's internals or submodules.
- `node_modules`, `.git`, and any dot-prefixed directory are skipped.
  Symlinked directories are skipped too (a `Dirent`'s type reflects the link
  itself, not its target, which incidentally avoids symlink cycles).
- `gitBraid.repoScanDepth` (default 2, range 0–8) lets users tune the
  cost/coverage trade-off for very large or very flat workspaces; 0 disables
  the downward pass entirely (matches pre-ADR-0007 behaviour).

---

## Decision 2 — Switching: in-panel toolbar dropdown, in addition to the command

**Chosen:** add a repo dropdown to the graph webview's toolbar
(`web/ui/repoDropdown.ts`, modeled on the existing `branchDropdown.ts`),
populated via the `config` host→webview message (`repos` + `currentRepo`
fields). Selecting a different repo posts `{ type: "selectRepo", root }`;
the host's handler simply calls the same `openRepo()` used by the
`gitBraid.selectRepo` command and the initial `gitBraid.openGraph` picker.

**Rejected:** replacing the `gitBraid.selectRepo` command/QuickPick with the
in-panel dropdown.

**Why keep both:** the command-palette path remains useful when no panel is
open yet (or for keyboard-only workflows), while the toolbar dropdown gives a
persistent, always-visible "which repo am I looking at" affordance once the
graph is open — and, unlike the command, doesn't require knowing the command
exists. Both paths converge on the same `openRepo()` recreate-panel flow from
ADR 0006 §Decision 2, so no new switching logic was introduced, only a new
entry point to the existing one.

---

## Consequences

- `resolveRepos()` (`src/extension.ts`) is now `async` (it was previously
  synchronous) purely for a stable call-site shape — `collectRepoRoots`
  itself is synchronous. All three call sites (`gitBraid.openGraph`,
  `gitBraid.selectRepo`, `runReleaseNotesCommand`) already ran inside async
  command handlers, so this is a non-breaking signature change internal to
  the extension.
- `openRepo()` accepts an optional pre-resolved `repos` list to avoid a
  redundant re-scan when the caller already has one (the two command
  handlers); the in-panel dropdown's switch callback has no such list handy
  and re-resolves on demand — an acceptable cost for a user-initiated action.
- `WebviewBridge`'s constructor gained `repos: string[]` and
  `onSelectRepo: (root: string) => void` parameters; `_sendConfig()` now also
  pushes `repos`/`currentRepo` alongside the existing branch list.
- No native (Rust/napi) changes were needed — `discoverRepo` and every other
  napi export are already stateless and take a repo path per call.
