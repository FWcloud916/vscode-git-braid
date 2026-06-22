# Changelog

All notable changes to Git Braid will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.1.0] — 2026-06-23 (pre-release)

### Added
- **Git graph viewer** (`gitBraid.openGraph`) — virtualised Canvas renderer with
  lane layout, HEAD marker, and commit detail panel (author, date, message, files).
- **Copy commit info** — context-menu actions to copy hash, subject, or full
  message for any commit.
- **Git write operations** — rebase, reset, stash pop, merge, cherry-pick, revert,
  and conflict surfacing via the `gitBraid.*` command palette.
- **AI release notes** (`gitBraid.generateReleaseNotes`) — LLM-powered release
  notes from a ref range; supports VS Code built-in LM API and BYO API keys
  (Anthropic, OpenAI); opt-in with per-run disclosure.
- **Rust core** (gitoxide) — high-performance log walk, lane layout, binary
  serialisation, semantic commit search, and ref listing; all reads are gitoxide
  only (no `git` subprocess spawned on the read path).
- **napi-rs native addon** — 4-platform prebuild matrix (darwin-arm64,
  darwin-x64, linux-x64-gnu, win32-x64-msvc); TypeScript declarations
  auto-generated from Rust doc comments.
- Initial project scaffold: Rust workspace, TypeScript extension host, webview
  renderer, CI workflows, ADRs, and spec documentation.

[Unreleased]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/FWcloud916/vscode-git-braid/releases/tag/v0.1.0
