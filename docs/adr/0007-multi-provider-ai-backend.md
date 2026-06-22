# ADR-0007: Multi-provider AI backend + SecretStorage key management

**Date:** 2026-06-23
**Status:** Accepted

---

## Context

M5 introduces the first AI feature: release-notes generation. The feature needs
an LLM backend. Two user groups exist:

1. **VS Code Copilot subscribers** — already pay for an LLM via `vscode.lm`;
   they expect zero extra setup.
2. **BYO-key users** — prefer direct model access (Anthropic, OpenAI, Gemini, Groq)
   for cost control, model choice, or privacy.

Both groups must be served without privileging one over the other. Additionally:

- API keys must never leak into settings.json (world-readable on shared machines,
  accidentally committed to dotfiles repos).
- Users must know what data goes to which provider before it is sent (plan §7.3
  opt-in requirement).
- The feature is opt-in (`gitBraid.ai.enabled` default false).

---

## Decision

**Implement two provider classes behind a single `AIProvider` interface:**

1. **`VscodeLmProvider`** — calls `vscode.lm.selectChatModels()` then
   `model.sendRequest()`. No key required. Falls back to a friendly error message
   if the VS Code Copilot subscription is absent. System messages are folded into
   the first user turn because the vscode.lm API has no system role.

2. **`BYOKeyProvider`** — a single class parameterised by
   `"anthropic" | "openai" | "gemini" | "groq"`:
   - **Anthropic**: `@anthropic-ai/sdk` with streaming + `.finalMessage()`.
   - **OpenAI / Groq**: raw `fetch` to the OpenAI-compatible `/chat/completions`
     endpoint (OpenAI default; Groq override). Native `fetch` is available in
     Node ≥ 18 (the VS Code extension host version target).
   - **Gemini**: raw `fetch` to the `generateContent` REST endpoint with an API
     key query parameter.
   
   Raw `fetch` for OpenAI/Groq/Gemini avoids bundling three extra SDKs and keeps
   `dist/extension.js` small. Only Anthropic is bundled because it is the
   project's own stack and the SDK provides streaming, retry, and type safety
   that outweigh the size cost.

**API key storage:** `context.secrets` (VS Code `SecretStorage` — OS keychain on
macOS/Windows, libsecret on Linux). Keys are prompted via `showInputBox({
password: true })` on first use and stored by a stable per-provider key name
(`"gitBraid.ai.key.<provider>"`). They never appear in settings.json or
workspace state.

**Per-run consent modal:** before any AI call the user sees a modal listing the
provider name, model, and data level (metadata-only vs +diff stat). This
satisfies plan §7.3 — the user confirms every run, not just at setup time.

---

## Consequences

**Positive:**
- Zero-setup path for Copilot subscribers; BYO path for everyone else.
- Four providers supported without four bundled SDKs.
- API keys stored in OS keychain, not in source-controllable files.
- Per-run consent is explicit and minimal — no long privacy-settings dialog.
- `AIProvider` interface is thin enough to add a fifth provider (e.g. a local
  model via Ollama's OpenAI-compatible API) without changing calling code.

**Negative / trade-offs:**
- Raw `fetch` for OpenAI/Groq/Gemini means no SDK-level retry, streaming
  helpers, or type-safe response shapes — callers parse the response JSON
  themselves. Acceptable for a simple single-turn use case.
- vscode.lm does not expose usage token counts; the `usage` field in
  `AICompletion` is omitted for that path.
- `@anthropic-ai/sdk` (~200 KB) is bundled unconditionally even when the user
  picks a different provider. Lazy dynamic import would require esbuild config
  changes; deferred to M6 if bundle size becomes a concern.

**Neutral / follow-up:**
- `gitBraid.clearAiKey` command lets users rotate or delete stored keys without
  digging into OS keychain tools.
- `gitBraid.ai.model` setting lets users pin a model string per provider; ignored
  for `vscode-lm` (model selection is VS Code's concern).
- If a sixth provider is needed, add a new `BYOProviderType` literal and a
  matching branch in `BYOKeyProvider.complete()`.
