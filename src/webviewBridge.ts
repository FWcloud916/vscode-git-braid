/**
 * Host ↔ Webview binary communication bridge.
 *
 * # Protocol (plan §3.5)
 *
 * - **Paged + incremental**: the webview requests a visible range; the host
 *   returns only that window + a small buffer. Scroll triggers more requests.
 * - **Binary encoding**: a flat `ArrayBuffer` (typed-array layout) replaces JSON.
 *   Zero-copy on the webview side — directly fed to the Canvas renderer.
 * - **String pool**: author names, commit messages referenced by index from
 *   CommitRow structs (avoids repeated string bytes per row).
 *
 * # Message shapes
 *
 * Host → Webview:
 *   `{ type: "batch", payload: ArrayBuffer }` — binary-encoded RowLayout batch
 *   `{ type: "error", message: string }`
 *
 * Webview → Host:
 *   `{ type: "requestBatch", offset: number, limit: number }`
 *   `{ type: "ready" }` — sent once the webview JS has initialised
 *
 * Phase: Phase 0 skeleton — creates the panel with a placeholder HTML page.
 *        Binary protocol implementation is Phase 0/1.
 */

import * as vscode from "vscode";

/** Messages the webview can send to the extension host. */
type WebviewMessage =
  | { type: "ready" }
  | { type: "requestBatch"; offset: number; limit: number };

/** Messages the extension host can send to the webview. */
type HostMessage =
  | { type: "batch"; payload: ArrayBuffer }
  | { type: "error"; message: string };

export class WebviewBridge implements vscode.Disposable {
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(
    context: vscode.ExtensionContext,
    private readonly _onDispose: () => void,
  ) {
    this._panel = vscode.window.createWebviewPanel(
      "gitBraid",
      "Git Braid",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      },
    );

    const webviewJsUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "dist", "webview.js"),
    );

    this._panel.webview.html = this._buildHtml(webviewJsUri);

    // Handle messages from the webview.
    this._panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this._handleMessage(message),
      undefined,
      this._disposables,
    );

    this._panel.onDidDispose(
      () => {
        this.dispose();
        this._onDispose();
      },
      undefined,
      this._disposables,
    );
  }

  reveal(): void {
    this._panel.reveal();
  }

  dispose(): void {
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _handleMessage(message: WebviewMessage): void {
    switch (message.type) {
      case "ready":
        // TODO(M1): trigger initial batch load once walk + layout are implemented.
        break;
      case "requestBatch":
        // TODO(M1): call native addon get_graph_batch(repoPath, offset, limit)
        //           → encode → post binary buffer back.
        void this._postMessage({ type: "error", message: "Not implemented yet (M1)" });
        break;
    }
  }

  private async _postMessage(message: HostMessage): Promise<void> {
    await this._panel.webview.postMessage(message);
  }

  private _buildHtml(webviewJsUri: vscode.Uri): string {
    // Content-Security-Policy: only allow scripts from the extension's dist/ dir.
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src 'nonce-${nonce}';
                 style-src 'unsafe-inline';" />
  <title>Git Braid</title>
  <style>
    html, body, #app { margin: 0; padding: 0; width: 100%; height: 100%;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family); }
    #loading { display: flex; align-items: center; justify-content: center;
      height: 100%; font-size: 14px; opacity: 0.6; }
  </style>
</head>
<body>
  <div id="app">
    <div id="loading">Git Braid — loading… (Phase 0 skeleton)</div>
  </div>
  <script nonce="${nonce}" src="${webviewJsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
