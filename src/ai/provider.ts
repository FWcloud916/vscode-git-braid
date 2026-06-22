/**
 * AIProvider abstraction — Phase 3.
 *
 * Abstracts over two backend strategies (plan §7.1):
 *   1. VS Code Language Model API (`vscode.lm`) — primary; uses the user's
 *      existing model subscription. No key management needed.
 *   2. BYO API key — fallback for users without `vscode.lm` access.
 *
 * All AI features are **opt-in** (plan §7.3). The extension must obtain
 * explicit user consent before sending any commit data to an external model.
 * Always surface: what data will be sent, to which provider, and give a
 * "metadata only / no diff" mode option.
 *
 * # Status
 *
 * **Stub** — Phase 3 implementation target.
 */

/**
 * A single prompt + response pair passed to an AI provider.
 * Kept provider-agnostic so callers don't depend on the underlying API shape.
 */
export interface AIMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** The result of an AI completion. */
export interface AICompletion {
  text: string;
  /** Token usage if available from the provider. */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Provider-agnostic interface for LLM completions.
 * Implement this for VS Code LM API and for BYO-key providers.
 */
export interface AIProvider {
  readonly name: string;
  complete(messages: AIMessage[]): Promise<AICompletion>;
}

// ── Future implementations (Phase 3) ──────────────────────────────────────

/**
 * VS Code Language Model API provider.
 * Uses `vscode.lm.selectChatModels()` — no key management required.
 *
 * @throws {Error} Until Phase 3 implementation.
 */
export class VscodeLmProvider implements AIProvider {
  readonly name = "vscode-lm";

  async complete(_messages: AIMessage[]): Promise<AICompletion> {
    throw new Error("VscodeLmProvider not implemented (Phase 3)");
  }
}

/**
 * BYO API key provider (e.g. Anthropic Claude direct API).
 *
 * @throws {Error} Until Phase 3 implementation.
 */
export class BYOKeyProvider implements AIProvider {
  readonly name = "byo-key";

  constructor(
    private readonly _apiKey: string,   // used in Phase 3 completion call
    private readonly _model: string,    // used in Phase 3 completion call
  ) {}

  async complete(_messages: AIMessage[]): Promise<AICompletion> {
    throw new Error("BYOKeyProvider not implemented (Phase 3)");
  }
}
