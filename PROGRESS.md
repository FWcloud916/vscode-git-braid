# Git Braid — Progress

> Concise status board. Details and rationale live in the linked docs.

---

## Current milestone: M4 — Write ops + context menu

**Goal:** Right-click a commit → checkout / create+delete branch/tag / merge / rebase / cherry-pick / revert / reset / stash ops. All writes via `git` CLI with friendly stderr.

**Status:** ✅ Done (Slices 1–4 complete)

### M4 Slice 1 — Context-menu infrastructure + checkout

| Task | Status | Notes |
|------|--------|-------|
| `web/ui/contextMenu.ts` (new) — DOM popup menu, VS Code CSS vars, auto-dismiss | ✅ | No deps; CSP-safe (inline styles) |
| `web/renderer/canvas.ts` — `onContextMenu` callback + `contextmenu` listener + `reset()` | ✅ | y→row reuses click-handler math |
| `web/index.ts` — `buildMenuItems`, `renderer.onContextMenu`, `reload` message | ✅ | Slice 1: checkout only |
| `src/gitActions.ts` — `checkout` impl + `isConflictError` pure helper | ✅ | `git checkout <ref>`; helper exported for tests |
| `src/webviewBridge.ts` — `GitActionOp` type, `action`/`reload` messages, `_handleAction`, `_presentGitError`, output channel | ✅ | Conflict path + Show-details dump to output channel |

### M4 Slice 2 — branch/tag CRUD + input/confirm flows

| Task | Status | Notes |
|------|--------|-------|
| `src/gitActions.ts` — `createBranch`, `deleteBranch` (force param), `createTag`, `deleteTag` | ✅ | `deleteBranch` uses `-d` by default; `force=true` upgrades to `-D` |
| `src/webviewBridge.ts` — `validateRefName` helper, 4 new `_handleAction` cases | ✅ | `deleteBranch` tries -d, offers -D modal if "not fully merged"; create ops use `showInputBox` |
| `web/index.ts` — `buildMenuItems` full Slice 2 menu (checkout + create + conditional delete) | ✅ | Per-branch checkout/delete; create always shown; delete section conditional on refs |

### M4 Slice 3 — merge / cherry-pick / revert + conflict surfacing

| Task | Status | Notes |
|------|--------|-------|
| `src/gitActions.ts` — `merge`, `cherryPick`, `revert` (`--no-edit`) | ✅ | Conflict exits non-zero; caught and classified by `_presentGitError` |
| `src/webviewBridge.ts` — 3 new `_handleAction` cases | ✅ | No pre-confirmation; conflict regex in `_presentGitError` fires correctly |
| `web/index.ts` — Merge / Cherry-pick / Revert menu items | ✅ | Added to integrative-ops section |

### M4 Slice 4 — rebase / reset / stash (history-altering ops)

| Task | Status | Notes |
|------|--------|-------|
| `src/gitActions.ts` — `rebase`, `resetSoft/Mixed/Hard`, `stashApply/Pop/Drop` | ✅ | All stubs replaced; stash ops take `stashRef` param for multi-stash repos |
| `src/webviewBridge.ts` — 8 new `_handleAction` cases | ✅ | `resetHard` + `stashDrop` require modal confirm; stash ref extracted from `msg.refs[0]` |
| `web/index.ts` — Rebase, Reset (×3), Stash (×3 per stash) menu items | ✅ | Stash items conditional on `REF_KIND_STASH` refs at commit |

---

## Previous milestone: M3 — Commit detail / diff / refs / find

**Goal:** Click a commit → see metadata, ref chips, changed files, and diffs.

**Status:** ✅ Done (Slices 1–4 complete)

### M3 Slice 1 — refs + metadata (BRAI v2) + selection + detail panel

| Task | Status | Notes |
|------|--------|-------|
| `crates/core/src/model.rs` — `CommitMeta`, `RefLabel`, `RefKind` types | ✅ | |
| `crates/core/src/walk.rs` — captures refs + per-row metadata | ✅ | Two-pass to avoid borrow-checker conflict |
| `crates/core/src/serialize.rs` — BRAI v2 (20-byte header, 56-byte CommitRow, RefRow table, StringPool) | ✅ | 11 round-trip tests |
| `bindings/napi/src/lib.rs` — `get_commit_detail` RPC | ✅ | |
| `src/webviewBridge.ts` — `selectCommit` / `commitDetail` round-trip | ✅ | |
| `web/renderer/decode.ts` — BRAI v2 decoder | ✅ | Ref chips, subject, author, commitTime |
| `web/renderer/canvas.ts` — selection highlight, ref chips, subject text, click handler | ✅ | |
| `web/index.ts` — detail panel DOM, `showDetail()` | ✅ | |
| **Bug fix** `crates/core/src/layout.rs` — shared-parent lane missing Straight | ✅ | Regression test added |

### M3 Slice 2 — changed-file list + VS Code built-in diff

| Task | Status | Notes |
|------|--------|-------|
| `Cargo.toml` — enable `blob-diff` gix feature | ✅ | Enables `Tree::changes()` API |
| `bindings/napi/src/lib.rs` — `FileChange` struct, `files` in `CommitDetail`, `get_blob` | ✅ | Tree-diff via gitoxide; rename detection OFF |
| `src/diffProvider.ts` — `gitbraid:` `TextDocumentContentProvider` | ✅ | Serves blob bytes via `get_blob`; no `git` subprocess |
| `src/extension.ts` — register content provider | ✅ | Registered once on `activate()` |
| `src/webviewBridge.ts` — `openDiff` message → `vscode.diff` | ✅ | |
| `web/index.ts` — render changed-file list, click-to-diff | ✅ | A/M/D badges, delegated click listener |

### M3 Slice 4 — multi-repo detection + picker + switch + dateFormat/graphColors settings

| Task | Status | Notes |
|------|--------|-------|
| `crates/core/src/walk.rs` — `discover_repo` (gitoxide upward walk) | ✅ | Returns canonical worktree root or `None` |
| `crates/core/tests/discover.rs` — 3 integration tests | ✅ | root / subdir / non-repo |
| `bindings/napi/src/lib.rs` — `discover_repo` napi fn | ✅ | No subprocess; non-repo → `null` |
| `src/extension.ts` — `resolveRepos` / `pickRepo` / `openRepo` / `selectRepo` command | ✅ | Single-repo = no picker; multi-root = showQuickPick |
| `src/webviewBridge.ts` — `_sendConfig` + `config` HostMessage | ✅ | Pushed before initial batch on `ready` |
| `package.json` — `gitBraid.selectRepo` command + `dateFormat` + `graphColors` config | ✅ | Two new settings declared |
| `web/renderer/canvas.ts` — `_palette` instance field + `setPalette` + `_paletteColor` | ✅ | Empty array reverts to built-in PALETTE |
| `web/format.ts` — `formatRelative` (injectable `nowMs`) | ✅ | Separate module for testability |
| `web/index.ts` — `config` message handler + `dateFormat` state + `formatDate` branching | ✅ | |
| `web/settings.test.ts` — 10 vitest tests | ✅ | formatRelative boundaries + PALETTE invariants |
| `docs/adr/0006-repo-discovery-strategy.md` | ✅ | Records workspace-scan vs vscode.git decision |

### M3 Slice 3 — find: full-history search + highlight + auto-load-to-match

| Task | Status | Notes |
|------|--------|-------|
| `crates/core/src/walk.rs` — `FindMatch` + `find_commits` | ✅ | Case-insensitive; subject / author / OID-prefix; max_results cap |
| `crates/core/tests/find.rs` — 8 integration tests | ✅ | Row-index stability contract explicitly tested |
| `bindings/napi/src/lib.rs` — `FindMatch` napi object + `find_commits` napi fn | ✅ | Same walk options as `get_graph_batch` (row-index alignment) |
| `src/webviewBridge.ts` — `find()` public method + `findResults` host message | ✅ | Gitoxide-only; no subprocess |
| `src/extension.ts` — `gitBraid.find` command registration | ✅ | Guards on bridge; `showInputBox` prompt |
| `package.json` — `gitBraid.find` command + `Cmd/Ctrl+F` keybinding | ✅ | `when: activeWebviewPanelId == 'gitBraid'` |
| `web/renderer/canvas.ts` — `setMatches`, `setCurrentMatch`, `clearFind`, `scrollToRow` | ✅ | Amber match bands; centred scroll |
| `web/index.ts` — find bar overlay, navigation (◀ ▶ / Enter / Esc), auto-load-to-match | ✅ | `pendingReveal` loads intervening rows on demand |

---

## Previous milestone: M2 — Canvas virtualised renderer

**Goal:** Webview paints the commit graph; native scroll + incremental paging.

**Status:** ✅ Done

| Task | Status | Notes |
|------|--------|-------|
| `web/renderer/decode.ts` — TS BRAI v1 decoder (DataView, no DOM) | ✅ | 12 tests green; mirrors Rust decode_batch |
| `web/renderer/canvas.ts` — virtualised Canvas renderer | ✅ | Native scroll, overscan, bezier curves, merge rings, short OID text |
| `web/index.ts` — decode + incremental paging wired | ✅ | `requestBatch` on scroll-to-bottom; in-flight guard; `markEnd` on repo tail |
| `web/renderer/decode.test.ts` — vitest round-trip tests | ✅ | 12 tests; bad-magic / wrong-version / truncation / seg_offset coverage |

---

## Previous milestone: M1 — Layout algorithm + napi binding

**Status:** ✅ Done

| Task | Status | Notes |
|------|--------|-------|
| `crates/core/src/layout.rs` — layout engine (eager convergence, append-stable flags) | ✅ | 3 golden tests green; invariant_append_only_stability confirmed |
| `crates/core/benches/layout.rs` — criterion bench un-stub | ✅ | 1k=63µs / 10k=628µs / 100k=6.3ms (all within targets) |
| `crates/core/src/serialize.rs` — BRAI v1 binary encode/decode | ✅ | 8 round-trip tests green; wire format locked |
| `bindings/napi/src/lib.rs` — `get_graph_batch` wired to walk+layout+encode | ✅ | Returns `Buffer`; smoke test: BRAI magic + correct row count |
| `src/webviewBridge.ts` — `ready`/`requestBatch` → native addon | ✅ | Binary batch posted to webview as ArrayBuffer |
| `src/extension.ts` — repo path from workspace folder | ✅ | Picks active-editor's folder, falls back to first |
| `.github/workflows/build-napi.yml` — 4-target prebuild matrix | ✅ | darwin-arm64/x64, linux-x64-gnu, win32-x64-msvc; validated locally |

---

## Previous milestone: M0 — Rust core log walk

**Status:** ✅ Done

| Task | Status | Notes |
|------|--------|-------|
| `crates/core/src/walk.rs` — gitoxide log walk | ✅ | Uses `gix::traverse::commit::topo`; 5 integration tests green |
| M0 CLI demo (binary crate) | ✅ | `crates/core/src/bin/braid-log.rs`; run: `cargo run -p git-braid-core --bin braid-log -- <path>` |

---

## Milestone map

| Milestone | Description | Target | Status |
|-----------|-------------|--------|--------|
| **M0** | Rust core: log walk + topo sort → CLI print | 3–5 days | ✅ |
| **M1** | Layout algorithm + napi binding → host gets layout | 1 week | ✅ |
| **M2 ⚑** | Canvas virtualised renderer → **MVP demo** | 3–5 days | ✅ |
| M3 | Commit detail / diff / refs / find | 2–3 weeks | ✅ S1–S4 done |
| M4 | Write ops + context menu | 3–4 weeks | ✅ S1–S4 done |
| M5 | First AI feature (release-notes generation) | 2 weeks | 🔲 |
| M6 | Marketplace publish (preview) | — | 🔲 |

⚑ **M2 is the go/no-go gate.** If the MVP demo is not compelling vs original
Git Graph + VS Code built-in, stop here.

---

## Detailed progress index

| Document | Contents |
|----------|----------|
| `docs/plan/project-plan.md` | Full project plan, risks, tech choices |
| `docs/specs/layout-spec.md` | Layout algorithm contract (System Contracts) |
| `docs/adr/` | Architecture decision records |

---

## Risk watch

| Risk | Level | Mitigation |
|------|-------|-----------|
| Scope creep | 🔴 High | Strict non-goals in CLAUDE.md §scope |
| napi prebuild matrix | 🟢 Low | ✅ Validated in M1 — 4-target CI matrix confirmed |
| gitoxide read-path gaps | 🟢 Low | Fall back to git CLI for missing ops |

---

_Updated: 2026-06-22 · M4 complete — Slices 1–4: context-menu + checkout + branch/tag CRUD + merge/cherry-pick/revert + rebase/reset/stash_
