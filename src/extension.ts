/**
 * Git Braid — VS Code Extension entry point.
 *
 * This module is loaded by VS Code when the extension activates. It:
 * 1. Registers the `gitBraid.openGraph` command.
 * 2. Creates and manages the Webview panel.
 * 3. Wires up the WebviewBridge (host ↔ webview binary protocol).
 *
 * All git read operations are delegated to the native Rust core via the napi
 * binding (`bindings/napi`). All git write operations (Phase 2) are in
 * `gitActions.ts` and use `child_process` to shell out to `git`.
 *
 * Phase: Phase 0 skeleton — registers the command and opens an empty panel.
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

    bridge = new WebviewBridge(context, () => {
      // Panel disposed — clean up.
      bridge = undefined;
    });
  });

  context.subscriptions.push(openGraph);
}

export function deactivate(): void {
  bridge?.dispose();
  bridge = undefined;
}
