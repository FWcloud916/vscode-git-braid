/**
 * Git Braid — VS Code Extension entry point.
 *
 * This module is loaded by VS Code when the extension activates. It:
 * 1. Registers the `gitBraid.openGraph` command.
 * 2. Resolves the repository path from the active workspace folder.
 * 3. Creates and manages the Webview panel via WebviewBridge.
 * 4. Wires up the host ↔ webview binary protocol.
 *
 * All git read operations are delegated to the native Rust core via the napi
 * binding (`bindings/napi`). All git write operations (Phase 2) are in
 * `gitActions.ts` and use `child_process` to shell out to `git`.
 */

import * as vscode from "vscode";
import { WebviewBridge } from "./webviewBridge";

let bridge: WebviewBridge | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const openGraph = vscode.commands.registerCommand("gitBraid.openGraph", () => {
    if (bridge) {
      // Reveal existing panel instead of creating a new one.
      bridge.reveal();
      return;
    }

    // Resolve the repository root from the first workspace folder.
    // Multi-root workspaces: use the folder that contains the active editor,
    // falling back to the first folder. (Phase 1 will add a proper repo picker.)
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      void vscode.window.showErrorMessage(
        "Git Braid: No workspace folder open. Open a git repository to use Git Braid.",
      );
      return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    const repoFolder =
      (activeEditor &&
        vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)) ??
      folders[0]!;
    const repoPath = repoFolder.uri.fsPath;

    bridge = new WebviewBridge(context, repoPath, () => {
      // Panel disposed — clean up reference.
      bridge = undefined;
    });
  });

  context.subscriptions.push(openGraph);
}

export function deactivate(): void {
  bridge?.dispose();
  bridge = undefined;
}
