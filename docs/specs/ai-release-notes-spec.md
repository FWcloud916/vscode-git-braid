# Release-notes generation — Behaviour Spec

> Version: v0.1
> Nature: Behaviour spec
> Implementation targets: `src/ai/releaseNotes.ts`, `src/ai/releaseNotesCommand.ts`
> Corresponds to: [plan §7.2](../plan/project-plan.md), [ADR-0007](../adr/0007-multi-provider-ai-backend.md)
> See also: [docs/ai/README.md](../ai/README.md) · [ai-provider-spec.md](./ai-provider-spec.md)

---

## 1. Purpose and scope

Specifies the complete end-to-end behaviour of the
`gitBraid.generateReleaseNotes` command: from the user invoking the command
through VS Code UI to a Markdown document opening in the editor.

### In scope

- The 10-step command flow.
- Range semantics (`from..to` notation).
- Privacy levels (metadata-only vs +diffstat).
- The prompt contract (system prompt structure, categorisation rules).
- Data-flow: gitoxide → messages → AI provider → Markdown output.
- Consent and opt-in gate.
- Error handling.

### Out of scope

- Provider-level behaviour (see [ai-provider-spec.md](./ai-provider-spec.md)).
- Layout, rendering, or the graph webview.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **range** | A pair of git refs `from..to` specifying the commits to include. `from` is exclusive (like `git log from..to`). `from = null` means full history up to `to`. |
| **metadata-only** | Privacy level that sends only commit subjects and author names to the AI. |
| **+diffstat** | Privacy level that additionally sends `filesChanged`, `insertions`, and `deletions` per commit (approximate newline counts from gitoxide). |
| **consent modal** | A modal `showWarningMessage` dialog that lists the data and provider before any AI call. |
| **RangeCommit** | The napi type returned by `walkRange`; see `bindings/napi/index.d.ts`. |

---

## 3. Input contract

```
ReleaseNotesInput:
  commits:         RangeCommit[]   // newest-first, from walkRange
  fromRef:         string | null   // null = full history
  toRef:           string          // e.g. "HEAD" or "v1.1.0"
  includeDiffStat: boolean
```

**Preconditions** (guaranteed by `runReleaseNotesCommand` before calling
`generateReleaseNotes`):

- `commits.length >= 1` — empty range is rejected with an error before the AI call.
- `toRef` is a valid git ref in the repository.
- The `AIProvider` instance has already been constructed and consented to.

---

## 4. Output contract

```
generateReleaseNotes(provider, input): Promise<string>
```

Returns a Markdown string produced by the AI model. The command opens it in a
new untitled editor with `language: "markdown"`.

`buildMessages(input): AIMessage[]` — pure function, returns `[system, user]`.

---

## 5. Command flow (10 steps)

Steps implemented in `runReleaseNotesCommand` (`src/ai/releaseNotesCommand.ts`):

1. **Opt-in gate** — check `gitBraid.ai.enabled`; if `false`, prompt to enable.
   Return early if user declines.

2. **Repo pick** — call `resolveRepos()` from `src/extension.ts`. Show error if
   no repos found. Show QuickPick if multiple repos.

3. **Ref picker** — call `listRefs(repoPath)` (gitoxide, no subprocess). Build
   items list: `HEAD` first, then branches, then tags. Show two sequential
   QuickPicks: `to` (end of range) then `from` (start, exclusive). Selecting
   "⟂ All history" sets `fromRef = null`.

4. **Privacy level picker** — two options:
   - `Metadata only` — commit subjects + author names (default).
   - `Include diff stat` — also send files changed and ± line counts.
   Default selection controlled by `gitBraid.ai.defaultDiffStat`.

5. **Provider construction** — read `gitBraid.ai.provider`:
   - `"vscode-lm"` → `new VscodeLmProvider()`.
   - Any BYO type → look up key from `context.secrets`
     (`gitBraid.ai.apiKey.<provider>`); prompt and store if missing.
     Construct `new BYOKeyProvider(type, key, model)`.

6. **Consent modal** — show a **modal** `showWarningMessage` that states:
   - Exact data to be sent (e.g. "commit subjects and author names" or
     "commit subjects, author names, and diff stats").
   - Provider destination (e.g. "anthropic (external API)" or
     "your VS Code Language Model (no external API call)").
   - The range label (e.g. `v1.0.0..HEAD`).
   User must click "Continue" to proceed; any other action returns early.

7. **Range walk** — call `walkRange(repoPath, fromRef, toRef, includeDiffStat)`
   (gitoxide, no subprocess). If `commits.length === 0`, throw an error.

8. **AI generation** — call `generateReleaseNotes(provider, input)` inside a
   `withProgress` notification (title: "Git Braid: Generating release notes…").

9. **Open result** — `vscode.workspace.openTextDocument({ language: "markdown",
   content: markdown })` then `showTextDocument(doc, { preview: false })`.

10. **Error handling** — any thrown error shows a toast ("Git Braid: X.") with a
    "Show details" action that dumps the full error to the "Git Braid" output
    channel.

---

## 6. Range semantics

```
from..to  ≡  git log ^from to  ≡  commits reachable from to, not from from
from = null  →  all commits reachable from to
```

`walkRange` in `crates/core/src/walk.rs` implements this using gitoxide's
topological builder with `with_ends([fromOid])`. A post-filter step removes
`from` itself from the output (matching `git log ^from` semantics where `from`
is excluded).

The range label in the prompt is:
```typescript
fromRef ? `${fromRef}..${toRef}` : toRef
```

---

## 7. Prompt contract

`buildMessages(input)` returns exactly two messages: `[system, user]`.

### System prompt structure

```
You are a technical writer generating concise, user-friendly release notes.

Given a list of git commits, produce a Markdown document with:
1. A level-2 heading: `## Release notes — {rangeLabel}`
2. Three sections (omit any section with no relevant commits):
   - **Features** — commits whose subject starts with `feat:` or `feat(`
   - **Bug Fixes** — commits whose subject starts with `fix:` or `fix(`
   - **Other Changes** — all remaining commits
3. Each commit as a bullet: `- <subject> (<author>)`
[4. After each bullet, if includeDiffStat and filesChanged > 0:
    `[N files, +I/-D lines]`]

Rules:
- Strip the conventional-commit prefix (e.g. "feat: " → just the description).
- Keep sentences short and factual.
- Do not invent information not present in the commit list.
- Output only the Markdown document; no preamble or explanation.
```

### User prompt structure

```
Generate release notes for the following {N} commit{s} in the range `{rangeLabel}`:

- {subject} ({authorName}) [{filesChanged} file{s}, +{insertions}/-{deletions}]
- ...
```

Diffstat `[N files, ...]` is appended per-commit only when `includeDiffStat` is
`true` **and** `c.filesChanged > 0`.

### Categorisation rules

| Section | Match condition on the raw subject |
|---|---|
| **Features** | `subject.startsWith("feat:")` or `subject.startsWith("feat(")` |
| **Bug Fixes** | `subject.startsWith("fix:")` or `subject.startsWith("fix(")` |
| **Other Changes** | Anything else (chore, docs, refactor, perf, test, unlabelled) |

Prefix stripping: the conventional-commit prefix (`feat: `, `fix(scope): `, etc.)
is stripped from the displayed bullet by the AI model following the system
prompt instructions. The raw subject string is always sent unchanged.

---

## 8. Edge cases

| Case | Handling |
|---|---|
| 0 commits in range | Error thrown inside `withProgress`: "No commits found in range [R]. Check that the selected refs are correct." Displayed as toast. |
| 1 commit | `"1 commit"` (not "1 commits") — pluralisation guarded by `commits.length === 1 ? "" : "s"` |
| `filesChanged === 0` with diffstat enabled | No `[N files, ...]` clause appended for that commit |
| Empty `from` (full history) | `fromRef = null`; `rangeLabel = toRef`; prompt says "commits in the range `HEAD`" |
| User cancels any picker | Function returns early, no AI call made |
| Missing VS Code LM subscription | `VscodeLmProvider.complete()` throws with a guidance message; caught by step 10 |
| Missing or invalid API key | User is prompted to enter one; storing it before retrying |

---

## 9. Privacy model

The privacy levels map to what is sent to the AI provider:

| Level | Subject | Author name | filesChanged | insertions | deletions |
|---|---|---|---|---|---|
| Metadata only | ✅ | ✅ | — | — | — |
| +Diff stat | ✅ | ✅ | ✅ | ✅ | ✅ |

Diff stat is an **approximation** from gitoxide newline-counting (not a real
Myers diff). It is clearly approximate in the prompt (`approximate` is not
stated explicitly in the prompt, but the ADR documents the approximation).

The email address and full commit body are **never sent**, regardless of privacy
level.

---

## 10. Open decisions

1. **Cancellability**: the `withProgress` call has `cancellable: false`. Allowing
   cancellation requires passing a `CancellationToken` through to the provider.

2. **Streaming UI feedback**: long-running AI completions show no incremental
   text. Streaming to the output channel or a side panel would improve UX for
   large ranges.

---

## 11. Interface with other modules

- **Upstream**: `walkRange` (gitoxide via napi) provides `RangeCommit[]`.
  `listRefs` provides refs for the picker.
- **Downstream**: `buildMessages` feeds `AIProvider.complete()`.
  `generateReleaseNotes` returns the Markdown to `runReleaseNotesCommand`.
- **Parallel**: none. Steps 7 + 8 are sequential (walk then generate).

---

_v0.1 — describes the M5 implementation. Update when streaming or cancellation
is added._
