# AI planned features — architecture notes

> Status: **Planned** (not yet implemented as of M5).
> These notes record the design intent so future implementors understand
> how each feature fits into the existing AI abstraction.
>
> See [docs/ai/README.md](./README.md) for the implemented feature (release-notes).

---

## Overview

The project plan (§7.2) defines four AI features. Release-notes generation
is complete (M5). The three remaining features share the same provider
abstraction but each has distinct data-flow and open design questions.

| Feature | Reuses `AIProvider.complete()` | Privacy sensitivity | Status |
|---|---|---|---|
| Semantic commit search | ⚠️ Needs `embed()` — see §1 | Low (subjects/OIDs only) | 📋 Planned |
| Conflict / merge summary | ✅ Yes | High (sends diffs) | 📋 Planned |
| Commit-message suggestion | ✅ Yes | High (sends staged diff) | 📋 Planned |

---

## 1. Semantic commit search

**Data-flow:**
```
User query string
  → embed(query) → query vector
  → compare vs commit-vector index
  → top-N matching commits (ranked by cosine similarity)
  → display in QuickPick / graph highlight
```

**Abstraction fit:** Embedding is a *different* call shape from text completion.
`AIProvider.complete()` accepts `AIMessage[]` and returns text. Embedding
accepts a string and returns a float vector. Two options:

- **Option A**: Add an `embed(text: string): Promise<number[]>` method to
  `AIProvider` (or a separate `EmbeddingProvider` interface). This is the cleaner
  model — providers either implement it or throw `NotImplemented`.
- **Option B**: Keep `AIProvider` for completions only; introduce a parallel
  `EmbeddingProvider` interface for semantic search. Providers that support both
  (e.g. OpenAI) would implement both interfaces.

**Open decisions:**

1. Which embedding source? Options:
   - **vscode.lm** — does not currently expose an embedding API.
   - **Anthropic** — no public embedding endpoint as of 2026.
   - **OpenAI** — `text-embedding-3-small` via a separate `/embeddings` endpoint.
   - **Gemini** — `text-embedding-004` via `embedContent` REST.
   - **Local model** — e.g. `nomic-embed-text` via Ollama. Low privacy risk.
     Requires bundling or downloading a model.

2. **Index storage**: commit embeddings must be computed once and cached.
   Options: an in-memory map (lost on extension restart), a flat binary file
   in `.git/braid-cache/`, or a SQLite database. An ADR is needed.

3. **Incremental update**: when new commits arrive (user `git pull`), only
   the new commits should be embedded — not the full history. Requires tracking
   which OIDs have been indexed.

4. **Compute location**: embedding can run in the Rust core (Rust ML crate),
   the TS extension host (JS inference), or via an external API. A future ADR
   must decide based on privacy, performance, and dependency constraints.

**Privacy:** Only commit subjects (and optionally short OIDs) would be sent to
an external embedding API. No code or diff content. Sensitivity is low, but
the per-feature opt-in + consent model still applies.

---

## 2. Conflict / merge context summary

**Data-flow:**
```
User selects a merge commit in the graph (or resolves a conflict in-editor)
  → getCommitDetail(repoPath, mergeOidHex)  → CommitDetail (parents[])
  → walkRange(parent1..mergeOid)            → commits on branch A
  → walkRange(parent2..mergeOid)            → commits on branch B  (optional)
  → [optional] fetch diffs for conflicted files via getBlob()
  → buildMessages([system, user])           → AIProvider.complete()
  → summary Markdown
```

**Abstraction fit:** `complete()` fits naturally — the summary is a text
completion. `getCommitDetail` (napi) provides the parent OIDs.
`walkRange` provides the branch histories.

**Open decisions:**

1. **Diff content**: whether to send actual file diff content (not just
   diffstats) to the model. Sending diffs gives much richer summaries but
   greatly increases privacy sensitivity (sends proprietary code). The consent
   modal must clearly disclose this.

2. **Obtaining diffs**: `getBlob` returns raw blob bytes; generating a unified
   diff requires either computing it in Rust (gitoxide has a diff API) or in TS
   (tedious). An ADR is needed before implementation.

3. **Trigger point**: is this triggered from the commit graph (right-click a
   merge commit) or from the VS Code merge-conflict editor? The latter requires
   a VS Code conflict editor API.

**Privacy:** Sending diffs is high-sensitivity. Must be a separate opt-in
from the diffstat opt-in already in release-notes. The "metadata-only vs +diff"
model from release-notes should be extended.

---

## 3. Commit-message suggestion

**Data-flow:**
```
User stages files (via git)
  → runGit(["diff", "--cached"])  → staged diff text
  → buildMessages([system, user]) → AIProvider.complete()
  → conventional-commit message suggestion
  → show in InputBox pre-filled / QuickPick with options
```

**Abstraction fit:** `complete()` fits naturally.

**Open decisions:**

1. **Staged diff source**: reading the staged diff (`git diff --cached`) is a
   **read-path** operation but uses the `git` CLI subprocess. Per ADR-0004,
   the read path should use gitoxide (no subprocess). However, gitoxide's index
   API (reading the staged diff from `.git/index`) is more complex than the
   write-path operations. Options:
   - Use `git diff --cached` via `runGit()` in `gitActions.ts` (pragmatic;
     deviates from the read/write split).
   - Implement staged-diff reading in Rust via gitoxide's index API (clean;
     requires new `crates/core/src/walk.rs` function and napi binding).
   - An ADR must resolve this before implementation.

2. **Output format**: the AI model should generate one conventional-commit
   message. The scope (e.g. `(core)`, `(web)`) could be inferred from changed
   file paths. Whether to show a single suggestion or multiple options is a UX
   decision.

3. **Commit execution**: suggestion is display-only; the user types or pastes
   into their own commit editor. Git Braid does not execute `git commit` directly
   in this flow (that would be a write-path action requiring its own ADR).

**Privacy:** Sends staged diff — potentially proprietary code. Very high
sensitivity. Requires explicit per-feature consent. Should default opt-out even
when `gitBraid.ai.enabled = true`.

---

## ADRs needed before implementation

| Feature | Decision required |
|---|---|
| Semantic search | Embedding provider choice, index storage, compute location |
| Semantic search | `AIProvider` interface extension (`embed()` vs separate interface) |
| Conflict summary | Diff content privacy level, diff generation approach |
| Commit-message suggestion | Staged-diff read path (gitoxide vs `git diff --cached`) |
