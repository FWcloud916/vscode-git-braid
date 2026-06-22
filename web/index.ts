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
 * Phase: Phase 0 skeleton — sends `ready`, listens for `batch` / `error`.
 */

import { CanvasRenderer } from "./renderer/canvas";

// The VS Code webview API, injected at runtime by the extension host.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vscode = (window as any).acquireVsCodeApi?.() as {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
} | undefined;

function postToHost(msg: unknown): void {
  vscode?.postMessage(msg);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

// Module-level reference kept so future scroll/resize handlers can call renderer.appendRows().
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used in Phase 0/1 rendering loop
let renderer: CanvasRenderer | undefined;

function init(): void {
  const app = document.getElementById("app");
  if (!app) return;

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%;";
  app.innerHTML = "";
  app.appendChild(canvas);

  renderer = new CanvasRenderer(canvas);

  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as { type: string; [k: string]: unknown };
    switch (message["type"]) {
      case "batch":
        // TODO(Phase 0/1): decode ArrayBuffer and feed to renderer.
        break;
      case "error":
        console.error("[Git Braid] host error:", message["message"]);
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
