# Changelog

All notable changes to Git Braid will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.2.1] — 2026-06-23

### Fixed
- Exclude `media/logo.png` and `RELEASING.md` from the packaged `.vsix` to
  reduce bundle size.

## [0.2.0] — 2026-06-23

### Added
- **Tag-driven stable/pre-release publish** — clean `vX.Y.Z` tags publish a
  stable Marketplace release; suffixed tags (`vX.Y.Z-rc.N`, `-beta.N`) publish
  a pre-release. Previously all `v*` tags forced `--pre-release`.
- **`RELEASING.md`** — release runbook covering prerequisites, tag convention,
  versioning policy, and step-by-step checklist.

## [0.1.2] — 2026-06-23

### Added
- **Status-bar open button** — a persistent `$(git-branch) Git Braid` item in
  the VS Code status bar (bottom-left) that opens the graph from any context;
  single-repo workspaces open directly with no picker.
- **Editor tab icon** — the Git Braid panel tab now shows `media/icon.png`
  instead of the generic file icon, making it easy to identify in multi-tab layouts.
- **Startup activation** — extension now activates on `onStartupFinished` so the
  status-bar button is visible from the first window without needing to run a command first.

## [0.1.1] — 2026-06-23

### Added
- **Graph toolbar** — branch switcher dropdown (searchable, with `✓`/`★` glyphs),
  remote toggle, fetch (`git fetch --all --prune`), and refresh buttons.
- **Ref rendering** — branch/tag icons on commit chips; local+remote refs collapsed
  into a single chip with a remote-mark dot.
- **Auto-refresh** — `FileSystemWatcher` debounces on HEAD/refs/packed-refs (300 ms)
  and reloads the graph on local git changes.
- `web/ui/branchDropdown.ts` — standalone searchable branch dropdown component
  replacing the native `<select>`; keyboard-navigable, CSP-safe.

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

[Unreleased]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/FWcloud916/vscode-git-braid/releases/tag/v0.1.0
