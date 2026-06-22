/**
 * `gitBraid.generateReleaseNotes` command implementation.
 *
 * Flow:
 *  1. Opt-in gate (gitBraid.ai.enabled)
 *  2. Repo pick (reuse resolveRepos/pickRepo from extension.ts)
 *  3. Ref picker — QuickPick for `to` then `from`
 *  4. Privacy level picker — metadata-only vs +diff stat
 *  5. Provider construction — vscode-lm or BYO key (from SecretStorage)
 *  6. Consent modal — explicit per-run disclosure (plan §7.3)
 *  7. Range walk (gitoxide read path)
 *  8. AI generation with progress notification
 *  9. Open result in a new untitled Markdown document
 * 10. Error handling — friendly message + "Show details" → output channel
 *
 * API keys are stored in VS Code SecretStorage; never in settings.json.
 */

import * as vscode from "vscode";
import { listRefs, walkRange } from "@git-braid/native";
import { VscodeLmProvider, BYOKeyProvider, type BYOProviderType } from "./provider";
import { generateReleaseNotes } from "./releaseNotes";

/** RefKind discriminant values (mirror crates/core/src/model.rs). */
const REF_KIND_LOCAL_BRANCH = 0;
const REF_KIND_TAG = 2;

// Secret storage key template — one key per provider type.
const SECRET_KEY = (provider: string) => `gitBraid.ai.apiKey.${provider}`;

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the full generate-release-notes flow.
 * Called by the `gitBraid.generateReleaseNotes` command handler.
 */
export async function runReleaseNotesCommand(
  context: vscode.ExtensionContext,
  resolveRepos: () => string[],
  pickRepo: (repos: string[]) => Promise<string | undefined>,
): Promise<void> {
  // ── 1. Opt-in gate ────────────────────────────────────────────────────────
  const config = vscode.workspace.getConfiguration("gitBraid");
  const aiEnabled = config.get<boolean>("ai.enabled", false);
  if (!aiEnabled) {
    const action = await vscode.window.showWarningMessage(
      "Git Braid AI features are disabled. Enable them to generate release notes?",
      { modal: false },
      "Enable",
    );
    if (action !== "Enable") {
      return;
    }
    await config.update(
      "ai.enabled",
      true,
      vscode.ConfigurationTarget.Global,
    );
  }

  // ── 2. Repo pick ──────────────────────────────────────────────────────────
  const repos = resolveRepos();
  if (repos.length === 0) {
    void vscode.window.showErrorMessage(
      "Git Braid: No git repository found in the open workspace folders.",
    );
    return;
  }
  const repoPath = await pickRepo(repos);
  if (!repoPath) {
    return;
  }

  // ── 3. Ref picker ─────────────────────────────────────────────────────────
  let refs: Awaited<ReturnType<typeof listRefs>>;
  try {
    refs = listRefs(repoPath);
  } catch (err) {
    showError("Failed to list refs", err, context);
    return;
  }

  // Build quick-pick items: branches first, then tags, plus HEAD entry.
  const refItems = [
    {
      label: "HEAD",
      description: "Current commit",
      kind: REF_KIND_LOCAL_BRANCH,
      refName: "HEAD",
    },
    ...refs.map((r) => ({
      label: r.name,
      description:
        r.kind === REF_KIND_TAG
          ? "tag"
          : r.kind === REF_KIND_LOCAL_BRANCH
            ? "branch"
            : "",
      kind: r.kind,
      refName: r.name,
    })),
  ];

  // Pick `to` (default = HEAD).
  const toPick = await vscode.window.showQuickPick(refItems, {
    title: "Git Braid — Release Notes: pick the END of the range (to)",
    placeHolder: "Commits up to this ref will be included (default: HEAD)",
    matchOnDescription: true,
  });
  if (!toPick) {
    return;
  }

  // Pick `from` (all history if the user picks the special item).
  const fromItems = [
    {
      label: "⟂  All history",
      description: "Include all commits up to the selected end",
      kind: -1,
      refName: null as string | null,
    },
    ...refItems.filter((r) => r.refName !== toPick.refName),
  ];
  const fromPick = await vscode.window.showQuickPick(fromItems, {
    title: `Git Braid — Release Notes: pick the START of the range (from), end = ${toPick.refName}`,
    placeHolder:
      "Only commits AFTER this ref are included (exclusive, like git log from..to)",
    matchOnDescription: true,
  });
  if (!fromPick) {
    return;
  }
  const fromRef = fromPick.refName; // null = full history

  // ── 4. Privacy level picker ───────────────────────────────────────────────
  const defaultDiffStat = config.get<boolean>("ai.defaultDiffStat", false);
  const privacyPick = await vscode.window.showQuickPick(
    [
      {
        label: "Metadata only",
        description: "Send commit subjects and author names (recommended)",
        includeDiffStat: false,
        picked: !defaultDiffStat,
      },
      {
        label: "Include diff stat",
        description:
          "Also send files changed and ± line counts per commit (approximate)",
        includeDiffStat: true,
        picked: defaultDiffStat,
      },
    ],
    {
      title: "Git Braid — Release Notes: privacy level",
      placeHolder: "Choose what commit data to send to the AI",
    },
  );
  if (!privacyPick) {
    return;
  }
  const includeDiffStat = privacyPick.includeDiffStat;

  // ── 5. Provider construction ──────────────────────────────────────────────
  const providerType = config.get<string>("ai.provider", "vscode-lm");

  let provider: VscodeLmProvider | BYOKeyProvider;

  if (providerType === "vscode-lm") {
    provider = new VscodeLmProvider();
  } else {
    const byo = providerType as BYOProviderType;
    const model = config.get<string>("ai.model", "");

    // Look up stored key; prompt and store if missing.
    const secretKey = SECRET_KEY(byo);
    let apiKey = await context.secrets.get(secretKey);
    if (!apiKey) {
      apiKey = await vscode.window.showInputBox({
        title: `Git Braid — Enter your ${byo} API key`,
        prompt:
          "The key will be stored in VS Code's SecretStorage and not exposed in settings.",
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) =>
          v.trim().length === 0 ? "API key cannot be empty" : undefined,
      });
      if (!apiKey) {
        return;
      }
      await context.secrets.store(secretKey, apiKey);
    }

    provider = new BYOKeyProvider(byo, apiKey, model);
  }

  // ── 6. Consent modal ──────────────────────────────────────────────────────
  // Disclose exactly what will be sent and to which provider (plan §7.3).
  const dataDesc = includeDiffStat
    ? "commit subjects, author names, and diff stats (files ± lines)"
    : "commit subjects and author names";

  const providerDesc =
    providerType === "vscode-lm"
      ? "your VS Code Language Model (no external API call)"
      : `${providerType} (external API)`;

  const toRef = toPick.refName;
  const rangeLabel = fromRef ? `${fromRef}..${toRef}` : toRef;

  const confirmed = await vscode.window.showWarningMessage(
    `Git Braid will send ${dataDesc} for commits in [${rangeLabel}] to ${providerDesc}. Continue?`,
    { modal: true },
    "Continue",
  );
  if (confirmed !== "Continue") {
    return;
  }

  // ── 7 + 8. Range walk + AI generation ────────────────────────────────────
  let markdown: string;
  try {
    markdown = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Git Braid: Generating release notes…",
        cancellable: false,
      },
      async () => {
        const commits = walkRange(repoPath, fromRef, toRef, includeDiffStat);
        if (commits.length === 0) {
          throw new Error(
            `No commits found in range [${rangeLabel}]. ` +
              "Check that the selected refs are correct.",
          );
        }
        return generateReleaseNotes(provider, {
          commits,
          fromRef,
          toRef,
          includeDiffStat,
        });
      },
    );
  } catch (err) {
    showError("Release-notes generation failed", err, context);
    return;
  }

  // ── 9. Open result in a new untitled Markdown document ────────────────────
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: markdown,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Show a friendly error toast with a "Show details" action that dumps the
 * error to the "Git Braid" output channel (mirrors `_presentGitError` pattern
 * in `webviewBridge.ts`).
 */
function showError(
  summary: string,
  err: unknown,
  context: vscode.ExtensionContext,
): void {
  const detail = err instanceof Error ? err.message : String(err);
  void vscode.window
    .showErrorMessage(`Git Braid: ${summary}.`, "Show details")
    .then((action) => {
      if (action === "Show details") {
        const channel = getOutputChannel(context);
        channel.appendLine(`[${new Date().toISOString()}] ${summary}`);
        channel.appendLine(detail);
        if (err instanceof Error && err.stack) {
          channel.appendLine(err.stack);
        }
        channel.show(true);
      }
    });
}

/** Lazy singleton for the "Git Braid" output channel. */
let _outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(_context: vscode.ExtensionContext): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel("Git Braid");
  }
  return _outputChannel;
}
