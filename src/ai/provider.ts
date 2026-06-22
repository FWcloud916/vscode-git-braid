/**
 * AIProvider abstraction — M5.
 *
 * Two backend strategies (plan §7.1):
 *   1. VS Code Language Model API (`vscode.lm`) — primary; uses the user's
 *      existing model subscription. No key management needed.
 *   2. BYO API key — supports Anthropic Claude, OpenAI, Google Gemini, and
 *      Groq (via raw HTTP fetch for non-Anthropic providers).
 *
 * All AI features are **opt-in** (plan §7.3). The extension must obtain
 * explicit user consent before sending any commit data to an external model.
 * Always surface: what data will be sent, to which provider, and give a
 * "metadata only / no diff" mode option.
 *
 * Provider lookup: `gitBraid.ai.provider` setting → one of
 *   "vscode-lm" | "anthropic" | "openai" | "gemini" | "groq"
 * BYO keys are stored in VS Code SecretStorage, never in settings.json.
 */

import * as vscode from "vscode";
import Anthropic from "@anthropic-ai/sdk";

// ── Shared message types ──────────────────────────────────────────────────────

/**
 * A single prompt + response pair, provider-agnostic.
 * Callers build a `messages` array and pass it to `AIProvider.complete`.
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
 * Both VscodeLmProvider and BYOKeyProvider implement this.
 */
export interface AIProvider {
  readonly name: string;
  complete(messages: AIMessage[]): Promise<AICompletion>;
}

// ── BYO provider types ────────────────────────────────────────────────────────

/** The set of BYO API providers supported. */
export type BYOProviderType = "anthropic" | "openai" | "gemini" | "groq";

// ── VscodeLmProvider ─────────────────────────────────────────────────────────

/**
 * VS Code Language Model API provider.
 *
 * Uses `vscode.lm.selectChatModels()` — no API key management required.
 * The user must have a compatible extension installed (e.g. GitHub Copilot).
 *
 * vscode.lm has no "system" role — system messages are prepended into the
 * first user message.
 */
export class VscodeLmProvider implements AIProvider {
  readonly name = "vscode-lm";

  async complete(messages: AIMessage[]): Promise<AICompletion> {
    const models = await vscode.lm.selectChatModels({});
    const model = models[0];
    if (!model) {
      throw new Error(
        "Git Braid: No VS Code Language Model is available. " +
          "Install a compatible AI extension (e.g. GitHub Copilot) " +
          "or configure a BYO API key in the Git Braid settings.",
      );
    }

    // Build vscode.lm message array. System role is not supported: fold system
    // messages into a leading user message (prepend before the first user turn).
    const systemParts: string[] = [];
    const lmMessages: vscode.LanguageModelChatMessage[] = [];
    let systemFlushed = false;

    for (const msg of messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
        continue;
      }
      // First non-system message: prepend accumulated system context.
      let content = msg.content;
      if (!systemFlushed && systemParts.length > 0) {
        content = systemParts.join("\n\n") + "\n\n" + content;
        systemFlushed = true;
      }
      if (msg.role === "user") {
        lmMessages.push(vscode.LanguageModelChatMessage.User(content));
      } else {
        lmMessages.push(vscode.LanguageModelChatMessage.Assistant(content));
      }
    }

    // If only system messages were provided (no user turns), emit them as user.
    if (!systemFlushed && systemParts.length > 0) {
      lmMessages.push(
        vscode.LanguageModelChatMessage.User(systemParts.join("\n\n")),
      );
    }

    const tokenSource = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(lmMessages, {}, tokenSource.token);

    let text = "";
    for await (const fragment of response.text) {
      text += fragment;
    }

    return { text };
  }
}

// ── BYOKeyProvider ────────────────────────────────────────────────────────────

/**
 * BYO API key provider supporting Anthropic, OpenAI, Gemini, and Groq.
 *
 * - **anthropic**: uses `@anthropic-ai/sdk` with streaming.
 * - **openai** / **groq**: OpenAI-compatible `/chat/completions` via raw fetch.
 *   Groq defaults to `https://api.groq.com/openai/v1`; overridable via baseURL.
 * - **gemini**: Google `generateContent` API via raw fetch.
 *
 * API keys are stored in VS Code SecretStorage — never in settings.json.
 */
export class BYOKeyProvider implements AIProvider {
  readonly name: string;

  constructor(
    private readonly _providerType: BYOProviderType,
    private readonly _apiKey: string,
    private readonly _model: string,
    private readonly _baseURL?: string,
  ) {
    this.name = `byo-${_providerType}`;
  }

  async complete(messages: AIMessage[]): Promise<AICompletion> {
    switch (this._providerType) {
      case "anthropic":
        return this._completeAnthropic(messages);
      case "openai":
        return this._completeOpenAICompat(
          messages,
          this._baseURL ?? "https://api.openai.com/v1",
        );
      case "groq":
        return this._completeOpenAICompat(
          messages,
          this._baseURL ?? "https://api.groq.com/openai/v1",
        );
      case "gemini":
        return this._completeGemini(messages);
    }
  }

  // ── Anthropic ──────────────────────────────────────────────────────────────

  private async _completeAnthropic(messages: AIMessage[]): Promise<AICompletion> {
    const client = new Anthropic({
      apiKey: this._apiKey,
      ...(this._baseURL ? { baseURL: this._baseURL } : {}),
    });

    // Extract leading system message (Anthropic uses a top-level `system` param).
    let system: string | undefined;
    const userAssistant: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        system = system ? system + "\n\n" + msg.content : msg.content;
      } else {
        userAssistant.push({ role: msg.role, content: msg.content });
      }
    }

    // Use streaming + finalMessage() for long output (plan §claude-api skill).
    const stream = client.messages.stream({
      model: this._model || "claude-opus-4-8",
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      ...(system ? { system } : {}),
      messages: userAssistant,
    });

    const final = await stream.finalMessage();

    const text = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      },
    };
  }

  // ── OpenAI-compatible (OpenAI + Groq) ──────────────────────────────────────

  private async _completeOpenAICompat(
    messages: AIMessage[],
    baseURL: string,
  ): Promise<AICompletion> {
    // vscode.lm-style system → just include it; OpenAI chat supports system role.
    const body = {
      model: this._model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this._apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "(no body)");
      throw new Error(
        `${this._providerType} API error ${resp.status}: ${errorText}`,
      );
    }

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const text = data.choices[0]?.message?.content ?? "";
    const usageData = data.usage;
    return {
      text,
      ...(usageData
        ? {
            usage: {
              inputTokens: usageData.prompt_tokens,
              outputTokens: usageData.completion_tokens,
            },
          }
        : {}),
    };
  }

  // ── Google Gemini ──────────────────────────────────────────────────────────

  private async _completeGemini(messages: AIMessage[]): Promise<AICompletion> {
    const model = this._model || "gemini-1.5-pro";

    // Separate system instructions from user/assistant turns.
    const systemParts: string[] = [];
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
      } else {
        // Gemini uses "user" and "model" roles.
        const geminiRole = msg.role === "assistant" ? "model" : "user";
        contents.push({ role: geminiRole, parts: [{ text: msg.content }] });
      }
    }

    const body: Record<string, unknown> = { contents };
    if (systemParts.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemParts.join("\n\n") }],
      };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this._apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "(no body)");
      throw new Error(`Gemini API error ${resp.status}: ${errorText}`);
    }

    const data = (await resp.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    };

    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("") ?? "";

    const usageMeta = data.usageMetadata;
    const hasUsage =
      usageMeta?.promptTokenCount !== undefined &&
      usageMeta.candidatesTokenCount !== undefined;

    return {
      text,
      ...(hasUsage
        ? {
            usage: {
              inputTokens: usageMeta!.promptTokenCount!,
              outputTokens: usageMeta!.candidatesTokenCount!,
            },
          }
        : {}),
    };
  }
}
