# Changelog

All notable changes to Git Braid will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.2.4] — 2026-07-07

### Added
- **Checkout remote branches from the graph context menu** — right-clicking a
  commit whose only ref is a remote branch (e.g. `origin/feature-x`) now
  offers `Checkout origin/feature-x`, which creates a local tracking branch
  and switches to it. Local-branch and detached-HEAD checkout are unchanged.

## [0.2.3] — 2026-07-01

### Changed
- **Ref chips now use the commit's lane colour** instead of a fixed colour
  per ref kind (local branch, remote branch, HEAD, stash), so a branch chip
  visually matches the graph line it's attached to. Tags keep a fixed
  colour, chosen outside the 16-colour lane palette so a tag is never
  mistaken for a lane.
- **Ref kind is now shown via icon** rather than colour: remote branches get
  a fetch/download glyph and stashes get a stacked-bars glyph, alongside the
  existing tag and local-branch/HEAD icons.
- **Chip layout polish** — solid separators now divide the icon from the
  label, and the label from the new cloud icon marking a remote-tracked
  branch (replacing the previous plain dot).

## [0.2.2] — 2026-07-01

### Changed
- **Expanded graph lane palette from 8 to 16 colours** — adds amber, lime,
  teal, sky, indigo, violet, magenta, and rose at palette indices 8–15,
  using the same saturation and lightness band as the original 8 colours.
  Repositories with more than 8 concurrent branches now cycle through
  twice as many distinct colours before repeating. Existing graphs are
  visually unchanged (indices 0–7 are preserved).

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

[Unreleased]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/FWcloud916/vscode-git-braid/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/FWcloud916/vscode-git-braid/releases/tag/v0.1.0
