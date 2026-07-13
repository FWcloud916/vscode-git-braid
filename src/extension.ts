/**
 * Git Braid — VS Code Extension entry point.
 *
 * This module is loaded by VS Code when the extension activates. It:
 * 1. Registers the `gitBraid.openGraph` and `gitBraid.selectRepo` commands.
 * 2. Discovers git repositories from the open workspace folders (both the
 *    folder itself/its ancestors, and nested/sibling repos beneath it).
 * 3. Presents a repo picker for multi-root workspaces.
 * 4. Creates and manages the Webview panel via WebviewBridge.
 *
 * All git read operations are delegated to the native Rust core via the napi
 * binding (`bindings/napi`). All git write operations (Phase 2) are in
 * `gitActions.ts` and use `child_process` to shell out to `git`.
 */

import * as path from "path";
import * as vscode from "vscode";
import { WebviewBridge } from "./webviewBridge";
import { GitBraidContentProvider } from "./diffProvider";
import { runReleaseNotesCommand } from "./ai/releaseNotesCommand";
import { discoverRepo } from "@git-braid/native";
import { collectRepoRoots, isRepoRoot, listChildDirs } from "./repoScan";

let bridge: WebviewBridge | undefined;

// ── Repository discovery ──────────────────────────────────────────────────────

/**
 * Discover every git repository reachable from the open workspace folders and
 * return the list of unique worktree roots found.
 *
 * Two discovery passes run per folder (docs/adr/0007-nested-repo-scan.md):
 *
 * 1. **Upward** — `discoverRepo` (gitoxide) walks up from the folder path
 *    until it finds a `.git` directory, so a workspace folder that is itself
 *    a subdirectory of a repo is still found correctly.
 * 2. **Downward** — `collectRepoRoots` scans up to `gitBraid.repoScanDepth`
 *    levels beneath the folder for nested/sibling repos (e.g. a `projects/`
 *    folder containing many unrelated checkouts), which the upward walk alone
 *    cannot see.
 *
 * Duplicates are removed (multiple folders, or the two passes, can resolve to
 * the same root). Exported so the AI release-notes command can reuse it
 * without duplicating discovery logic.
 */
export async function resolveRepos(): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const maxDepth =
    vscode.workspace.getConfiguration("gitBraid").get<number>("repoScanDepth") ?? 2;

  const seen = new Set<string>();
  const repos: string[] = [];
  function add(root: string | null | undefined): void {
    if (root && !seen.has(root)) {
      seen.add(root);
      repos.push(root);
    }
  }

  for (const folder of folders) {
    const folderPath = folder.uri.fsPath;
    add(discoverRepo(folderPath));
    for (const root of collectRepoRoots([folderPath], maxDepth, {
      isRepoRoot,
      childDirs: listChildDirs,
    })) {
      add(root);
    }
  }

  return repos;
}

/**
 * If there is exactly one repo, return it without prompting.
 * Otherwise present a `showQuickPick` and return the chosen root, or
 * `undefined` if the user cancelled.
 *
 * Exported so the AI release-notes command can reuse it.
 */
export async function pickRepo(repos: string[]): Promise<string | undefined> {
  if (repos.length === 1) {
    return repos[0]!;
  }
  const items = repos.map((root) => ({
    label: path.basename(root),
    description: root,
    root,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: "Git Braid — Select repository",
    placeHolder: "Choose a repository to visualise",
    matchOnDescription: true,
  });
  return pick?.root;
}

/**
 * Dispose any existing bridge panel and open a fresh one for `repoPath`.
 * Using recreate-panel keeps the protocol simple: the webview resets naturally
 * via the `ready` message on each new panel load (no extra `reset` message needed).
 *
 * The bridge is given the full discovered repo list (re-resolved on every
 * open unless the caller already has a fresh one, e.g. the command handlers
 * below right after their own `resolveRepos()` call) so the webview's
 * in-panel repo dropdown can offer every repo, not just the one being opened.
 * Passing `(root) => openRepo(context, root)` as the switch callback lets the
 * dropdown trigger the same recreate-panel flow used by `gitBraid.selectRepo`.
 */
async function openRepo(
  context: vscode.ExtensionContext,
  repoPath: string,
  repos?: string[],
): Promise<void> {
  const repoList = repos ?? (await resolveRepos());
  bridge?.dispose();
  bridge = new WebviewBridge(
    context,
    repoPath,
    repoList,
    (root) => {
      void openRepo(context, root);
    },
    () => {
      bridge = undefined;
    },
  );
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // ── gitBraid.openGraph ────────────────────────────────────────────────────
  const openGraph = vscode.commands.registerCommand(
    "gitBraid.openGraph",
    async () => {
      if (bridge) {
        // Reveal existing panel instead of creating a new one.
        bridge.reveal();
        return;
      }

      const repos = await resolveRepos();
      if (repos.length === 0) {
        void vscode.window.showErrorMessage(
          "Git Braid: No git repository found in the open workspace folders.",
        );
        return;
      }

      const pick = await pickRepo(repos);
      if (pick) {
        await openRepo(context, pick, repos);
      }
    },
  );

  // ── gitBraid.selectRepo ───────────────────────────────────────────────────
  // Allows the user to switch repositories even when the graph panel is open.
  const selectRepo = vscode.commands.registerCommand(
    "gitBraid.selectRepo",
    async () => {
      const repos = await resolveRepos();
      if (repos.length === 0) {
        void vscode.window.showInformationMessage(
          "Git Braid: No git repositories found in the open workspace folders.",
        );
        return;
      }

      // Always show the picker — even with one repo — so the user can confirm
      // which repo is open and intentionally reload the graph for it.
      const items = repos.map((root) => ({
        label: path.basename(root),
        description: root,
        root,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title: "Git Braid — Switch repository",
        placeHolder: "Choose a repository to visualise",
        matchOnDescription: true,
      });
      if (pick) {
        await openRepo(context, pick.root, repos);
      }
    },
  );

  // ── gitBraid.find ─────────────────────────────────────────────────────────
  // Search full history and highlight matches in the open graph.
  // The keybinding (Cmd+F when the graph panel is focused) is in package.json.
  const find = vscode.commands.registerCommand("gitBraid.find", async () => {
    if (!bridge) {
      void vscode.window.showInformationMessage(
        "Git Braid: open the graph first (Git Braid: Open Graph).",
      );
      return;
    }
    const query = await vscode.window.showInputBox({
      prompt: "Find commit — subject, author name, or OID prefix (case-insensitive)",
      placeHolder: "e.g. fix crash, alice, or a1b2c3d",
    });
    if (query) {
      bridge.reveal();
      await bridge.find(query);
    }
  });

  // ── gitBraid.generateReleaseNotes ─────────────────────────────────────────
  // AI-assisted release-notes generation for a commit range (M5).
  // Opt-in gated: gitBraid.ai.enabled must be true (or the user enables it
  // when prompted). Keys stored in SecretStorage, never in settings.json.
  const generateReleaseNotes = vscode.commands.registerCommand(
    "gitBraid.generateReleaseNotes",
    () => runReleaseNotesCommand(context, resolveRepos, pickRepo),
  );

  // ── gitBraid.clearAiKey ────────────────────────────────────────────────────
  // Utility command to remove a stored BYO API key from SecretStorage.
  const clearAiKey = vscode.commands.registerCommand(
    "gitBraid.clearAiKey",
    async () => {
      const providers = ["anthropic", "openai", "gemini", "groq"];
      const pick = await vscode.window.showQuickPick(
        providers.map((p) => ({
          label: p,
          description: `Clear stored ${p} API key`,
        })),
        { title: "Git Braid — Clear stored API key", placeHolder: "Select provider" },
      );
      if (pick) {
        await context.secrets.delete(`gitBraid.ai.apiKey.${pick.label}`);
        void vscode.window.showInformationMessage(
          `Git Braid: ${pick.label} API key removed from SecretStorage.`,
        );
      }
    },
  );

  // Register the `gitbraid:` content provider once, for the lifetime of the
  // extension. The provider serves blob content to VS Code's built-in diff
  // viewer via gitoxide (no `git` subprocess).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "gitbraid",
      new GitBraidContentProvider(),
    ),
  );

  // ── Status-bar open button ────────────────────────────────────────────────
  // Always-visible entry point in the bottom-left of VS Code. Clicking it runs
  // the same `gitBraid.openGraph` command (single repo → opens directly, multi
  // repo → shows picker, already open → reveals).
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0,
  );
  statusBarItem.text = "$(git-branch) Git Braid";
  statusBarItem.tooltip = "Open Git Braid graph";
  statusBarItem.command = "gitBraid.openGraph";
  statusBarItem.show();

  context.subscriptions.push(openGraph, selectRepo, find, generateReleaseNotes, clearAiKey, statusBarItem);
}

export function deactivate(): void {
  bridge?.dispose();
  bridge = undefined;
}
