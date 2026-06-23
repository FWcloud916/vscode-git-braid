# Git Braid — Claude Code guide

This file is read by Claude Code at the start of every session. It tells you
what this project is, what the hard constraints are, and where things live.

---

## What this project is

A VS Code extension that visualises git history. Two differentiators:
1. **Performance on large repos** — Rust core (gitoxide) + Canvas virtualised renderer.
2. **AI-assisted history** — semantic search, PR/release-notes generation, conflict context.

Current phase: **Phase 0 / M0** — Rust core log-walk stub exists; nothing computes yet.

---

## Hard constraints — read before touching anything

### 1. Clean-room rule (legal)

**Never open, read, or copy from the original Git Graph extension's source code.**

When implementing a feature:
- Refer to public git documentation, git man pages, and algorithm literature.
- Refer to the behaviour specs in `docs/specs/` (written from observable behaviour only).
- Keep the commit log as the evidence chain.

Violating this exposes the project to copyright liability. If you are unsure
whether something is clean-room, ask before writing code.

### 2. Layout invariants (correctness) — do not break

These invariants in `crates/core/src/layout.rs` / `docs/specs/layout-spec.md §5`
are the foundation of incremental loading and virtualised rendering correctness:

| # | Invariant | Why it matters |
|---|-----------|----------------|
| 4 | **Determinism** — same input → same output, byte-for-byte | Required for caching and testing |
| 5 | **Append-only stability** — `layout(commits[..N])` rows == `layout(commits[..N+k])` rows 0..N | Required for incremental paging |
| 2 | **No mid-life lane shift** — compaction is disabled | Prevents visual jumps when new data arrives |
| 6 | **First-parent straight** — first-parent line stays in same lane | Visual consistency of main-line |

Never introduce randomness, hash-iteration order, or external state into the
layout function. Never add compaction without re-evaluating invariant 5.

### 3. Scope discipline (most likely cause of project failure)

These are **non-goals** — do not implement them even if asked:
- Inline editor blame / annotations (GitLens-style)
- Own diff viewer (use VS Code's built-in)
- GUI conflict editor
- Non-git VCS support

---

## Architecture — where code lives

```
crates/core/         Rust: log walk (M0), layout (M1), binary serialize
bindings/napi/       napi-rs native addon: thin FFI adapter, no business logic
src/                 TypeScript extension host
  extension.ts       activate/deactivate + command registration
  webviewBridge.ts   host↔webview binary protocol (ArrayBuffer paging)
  gitActions.ts      git write ops via CLI — Phase 2
  ai/provider.ts     AIProvider abstraction — Phase 3
web/                 Webview (browser context)
  renderer/canvas.ts Canvas virtualised renderer
  index.ts           entry, postMessage handling
docs/specs/          Algorithm specs (System Contracts style)
docs/adr/            Architecture decision records
docs/plan/           Project plan
```

### Read/write split

- **Read path** (hot): Rust → gitoxide → direct ODB access. Never spawn git for reads.
- **Write path** (cold): TypeScript → `child_process.spawn('git', …)`. Never use a git library for writes.

---

## Build & test commands

```bash
# Rust
cargo build --workspace
cargo test --workspace                     # golden tests are #[ignore] — that's expected
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings -A clippy::todo

# TypeScript
pnpm install
pnpm run build                             # produces dist/extension.js + dist/webview.js
pnpm run typecheck                         # both src/ and web/ tsconfigs
pnpm run lint

# Native addon (build .node for current platform)
pnpm run build:napi:debug                  # debug build
pnpm run build:napi                        # release build
```

---

## Commit & doc conventions

- **Conventional Commits**: `feat:`, `fix:`, `perf:`, `docs:`, `test:`, `chore:`, `refactor:`
- Scope: `(core)`, `(napi)`, `(ext)`, `(web)`, `(ci)`, `(docs)`
- Examples: `feat(core): implement log walk using gitoxide` · `perf(web): virtualise renderer`
- Docs in `docs/adr/` for every non-obvious architectural decision.
- Docs in `docs/specs/` for every cross-layer algorithm contract.

---

## Key docs to read

- `docs/plan/project-plan.md` — full project plan (milestones, risks, tech choices)
- `docs/specs/layout-spec.md` — layout algorithm specification (before touching `layout.rs`)
- `docs/adr/` — rationale for gitoxide, napi, read/write split, clean-room approach
- `CONTRIBUTING.md` — dev setup + clean-room workflow + PR checklist
- `PROGRESS.md` — current milestone status

---

## GitHub Actions — commit-hash pinning rule

Every `uses:` line in `.github/workflows/` **must** use a full 40-char commit SHA,
never a floating tag. Keep the version tag as an inline comment:

```yaml
- uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5
```

To resolve a SHA when adding or upgrading an action:

```bash
# Tag-based action:
gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq '.object.sha'
# If type == "tag" (annotated), dereference: gh api repos/.../git/tags/<sha> --jq '.object.sha'
# Branch-based (e.g. dtolnay/rust-toolchain@stable):
gh api repos/<owner>/<repo>/git/ref/heads/<branch> --jq '.object.sha'
```

---

## napi prebuild note

The `.node` native addon must be prebuilt for all 4 targets in CI *early* (M1, not at
release time). This is called out as a top risk in the project plan. The CI workflow is at
`.github/workflows/build-napi.yml`. Validate it by M1 — don't defer.
