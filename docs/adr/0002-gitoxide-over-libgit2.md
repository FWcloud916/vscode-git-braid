# ADR-0002: Use gitoxide (gix) for the git read path

**Date:** 2026-06-22
**Status:** Accepted

---

## Context

The Rust core needs a library to read the git object database (ODB):
walk commits, resolve refs, read object metadata. Two mature options exist:

| | gitoxide (`gix`) | libgit2 bindings (`git2-rs`) |
|---|---|---|
| Implementation | Pure Rust | C library (libgit2) via FFI bindings |
| Compilation | No C toolchain needed; cross-compiles cleanly | Requires C build toolchain |
| WASM target | Possible (pure Rust) | Difficult (C FFI) |
| Log-walk performance | Designed for high-throughput traversal | Mature but C FFI boundary overhead |
| Read-path maturity | Complete | Complete |
| Write-path maturity | Still developing (2025) | Complete |

Our core constraint: we **only use this library for reads**. Write operations
(checkout, merge, …) are handled by shelling out to the `git` CLI.
This makes the write-path immaturity of gitoxide irrelevant.

---

## Decision

Use **gitoxide (`gix`)** for the git read path in `crates/core/src/walk.rs`.

---

## Consequences

**Positive:**
- No C toolchain dependency — simpler CI, fewer platform edge cases.
- Log-walk is architecturally optimised for the traversal workload we need.
- Pure Rust opens the path to a future WASM build (e.g. running layout in
  the webview for further latency reduction).
- Single-language codebase for the Rust core.

**Negative / trade-offs:**
- gitoxide is newer than libgit2 and some edge cases may not be handled.
- If a read-path gap is found, we fall back to `git log` CLI for that specific
  operation (not ideal, but acceptable for edge cases).

**Neutral / follow-up:**
- Track gitoxide release notes for any breaking API changes.
- If a needed read feature is missing, open an issue in the gitoxide repo
  before falling back to CLI — the project is very active.
