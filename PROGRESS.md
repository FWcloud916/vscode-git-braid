# Git Braid — Progress

> Concise status board. Details and rationale live in the linked docs.

---

## Current milestone: M0 — Rust core log walk

**Goal:** `walk_commits()` prints topo-sorted commits for a real repo. CLI demo only.

**Status:** ✅ Done

| Task | Status | Notes |
|------|--------|-------|
| `crates/core/src/walk.rs` — gitoxide log walk | ✅ | Uses `gix::traverse::commit::topo`; 5 integration tests green |
| `crates/core/src/layout.rs` — layout algorithm | 🔲 | Stub in place (M1 target) |
| M0 CLI demo (binary crate) | ✅ | `crates/core/src/bin/braid-log.rs`; run: `cargo run -p git-braid-core --bin braid-log -- <path>` |

---

## Milestone map

| Milestone | Description | Target | Status |
|-----------|-------------|--------|--------|
| **M0** | Rust core: log walk + topo sort → CLI print | 3–5 days | ✅ |
| **M1** | Layout algorithm + napi binding → host gets layout | 1 week | 🔲 |
| **M2 ⚑** | Canvas virtualised renderer → **MVP demo** | 3–5 days | 🔲 |
| M3 | Commit detail / diff / refs / find | 2–3 weeks | 🔲 |
| M4 | Write ops + context menu | 3–4 weeks | 🔲 |
| M5 | First AI feature (release-notes generation) | 2 weeks | 🔲 |
| M6 | Marketplace publish (preview) | — | 🔲 |

⚑ **M2 is the go/no-go gate.** If the MVP demo is not compelling vs original
Git Graph + VS Code built-in, stop here.

---

## Detailed progress index

_Links will be added as work progresses._

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
| napi prebuild matrix | 🟡 Medium | Validate CI matrix by M1 |
| gitoxide read-path gaps | 🟢 Low | Fall back to git CLI for missing ops |

---

_Updated: 2026-06-22 · M0 complete → M1 next (layout algorithm)_
