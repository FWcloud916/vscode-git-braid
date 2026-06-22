/**
 * Webview entry point.
 *
 * Runs inside VS Code's sandboxed browser context. Has NO access to Node.js
 * APIs, the filesystem, or the VS Code API directly. All communication with
 * the extension host goes through `acquireVsCodeApi().postMessage`.
 *
 * # Message protocol
 *
 * See `src/webviewBridge.ts` for the full message shape definitions.
 *
 * Host → Webview:
 *   `{ type: "batch", payload: ArrayBuffer }` — BRAI v2 binary batch
 *   `{ type: "commitDetail", detail: CommitDetailPayload }` — single commit detail
 *   `{ type: "error", message: string }`
 *
 * Webview → Host:
 *   `{ type: "ready" }` — sent once on init
 *   `{ type: "requestBatch", offset: number, limit: number }` — paging
 *   `{ type: "selectCommit", oid: string }` — user clicked a row
 */

import { CanvasRenderer } from "./renderer/canvas";
import { decodeBatch } from "./renderer/decode";

// ── VS Code API ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vscode = (window as any).acquireVsCodeApi?.() as {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
} | undefined;

function postToHost(msg: unknown): void {
  vscode?.postMessage(msg);
}

// ── Paging constants ──────────────────────────────────────────────────────────

/**
 * Number of commits to request per follow-up page.
 * The initial batch size is controlled by `gitBraid.initialCommitLoad` on the
 * host side (default 300). We use the same value here for consistency.
 */
const PAGE_SIZE = 300;

// ── Commit detail panel ─────────────────────────────────────────────────────────

/** Full commit metadata for the detail panel, sent by the host on selection. */
interface CommitDetailPayload {
  oid: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  commitTime: number;
  message: string;
}

function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? s;
}

function showDetail(pane: HTMLElement, d: CommitDetailPayload): void {
  pane.style.display = "block";
  pane.innerHTML = `
    <div style="margin-bottom:12px;">
      <div style="font-size:13px;font-weight:bold;margin-bottom:6px;word-break:break-all;">
        ${escHtml(firstLine(d.message))}
      </div>
      <div style="color:var(--vscode-descriptionForeground,#888);font-size:11px;">
        ${escHtml(d.oid.slice(0, 12))}
      </div>
    </div>
    <hr style="border:none;border-top:1px solid var(--vscode-panel-border,#444);margin:8px 0;">
    <table style="border-collapse:collapse;width:100%;font-size:11px;line-height:1.6;">
      <tr><td style="color:#888;padding-right:8px;">Author</td>
          <td>${escHtml(d.authorName)} &lt;${escHtml(d.authorEmail)}&gt;</td></tr>
      <tr><td style="color:#888;">Date</td>
          <td>${formatDate(d.authorTime)}</td></tr>
      <tr><td style="color:#888;">Committer</td>
          <td>${escHtml(d.committerName)}</td></tr>
      <tr><td style="color:#888;">Commit date</td>
          <td>${formatDate(d.commitTime)}</td></tr>
      ${d.parents.length > 0 ? `<tr><td style="color:#888;">Parents</td>
          <td>${d.parents.map(p => `<code>${escHtml(p.slice(0, 12))}</code>`).join(", ")}</td></tr>` : ""}
    </table>
    <hr style="border:none;border-top:1px solid var(--vscode-panel-border,#444);margin:8px 0;">
    <pre style="font-size:11px;white-space:pre-wrap;word-break:break-word;margin:0;
                color:var(--vscode-foreground,#ccc);font-family:var(--vscode-font-family,monospace);">${escHtml(d.message)}</pre>
  `;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function init(): void {
  const app = document.getElementById("app");
  if (!app) return;

  // Clear the loading placeholder inserted by the host HTML, and split the
  // viewport into a graph pane (left) and a detail pane (right).
  app.innerHTML = "";
  app.style.cssText =
    "width:100%; height:100%; margin:0; padding:0; display:flex; flex-direction:row;";

  // Graph viewport (left, fills remaining width).
  const graphPane = document.createElement("div");
  graphPane.style.cssText = "flex:1; min-width:0; height:100%; overflow:hidden;";
  app.appendChild(graphPane);

  // Detail panel (right side, hidden until a commit is selected).
  const detailPane = document.createElement("aside");
  detailPane.style.cssText = [
    "width:320px; height:100%; overflow-y:auto;",
    "background:var(--vscode-sideBar-background,#252526);",
    "color:var(--vscode-foreground,#ccc);",
    "font-family:var(--vscode-font-family,sans-serif);",
    "font-size:12px;",
    "border-left:1px solid var(--vscode-panel-border,#333);",
    "padding:12px; box-sizing:border-box;",
    "display:none;", // hidden until selection
  ].join("");
  app.appendChild(detailPane);

  const renderer = new CanvasRenderer(graphPane);

  // Track total rows loaded so paging offsets are correct.
  let loadedCount = 0;
  // Guard against firing multiple concurrent requestBatch calls.
  let inFlight = false;

  renderer.onNeedMore = (currentCount: number) => {
    if (inFlight) return;
    inFlight = true;
    postToHost({ type: "requestBatch", offset: currentCount, limit: PAGE_SIZE });
  };

  renderer.onSelect = (oidHex: string) => {
    postToHost({ type: "selectCommit", oid: oidHex });
  };

  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as { type: string; [k: string]: unknown };

    switch (message["type"]) {
      case "batch": {
        const payload = message["payload"];
        if (!(payload instanceof ArrayBuffer)) {
          console.error("[Git Braid] batch payload is not an ArrayBuffer");
          inFlight = false;
          break;
        }
        try {
          const rows = decodeBatch(payload);
          renderer.appendRows(rows); // clears _pendingMore guard inside renderer
          loadedCount += rows.length;
          // If we got fewer rows than requested, we've reached the end of the repo.
          if (rows.length < PAGE_SIZE && rows.length !== loadedCount /* not the very first page */) {
            renderer.markEnd();
          }
          // Also mark end on truly empty response.
          if (rows.length === 0) {
            renderer.markEnd();
          }
        } catch (err) {
          console.error("[Git Braid] failed to decode batch:", err);
        }
        inFlight = false;
        break;
      }
      case "commitDetail": {
        const detail = message["detail"] as CommitDetailPayload | undefined;
        if (!detail) break;
        showDetail(detailPane, detail);
        break;
      }
      case "error":
        console.error("[Git Braid] host error:", message["message"]);
        inFlight = false;
        break;
    }
  });

  // Signal to the host that we're ready to receive data.
  postToHost({ type: "ready" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
