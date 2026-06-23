# AIProvider — Protocol Spec

> Version: v0.1
> Nature: Protocol spec
> Implementation target: `src/ai/provider.ts`
> Corresponds to: [ADR-0007](../adr/0007-multi-provider-ai-backend.md)
> See also: [docs/ai/README.md](../ai/README.md)

---

## 1. Purpose and scope

The `AIProvider` interface is a **provider-agnostic single-turn completion
protocol**. It hides the structural differences between five LLM backends
(VS Code Language Model API, Anthropic, OpenAI, Groq, Google Gemini) behind
one stable call signature.

### In scope

- The `AIMessage` input type (roles, content).
- The `AICompletion` output type (text, optional usage).
- Per-provider system-role normalization rules (the core behavioural contract).
- Error semantics for HTTP failures.
- The `BYOKeyProvider` extension point.

### Out of scope

- User opt-in / consent — that is the *caller's* responsibility
  (`releaseNotesCommand.ts`).
- API key management — handled by VS Code `SecretStorage` in the caller.
- Streaming to the user — `complete()` awaits the full response before returning.
- Multi-turn conversations — only single-turn (`messages` → `completion`).

---

## 2. Terminology

| Term | Definition |
|---|---|
| **system message** | `AIMessage` with `role: "system"` — typically the task instruction given to the LLM before user content. |
| **user message** | `AIMessage` with `role: "user"`. |
| **assistant message** | `AIMessage` with `role: "assistant"` — prior model output in a multi-turn conversation (not currently used by any caller). |
| **system-role normalization** | The per-provider transformation applied to handle providers that lack a native `system` role. |
| **BYO provider** | A `BYOKeyProvider` instance using one of `"anthropic" \| "openai" \| "gemini" \| "groq"`. |

---

## 3. Input contract

```
AIMessage:
  role:    "user" | "assistant" | "system"
  content: string   // non-empty in practice; empty string is tolerated
```

```
complete(messages: AIMessage[]): Promise<AICompletion>
```

**Preconditions** (caller guarantees; providers do not validate):

- `messages` is non-empty.
- At most one `system` message; it appears first if present. (Current callers
  produce exactly `[system, user]`. Multiple system messages are supported by
  Anthropic concatenation but not tested.)
- Content strings are valid UTF-8.

---

## 4. Output contract

```
AICompletion:
  text:  string               // model's full response text; may be empty
  usage?: {
    inputTokens:  number      // tokens consumed by the prompt
    outputTokens: number      // tokens in the completion
  }
```

`usage` is **omitted** for `VscodeLmProvider` — the VS Code LM API does not
expose token counts.

---

## 5. Invariants

1. **Provider-agnostic input**: callers build `AIMessage[]` with standard roles and
   pass it to any provider implementation without modification.

2. **Deterministic role mapping**: given the same messages array, the provider
   always produces the same API request structure (no randomness in the mapping
   itself; model output is non-deterministic).

3. **Keys never in settings.json**: `BYOKeyProvider` receives the key as a
   constructor argument. The caller obtains it from VS Code `SecretStorage`.
   No provider implementation reads from `workspace.getConfiguration`.

4. **`usage` is best-effort**: absence of `usage` is never an error. Callers
   must treat it as optional.

5. **Throws on failure**: `complete()` throws `Error` on any failure (network,
   HTTP non-ok, provider-level error). It never resolves with a partial or
   error-flagged `AICompletion`.

---

## 6. Core algorithm — per-provider system-role normalization

This is the central behavioural contract of the provider layer.

### 6a. `VscodeLmProvider`

`vscode.lm` has no `system` role. System messages are folded into the first
user turn:

```
for msg in messages:
  if msg.role == "system":
    collect into systemParts[]
  else (user / assistant):
    if first non-system and systemParts non-empty:
      prepend systemParts.join("\n\n") + "\n\n" to content
    emit as LanguageModelChatMessage.User / .Assistant
if no user message at all:
  emit systemParts.join("\n\n") as a single User message
```

Result: the VS Code LM receives a pure user/assistant alternation; all system
context is embedded in the first user turn's text.

### 6b. `BYOKeyProvider — anthropic`

Anthropic's API has a top-level `system` parameter separate from the messages
array:

```
system = ""
userAssistant = []
for msg in messages:
  if msg.role == "system":
    system = system ? system + "\n\n" + msg.content : msg.content
  else:
    userAssistant.push({ role: msg.role, content: msg.content })
send: { system, messages: userAssistant, model, max_tokens: 4096, thinking: {type:"adaptive"} }
```

Multiple system messages are concatenated with `"\n\n"`. The `thinking` parameter
enables adaptive extended thinking on supported models.

### 6c. `BYOKeyProvider — openai` and `groq`

Both use the OpenAI-compatible `/chat/completions` endpoint which natively
supports `system`, `user`, and `assistant` roles. Messages are passed through
unchanged:

```
POST {baseURL}/chat/completions
body: { model, messages: messages.map(m => { role: m.role, content: m.content }) }
```

`openai` baseURL: `https://api.openai.com/v1` (default).
`groq` baseURL: `https://api.groq.com/openai/v1` (default). Both are
overridable via the `_baseURL` constructor argument.

### 6d. `BYOKeyProvider — gemini`

Gemini separates system instructions from the conversation content:

```
systemParts = []
contents = []
for msg in messages:
  if msg.role == "system":
    systemParts.push(msg.content)
  else:
    geminiRole = msg.role == "assistant" ? "model" : "user"
    contents.push({ role: geminiRole, parts: [{ text: msg.content }] })

body = { contents }
if systemParts non-empty:
  body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] }

POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}
```

Note the role rename: `assistant` → `"model"` (Gemini's convention).

---

## 7. Error contract

HTTP failures from BYO providers throw:
```
Error: `${providerType} API error ${status}: ${body}`
```
where `body` is the raw response text (or `"(no body)"` if reading fails).

`VscodeLmProvider` throws the VS Code LM API error directly, plus a
friendly guidance message if no model is available:
```
Error: "Git Braid: No VS Code Language Model is available. Install a
        compatible AI extension (e.g. GitHub Copilot) or configure a BYO API key."
```

---

## 8. Edge cases

| Case | Handling |
|---|---|
| `messages` is `[]` | Passed as-is; behaviour is provider-defined (likely an API error) |
| System message only, no user turn | `VscodeLmProvider`: emits the system content as a User message. All BYO providers: `contents`/`messages` array is empty, which may be an API error. |
| `usage` absent in OpenAI/Groq response | `usage` field omitted from `AICompletion`; not an error |
| `usage` absent in Gemini response | Same |
| `oid` field empty in Gemini `candidates` | `text` field in `AICompletion` is `""` |
| `choices[0]` absent in OpenAI response | `text` field in `AICompletion` is `""` |

---

## 9. Performance notes

- `VscodeLmProvider`: streams and collects fragments in a `for await … of` loop.
  Latency dominated by the VS Code LM extension's round-trip time.
- `anthropic`: uses `@anthropic-ai/sdk` streaming + `.finalMessage()`. Streaming
  avoids timeout on long completions.
- `openai` / `groq` / `gemini`: single non-streaming `fetch`. Suitable for the
  current single-turn use case; may time out on very long completions.

---

## 10. Open decisions

1. **Lazy bundle for Anthropic SDK**: `@anthropic-ai/sdk` (~200 KB) is always
   bundled. If bundle size becomes a concern, dynamic `import()` could defer it
   to when the user first picks `anthropic`. Requires esbuild config changes.
   (ADR-0007 §Negative trade-offs.)

2. **Streaming for non-Anthropic BYO providers**: raw `fetch` with no streaming
   means there is no progress feedback for long completions. Phase 6 can add SSE
   streaming for OpenAI/Groq/Gemini if needed.

3. **`embed()` method**: semantic search (planned M6) requires embedding vectors,
   not text completions. The current `AIProvider` interface has only `complete()`.
   Adding an `embed()` method (or a separate `EmbeddingProvider` interface) will
   be needed. See [planned-features.md](../ai/planned-features.md).

---

## 11. Interface with other modules

- **Upstream**: `releaseNotes.ts` calls `provider.complete(messages)`. Other
  planned AI features will do the same.
- **Downstream**: `AICompletion.text` is returned to the feature-logic layer
  (`generateReleaseNotes`, etc.) for display or further processing.
- **Parallel**: consent / key management live in `releaseNotesCommand.ts` and
  must run before calling `complete()`.
