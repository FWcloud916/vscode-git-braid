# Contributing to Git Braid

Thank you for considering a contribution! Please read this document before
opening an issue or pull request.

---

## Table of contents

1. [Development setup](#1-development-setup)
2. [Clean-room policy](#2-clean-room-policy)
3. [Commit conventions](#3-commit-conventions)
4. [Branch and PR workflow](#4-branch-and-pr-workflow)
5. [PR checklist](#5-pr-checklist)
6. [Performance-sensitive PRs](#6-performance-sensitive-prs)
7. [Documentation standards](#7-documentation-standards)
8. [Licence sign-off](#8-licence-sign-off)

---

## 1. Development setup

**Prerequisites:** Rust 1.80+, Node.js 20+, pnpm 9+.

```bash
# 1. Clone
git clone https://github.com/FWcloud916/vscode-git-braid
cd vscode-git-braid

# 2. Install JS dependencies
pnpm install

# 3. Build TypeScript
pnpm run build

# 4. Run Rust tests
cargo test --workspace
# 5. Check Rust
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings

# 6. Build native addon (for napi work)
pnpm run build:napi:debug

# 7. Regenerate bindings/napi/index.d.ts (only needed after changing #[napi] exports)
pnpm run gen-dts:napi
```

> **`index.d.ts` is committed.** Normal `build:napi` / `build:napi:debug` runs
> redirect napi's generated d.ts to `_napi.d.ts.tmp` so they never overwrite the
> committed file. Only run `gen-dts:napi` intentionally, after updating Rust
> `#[napi]` exports or their `///` doc comments.

**VS Code development host:** Press **F5** in VS Code. Then open the command
palette and run **Git Braid: Open Graph**.

---

## 2. Clean-room policy

Git Braid is a **clean-room reimplementation**. The original Git Graph extension
has no open-source licence: viewing its source is fine; using, copying, or
adapting it is not.

**Rules:**

1. **Never open or reference the original extension's source code** while
   working on this project. If you have the source open in another window, close
   it first.
2. Before implementing any user-visible behaviour, write a **behaviour spec** in
   `docs/specs/` that describes only what you observed from running the
   extension, not from reading its code. The spec is the clean-room barrier.
3. **The git commit log is your evidence chain.** Every commit should be
   self-contained and describe what you did and why, without referencing the
   original source.
4. If you are unsure whether something crosses the line, ask before writing code.

See also `docs/adr/0001-clean-room-not-fork.md` for the full rationale.

---

## 3. Commit conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

```
<type>(<scope>): <subject>

[optional body]

[optional footer: BREAKING CHANGE, closes #N]
```

**Types:**

| Type | Use for |
|------|---------|
| `feat` | New feature or user-visible behaviour |
| `fix` | Bug fix |
| `perf` | Performance improvement (always include benchmark numbers in body) |
| `docs` | Documentation only |
| `test` | Adding or fixing tests |
| `refactor` | Code change that is neither a fix nor a feature |
| `chore` | Tooling, deps, CI, build |
| `ci` | CI workflow changes |

**Scopes:**

| Scope | Area |
|-------|------|
| `core` | `crates/core/` — Rust layout engine |
| `napi` | `bindings/napi/` — native addon |
| `ext` | `src/` — TypeScript extension host |
| `web` | `web/` — webview renderer |
| `ci` | `.github/workflows/` |
| `docs` | Documentation and specs |

**Examples:**

```
feat(core): implement gitoxide log walk with topo-order sort
perf(web): virtualise canvas renderer — 60fps on 10k commits
fix(ext): handle detached HEAD in webview panel title
docs(specs): add stash behaviour spec
chore(ci): add darwin-arm64 to napi prebuild matrix
```

---

## 4. Branch and PR workflow

```
main             — always green; direct push protected
feat/<name>      — feature branches
fix/<name>       — bug fixes
perf/<name>      — performance work
docs/<name>      — documentation only
chore/<name>     — tooling / build
```

- Open a PR against `main`.
- Keep PRs focused — one concern per PR.
- Link related issues in the PR description.
- For large features (e.g. full M1 layout engine), prefer a series of small PRs
  over one big one.

---

## 5. PR checklist

Before requesting review, confirm all items are green:

- [ ] `cargo fmt --all -- --check` passes
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` passes
- [ ] `cargo test --workspace` passes (ignored tests expected)
- [ ] `pnpm run typecheck` passes (both `tsconfig.json` and `tsconfig.web.json`)
- [ ] `pnpm run lint` passes
- [ ] `pnpm run build` produces `dist/extension.js` and `dist/webview.js`
- [ ] New public Rust types have `///` rustdoc comments
- [ ] New public TypeScript exports have `/** */` JSDoc comments
- [ ] If you changed cross-layer data contracts in `model.rs`, you updated
  `serialize.rs`, `webviewBridge.ts`, and `canvas.ts` accordingly

---

## 6. Performance-sensitive PRs

Any PR that touches `crates/core/src/layout.rs`, `crates/core/src/walk.rs`,
or `web/renderer/canvas.ts` must include benchmark results.

```bash
# Run benchmarks
cargo bench --package git-braid-core

# Compare against baseline (once implemented)
cargo bench --package git-braid-core -- --baseline main
```

Performance targets (plan §6.1):

| Metric | Target | Repo size |
|--------|--------|-----------|
| First paint | < 500ms | 10k commits |
| Scroll frame rate | stable 60fps | 10k–100k |
| Batch load latency | < 100ms | any |

A PR that regresses these numbers on a CI run will not be merged without a
documented justification.

---

## 7. Documentation standards

See `docs/guides/doc-conventions.md` for the full rules. Summary:

- **ADR** for every non-obvious architectural decision. Template: `docs/adr/template.md`.
- **Spec** (System Contracts) for every cross-layer algorithm. Template: `docs/guides/spec-template.md`.
- Public Rust items: rustdoc (`///`) on every `pub` item in `model.rs`, `layout.rs`, `walk.rs`.
- Public TypeScript exports: JSDoc (`/** */`).
- Docs files: language is **English** for public-facing docs;
  existing Chinese planning docs in `docs/plan/` and `docs/specs/` may stay in Traditional Chinese.

---

## 8. GitHub Actions — commit-hash pinning

All `uses:` entries in `.github/workflows/` **must** reference a full commit SHA,
not a floating version tag. This prevents supply-chain attacks where a tag is
silently moved to malicious code.

**Format** — full 40-char SHA, version tag as inline comment:

```yaml
- uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5
```

**Never** write:
```yaml
- uses: actions/checkout@v5   # ← forbidden: tag can be moved
```

### Resolving a SHA for a new action or version bump

```bash
# For a tag (most actions):
gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq '.object.sha'
# If the result type is "tag" (annotated), dereference once more:
gh api repos/<owner>/<repo>/git/tags/<sha> --jq '.object.sha'

# For a branch ref (e.g. dtolnay/rust-toolchain@stable):
gh api repos/<owner>/<repo>/git/ref/heads/<branch> --jq '.object.sha'
```

Current pinned SHAs are in the workflow files. Bump them together with any
version upgrade (`chore(ci):` commit, same PR as the action version change).

---

## 9. Licence sign-off

By contributing, you agree that your contribution is licensed under the
[MIT License](./LICENSE) and that you have the right to make that contribution.

All commits must be made under your real identity. Add a sign-off line if
your employer requires DCO:

```
Signed-off-by: Name <email@example.com>
```
