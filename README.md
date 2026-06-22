# Git Braid

> High-performance, AI-assisted git graph visualisation for VS Code.

**Status:** Pre-MVP · Phase 0 in progress · [See PROGRESS.md](./PROGRESS.md)

---

## Why another git graph extension?

VS Code's current options each have a gap:

| Option | Strength | Gap |
|--------|----------|-----|
| Git Graph (mhutchie) | Intuitive UI, complete operations | ~5 years unmaintained, no open-source licence, slow on large repos |
| VS Code built-in (1.93+) | Official, zero-install | Feature-light, no AI |
| GitLens | Deep editor integration | Monolithic, graph is one feature among many, commercial |

**Git Braid** fills the gap: a focused, lightweight extension that is fast on
huge repos *and* brings AI-assisted history understanding.

Two core differentiators:
1. **Performance** — 10k–100k commit repos remain smooth. Rust core reads the
   git object database directly (via [gitoxide](https://github.com/Byron/gitoxide));
   a Canvas virtualised renderer paints only the visible window.
2. **AI assistance** — semantic commit search, PR/release-notes generation,
   merge-conflict context summaries. Uses VS Code's Language Model API (no key
   required) with a BYO-key fallback.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Webview (Browser — Canvas virtualised renderer)          │
│  web/renderer/canvas.ts · web/index.ts                    │
└───────────────▲──────────────────┬───────────────────────┘
                │ binary ArrayBuffer│ postMessage (user actions)
┌───────────────┴──────────────────▼───────────────────────┐
│  Extension Host (Node.js / TypeScript)                    │
│  src/extension.ts · src/webviewBridge.ts                  │
│  src/gitActions.ts (write ops) · src/ai/provider.ts       │
└───────────────▲──────────────────┬───────────────────────┘
                │ napi-rs FFI       │ child_process (git CLI)
┌───────────────┴──────────┐  ┌────▼──────────────────────┐
│  Rust core (native addon) │  │  git CLI (write ops only) │
│  crates/core/             │  │  checkout · merge · …     │
│  · walk.rs  (gitoxide)   │  └───────────────────────────┘
│  · layout.rs (pure fn)   │
│  · serialize.rs (binary) │
└──────────────────────────┘
```

**Read/write split** (key design decision): the hot read path (log walk +
layout) runs in Rust for maximum performance. All write operations shell out
to the `git` CLI — git's own binary handles hooks, submodules, and config
edge cases correctly.

---

## Technology stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Rust core | Rust + gitoxide (`gix`) | Pure Rust; direct ODB read without subprocess |
| FFI | napi-rs (native addon) | Direct file-system access; highest performance |
| Write ops | `git` CLI via `child_process` | Correctness; avoids reimplementing edge cases |
| Extension | TypeScript + VS Code Extension API | Required by the platform |
| Renderer | Canvas 2D (→ WebGL for extreme scale) | Virtualised; no DOM node per commit |
| Binary protocol | Custom flat ArrayBuffer | Zero GC pressure in the render loop |
| AI | `vscode.lm` API + BYO-key fallback | User's existing subscription; no key management |
| Tests | `cargo test` + Criterion benchmarks; Vitest | Performance regressions gated in CI |
| CI | GitHub Actions (multi-platform napi prebuild) | darwin-arm64/x64, linux-x64, win-x64 |

---

## Development quickstart

**Prerequisites:** Rust 1.80+, Node.js 20+, pnpm 9+.

```bash
# Clone
git clone https://github.com/TBD/vscode-git-braid
cd vscode-git-braid

# Install JS dependencies
pnpm install

# Build the TypeScript extension + webview
pnpm run build

# Run Rust tests (golden tests are #[ignore] until M1)
cargo test --workspace

# Check Rust formatting + lints
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings -A clippy::todo

# Type-check TypeScript
pnpm run typecheck

# Lint TypeScript
pnpm run lint

# Run in VS Code Extension Development Host
# Press F5 in VS Code, then run "Git Braid: Open Graph" from the command palette.
```

### Build the native addon locally

```bash
# Requires the napi-rs CLI (installed via pnpm)
pnpm run build:napi:debug
```

---

## Project roadmap

| Milestone | Description | Status |
|-----------|-------------|--------|
| M0 | Rust core: gitoxide log walk + topo sort | 🔲 |
| M1 | Layout algorithm + napi binding | 🔲 |
| **M2** | **Canvas virtualised renderer — MVP demo** | 🔲 |
| M3 | Commit detail / diff / refs / find | 🔲 |
| M4 | Write operations + context menu | 🔲 |
| M5 | First AI feature (release-notes generation) | 🔲 |
| M6 | Marketplace publish (preview) | 🔲 |

> **M2 is the go/no-go gate.** If the MVP demo is not compelling, the project
> stops. See [PROGRESS.md](./PROGRESS.md) for current status.

---

## Clean-room notice

Git Braid is a **clean-room reimplementation** of the Git Graph concept. It is
**not** a fork of any existing extension. See [CONTRIBUTING.md](./CONTRIBUTING.md)
for the clean-room development policy.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). All contributors must follow the
clean-room discipline and sign off commits under the MIT licence.

---

## Licence

[MIT](./LICENSE) © Git Braid contributors
