/**
 * Git Braid — VS Code Extension entry point.
 *
 * This module is loaded by VS Code when the extension activates. It:
 * 1. Registers the `gitBraid.openGraph` and `gitBraid.selectRepo` commands.
 * 2. Discovers git repositories from the open workspace folders.
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
import { discoverRepo } from "@git-braid/native";

let bridge: WebviewBridge | undefined;

// ── Repository discovery ──────────────────────────────────────────────────────

/**
 * Map every open workspace folder through gitoxide's repo-discovery and return
 * the list of unique worktree roots found.
 *
 * Discovery uses `discoverRepo` (gitoxide, no subprocess) which walks upward
 * from each folder's path until it finds a `.git` directory — so a workspace
 * folder that is a subdirectory of a repo is still found correctly.
 * Duplicates are removed (multiple folders can resolve to the same root).
 */
function resolveRepos(): string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const seen = new Set<string>();
  const repos: string[] = [];
  for (const folder of folders) {
    const root = discoverRepo(folder.uri.fsPath);
    if (root && !seen.has(root)) {
      seen.add(root);
      repos.push(root);
    }
  }
  return repos;
}

/**
 * If there is exactly one repo, return it without prompting.
 * Otherwise present a `showQuickPick` and return the chosen root, or
 * `undefined` if the user cancelled.
 */
async function pickRepo(repos: string[]): Promise<string | undefined> {
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
 */
function openRepo(context: vscode.ExtensionContext, repoPath: string): void {
  bridge?.dispose();
  bridge = new WebviewBridge(context, repoPath, () => {
    bridge = undefined;
  });
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

      const repos = resolveRepos();
      if (repos.length === 0) {
        void vscode.window.showErrorMessage(
          "Git Braid: No git repository found in the open workspace folders.",
        );
        return;
      }

      const pick = await pickRepo(repos);
      if (pick) {
        openRepo(context, pick);
      }
    },
  );

  // ── gitBraid.selectRepo ───────────────────────────────────────────────────
  // Allows the user to switch repositories even when the graph panel is open.
  const selectRepo = vscode.commands.registerCommand(
    "gitBraid.selectRepo",
    async () => {
      const repos = resolveRepos();
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
        openRepo(context, pick.root);
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

  // Register the `gitbraid:` content provider once, for the lifetime of the
  // extension. The provider serves blob content to VS Code's built-in diff
  // viewer via gitoxide (no `git` subprocess).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "gitbraid",
      new GitBraidContentProvider(),
    ),
  );

  context.subscriptions.push(openGraph, selectRepo, find);
}

export function deactivate(): void {
  bridge?.dispose();
  bridge = undefined;
}
