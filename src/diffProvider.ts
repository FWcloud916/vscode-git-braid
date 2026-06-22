/**
 * `gitbraid:` TextDocumentContentProvider — serves git blob content to VS Code's
 * built-in diff viewer without spawning a `git` subprocess (read-path rule).
 *
 * # URI scheme
 *
 * ```
 * gitbraid:/<file-path>?repo=<fsPath>&oid=<blobOidHex>
 * ```
 *
 * - The **URI path** is the file path relative to the repository root. VS Code
 *   infers the language mode from the file extension, giving correct syntax
 *   highlighting in the diff.
 * - `repo` query param: absolute filesystem path to the repository root.
 * - `oid` query param: 40-character hex blob OID. An **empty** `oid` means "the
 *   file does not exist on this side" (added / deleted). An empty document is
 *   returned, which VS Code renders as the blank side of the diff.
 *
 * # Registration
 *
 * Registered once in `activate()` via
 * `vscode.workspace.registerTextDocumentContentProvider("gitbraid", ...)`.
 * The `vscode.Disposable` is pushed to `context.subscriptions`.
 */

import * as vscode from "vscode";
import { getBlob } from "@git-braid/native";

export class GitBraidContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const repo = params.get("repo") ?? "";
    const oid = params.get("oid") ?? "";

    if (!repo || !oid) {
      // Missing side of an add/delete — return empty document.
      return "";
    }

    try {
      const buf = getBlob(repo, oid);
      return new TextDecoder().decode(buf);
    } catch (err) {
      // Return empty string rather than throwing — a corrupted blob shouldn't
      // crash the diff view, just show as empty.
      console.error(`[Git Braid] get_blob failed for oid=${oid}: ${String(err)}`);
      return "";
    }
  }
}

/**
 * Build a `gitbraid:` URI for a specific blob.
 *
 * @param repoPath - Absolute filesystem path to the repository root.
 * @param filePath - Path to the file relative to the repository root.
 * @param oidHex   - Full 40-char hex blob OID, or `""` for the missing side.
 */
export function buildDiffUri(repoPath: string, filePath: string, oidHex: string): vscode.Uri {
  // The URI path becomes the "virtual filename" VS Code uses for the diff tab
  // title and language detection, so we use the file's own path.
  const uriPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
  const query = `repo=${encodeURIComponent(repoPath)}&oid=${encodeURIComponent(oidHex)}`;
  return vscode.Uri.from({ scheme: "gitbraid", path: uriPath, query });
}
