# Git Braid — Progress

> Concise status board. Details and rationale live in the linked docs.

---

## Current milestone: M3 — Commit detail / diff / refs / find

**Goal:** Click a commit → see metadata, ref chips, changed files, and diffs.

**Status:** 🔄 In progress (Slices 1–3 ✅, Slice 4 🔲)

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
| M3 | Commit detail / diff / refs / find | 2–3 weeks | 🔄 S1–S3 done |
| M4 | Write ops + context menu | 3–4 weeks | 🔲 |
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

_Updated: 2026-06-22 · M3 Slices 1–3 complete — refs/metadata/detail panel + file-list/diff + find_
