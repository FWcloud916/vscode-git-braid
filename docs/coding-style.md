# Git Braid — Coding Style

> **Type:** Reference / How-to
> **Audience:** Developers, AI assistants, code reviewers
> **Last updated:** 2026-07-07
>
> Linter-enforced rules for both toolchains, generated from the project's own
> configuration. Team conventions the linter cannot check live in
> [guides/doc-conventions.md](guides/doc-conventions.md) and
> [../CONTRIBUTING.md](../CONTRIBUTING.md) — this file links, not duplicates.
>
> Configuration source: `eslint.config.mjs`, `.prettierrc.json`, `rustfmt.toml`,
> `clippy.toml`, `.editorconfig`
>
> **Terminology:** RFC 2119 keywords — **MUST** (mandatory), **SHOULD** (recommended),
> **MAY** (optional).

---

## 1. Linter Overview

Two toolchains, both gated in CI:

| Toolchain | Tools | Scope |
|---|---|---|
| TypeScript | ESLint (flat config, `@typescript-eslint`) + Prettier | `src/` (extension host, `tsconfig.json`) and `web/` (webview, `tsconfig.web.json`) — separate config blocks |
| Rust | rustfmt + clippy (`-D warnings`) | entire cargo workspace (`crates/core`, `bindings/napi`) |

`.editorconfig` sets the shared baseline: UTF-8, LF, final newline, trimmed trailing
whitespace; 2-space indent for TS/JS/JSON/YAML/TOML/MD, 4-space for Rust, tabs in Makefiles.

## 2. Linter Rules Summary

**TypeScript (both `src/` and `web/`)** — on top of `@typescript-eslint` recommended:

| Rule | Level | Value |
|---|---|---|
| `@typescript-eslint/no-explicit-any` | error | `any` is banned |
| `@typescript-eslint/no-unused-vars` | error | unused args allowed only with `_` prefix |
| `no-console` | warn (src only) | `console.warn`/`console.error` allowed |

**Webview only (`web/`)** — enforces the architecture boundary:

| Rule | Level | Why |
|---|---|---|
| `no-restricted-globals`: `require` | error | webview MUST use ES module imports — no Node API access |
| `no-restricted-globals`: `process` | error | webview has no Node.js `process` |

**Prettier**: `printWidth` 100, 2-space indent, semicolons, double quotes,
trailing commas everywhere, `arrowParens: always`.

**rustfmt** (`rustfmt.toml`): edition 2021, `max_width` 100. ⚠️ `imports_granularity =
Module` and `group_imports = StdExternalCrate` are configured but **inert on the stable
toolchain** — rustfmt warns they are nightly-only and ignores them (verified 2026-07-07,
rustfmt from rustc 1.92 stable). Import grouping is therefore convention, not enforced.

**clippy**: default deny list via `-D warnings`, no overrides (the former
`-A clippy::todo` allowance was removed once the last `todo!()` stub was implemented —
see `clippy.toml`).

## 3. Project-Specific Code Examples

Not duplicated here — [CODEMAP.md](CODEMAP.md) §"Core files reference" annotates every
core file, and [specs/](specs/) hold the behaviour contracts worth imitating.

## 4. Team Conventions (Not Enforced by the Linter)

See [guides/doc-conventions.md](guides/doc-conventions.md): Conventional Commits with
scopes `(core)`/`(napi)`/`(ext)`/`(web)`/`(ci)`/`(docs)`, rustdoc/TSDoc rules, doc
language policy, and the ADR-vs-spec decision guide.

## 5. Architecture Conventions

- The webview MUST NOT call Node or VS Code APIs directly — enforced by the ESLint
  `no-restricted-globals` block above; the message-passing boundary is described in
  [architecture.md](architecture.md) §2–3.
- Reads never spawn a subprocess; write operations shell out to the `git` CLI —
  [architecture.md](architecture.md) §5 (read/write split).
- Layout code MUST preserve the invariants in [specs/layout-spec.md](specs/layout-spec.md)
  §5 — see the hard-constraints table in [../AGENTS.md](../AGENTS.md).

## 6. Running the Linter (Pre-merge)

```bash
# TypeScript
pnpm run lint            # eslint src web
pnpm run lint:fix        # eslint src web --fix
pnpm run typecheck       # tsc --noEmit (both tsconfigs)

# Rust
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

## 7. References

- [`eslint.config.mjs`](../eslint.config.mjs) · [`.prettierrc.json`](../.prettierrc.json)
- [`rustfmt.toml`](../rustfmt.toml) · [`clippy.toml`](../clippy.toml)
- [`.editorconfig`](../.editorconfig)
- [CONTRIBUTING.md](../CONTRIBUTING.md) — dev setup, clean-room workflow, PR checklist
