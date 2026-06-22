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
 *   `{ type: "batch", payload: ArrayBuffer }` — BRAI v2 binary batch
 *   `{ type: "commitDetail", detail: CommitDetail }` — single commit full detail
 *   `{ type: "error", message: string }`
 *
 * Webview → Host:
 *   `{ type: "requestBatch", offset: number, limit: number }`
 *   `{ type: "ready" }` — sent once the webview JS has initialised
 *   `{ type: "selectCommit", oid: string }` — user clicked a commit row
 */

import * as path from "path";
import * as vscode from "vscode";
import { getGraphBatch, getCommitDetail, findCommits, type CommitDetail, type FindMatch } from "@git-braid/native";
import { buildDiffUri } from "./diffProvider";

/** Messages the webview can send to the extension host. */
type WebviewMessage =
  | { type: "ready" }
  | { type: "requestBatch"; offset: number; limit: number }
  | { type: "selectCommit"; oid: string }
  | { type: "openDiff"; filePath: string; oldOid: string; newOid: string; status: string };

/** Messages the extension host can send to the webview. */
type HostMessage =
  | { type: "batch"; payload: ArrayBuffer }
  | { type: "commitDetail"; detail: CommitDetail }
  | { type: "findResults"; query: string; matches: FindMatch[] }
  | { type: "config"; dateFormat: string; palette: string[] }
  | { type: "error"; message: string };

export class WebviewBridge implements vscode.Disposable {
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(
    context: vscode.ExtensionContext,
    private readonly _repoPath: string,
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

  /**
   * Search the full commit history for `query` and post results to the webview.
   *
   * Delegates to the Rust `find_commits` napi function (gitoxide, no subprocess).
   * The webview receives `{ type: "findResults", query, matches }` and handles
   * highlighting + navigation itself.
   */
  async find(query: string): Promise<void> {
    try {
      const matches = findCommits(this._repoPath, query, 1000);
      await this._postMessage({ type: "findResults", query, matches });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this._postMessage({ type: "error", message });
    }
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
        // Webview has initialised — push display config first (so the renderer
        // has the correct palette before the first paint), then load commits.
        void this._sendConfig();
        void this._sendInitialBatch();
        break;
      case "requestBatch":
        void this._sendBatch(message.offset, message.limit);
        break;
      case "selectCommit":
        void this._sendCommitDetail(message.oid);
        break;
      case "openDiff":
        void this._openDiff(message.filePath, message.oldOid, message.newOid, message.status);
        break;
    }
  }

  /**
   * Send display configuration to the webview.
   *
   * Called before the initial batch on `ready` so the renderer has the correct
   * palette and date format before the first paint. Reading config here (rather
   * than caching in the constructor) means reopening the panel picks up any
   * settings changes made since the last open.
   */
  private async _sendConfig(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("gitBraid");
    const dateFormat = cfg.get<string>("dateFormat") ?? "absolute";
    const palette = cfg.get<string[]>("graphColors") ?? [];
    await this._postMessage({ type: "config", dateFormat, palette });
  }

  /** Send the initial batch on `ready`, using the configured commit load size. */
  private async _sendInitialBatch(): Promise<void> {
    const limit =
      vscode.workspace
        .getConfiguration("gitBraid")
        .get<number>("initialCommitLoad") ?? 300;
    await this._sendBatch(0, limit);
  }

  /**
   * Call `getGraphBatch` on the native addon and post the binary buffer
   * to the webview as `{ type: "batch", payload: ArrayBuffer }`.
   *
   * On error, posts `{ type: "error", message }` instead of throwing.
   */
  private async _sendBatch(offset: number, limit: number): Promise<void> {
    try {
      const result = getGraphBatch(this._repoPath, offset, limit);
      // Node.js `Buffer` may share a pool-allocated `ArrayBuffer`. Slice to get
      // an independent `ArrayBuffer` backed exactly by these bytes (required for
      // VS Code's transferable postMessage serialisation).
      const payload = result.buffer.slice(
        result.byteOffset,
        result.byteOffset + result.byteLength,
      ) as ArrayBuffer;
      await this._postMessage({ type: "batch", payload });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this._postMessage({ type: "error", message });
    }
  }

  /**
   * Fetch full commit detail from the native addon and post it to the webview.
   * Called when the webview reports a `selectCommit` message (user clicked a row).
   */
  private async _sendCommitDetail(oidHex: string): Promise<void> {
    try {
      const detail = getCommitDetail(this._repoPath, oidHex);
      await this._postMessage({ type: "commitDetail", detail });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this._postMessage({ type: "error", message });
    }
  }

  /**
   * Open VS Code's built-in side-by-side diff for a single changed file.
   *
   * Called when the webview reports an `openDiff` message (user clicked a file
   * row in the changed-files list). Both blob sides are served by the
   * `gitbraid:` `TextDocumentContentProvider` — no `git` subprocess is spawned.
   */
  private async _openDiff(
    filePath: string,
    oldOid: string,
    newOid: string,
    status: string,
  ): Promise<void> {
    try {
      const leftUri = buildDiffUri(this._repoPath, filePath, oldOid);
      const rightUri = buildDiffUri(this._repoPath, filePath, newOid);
      const shortOid = newOid.slice(0, 8) || oldOid.slice(0, 8);
      const basename = path.basename(filePath);
      const statusLabel = status === "A" ? "added" : status === "D" ? "deleted" : "modified";
      const title = `${basename} (${statusLabel} ${shortOid})`;
      await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this._postMessage({ type: "error", message });
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
    <div id="loading">Git Braid — loading…</div>
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
