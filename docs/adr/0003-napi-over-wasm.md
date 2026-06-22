# ADR-0003: Use napi-rs native addon over WASM

**Date:** 2026-06-22
**Status:** Accepted

---

## Context

The Rust core (`crates/core`) must be exposed to the TypeScript extension host.
Two mechanisms are viable:

| | napi-rs (native `.node` addon) | WASM |
|---|---|---|
| Runs in | Extension Host (Node.js) | Host or webview |
| Filesystem / ODB access | Direct (maximum speed) | Must feed data in; awkward |
| Distribution | Per-platform `.node` prebuilds (4 targets) | Single `.wasm` binary, cross-platform |
| Performance | Maximum | High, slightly lower |
| Build complexity | Cross-compile CI matrix | Simpler distribution |

Our primary constraint: the Rust core reads `.git` directly from disk.
A native addon in the Extension Host process has direct file-system access
and can call `gix::open()` on any path. WASM in the webview sandbox has
no file-system access and would require the host to pipe all ODB data in,
adding latency and complexity.

The development machine is **darwin-arm64**. The prebuild matrix must also
cover `darwin-x64`, `linux-x64-gnu`, and `win32-x64-msvc`.

---

## Decision

Use **napi-rs** to compile the Rust core to a platform-native `.node` addon
loaded by the Extension Host process.

Keep the WASM path available in the future: since gitoxide is pure Rust, a
`crates/core` WASM build is possible. The door is left open for moving the
layout algorithm into the webview as a WASM module if that reduces latency
in a later phase.

---

## Consequences

**Positive:**
- Direct file-system access: no data-piping ceremony, lowest possible latency.
- Maximum Rust ↔ Node throughput (no JS ↔ WASM boundary overhead for large buffers).
- napi-rs is well-supported in the VS Code extension ecosystem.

**Negative / trade-offs:**
- Must maintain a 4-target prebuild matrix in CI (darwin-arm64/x64, linux-x64, win32-x64).
- Adds CI complexity and requires GitHub Actions build matrix to work correctly.
- **This must be validated in M1, not deferred** (top risk in project plan §9).

**Neutral / follow-up:**
- Future option: move `layout.rs` alone into a WASM module loaded by the
  webview. This would eliminate one round-trip (webview → host → Rust → host → webview)
  for layout recalculations. Evaluate at M3.
