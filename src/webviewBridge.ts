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
 *   `{ type: "findResults", query, matches }` — full-history search results
 *   `{ type: "config", dateFormat, palette }` — display settings
 *   `{ type: "reload" }` — clear rows and re-request from offset 0 (after write op)
 *   `{ type: "error", message: string }`
 *
 * Webview → Host:
 *   `{ type: "ready" }` — sent once the webview JS has initialised
 *   `{ type: "requestBatch", offset: number, limit: number }` — paging
 *   `{ type: "selectCommit", oid: string }` — user clicked a commit row
 *   `{ type: "openDiff", filePath, oldOid, newOid, status }` — file diff request
 *   `{ type: "action", op: GitActionOp, oid, refs }` — git write op request
 */

import * as path from "path";
import * as vscode from "vscode";
import { getGraphBatch, getCommitDetail, findCommits, type CommitDetail, type FindMatch } from "@git-braid/native";
import { buildDiffUri } from "./diffProvider";
import { checkout, createBranch, deleteBranch, createTag, deleteTag, isConflictError } from "./gitActions";

/**
 * Validate a proposed git ref name without spawning a process.
 *
 * This is a **client-side pre-check** — git itself is the final authority.
 * Blocks only the most obvious invalid inputs so the `showInputBox` prompt
 * gives immediate feedback. Returns an error string (shown in the input box)
 * or `undefined` if the name passes the basic checks.
 */
function validateRefName(name: string): string | undefined {
  if (!name.trim()) return "Name cannot be empty";
  // Disallow: whitespace, ~, ^, :, ?, *, [, \, .., @{, leading -, trailing .
  if (
    /\s/.test(name) ||
    /[~^:?*\[\\]/.test(name) ||
    /\.\./.test(name) ||
    /@\{/.test(name) ||
    name.startsWith("-") ||
    name.endsWith(".") ||
    name.endsWith(".lock")
  ) {
    return "Invalid ref name — contains disallowed characters";
  }
  return undefined;
}

/**
 * All git write operations that can be requested from the webview.
 * Must stay in sync with the `GitActionOp` type in `web/index.ts`.
 */
export type GitActionOp =
  | "checkout"
  | "createBranch"
  | "deleteBranch"
  | "merge"
  | "rebase"
  | "cherryPick"
  | "revert"
  | "resetSoft"
  | "resetMixed"
  | "resetHard"
  | "createTag"
  | "deleteTag"
  | "stashApply"
  | "stashPop"
  | "stashDrop";

/** A ref descriptor included with an action request. */
interface ActionRef { name: string; kind: number }

/** Messages the webview can send to the extension host. */
type WebviewMessage =
  | { type: "ready" }
  | { type: "requestBatch"; offset: number; limit: number }
  | { type: "selectCommit"; oid: string }
  | { type: "openDiff"; filePath: string; oldOid: string; newOid: string; status: string }
  | { type: "action"; op: GitActionOp; oid: string; refs: ActionRef[] };

/** Messages the extension host can send to the webview. */
type HostMessage =
  | { type: "batch"; payload: ArrayBuffer }
  | { type: "commitDetail"; detail: CommitDetail }
  | { type: "findResults"; query: string; matches: FindMatch[] }
  | { type: "config"; dateFormat: string; palette: string[] }
  | { type: "reload" }
  | { type: "actionResult"; op: string; ok: boolean; message?: string }
  | { type: "error"; message: string };

export class WebviewBridge implements vscode.Disposable {
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  // Lazy output channel for surfacing full git stderr to the user on demand.
  private _outputChannel: vscode.OutputChannel | undefined;

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
      case "action":
        void this._handleAction(message);
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

  /**
   * Dispatch a git write-operation request from the webview.
   *
   * 1. Perform any required host-side confirmation or text input.
   * 2. Call the appropriate `gitActions` function with `this._repoPath` as cwd.
   * 3. On success: post `{ type: "reload" }` so the webview resets + re-fetches.
   * 4. On failure: call `_presentGitError` (friendly modal + optional log dump).
   */
  private async _handleAction(
    msg: Extract<WebviewMessage, { type: "action" }>,
  ): Promise<void> {
    try {
      switch (msg.op) {
        case "checkout": {
          // Prefer a local branch name (tracks the branch pointer) over a
          // detached OID checkout.
          const branchRef = msg.refs.find(r => r.kind === 0 /* LOCAL_BRANCH */);
          const target = branchRef !== undefined ? branchRef.name : msg.oid;
          await checkout(target, this._repoPath);
          break;
        }

        case "createBranch": {
          const name = await vscode.window.showInputBox({
            prompt: "New branch name",
            placeHolder: "e.g. feature/my-feature",
            validateInput: validateRefName,
          });
          if (name === undefined) return; // user cancelled
          await createBranch(name, msg.oid, this._repoPath);
          break;
        }

        case "deleteBranch": {
          const branchName = msg.refs[0]?.name;
          if (branchName === undefined) return;
          const confirm = await vscode.window.showWarningMessage(
            `Delete branch "${branchName}"?`,
            { modal: true },
            "Delete",
          );
          if (confirm !== "Delete") return;
          try {
            await deleteBranch(branchName, this._repoPath);
          } catch (err) {
            type ExecErr = Error & { stderr?: string };
            const stderr = (err instanceof Error ? (err as ExecErr).stderr : undefined) ?? "";
            if (/not fully merged/i.test(stderr)) {
              // Offer a force delete when git refuses the safe -d.
              const force = await vscode.window.showWarningMessage(
                `Branch "${branchName}" is not fully merged. Force delete anyway?`,
                { modal: true },
                "Force Delete",
              );
              if (force !== "Force Delete") return;
              await deleteBranch(branchName, this._repoPath, true);
              // falls through to reload below
            } else {
              throw err; // re-raised to outer catch → _presentGitError
            }
          }
          break;
        }

        case "createTag": {
          const tagName = await vscode.window.showInputBox({
            prompt: "New tag name",
            placeHolder: "e.g. v1.0.0",
            validateInput: validateRefName,
          });
          if (tagName === undefined) return;
          await createTag(tagName, msg.oid, this._repoPath);
          break;
        }

        case "deleteTag": {
          const tName = msg.refs[0]?.name;
          if (tName === undefined) return;
          const confirmTag = await vscode.window.showWarningMessage(
            `Delete tag "${tName}"?`,
            { modal: true },
            "Delete",
          );
          if (confirmTag !== "Delete") return;
          await deleteTag(tName, this._repoPath);
          break;
        }

        default:
          // Not yet implemented in this slice — silently ignore.
          return;
      }
      await this._postMessage({ type: "reload" });
    } catch (err) {
      await this._presentGitError(msg.op, err);
    }
  }

  /**
   * Surface a git write-op failure to the user in a friendly way.
   *
   * - **Conflicts** (merge/cherry-pick/rebase stopping mid-op) are expected
   *   outcomes. They get an informational warning modal and still trigger a
   *   `reload` because the working tree + HEAD may have changed.
   * - **Hard failures** show a one-line error toast. "Show details" dumps the
   *   full stderr to the "Git Braid" output channel so power users can inspect.
   */
  private async _presentGitError(op: string, err: unknown): Promise<void> {
    // `execFileAsync` rejection is an `Error` with `.stderr` and `.stdout`.
    type ExecErr = Error & { stderr?: string; stdout?: string };
    const asExec = err instanceof Error ? (err as ExecErr) : undefined;
    const stderr = asExec?.stderr ?? (err instanceof Error ? err.message : String(err));
    const stdout = asExec?.stdout ?? "";
    const combined = `${stderr} ${stdout}`.trim();

    if (isConflictError(combined)) {
      // Conflict = non-fatal: warn the user and reload so the graph reflects
      // the partial state (e.g. MERGE_HEAD created by `git merge`).
      void vscode.window.showWarningMessage(
        `Git Braid: ${op} stopped due to conflicts — ` +
        `resolve them in your editor, then commit.`,
      );
      await this._postMessage({ type: "reload" });
      return;
    }

    const firstLine = stderr.split("\n")[0] ?? stderr;
    const choice = await vscode.window.showErrorMessage(
      `Git Braid: ${op} failed — ${firstLine}`,
      "Show details",
    );
    if (choice === "Show details") {
      const ch = this._getOutputChannel();
      ch.appendLine(`=== ${op} error ===`);
      ch.appendLine(stderr || String(err));
      ch.show();
    }
  }

  /** Return (creating on first use) the shared "Git Braid" output channel. */
  private _getOutputChannel(): vscode.OutputChannel {
    if (this._outputChannel === undefined) {
      this._outputChannel = vscode.window.createOutputChannel("Git Braid");
      this._disposables.push(this._outputChannel);
    }
    return this._outputChannel;
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
