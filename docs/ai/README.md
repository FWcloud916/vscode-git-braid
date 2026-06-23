# AI subsystem — architecture & code-map

> **Primary purpose:** let an agent or human find the right file to change or fix
> something in the AI subsystem in under 30 seconds.
>
> Related: [docs/specs/ai-provider-spec.md](../specs/ai-provider-spec.md) ·
> [docs/specs/ai-release-notes-spec.md](../specs/ai-release-notes-spec.md) ·
> [docs/ai/planned-features.md](./planned-features.md) ·
> [docs/adr/0007-multi-provider-ai-backend.md](../adr/0007-multi-provider-ai-backend.md) ·
> [docs/plan/project-plan.md §7](../plan/project-plan.md)

---

## Quick navigation — feature → file → key symbol

| Feature / area | Primary file | Key symbol(s) |
|---|---|---|
| Release-notes — full command flow (UI, pickers, consent) | `src/ai/releaseNotesCommand.ts` | `runReleaseNotesCommand` |
| Release-notes — prompt building + generation (pure, testable) | `src/ai/releaseNotes.ts` | `buildMessages`, `generateReleaseNotes` |
| Provider abstraction + all backends | `src/ai/provider.ts` | `AIProvider`, `VscodeLmProvider`, `BYOKeyProvider` |
| Tests (categorisation, prompt contract) | `src/ai/releaseNotes.test.ts` | Vitest suite |
| Command registration + opt-in gate | `src/extension.ts:167–196` | `generateReleaseNotes`, `clearAiKey` |
| Gitoxide read-path (range walk, ref listing) | `@git-braid/native` → `bindings/napi/src/lib.rs` | `walkRange`, `listRefs` |

---

## "I want to change / fix X" — start here

| Task | Go to | What to change |
|---|---|---|
| Add a new AI provider (e.g. Ollama) | `src/ai/provider.ts` | Add literal to `BYOProviderType`, add branch in `BYOKeyProvider.complete()` |
| Change the release-notes prompt | `src/ai/releaseNotes.ts:46–65` | Edit `systemPrompt` inside `buildMessages()` |
| Change categorisation rules (feat/fix/other) | `src/ai/releaseNotes.ts:46–65` | Edit the bullet / section rules in `systemPrompt` |
| Add a diffstat field or change its format | `src/ai/releaseNotes.ts:53–59` | Edit the optional diffstat clause in `systemPrompt` |
| Adjust privacy level options | `src/ai/releaseNotesCommand.ts:136–161` | Edit the `showQuickPick` items (step 4) |
| Change the per-run consent modal wording | `src/ai/releaseNotesCommand.ts:196–217` | Edit `showWarningMessage` call (step 6) |
| Change the secret storage key name | `src/ai/releaseNotesCommand.ts:29` | Edit `SECRET_KEY` template literal **and** update `docs/adr/0007` |
| Add / rename an AI setting | `package.json` `contributes.configuration` | Add the setting; update `src/ai/releaseNotesCommand.ts` reader |
| Change the `clearAiKey` command | `src/extension.ts:178–196` | Edit the command handler |
| Fix secret key name in ADR-0007 | `docs/adr/0007-multi-provider-ai-backend.md` | Already corrected to `gitBraid.ai.apiKey.<provider>` |

---

## Entry points

| Command ID | Registered in | Handler |
|---|---|---|
| `gitBraid.generateReleaseNotes` | `src/extension.ts:171–175` | `runReleaseNotesCommand(context, resolveRepos, pickRepo)` |
| `gitBraid.clearAiKey` | `src/extension.ts:178–196` | Inline — deletes from `context.secrets` |

**Opt-in gate:** `gitBraid.ai.enabled` (default `false`). The command prompts to
enable on first run. No AI call is made when the gate is off.

---

## Layer diagram

```
┌─────────────────────────────────────────────────────────────┐
│  Command layer (VS Code UI, pickers, consent, progress)     │
│  src/ai/releaseNotesCommand.ts                              │
│    runReleaseNotesCommand()                                 │
└───────────────┬──────────────────────────────┬─────────────┘
                │ calls                        │ calls
                ▼                              ▼
┌──────────────────────────┐   ┌───────────────────────────────┐
│ Feature logic (pure)     │   │ gitoxide read path             │
│ src/ai/releaseNotes.ts   │   │ @git-braid/native              │
│   buildMessages()        │   │  listRefs(), walkRange()        │
│   generateReleaseNotes() │   └───────────────────────────────┘
└──────────────┬───────────┘
               │ calls
               ▼
┌─────────────────────────────────────────────────────────────┐
│  Provider abstraction                                        │
│  src/ai/provider.ts                                         │
│    interface AIProvider { complete(messages) }              │
└──────────────────┬──────────────────────────────────────────┘
                   │ implemented by
        ┌──────────┴──────────────┐
        ▼                         ▼
┌──────────────────┐   ┌──────────────────────────────────────┐
│ VscodeLmProvider │   │ BYOKeyProvider                        │
│ (no key needed)  │   │ anthropic | openai | gemini | groq   │
│                  │   │ (@anthropic-ai/sdk or raw fetch)      │
└──────────────────┘   └──────────────────────────────────────┘
```

---

## Read-path integration

AI features are **consumers** of the gitoxide read path (ADR-0004). They call into
`@git-braid/native` (the napi binding) which delegates to `crates/core/src/walk.rs`:

- `listRefs(repoPath)` — branch + tag list for the range-picker QuickPick.
- `walkRange(repoPath, fromRev, toRev, includeDiffStat)` — ordered commit list for
  the prompt. Diffstat is approximate (newline-count), computed inside Rust without
  spawning a `git` subprocess.

AI features **never** use the git CLI write path (`src/gitActions.ts`) — they are
strictly read-only.

---

## Privacy and consent model

| Mechanism | Where |
|---|---|
| Opt-in gate (`gitBraid.ai.enabled`) | Step 1 of `runReleaseNotesCommand` |
| Provider setting (`gitBraid.ai.provider`) | Read in step 5 |
| Privacy level picker (metadata-only vs +diffstat) | Step 4 |
| Per-run consent modal | Step 6 — names provider + data type |
| API keys | `context.secrets` (OS keychain), key `gitBraid.ai.apiKey.<provider>` |
| Keys never in settings.json | Enforced by using `SecretStorage` only |

The `AIProvider` interface itself has **no knowledge of consent**. Consent is the
caller's (`releaseNotesCommand.ts`) responsibility.

---

## Feature status matrix

| Feature | Status | Milestone |
|---|---|---|
| Release-notes generation | ✅ Implemented | M5 |
| Semantic commit search | 📋 Planned | M6+ |
| Conflict / merge context summary | 📋 Planned | M6+ |
| Commit-message suggestion | 📋 Planned | M6+ |

See [planned-features.md](./planned-features.md) for the architecture of the
three planned features.

---

## Configuration and command surface

### Settings (`package.json`)

| Setting | Type | Default | Purpose |
|---|---|---|---|
| `gitBraid.ai.enabled` | boolean | `false` | Master opt-in gate |
| `gitBraid.ai.provider` | enum | `"vscode-lm"` | Backend: `vscode-lm` \| `anthropic` \| `openai` \| `gemini` \| `groq` |
| `gitBraid.ai.model` | string | `""` | Model string for BYO providers; ignored for `vscode-lm` |
| `gitBraid.ai.defaultDiffStat` | boolean | `false` | Pre-select the "+diff stat" privacy level |

### Secret storage

Keys are stored via `context.secrets` (VS Code `SecretStorage` — OS keychain on
macOS/Windows, libsecret on Linux). Key format: `gitBraid.ai.apiKey.<provider>`,
where `<provider>` is one of `anthropic`, `openai`, `gemini`, `groq`.

### Commands (`package.json`)

| Command | ID | Location |
|---|---|---|
| Generate Release Notes | `gitBraid.generateReleaseNotes` | `src/extension.ts:171` |
| Clear Stored API Key | `gitBraid.clearAiKey` | `src/extension.ts:178` |
