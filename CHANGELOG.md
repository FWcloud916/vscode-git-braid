# Changelog

All notable changes to Git Braid will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- Initial project scaffold: Rust workspace (`crates/core`, `bindings/napi`),
  TypeScript extension host (`src/`), webview renderer skeleton (`web/`).
- `crates/core/src/model.rs`: cross-layer System Contract types
  (`CommitIn`, `RowLayout`, `Segment`, `BoundaryState`, `LaneEntry`).
- `crates/core/src/layout.rs`: `layout()` function stub with full rustdoc
  invariant documentation (append-only stability, determinism, no lane shift).
- `crates/core/tests/golden.rs`: spec §9 golden test and invariant tests
  (marked `#[ignore]` until M1 implementation).
- `src/extension.ts`: `gitBraid.openGraph` command registration.
- `src/webviewBridge.ts`: webview panel creation with binary protocol skeleton.
- Canvas virtualised renderer stub (`web/renderer/canvas.ts`).
- CI: `ci.yml` (Rust + TypeScript checks) and `build-napi.yml`
  (4-platform native addon prebuild matrix).
- Documentation: `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `PROGRESS.md`.
- ADRs: clean-room rationale, gitoxide choice, napi choice, read/write split.
- Docs: spec template, doc conventions guide, docs index.

[Unreleased]: https://github.com/TBD/vscode-git-braid/compare/HEAD
