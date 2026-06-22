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
 *   `{ type: "batch", payload: ArrayBuffer }` — BRAI v1 binary batch
 *   `{ type: "error", message: string }`
 *
 * Webview → Host:
 *   `{ type: "ready" }` — sent once on init
 *   `{ type: "requestBatch", offset: number, limit: number }` — paging
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

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function init(): void {
  const app = document.getElementById("app");
  if (!app) return;

  // Clear the loading placeholder inserted by the host HTML.
  app.innerHTML = "";
  // Ensure the container fills the full viewport (already set by host CSS, but
  // enforce here in case the webview HTML changes).
  app.style.cssText = "width:100%; height:100%; margin:0; padding:0;";

  const renderer = new CanvasRenderer(app);

  // Track total rows loaded so paging offsets are correct.
  let loadedCount = 0;
  // Guard against firing multiple concurrent requestBatch calls.
  let inFlight = false;

  renderer.onNeedMore = (currentCount: number) => {
    if (inFlight) return;
    inFlight = true;
    postToHost({ type: "requestBatch", offset: currentCount, limit: PAGE_SIZE });
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
