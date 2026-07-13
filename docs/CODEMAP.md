# Git Braid — Code map

> **Primary purpose:** navigate to the right file in under 30 seconds.
>
> For the full architecture narrative, see [docs/architecture.md](./architecture.md).
> For the AI subsystem, see [docs/ai/README.md](./ai/README.md).

---

## Layer → directory → responsibility

| Layer | Directory | What lives here |
|---|---|---|
| Rust core | `crates/core/src/` | git ODB walk, graph layout, binary serialisation, data types |
| CLI demo | `crates/core/src/bin/` | `braid-log` — M0 CLI for manual testing |
| Benchmarks | `crates/core/benches/` | Criterion perf benchmarks |
| FFI binding | `bindings/napi/src/` | napi-rs thin adapter: JS ↔ Rust |
| FFI types | `bindings/napi/index.d.ts` | Auto-generated TypeScript declarations |
| Extension host | `src/` | VS Code commands, webview manager, write ops, AI subsystem |
| AI subsystem | `src/ai/` | AIProvider abstraction, release-notes feature |
| Webview | `web/` | Browser-side canvas renderer, message protocol client |

---

## Feature → file(s) → key symbol(s)

| Feature | File(s) | Key symbol(s) |
|---|---|---|
| Log walk (gitoxide) | `crates/core/src/walk.rs` | `walk_commits`, `discover_repo`, `find_commits`, `list_refs`, `walk_range` |
| Graph layout | `crates/core/src/layout.rs` | `layout(commits, boundary)` → `(Vec<RowLayout>, BoundaryState)` |
| Binary serialisation (BRAI v2) | `crates/core/src/serialize.rs` | `encode_batch`, `decode_batch` |
| Data contracts (types) | `crates/core/src/model.rs` | `CommitIn`, `RowLayout`, `Segment`, `CommitMeta`, `BoundaryState`, `RangeCommit` |
| napi binding | `bindings/napi/src/lib.rs` | `get_graph_batch`, `get_commit_detail`, `get_blob`, `find_commits`, `list_refs`, `walk_range` |
| Extension activation | `src/extension.ts` | `activate`, `deactivate`, `resolveRepos`, `pickRepo`, `openRepo` |
| Nested/sibling repo scan | `src/repoScan.ts` | `collectRepoRoots`, `isRepoRoot`, `listChildDirs` |
| Host ↔ webview protocol | `src/webviewBridge.ts` | `WebviewBridge` class, `_handleMessage`, `_sendBatch` |
| Git write operations | `src/gitActions.ts` | `checkout`, `merge`, `rebase`, `createBranch`, `deleteBranch`, … |
| Diff viewer integration | `src/diffProvider.ts` | `GitBraidContentProvider`, `buildDiffUri` |
| AI provider abstraction | `src/ai/provider.ts` | `AIProvider`, `VscodeLmProvider`, `BYOKeyProvider` |
| Release-notes generation | `src/ai/releaseNotes.ts` | `buildMessages`, `generateReleaseNotes` |
| Release-notes command | `src/ai/releaseNotesCommand.ts` | `runReleaseNotesCommand` |
| Canvas renderer | `web/renderer/canvas.ts` | `CanvasRenderer`, `appendRows`, `_paint` |
| BRAI v2 decoder (browser) | `web/renderer/decode.ts` | `decodeBatch`, `DecodedRow`, `shortOid` |
| Webview entry / message loop | `web/index.ts` | `init`, message handler, paging state |
| Date formatting | `web/format.ts` | `formatRelative` |
| Context menu | `web/ui/contextMenu.ts` | `showContextMenu`, `MenuItem` |
| Branch dropdown | `web/ui/branchDropdown.ts` | `createBranchDropdown`, `BranchDropdown`, `BranchDropdownItem` |
| Repo dropdown | `web/ui/repoDropdown.ts` | `createRepoDropdown`, `RepoDropdown`, `RepoDropdownItem` |

---

## "I want to change / fix X" — start here

| Task | Go to |
|---|---|
| Change how commits are walked / sorted | `crates/core/src/walk.rs` — `walk_commits` |
| Change lane / colour assignment | `crates/core/src/layout.rs` — `layout()` |
| Change the binary wire format | `crates/core/src/serialize.rs` **and** `web/renderer/decode.ts` (keep in sync) |
| Add a new napi-exported function | `bindings/napi/src/lib.rs`, then run `pnpm run gen-dts:napi` |
| Register a new VS Code command | `src/extension.ts` `activate()` + `package.json` `contributes.commands` |
| Change host ↔ webview message shapes | `src/webviewBridge.ts` **and** `web/index.ts` message handler (keep in sync) |
| Add a git write operation | `src/gitActions.ts` + wire up in `src/webviewBridge.ts` `_handleAction` |
| Change the diff viewer | `src/diffProvider.ts` |
| Add an AI provider | `src/ai/provider.ts` — `BYOProviderType` + `BYOKeyProvider.complete()` |
| Change the release-notes prompt | `src/ai/releaseNotes.ts` — `buildMessages()` |
| Change the release-notes command UX | `src/ai/releaseNotesCommand.ts` |
| Change Canvas rendering / colours | `web/renderer/canvas.ts` — `_paint()` |
| Change context menu items | `web/index.ts` — `buildMenuItems()` |
| Change toolbar branch dropdown | `web/ui/branchDropdown.ts` — `createBranchDropdown()` |
| Change toolbar repo dropdown / switching | `web/ui/repoDropdown.ts` — `createRepoDropdown()` **and** `src/extension.ts` `openRepo()` |
| Change nested/sibling repo discovery | `src/repoScan.ts` — `collectRepoRoots()` + `gitBraid.repoScanDepth` setting |
| Change graph branch/remote filter | `src/webviewBridge.ts` `_handleMessage` setFilter + `crates/core/src/walk.rs` `WalkOptions` |
| Add a VS Code setting | `package.json` `contributes.configuration` |
| Fix a CI / build issue | `.github/workflows/`, `bindings/napi/build.rs` |

---

## Core files reference

Each file with its purpose, layer, and key exported symbols.

---

### Rust core — `crates/core/src/`

#### `lib.rs`

**Layer:** Rust core
**Purpose:** Crate root — declares the four submodules and re-exports the most-used public API.
**Contents:**
- Declares `pub mod layout`, `pub mod model`, `pub mod serialize`, `pub mod walk`.
- Re-exports: `layout::layout`, all public types from `model`.
- Contains the crate-level architecture doc comment (data flow diagram, read-only contract).

---

#### `model.rs`

**Layer:** Rust core
**Purpose:** Authoritative data contracts shared across all layers — Rust core, napi binding, TS host, and webview.
**Contents:**
- `Oid = [u8; 20]` — 20-byte SHA-1 key.
- `ColorId = u8` — palette index.
- `CommitIn { oid, parents }` — input to the layout engine; geometry-pure.
- `RowLayout { oid, lane, color, segments, flags }` — output of the layout engine.
- `Segment { from_lane, to_lane, color, kind }` — one line segment between rows.
- `SegKind` — `Straight | MergeOut | ConvergeIn`.
- `RowFlags` — bitflags: `IS_MERGE`, `IS_ROOT`, `PARENT_OFFSCREEN`, `IS_TIP`, `IS_SYNTHETIC`, `IS_STASH`.
- `BoundaryState { lanes, next_color }` — minimal state for incremental layout continuation.
- `LaneEntry { waiting_for, color }` — one active-lane slot.
- `RefInfo { name, kind, oid }` — ref for the release-notes range picker.
- `RangeCommit { oid, subject, author_name, commit_time, files_changed, insertions, deletions }` — one commit for the AI prompt.
- `RefKind` — `LocalBranch | RemoteBranch | Tag | Head | Stash`.
- `RefLabel { name, kind }` — ref attached to a commit.
- `CommitMeta { oid, subject, author, commit_time, refs }` — human-facing fields (never influences geometry).

⚠️ **Do not change the shape of these types without updating `serialize.rs`, `bindings/napi/src/lib.rs`, `src/webviewBridge.ts`, and `web/renderer/canvas.ts`.**

---

#### `walk.rs`

**Layer:** Rust core (hot read path)
**Purpose:** Reads the git object database via gitoxide and produces topologically-ordered commit lists for the layout engine, find feature, AI range walk, and ref listing.
**Contents:**
- `SortOrder` — `TopoDate` (default, topo order ties broken by date) | `Date` (date order).
- `WalkOptions { order, limit, first_parent_only }` — walk configuration.
- `walk_commits(repo_path, opts)` — full walk; returns `(Vec<CommitIn>, Vec<CommitMeta>)`. Two-pass: topology first (borrows `repo.objects`), metadata second.
- `find_commits(repo_path, query, opts, max_results)` — case-insensitive substring match over subjects/authors/OID hex prefix. Returns `Vec<FindMatch>`.
- `FindMatch { oid, row_index, subject, author, commit_time }` — search hit.
- `list_refs(repo_path)` — local branches + tags only (no HEAD/stash/remotes); sorted branches-first alphabetically.
- `walk_range(repo_path, from_rev, to_rev, include_diff_stat)` — `from..to` walk for AI; diffstat is approximate newline count.
- `discover_repo(path)` — upward directory search via gitoxide; returns worktree root or `None`.
- **No subprocess is ever spawned from this file.**

---

#### `layout.rs`

**Layer:** Rust core
**Purpose:** Pure graph layout engine — assigns lanes and colours to commits, produces line segments for the gap between rows.
**Contents:**
- `PALETTE_SIZE: u32 = 16` — number of colours (must stay in sync with `web/renderer/canvas.ts PALETTE`).
- `layout(commits: &[CommitIn], boundary: Option<BoundaryState>) -> (Vec<RowLayout>, BoundaryState)` — the single public entry point.
- `LayoutState` — internal mutable working state: `lanes` (active-lane vector), `waiting_index` (OID → lane indices), `next_color`.
- Single-pass O(n · L) top-down scan. Eager convergence for invariant 5.
- **Critical invariants (never break):** Determinism (4), Append-only stability (5), No mid-life lane shift (2), First-parent straight (6). See `docs/specs/layout-spec.md`.

---

#### `serialize.rs`

**Layer:** Rust core
**Purpose:** Flat binary encoder/decoder for the host ↔ webview batch protocol (BRAI v2).
**Contents:**
- `encode_batch(rows: &[RowLayout], metas: &[CommitMeta]) -> Vec<u8>` — encodes a batch into a flat buffer with a 20-byte header, StringPool, CommitRow×N (56 B), RefRow×R (8 B), SegmentRow×M (8 B).
- `decode_batch(buf: &[u8]) -> Result<(Vec<RowLayout>, Vec<CommitMeta>), DecodeError>` — inverse; used in Rust tests.
- `DecodeError` — `TooShort | BadMagic | UnsupportedVersion | Malformed`.
- String deduplication via linear-scan `intern()` (insertion-order determinism).
- The JS counterpart is `web/renderer/decode.ts:decodeBatch`.

---

#### `bin/braid-log.rs`

**Layer:** CLI demo (M0)
**Purpose:** Thin CLI wrapper around `walk_commits` for manual correctness testing and timing.
**Contents:**
- `main()` — parses `--date`, `--first-parent`, `--limit N`, and optional `PATH` argument.
- Calls `walk_commits`, prints each commit as `index  oid7  parents…`.
- Prints elapsed time in milliseconds.
- Not used by the extension; purely for development / CI perf checking.

---

#### `benches/layout.rs`

**Layer:** Benchmarks
**Purpose:** Criterion performance benchmarks for the layout engine.
**Contents:**
- `linear_chain(n)` — synthetic linear commit chain.
- `bench_layout_linear` — benchmarks at 1k, 10k, 100k commits.
- Perf targets: first paint < 500ms for 10k commits, batch latency < 100ms.
- Run with: `cargo bench --package git-braid-core`.

---

### napi binding — `bindings/napi/`

#### `src/lib.rs`

**Layer:** FFI (napi-rs native addon)
**Purpose:** Thin adapter exposing Rust core functions to TypeScript. No business logic.
**Contents:**
- `discover_repo(path: String) -> Option<String>` — gitoxide repo discovery.
- `get_graph_batch(repo_path, offset, limit) -> napi::Result<Buffer>` — walk + layout + encode; returns BRAI v2 `Buffer`.
- `get_commit_detail(repo_path, oid_hex) -> CommitDetail` — full metadata + file list for the detail panel.
- `get_blob(repo_path, oid_hex) -> Buffer` — raw blob bytes for the diff viewer.
- `find_commits(repo_path, query, max_results) -> Vec<FindMatch>` — full-history search.
- `list_refs(repo_path) -> Vec<RefInfo>` — refs for the release-notes picker.
- `walk_range(repo_path, from_rev, to_rev, include_diff_stat) -> Vec<RangeCommit>` — AI range walk.
- napi-rs maps Rust `snake_case` fields to TypeScript `camelCase` automatically.

---

#### `build.rs`

**Layer:** FFI build
**Purpose:** One-liner that calls `napi_build::setup()` to emit platform-specific linker flags.
**Contents:** `main() { napi_build::setup(); }`

---

#### `index.d.ts`

**Layer:** FFI types
**Purpose:** Auto-generated TypeScript type declarations for all `#[napi]` exports.
**Contents:** `declare function discoverRepo`, `getGraphBatch`, `getCommitDetail`, `getBlob`, `findCommits`, `listRefs`, `walkRange`; interfaces `FileChange`, `CommitDetail`, `FindMatch`, `RefInfo`, `RangeCommit`.
**Do not edit by hand.** Regenerate with `pnpm run gen-dts:napi` after changing `bindings/napi/src/lib.rs`.

---

### Extension host — `src/`

#### `extension.ts`

**Layer:** Extension host
**Purpose:** VS Code extension entry point — registers commands and manages the single WebviewBridge instance.
**Contents:**
- `activate(context)` — registers five commands: `openGraph`, `selectRepo`, `find`, `generateReleaseNotes`, `clearAiKey`. Registers `GitBraidContentProvider`. Creates a left-aligned `StatusBarItem` (text `$(git-branch) Git Braid`) that runs `gitBraid.openGraph`; always visible from startup via `"activationEvents": ["onStartupFinished"]` in `package.json`.
- `deactivate()` — disposes the bridge.
- `resolveRepos()` — `async`. Two passes per workspace folder: upward via `discoverRepo` (gitoxide, folder-is-repo-or-subdir), and downward via `collectRepoRoots` (`repoScan.ts`) up to `gitBraid.repoScanDepth` levels for nested/sibling repos. Returns deduped repo roots. Exported for reuse by AI command. See `docs/adr/0007-nested-repo-scan.md`.
- `pickRepo(repos)` — single-repo shortcut or QuickPick. Exported for reuse by AI command.
- `openRepo(context, repoPath, repos?)` — disposes old bridge, creates a new `WebviewBridge` passing the discovered repo list and a switch callback `(root) => openRepo(context, root)` (re-invoked when the webview's repo dropdown or the `selectRepo` command picks a different repo).

---

#### `repoScan.ts`

**Layer:** Extension host (pure — no `vscode` import, unit-tested via `repoScan.test.ts`)
**Purpose:** Bounded-depth filesystem scan for nested/sibling git repositories, filling the gap the upward-only `discoverRepo` walk leaves (see `docs/adr/0007-nested-repo-scan.md`).
**Contents:**
- `collectRepoRoots(roots, maxDepth, deps)` — dependency-injected scan; stops descending once a directory is identified as a repo; deduplicates by canonical root.
- `RepoScanDeps` — `{ isRepoRoot(dir), childDirs(dir) }`, injected for testability.
- `listChildDirs(dir)` — real `fs.readdirSync` implementation; skips `node_modules`, `.git`, dot-dirs, and symlinked directories.
- `isRepoRoot(dir)` — real implementation; checks for a direct `.git` entry, then resolves the canonical root via `discoverRepo`.

---

#### `webviewBridge.ts`

**Layer:** Extension host
**Purpose:** Manages the VS Code WebviewPanel and all host ↔ webview message exchange.
**Contents:**
- `WebviewBridge` class with `reveal()`, `find()`, `dispose()`. Panel `iconPath` set to `media/icon.png` so the editor tab shows the Git Braid icon. Constructor takes `(context, repoPath, repos, onSelectRepo, onDispose)` — `repos` and `onSelectRepo` back the toolbar repo dropdown.
- `_handleMessage(message)` — dispatch switch over message types: `ready`, `requestBatch`, `selectCommit`, `openDiff`, `action`, `copy`, `setFilter`, `refresh`, `fetch`, `selectRepo`.
- `_sendConfig()` — posts `dateFormat`, `palette`, `branches`/`currentBranch`, and `repos`/`currentRepo` (repo dropdown data, mapped from the constructor's `repos` list).
- `_sendBatch(offset, limit)` — calls `getGraphBatch`, slices the Node.js Buffer, posts `ArrayBuffer`.
- `_sendCommitDetail(oid)` — calls `getCommitDetail`, posts.
- `_openDiff(filePath, oldOid, newOid, status)` — builds `gitbraid:` URIs, calls `vscode.diff`.
- `_handleAction(msg)` — dispatches to `gitActions.*`; shows confirmation modals; posts `reload` on success.
- `_handleCopy(msg)` — copies hash/shortHash/subject/message to clipboard.
- `_presentGitError(op, err)` — conflict-aware error display; "Show details" dumps to output channel.
- `WebviewMessage` / `HostMessage` — typed unions for both directions.
- `GitActionOp` — union of 14 write operation names.

---

#### `gitActions.ts`

**Layer:** Extension host (write path)
**Purpose:** All git write operations — shelled out to the `git` CLI via `child_process.execFile`.
**Contents:**
- `runGit(args, cwd)` — thin wrapper around `promisify(execFile)("git", args, { cwd })`.
- `isConflictError(output)` — regex-based conflict detection (testable without VS Code).
- `NotImplementedError` — error class for unimplemented stubs.
- Implemented operations: `checkout`, `createBranch`, `deleteBranch` (with force flag), `merge`, `rebase`, `cherryPick`, `revert`, `createTag`, `deleteTag`, `resetSoft`, `resetMixed`, `resetHard`, `stashApply`, `stashPop`, `stashDrop`.

---

#### `diffProvider.ts`

**Layer:** Extension host
**Purpose:** `TextDocumentContentProvider` for the `gitbraid:` URI scheme — serves blob bytes to VS Code's built-in diff viewer without spawning a `git` subprocess.
**Contents:**
- `GitBraidContentProvider implements vscode.TextDocumentContentProvider`.
- `provideTextDocumentContent(uri)` — parses `repo` and `oid` query params; calls `getBlob(repo, oid)` (napi); decodes as UTF-8; returns `""` for the missing side of add/delete.
- `buildDiffUri(repoPath, filePath, oidHex)` — builds `gitbraid:/<filePath>?repo=...&oid=...`.

---

#### `src/ai/provider.ts`

**Layer:** Extension host / AI subsystem
**Purpose:** Provider-agnostic LLM completion abstraction with backends for VS Code LM, Anthropic, OpenAI, Gemini, and Groq.
**Contents:**
- `AIMessage { role, content }` — input message type.
- `AICompletion { text, usage? }` — output type.
- `AIProvider` interface — `name: string`, `complete(messages): Promise<AICompletion>`.
- `BYOProviderType` — `"anthropic" | "openai" | "gemini" | "groq"`.
- `VscodeLmProvider` — calls `vscode.lm.selectChatModels()`, folds system messages into first user turn.
- `BYOKeyProvider(type, apiKey, model, baseURL?)` — routes to `_completeAnthropic`, `_completeOpenAICompat`, or `_completeGemini`.
- See [docs/specs/ai-provider-spec.md](./specs/ai-provider-spec.md).

---

#### `src/ai/releaseNotes.ts`

**Layer:** Extension host / AI subsystem
**Purpose:** Pure, vscode-free prompt builder and generator for release-notes. Unit-testable without an extension host.
**Contents:**
- `ReleaseNotesInput { commits, fromRef, toRef, includeDiffStat }` — input type.
- `buildMessages(input): AIMessage[]` — builds `[system, user]` messages. The system prompt specifies the Markdown structure, section headings, bullet format, and conventional-commit categorisation rules.
- `generateReleaseNotes(provider, input): Promise<string>` — calls `buildMessages`, then `provider.complete`, returns the Markdown string.
- See [docs/specs/ai-release-notes-spec.md](./specs/ai-release-notes-spec.md).

---

#### `src/ai/releaseNotesCommand.ts`

**Layer:** Extension host / AI subsystem
**Purpose:** VS Code command implementation for `gitBraid.generateReleaseNotes` — orchestrates the full 10-step user flow from opt-in gate through Markdown output.
**Contents:**
- `runReleaseNotesCommand(context, resolveRepos, pickRepo)` — the full flow: opt-in gate → repo pick → ref picker → privacy picker → provider construction → consent modal → range walk → AI generation → open Markdown doc.
- `SECRET_KEY(provider)` — returns `gitBraid.ai.apiKey.${provider}` (the SecretStorage key name).
- `showError(summary, err, context)` — toast + "Show details" → output channel.
- `getOutputChannel(context)` — lazy singleton output channel.

---

### Webview — `web/`

#### `web/index.ts`

**Layer:** Webview
**Purpose:** Webview entry point — bootstraps the UI, owns the message loop, manages paging and find state.
**Contents:**
- `init()` — builds the DOM layout (header bar, graph pane, find bar, detail pane), instantiates `CanvasRenderer`.
- Message handler (`window.addEventListener("message", ...)`) — handles `batch`, `config`, `commitDetail`, `findResults`, `reload`, `error`.
- Paging state: `loadedCount`, `inFlight`, `reachedEnd`.
- Find state: `matches`, `currentMatchIdx`, `pendingReveal`.
- `buildMenuItems(info)` — builds the 14-item right-click context menu.
- `showDetail(pane, detail, onClose)` — renders the commit detail panel HTML.
- Sends `{ type: "ready" }` on init; requests further batches via `requestBatch`.

---

#### `web/format.ts`

**Layer:** Webview
**Purpose:** Pure date-formatting helpers, isolated for unit testing without DOM.
**Contents:**
- `formatRelative(epochSeconds, nowMs)` — returns "just now", "N minutes/hours/days ago", or locale date string for > 30 days.
- No browser API calls; `nowMs` is a parameter so tests can pin the clock.

---

#### `web/renderer/canvas.ts`

**Layer:** Webview
**Purpose:** Canvas-based virtualised commit graph renderer. Only the visible window + overscan is painted.
**Contents:**
- `PALETTE` — 16 CSS colour strings (matches `PALETTE_SIZE` in Rust `layout.rs`).
- Constants: `ROW_HEIGHT = 24`, `LANE_WIDTH = 14`, `PAD_X = 12`, `NODE_RADIUS = 4`.
- Column widths: `COL_DATE_WIDTH = 150`, `COL_AUTHOR_WIDTH = 120`, `COL_COMMIT_WIDTH = 80`. Exported for header alignment.
- `CanvasRenderer` class:
  - `appendRows(rows)` — adds rows, updates spacer height, repaints.
  - `markEnd()` — signals no more pages.
  - `setMatches(indices)` / `setCurrentMatch(index)` / `clearFind()` — find highlighting.
  - `clearSelection()` — clears the selection highlight.
  - `setPalette(colors)` — overrides the colour cycle.
  - `scrollToRow(index)` — scrolls the viewport to centre on a row.
  - `reset()` — clears all state after a write operation.
  - `onNeedMore`, `onSelect`, `onContextMenu` — callbacks set by `web/index.ts`.
  - `_paint()` — the render loop: find tints → selection highlight → segments → nodes + text.
  - `_drawSegment(seg, yTop, yBottom)` — straight vertical or cubic bezier diagonal.

---

#### `web/renderer/decode.ts`

**Layer:** Webview
**Purpose:** BRAI v2 binary batch decoder — the browser-side mirror of `crates/core/src/serialize.rs`.
**Contents:**
- Constants matching Rust: `SEG_KIND_STRAIGHT/MERGE_OUT/CONVERGE_IN`, `FLAG_IS_MERGE/ROOT/…`, `REF_KIND_*`.
- `DecodedSegment`, `DecodedRef`, `DecodedRow` — TypeScript output types.
- `decodeBatch(buffer: ArrayBuffer): DecodedRow[]` — full decoder with bounds checking. Uses `DataView` for little-endian reads; `TextDecoder` for UTF-8 strings. The `oid` field is a `Uint8Array` view into the original buffer.
- `shortOid(oid: Uint8Array): string` — first 7 hex chars (git short-hash style).

---

#### `web/ui/contextMenu.ts`

**Layer:** Webview
**Purpose:** Lightweight DOM right-click popup for Canvas commit rows (which are not DOM elements and cannot use VS Code's built-in menu system).
**Contents:**
- `MenuItem` — `{ label: string; action: () => void } | { separator: true }`.
- `showContextMenu(x, y, items)` — creates and positions a fixed DOM popup, clamps to viewport, auto-dismisses on click-outside / Escape / scroll.
- At most one menu open at a time (module-level `_current` ref).

---

#### `web/ui/branchDropdown.ts`

**Layer:** Webview
**Purpose:** Searchable, widened branch-switcher dropdown for the graph toolbar. Replaces a native `<select>` (which cannot host a filter input) with a custom widget styled with VS Code CSS variables.
**Contents:**
- `BranchDropdownItem` — `{ name, kind, isCurrent }` (same shape as `config.branches` payload).
- `BranchDropdown` — handle returned by the factory: `{ el, setItems, setSelected }`.
- `createBranchDropdown({ initial, onSelect })` — builds the trigger button and manages the popup lifecycle. The popup contains a `Filter Branches…` input, a "Show All" row, and a scrollable branch list with `✓`/`★` glyphs. Supports `↑/↓/Enter/Escape` keyboard navigation and auto-dismisses on outside-click or scroll. At most one popup open at a time (module-level ref, same idiom as `contextMenu.ts`). All styles are inline; no external assets (CSP-safe).

---

#### `web/ui/repoDropdown.ts`

**Layer:** Webview
**Purpose:** Repo picker for the graph toolbar (leftmost, ahead of the branch dropdown) — lets the user switch which discovered repo is displayed without the command palette. Modeled directly on `branchDropdown.ts`.
**Contents:**
- `RepoDropdownItem` — `{ root, name }` (same shape as `config.repos` payload).
- `RepoDropdown` — handle returned by the factory: `{ el, setItems, setCurrent }`.
- `createRepoDropdown({ initial, onSelect })` — same popup/filter/keyboard-nav idiom as `branchDropdown.ts`, minus the "Show All" row and kind/star logic (a repo is always selected; `✓` marks the current one). Selecting a different repo posts `{ type: "selectRepo", root }`; the host recreates the panel for the new repo, so this component doesn't self-update after a selection — a fresh `config` message does that.

---

## Hard constraints (quick reference)

1. **Clean-room**: never read original Git Graph source. See [ADR-0001](./adr/0001-clean-room-not-fork.md).
2. **Layout invariants** (never break): Determinism (4), Append-only stability (5), No mid-life lane shift (2), First-parent straight (6). Full spec: [specs/layout-spec.md](./specs/layout-spec.md).
3. **Read/write split**: reads → Rust/gitoxide. Writes → `git` CLI subprocess. See [ADR-0004](./adr/0004-read-write-split.md).
4. **Non-goals**: no inline blame, no own diff viewer, no GUI conflict editor, no non-git VCS.
