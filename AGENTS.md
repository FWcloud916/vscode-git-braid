# Git Braid — Claude Code guide

This file is read by Claude Code at the start of every session. It tells you
what this project is, what the hard constraints are, and where things live.

---

## What this project is

A VS Code extension that visualises git history. Two differentiators:
1. **Performance on large repos** — Rust core (gitoxide) + Canvas virtualised renderer.
2. **AI-assisted history** — semantic search, PR/release-notes generation, conflict context.

Current phase: see **[PROGRESS.md](./PROGRESS.md)** — always the live status; do not
trust phase claims hardcoded elsewhere.

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

## Architecture and code map

See **[docs/architecture.md](docs/architecture.md)** for the full architecture
record: component diagram, data-flows (read / write / AI), binary protocol,
tech-stack table, and hard-constraint rationale.

See **[docs/CODEMAP.md](docs/CODEMAP.md)** for the per-file reference: one
entry for every core file with its purpose, layer, and key symbols, plus
"where do I change X?" task tables.

---

## Build & test commands

```bash
# Rust
cargo build --workspace
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings

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

Conventional Commits with scopes `(core)`, `(napi)`, `(ext)`, `(web)`, `(ci)`, `(docs)`.
See **[docs/guides/doc-conventions.md](docs/guides/doc-conventions.md)** for the full policy:
commit scope examples, rustdoc/TSDoc rules, doc language policy, and when to write an ADR vs spec.

---

## Key docs to read

- `docs/architecture.md` — full architecture: diagrams, data-flows, tech stack, constraints
- `docs/CODEMAP.md` — per-file reference + "where do I change X?" tables
- `docs/ai/README.md` — AI subsystem hub: feature→file map, privacy model, configuration
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

The `.node` native addon is prebuilt for all 4 targets in CI — the workflow lives at
`.github/workflows/build-napi.yml`. When adding a target or touching the napi surface,
keep that workflow green; packaging (`pnpm run package`) vendors the release build.
