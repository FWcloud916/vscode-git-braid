# Git Braid — Architecture

> The single authoritative architecture record. Cross-referenced from CLAUDE.md,
> README.md, and the per-subsystem docs.
>
> See also: [docs/CODEMAP.md](./CODEMAP.md) for the per-file reference.

---

## 1. System goals

1. **Performance on large repos** — 10k–100k commit repos must remain smooth.
   First paint < 500ms; 60fps scroll. Achieved by a Rust core reading the ODB
   directly and a Canvas virtualised renderer that paints only the visible window.

2. **AI-assisted history** — release-notes generation, semantic search, conflict
   context, commit-message suggestion. Uses VS Code's existing LM subscription
   (zero-setup) with BYO-key fallback.

These two goals drive every major architectural decision.

---

## 2. Layered component diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Webview  (VS Code's sandboxed Electron browser context)            │
│                                                                     │
│  web/index.ts          — entry: postMessage handler, paging state   │
│  web/renderer/canvas.ts — CanvasRenderer (virtual list, 60fps)      │
│  web/renderer/decode.ts — BRAI v2 binary → DecodedRow[]             │
│  web/format.ts          — date formatting helpers                   │
│  web/ui/contextMenu.ts  — DOM right-click popup (no vscode API)     │
└──────────────▲─────────────────────────┬────────────────────────────┘
               │  ArrayBuffer (BRAI v2)  │ postMessage (user actions)
               │  binary batch           │ { type, ...fields }
┌──────────────┴─────────────────────────▼────────────────────────────┐
│  Extension Host  (Node.js / TypeScript)                             │
│                                                                     │
│  src/extension.ts       — activate, command registration            │
│  src/webviewBridge.ts   — WebviewPanel manager, message dispatch    │
│  src/diffProvider.ts    — gitbraid: TextDocumentContentProvider     │
│  src/gitActions.ts      — write ops (child_process → git CLI)       │
│  src/ai/               — AI subsystem (opt-in, M5)                  │
│    provider.ts          — AIProvider interface + backends           │
│    releaseNotes.ts      — prompt builder + generator (pure)         │
│    releaseNotesCommand.ts — VS Code command flow (UI, consent)      │
└──────────────▲─────────────────────────┬────────────────────────────┘
               │ napi-rs FFI (sync call) │ child_process.execFile
               │ returns Buffer/objects  │ (write ops only)
┌──────────────┴──────────────┐    ┌─────▼──────────────────────────┐
│  Rust core + napi binding   │    │  git CLI (write ops only)      │
│                             │    │  checkout · merge · rebase …   │
│  bindings/napi/src/lib.rs   │    └────────────────────────────────┘
│  ┌──────────────────────┐   │
│  │ crates/core/         │   │
│  │  walk.rs   (gitoxide)│   │
│  │  layout.rs (pure fn) │   │
│  │  serialize.rs (BRAI) │   │
│  │  model.rs  (types)   │   │
│  └──────────────────────┘   │
│                             │
│  gitoxide reads .git/       │
│  object database directly   │
└─────────────────────────────┘
```

---

## 3. End-to-end data flows

### 3a. Read / render path (hot path)

```
User opens graph
→ extension.ts: activate() → WebviewBridge constructor
→ Webview sends { type: "ready" }
→ WebviewBridge._sendConfig() → { type: "config", palette, dateFormat }
→ WebviewBridge._sendInitialBatch(offset=0, limit=300)
  → getGraphBatch(repoPath, offset, limit)        [napi FFI]
    → walk_commits(repoPath, opts)                [Rust: walk.rs + gitoxide]
    → layout(commits, boundary)                   [Rust: layout.rs — pure fn]
    → encode_batch(rows, metas)                   [Rust: serialize.rs → BRAI v2]
  → returns Node.js Buffer
→ WebviewBridge posts { type: "batch", payload: ArrayBuffer }
→ Webview: decodeBatch(arrayBuffer)               [web/renderer/decode.ts]
→ CanvasRenderer.appendRows(rows)                 [web/renderer/canvas.ts]
→ _paint() — draws visible window only
```

Subsequent pages: scroll → `onNeedMore` → `{ type: "requestBatch" }` → repeat.

### 3b. Write path (cold path)

```
User right-clicks commit → context menu → selects "Merge into current branch"
→ Webview posts { type: "action", op: "merge", oid: "...", refs: [] }
→ WebviewBridge._handleAction()
→ gitActions.merge(oid, repoPath)                 [src/gitActions.ts]
  → child_process.execFile("git", ["merge", oid])
→ on success: post { type: "reload" }
→ Webview: renderer.reset() + requestBatch(0, PAGE_SIZE) → re-render
```

Confirmation modals (e.g. "Reset (hard)") are shown in the extension host before
`gitActions.*` is called.

### 3c. AI path (opt-in)

```
User invokes "Generate Release Notes" command
→ src/extension.ts: runReleaseNotesCommand(context, resolveRepos, pickRepo)
→ src/ai/releaseNotesCommand.ts: 10-step flow
  (opt-in gate → repo pick → ref picker → privacy picker
   → provider construction → consent modal)
→ walkRange(repoPath, fromRef, toRef, includeDiffStat) [napi: walk.rs]
→ src/ai/releaseNotes.ts: buildMessages(input)
→ AIProvider.complete(messages)                   [src/ai/provider.ts]
→ Returns Markdown string
→ openTextDocument({ language: "markdown", content })
```

See [docs/ai/README.md](./ai/README.md) and [docs/specs/ai-release-notes-spec.md](./specs/ai-release-notes-spec.md).

### 3d. Diff view path

```
User clicks a file in the commit detail panel
→ Webview posts { type: "openDiff", filePath, oldOid, newOid, status }
→ WebviewBridge._openDiff()
  → buildDiffUri(repoPath, filePath, oid)          [src/diffProvider.ts]
  → vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title)
→ VS Code built-in diff viewer opens
→ GitBraidContentProvider.provideTextDocumentContent(uri)
  → getBlob(repoPath, oidHex)                      [napi: lib.rs]
  → returns blob bytes → decoded as UTF-8 text
```

---

## 4. Binary paging protocol (BRAI v2)

The host ↔ webview channel uses a flat `ArrayBuffer` (not JSON) for commit
batches. This eliminates garbage-collection pressure in the Canvas render loop.

Format: Header (20 B) · StringPool · CommitRow×N (56 B each) ·
RefRow×R (8 B each) · SegmentRow×S (8 B each).

The StringPool deduplicates author names and subjects by integer index.
Typed-array views (`DataView`, `Uint8Array`) allow zero-copy reads in the webview.

Full wire format spec: `crates/core/src/serialize.rs` (Rust encoder) and
`web/renderer/decode.ts` (JS decoder).

---

## 5. Read / write split

**Rule**: git **reads** use the Rust core via gitoxide. Git **writes** use
`child_process` + the `git` CLI. Never mix.

| Path | Why |
|---|---|
| **Read**: gitoxide / ODB direct | No subprocess overhead; no shell parsing; O(n) deterministic walk |
| **Write**: `git` CLI subprocess | Correctness: hooks, submodules, config interaction — git's own binary handles all edge cases |

Codified in [ADR-0004](./adr/0004-read-write-split.md). Enforced by having
`gitActions.ts` use only `child_process` and `crates/core` + `bindings/napi`
use only gitoxide.

---

## 6. Hard constraints

### 6a. Clean-room rule (legal)

Never open, read, or copy from the original Git Graph extension's source code.
Consult only public git documentation, git man pages, and the behaviour specs
in `docs/specs/`. See [ADR-0001](./adr/0001-clean-room-not-fork.md).

### 6b. Layout invariants (correctness)

Four invariants in `crates/core/src/layout.rs` must never be broken:

| # | Invariant | Impact if broken |
|---|---|---|
| 4 | **Determinism** — same input → same output | Cache / test failures |
| 5 | **Append-only stability** — `layout(commits[..N])` rows 0..N equal rows of `layout(commits[..N+k])` 0..N | Incremental paging produces wrong geometry |
| 2 | **No mid-life lane shift** — compaction disabled | Visual jumps when new data arrives |
| 6 | **First-parent straight** — first-parent inherits the commit's lane | Main-line jumps lanes visually |

Full specification: [docs/specs/layout-spec.md](./specs/layout-spec.md).

### 6c. Non-goals

These will never be implemented; do not add scope:

- Inline editor blame / annotations (GitLens-style)
- Own diff viewer (VS Code's built-in is used)
- GUI conflict editor
- Non-git VCS support

---

## 7. Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Rust core | Rust + gitoxide (`gix`) | Pure Rust; direct ODB read without subprocess; no libgit2 dependency |
| FFI | napi-rs (native `.node` addon) | Direct filesystem access; highest read performance; type-safe bindings |
| Write ops | `git` CLI via `child_process` | Correctness; hooks/submodules/config handled by git itself |
| Extension host | TypeScript + VS Code Extension API | Required by the platform |
| Renderer | Canvas 2D | Virtualised; no DOM node per commit; 60fps target |
| Binary protocol | Custom flat ArrayBuffer (BRAI v2) | Zero GC pressure in the render loop |
| AI (zero-setup) | VS Code `vscode.lm` API | Uses user's existing Copilot subscription |
| AI (BYO key) | Anthropic SDK + raw `fetch` | SDK for Anthropic (streaming); raw fetch avoids three extra SDKs |
| Tests | `cargo test`, Criterion benchmarks, Vitest | Performance regressions gated in CI |
| CI | GitHub Actions (multi-platform napi prebuild) | Prebuilt `.node` for darwin-arm64/x64, linux-x64, win32-x64 |

---

## 8. Related decisions and specs

| Document | Topic |
|---|---|
| [ADR-0001](./adr/0001-clean-room-not-fork.md) | Clean-room rationale |
| [ADR-0002](./adr/0002-gitoxide-over-libgit2.md) | Why gitoxide instead of libgit2 |
| [ADR-0003](./adr/0003-napi-over-wasm.md) | Why napi-rs instead of WASM |
| [ADR-0004](./adr/0004-read-write-split.md) | Read/write split rationale |
| [ADR-0005](./adr/0005-diff-via-gitoxide-blob-provider.md) | Diff viewer integration |
| [ADR-0006](./adr/0006-repo-discovery-strategy.md) | Repository discovery |
| [ADR-0007](./adr/0007-multi-provider-ai-backend.md) | Multi-provider AI backend |
| [specs/layout-spec.md](./specs/layout-spec.md) | Layout algorithm contract |
| [ai/README.md](./ai/README.md) | AI subsystem overview + code-map |
| [specs/ai-provider-spec.md](./specs/ai-provider-spec.md) | AIProvider protocol |
| [specs/ai-release-notes-spec.md](./specs/ai-release-notes-spec.md) | Release-notes behaviour |
| [CODEMAP.md](./CODEMAP.md) | Per-file reference for all core files |
