# Git Braid — Progress

> Concise status board. Details and rationale live in the linked docs.

---

## Current milestone: M2 — Canvas virtualised renderer

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
| M3 | Commit detail / diff / refs / find | 2–3 weeks | 🔲 |
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

_Updated: 2026-06-22 · M2 complete → M3 next (commit detail / diff / refs / find)_
