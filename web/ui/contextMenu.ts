/**
 * Lightweight right-click context menu for the Canvas graph pane.
 *
 * Canvas rows are not DOM elements, so VS Code's `menus` contribution points
 * cannot target them. This module renders a plain DOM popup positioned at the
 * cursor, styled with VS Code CSS variables (consistent with the find bar and
 * detail panel).
 *
 * # Usage
 *
 *   showContextMenu(clientX, clientY, [
 *     { label: "Checkout this commit", action: () => { ... } },
 *     { separator: true },
 *     { label: "Create branch here…", action: () => { ... } },
 *   ]);
 *
 * # CSP note
 *
 * All styles are set via `.style` (inline style properties), which is
 * permitted by the webview's `style-src 'unsafe-inline'` CSP directive.
 * No stylesheet or `<style>` block is injected.
 */

/** A single menu entry: either a clickable item or a visual separator line. */
export type MenuItem =
  | { label: string; action: () => void }
  | { separator: true };

// The currently-open popup element; at most one is open at a time.
let _current: HTMLElement | null = null;

/** Close any currently-open context menu. */
function _dismiss(): void {
  if (_current) {
    _current.remove();
    _current = null;
  }
}

/**
 * Show a context menu at (`x`, `y`) in client (viewport) coordinates.
 *
 * Any previously-open menu is dismissed first. The popup is clamped so it
 * never overflows the viewport edges. It auto-dismisses on any click outside,
 * a second `contextmenu` event, an `Escape` keypress, or a scroll.
 *
 * If `items` is empty, nothing is shown.
 */
export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  _dismiss();
  if (items.length === 0) return;

  const menu = document.createElement("div");
  menu.style.cssText = [
    "position:fixed;",
    "z-index:100;",
    "background:var(--vscode-editorWidget-background,#252526);",
    "border:1px solid var(--vscode-editorWidget-border,#454545);",
    "border-radius:4px;",
    "padding:4px 0;",
    "min-width:180px;",
    "box-shadow:0 4px 12px rgba(0,0,0,.5);",
    "font-family:var(--vscode-font-family,monospace);",
    "font-size:12px;",
    "color:var(--vscode-foreground,#ccc);",
    "user-select:none;",
  ].join("");

  for (const item of items) {
    if ("separator" in item) {
      const sep = document.createElement("div");
      sep.style.cssText =
        "border-top:1px solid var(--vscode-panel-border,#444); margin:4px 0;";
      menu.appendChild(sep);
    } else {
      const el = document.createElement("div");
      el.style.cssText = "padding:5px 16px; cursor:pointer; white-space:nowrap;";
      el.textContent = item.label;
      const cb = item.action; // capture in closure before the loop moves on
      el.addEventListener("mouseover", () => {
        el.style.background =
          "var(--vscode-list-hoverBackground,rgba(255,255,255,.07))";
      });
      el.addEventListener("mouseout", () => {
        el.style.background = "";
      });
      el.addEventListener("click", (e) => {
        e.stopPropagation(); // don't let the dismiss listener fire first
        _dismiss();
        cb();
      });
      menu.appendChild(el);
    }
  }

  document.body.appendChild(menu);
  _current = menu;

  // Clamp: position the menu so it doesn't overflow the viewport.
  // We read offsetWidth/offsetHeight after appending (layout has run).
  const { offsetWidth: mw, offsetHeight: mh } = menu;
  const { innerWidth: vw, innerHeight: vh } = window;
  menu.style.left = `${Math.max(0, Math.min(x, vw - mw - 4))}px`;
  menu.style.top  = `${Math.max(0, Math.min(y, vh - mh - 4))}px`;

  // Auto-dismiss listeners (capture phase fires before target's own handlers).
  const onDismiss = (e: Event): void => {
    // For keydown events only dismiss on Escape; let other keys fall through.
    if (e instanceof KeyboardEvent && e.key !== "Escape") return;
    _dismiss();
    document.removeEventListener("click",       onDismiss, true);
    document.removeEventListener("contextmenu", onDismiss, true);
    document.removeEventListener("keydown",     onDismiss, true);
    window.removeEventListener  ("scroll",      onDismiss, true);
  };
  document.addEventListener("click",       onDismiss, true);
  document.addEventListener("contextmenu", onDismiss, true);
  document.addEventListener("keydown",     onDismiss, true);
  window.addEventListener  ("scroll",      onDismiss, true);
}
