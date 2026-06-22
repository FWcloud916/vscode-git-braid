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
 *   `{ type: "findResults", query: string, matches: FindMatchPayload[] }` — search results
 *   `{ type: "config", dateFormat: string, palette: string[] }` — display settings
 *   `{ type: "reload" }` — clear rows and re-request from offset 0 (after write op)
 *   `{ type: "error", message: string }`
 *
 * Webview → Host:
 *   `{ type: "ready" }` — sent once on init
 *   `{ type: "requestBatch", offset: number, limit: number }` — paging
 *   `{ type: "selectCommit", oid: string }` — user clicked a row
 *   `{ type: "openDiff", filePath, oldOid, newOid, status }` — file row clicked
 *   `{ type: "action", op: GitActionOp, oid: string, refs: ActionRef[] }` — write op
 */

import { CanvasRenderer } from "./renderer/canvas";
import { decodeBatch, REF_KIND_LOCAL_BRANCH, type DecodedRef } from "./renderer/decode";
import { formatRelative } from "./format";
import { showContextMenu, type MenuItem } from "./ui/contextMenu";

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
  /** Files changed vs first parent. Sorted by path. */
  files: FileChangePayload[];
}

/** A single search hit, mirroring the napi `FindMatch` object (camelCase). */
interface FindMatchPayload {
  oid: string;
  rowIndex: number;
  subject: string;
  author: string;
  commitTime: number;
}

/** A single file-level change, mirroring the Rust `FileChange` napi object. */
interface FileChangePayload {
  path: string;
  status: string;   // "A" | "M" | "D"
  oldOid: string;
  newOid: string;
}

// ── Date formatting ───────────────────────────────────────────────────────────

/**
 * Current display format for commit timestamps, set by the `config` host message.
 * Defaults to "absolute" until the host pushes configuration.
 */
let dateFormat: "absolute" | "relative" = "absolute";

function formatDate(epochSeconds: number): string {
  if (dateFormat === "relative") {
    return formatRelative(epochSeconds, Date.now());
  }
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

// ── Write-op types ────────────────────────────────────────────────────────────

/**
 * All git write operations that can be requested from the webview.
 * Must stay in sync with the `GitActionOp` type in `src/webviewBridge.ts`.
 */
type GitActionOp =
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

/** A ref descriptor sent with an action request. */
interface ActionRef { name: string; kind: number }

/**
 * Build context-menu items for the right-clicked commit row.
 *
 * Slice 1: checkout only (branch-name if available, OID otherwise).
 * Subsequent slices add create/delete branch, merge, rebase, etc.
 */
function buildMenuItems(info: { oidHex: string; refs: DecodedRef[] }): MenuItem[] {
  const items: MenuItem[] = [];
  const actionRefs: ActionRef[] = info.refs.map(r => ({ name: r.name, kind: r.kind }));

  // Checkout: if a local branch sits on this commit, check out by name
  // (switches the branch pointer); otherwise check out the OID as a
  // detached HEAD.
  const localBranch = info.refs.find(r => r.kind === REF_KIND_LOCAL_BRANCH);
  const checkoutLabel = localBranch !== undefined
    ? `Checkout ${localBranch.name}`
    : "Checkout this commit";

  items.push({
    label: checkoutLabel,
    action: () => postToHost({
      type: "action",
      op: "checkout" as GitActionOp,
      oid: info.oidHex,
      refs: actionRefs,
    }),
  });

  return items;
}

/** Colour for the status badge (A/M/D). */
function statusColor(s: string): string {
  if (s === "A") return "var(--vscode-gitDecoration-addedResourceForeground,#73c991)";
  if (s === "D") return "var(--vscode-gitDecoration-deletedResourceForeground,#f14c4c)";
  return "var(--vscode-gitDecoration-modifiedResourceForeground,#e2c08d)";
}

/** Render a single file row for the changed-files list. */
function fileRowHtml(f: FileChangePayload): string {
  const slashIdx = f.path.lastIndexOf("/");
  const dir = slashIdx >= 0 ? escHtml(f.path.slice(0, slashIdx + 1)) : "";
  const base = escHtml(f.path.slice(slashIdx + 1));
  const color = statusColor(f.status);
  return `<div class="gb-file-row"
    data-path="${escHtml(f.path)}"
    data-old-oid="${escHtml(f.oldOid)}"
    data-new-oid="${escHtml(f.newOid)}"
    data-status="${escHtml(f.status)}"
    style="display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer;
           border-radius:3px;user-select:none;"
    onmouseover="this.style.background='var(--vscode-list-hoverBackground,rgba(255,255,255,.07))'"
    onmouseout="this.style.background=''">
    <span style="font-size:10px;font-weight:bold;color:${color};min-width:12px;">${escHtml(f.status)}</span>
    <span style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
      ${dir ? `<span style="color:var(--vscode-descriptionForeground,#888);">${dir}</span>` : ""}<span style="color:var(--vscode-foreground,#ccc);">${base}</span>
    </span>
  </div>`;
}

function showDetail(pane: HTMLElement, d: CommitDetailPayload): void {
  pane.style.display = "block";

  const filesSection =
    d.files.length === 0
      ? `<div style="color:var(--vscode-descriptionForeground,#888);font-size:11px;padding:4px 0;">No file changes</div>`
      : `<div id="gb-files-list">${d.files.map(fileRowHtml).join("")}</div>`;

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
    <div style="font-size:11px;font-weight:600;margin-bottom:4px;color:var(--vscode-foreground,#ccc);">
      Files (${d.files.length})
    </div>
    ${filesSection}
    <hr style="border:none;border-top:1px solid var(--vscode-panel-border,#444);margin:8px 0;">
    <pre style="font-size:11px;white-space:pre-wrap;word-break:break-word;margin:0;
                color:var(--vscode-foreground,#ccc);font-family:var(--vscode-font-family,monospace);">${escHtml(d.message)}</pre>
  `;

  // Wire up click-to-diff on file rows (delegated listener on the files list).
  const filesList = pane.querySelector<HTMLElement>("#gb-files-list");
  if (filesList) {
    filesList.addEventListener("click", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".gb-file-row");
      if (!row) return;
      const { path: filePath, oldOid, newOid, status } = row.dataset as {
        path: string;
        oldOid: string;
        newOid: string;
        status: string;
      };
      postToHost({ type: "openDiff", filePath, oldOid, newOid, status });
    });
  }
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

  // ── Graph area: wrapper (position:relative for the find bar overlay) + scroll container.
  const graphWrapper = document.createElement("div");
  graphWrapper.style.cssText = "flex:1; min-width:0; height:100%; position:relative; overflow:hidden;";
  app.appendChild(graphWrapper);

  // The CanvasRenderer's scroll viewport fills the wrapper.
  // NOTE: CanvasRenderer's constructor overwrites `position` to "relative", so we
  // cannot rely on absolute offsets for sizing. Use width/height:100% instead — the
  // wrapper's overflow:hidden ensures graphPane never escapes the viewport box, and
  // the renderer's overflow:auto handles scrolling internally.
  const graphPane = document.createElement("div");
  graphPane.style.cssText = "width:100%; height:100%;";
  graphWrapper.appendChild(graphPane);

  // ── Find bar overlay (position:absolute inside graphWrapper — always visible
  //    regardless of scroll position).
  const findBar = document.createElement("div");
  findBar.style.cssText = [
    "position:absolute; top:8px; right:8px; z-index:20;",
    "display:none; align-items:center; gap:6px;",
    "background:var(--vscode-editorWidget-background,#252526);",
    "border:1px solid var(--vscode-editorWidget-border,#454545);",
    "border-radius:4px; padding:4px 10px;",
    "font-family:var(--vscode-font-family,monospace); font-size:11px;",
    "color:var(--vscode-foreground,#ccc);",
    "box-shadow:0 2px 8px rgba(0,0,0,.4);",
    "white-space:nowrap;",
  ].join(" ");
  graphWrapper.appendChild(findBar);

  const findLabel = document.createElement("span");
  const findPrev = document.createElement("button");
  const findNext = document.createElement("button");
  const findClose = document.createElement("button");

  for (const btn of [findPrev, findNext, findClose]) {
    btn.style.cssText = [
      "background:none; border:none; cursor:pointer; padding:0 2px;",
      "color:var(--vscode-foreground,#ccc); font-size:12px; line-height:1;",
    ].join(" ");
  }
  findPrev.textContent  = "◀";
  findNext.textContent  = "▶";
  findClose.textContent = "✕";
  findPrev.title  = "Previous match (Shift+Enter)";
  findNext.title  = "Next match (Enter)";
  findClose.title = "Clear find (Escape)";

  findBar.appendChild(findLabel);
  findBar.appendChild(findPrev);
  findBar.appendChild(findNext);
  findBar.appendChild(findClose);

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

  // ── Paging state ─────────────────────────────────────────────────────────
  // Track total rows loaded so paging offsets are correct.
  let loadedCount = 0;
  // Guard against firing multiple concurrent requestBatch calls.
  let inFlight = false;
  // Set once the repo signals no more commits.
  let reachedEnd = false;

  // ── Find state ───────────────────────────────────────────────────────────
  let matches: FindMatchPayload[] = [];
  let currentMatchIdx = -1;
  // Row index we're waiting to reveal once enough rows are loaded.
  let pendingReveal: number | null = null;

  function updateFindBar(): void {
    if (matches.length === 0) {
      findLabel.textContent = `no matches`;
      findPrev.disabled = true;
      findNext.disabled = true;
    } else {
      findLabel.textContent = `${currentMatchIdx + 1} / ${matches.length}`;
      findPrev.disabled = false;
      findNext.disabled = false;
    }
  }

  function clearFind(): void {
    matches = [];
    currentMatchIdx = -1;
    pendingReveal = null;
    renderer.clearFind();
    findBar.style.display = "none";
  }

  function revealMatch(): void {
    if (matches.length === 0 || currentMatchIdx < 0) return;
    const target = matches[currentMatchIdx]!.rowIndex;
    updateFindBar();

    if (target < loadedCount) {
      // Already loaded — scroll and highlight immediately.
      renderer.scrollToRow(target);
      renderer.setCurrentMatch(target);
      pendingReveal = null;
    } else if (!reachedEnd) {
      // Row not yet paged in — request enough rows to reach it.
      pendingReveal = target;
      if (!inFlight) {
        inFlight = true;
        const need = target - loadedCount + 50;
        postToHost({
          type: "requestBatch",
          offset: loadedCount,
          limit: Math.max(PAGE_SIZE, need),
        });
      }
    }
    // If reachedEnd and target >= loadedCount: shouldn't happen (same walk order);
    // leave the bar showing the label — the user can see the issue.
  }

  function gotoMatch(dir: 1 | -1): void {
    if (matches.length === 0) return;
    currentMatchIdx = (currentMatchIdx + dir + matches.length) % matches.length;
    revealMatch();
  }

  // ── Find bar button wiring ────────────────────────────────────────────────
  findPrev.addEventListener("click",  () => gotoMatch(-1));
  findNext.addEventListener("click",  () => gotoMatch(1));
  findClose.addEventListener("click", () => clearFind());

  // ── Keyboard navigation in the find bar (also works when graph is focused).
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (findBar.style.display === "none") return;
    if (e.key === "Escape") {
      clearFind();
      e.preventDefault();
    } else if (e.key === "Enter" || e.key === "F3") {
      gotoMatch(e.shiftKey ? -1 : 1);
      e.preventDefault();
    }
  });

  // ── Renderer callbacks ────────────────────────────────────────────────────
  renderer.onNeedMore = (currentCount: number) => {
    if (inFlight) return;
    inFlight = true;
    postToHost({ type: "requestBatch", offset: currentCount, limit: PAGE_SIZE });
  };

  renderer.onSelect = (oidHex: string) => {
    postToHost({ type: "selectCommit", oid: oidHex });
  };

  // Right-click: build the context menu from the row's refs and show it.
  renderer.onContextMenu = (info) => {
    showContextMenu(info.clientX, info.clientY, buildMenuItems(info));
  };

  // ── Message handler ───────────────────────────────────────────────────────
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
            reachedEnd = true;
            renderer.markEnd();
          }
          // Also mark end on truly empty response.
          if (rows.length === 0) {
            reachedEnd = true;
            renderer.markEnd();
          }
          // Resume a pending reveal now that more rows are available.
          if (pendingReveal !== null) {
            revealMatch();
          }
        } catch (err) {
          console.error("[Git Braid] failed to decode batch:", err);
        }
        inFlight = false;
        break;
      }

      case "config": {
        const fmt = message["dateFormat"] as string | undefined;
        if (fmt === "relative" || fmt === "absolute") {
          dateFormat = fmt;
        }
        const palette = message["palette"] as string[] | undefined;
        if (palette) {
          renderer.setPalette(palette);
        }
        break;
      }

      case "commitDetail": {
        const detail = message["detail"] as CommitDetailPayload | undefined;
        if (!detail) break;
        showDetail(detailPane, detail);
        break;
      }

      case "findResults": {
        const query   = message["query"]   as string | undefined ?? "";
        const hits    = message["matches"] as FindMatchPayload[] | undefined ?? [];
        matches        = hits;
        currentMatchIdx = hits.length > 0 ? 0 : -1;
        pendingReveal   = null;

        renderer.setMatches(hits.map(m => m.rowIndex));

        // Show the find bar.
        findBar.style.display  = "flex";
        findLabel.textContent  = `"${query}" — `;
        updateFindBar();

        if (hits.length > 0) {
          revealMatch();
        }
        break;
      }

      case "reload": {
        // A write operation succeeded — reset the graph and reload from scratch.
        // Re-using the existing batch-request flow means no new protocol needed
        // on the native side (getGraphBatch already re-walks from root every call).
        loadedCount = 0;
        inFlight = true;
        reachedEnd = false;
        pendingReveal = null;
        renderer.reset();
        clearFind();
        postToHost({ type: "requestBatch", offset: 0, limit: PAGE_SIZE });
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
