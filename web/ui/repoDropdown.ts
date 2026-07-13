/**
 * Repo picker for the graph toolbar.
 *
 * Lets the user switch which discovered git repository is displayed without
 * going through the command palette (`gitBraid.selectRepo`). Modeled directly
 * on `web/ui/branchDropdown.ts` — same inline-style / CSP-safe / Unicode-glyph
 * conventions, `position:fixed` popup, filter input, keyboard nav, and
 * single-popup singleton; see that file for the rationale behind those
 * choices.
 *
 * Differences from the branch dropdown: there is no "Show All" entry (a repo
 * is always selected) and no kind/star logic — just a name, a full-path
 * tooltip, and a `✓` marking the current repo. Selecting a different repo
 * posts `{ type: "selectRepo", root }` to the host, which recreates the
 * webview panel for the new repo (docs/adr/0006-repo-discovery-strategy.md
 * §Decision 2) — so this component does not attempt to update its own
 * "current" state after a selection; the panel reload does that via a fresh
 * `config` message.
 */

/** A single item in the dropdown's repo list. */
export interface RepoDropdownItem {
  root: string;
  name: string;
}

/** Handle returned by {@link createRepoDropdown}. */
export interface RepoDropdown {
  /** The trigger button element — append this to the toolbar. */
  el: HTMLElement;
  /** Replace the repo list. Called when the host pushes `config.repos`. */
  setItems(items: RepoDropdownItem[]): void;
  /** Update which repo is marked current, and the trigger label. */
  setCurrent(root: string): void;
}

// At most one popup is open at a time (shared with branchDropdown would be
// nicer, but each dropdown module keeps its own singleton — only one popup
// of any kind is opened at a time in practice since both are triggered by a
// direct click on their own trigger button, which closes any other popup via
// the shared document-level dismiss listener pattern).
let _popup: HTMLElement | null = null;

function _closePopup(): void {
  if (_popup) {
    _popup.remove();
    _popup = null;
  }
}

/**
 * Create a searchable repo dropdown.
 *
 * @param opts.initial  Currently open repo's root path, or `null` before the
 *   first `config` message arrives.
 * @param opts.onSelect Called when the user picks a different repo.
 */
export function createRepoDropdown(opts: {
  initial: string | null;
  onSelect: (root: string) => void;
}): RepoDropdown {
  let _items: RepoDropdownItem[] = [];
  let _current: string | null = opts.initial;

  // ── Trigger button ───────────────────────────────────────────────────────────
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.title = "Switch repository";
  trigger.style.cssText = [
    "display:inline-flex; align-items:center; justify-content:space-between;",
    "min-width:120px; max-width:220px;",
    "background:var(--vscode-dropdown-background,#3c3c3c);",
    "color:var(--vscode-dropdown-foreground,#ccc);",
    "border:1px solid var(--vscode-dropdown-border,#555);",
    "border-radius:3px; padding:1px 6px; font-size:11px;",
    "font-family:inherit; cursor:pointer; gap:4px; overflow:hidden;",
  ].join(" ");

  const triggerLabel = document.createElement("span");
  triggerLabel.style.cssText = [
    "flex:1; overflow:hidden; text-overflow:ellipsis;",
    "white-space:nowrap; text-align:left;",
  ].join(" ");

  const triggerChevron = document.createElement("span");
  triggerChevron.textContent = "▾";
  triggerChevron.style.cssText = "flex-shrink:0; opacity:0.7; pointer-events:none;";

  trigger.appendChild(triggerLabel);
  trigger.appendChild(triggerChevron);

  function _updateLabel(): void {
    const item = _items.find((r) => r.root === _current);
    triggerLabel.textContent = item?.name ?? _current ?? "Select repo…";
    trigger.title = _current ?? "Switch repository";
  }
  _updateLabel();

  // ── Popup ────────────────────────────────────────────────────────────────────
  function _openPopup(): void {
    _closePopup();

    const rect = trigger.getBoundingClientRect();

    const popup = document.createElement("div");
    popup.style.cssText = [
      "position:fixed; z-index:200;",
      "background:var(--vscode-editorWidget-background,#252526);",
      "border:1px solid var(--vscode-editorWidget-border,#454545);",
      "border-radius:4px;",
      "box-shadow:0 4px 12px rgba(0,0,0,.5);",
      "font-family:var(--vscode-font-family,monospace); font-size:11px;",
      "color:var(--vscode-foreground,#ccc);",
      "user-select:none;",
      "display:flex; flex-direction:column;",
      `min-width:${Math.max(220, rect.width)}px; max-width:420px;`,
    ].join(" ");

    // Initial position — clamped after appending (once layout runs).
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 2}px`;

    // ── Filter input ─────────────────────────────────────────────────────────
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.placeholder = "Filter Repositories…";
    filterInput.style.cssText = [
      "width:100%; box-sizing:border-box;",
      "background:var(--vscode-input-background,#3c3c3c);",
      "color:var(--vscode-input-foreground,#ccc);",
      "border:none; border-bottom:1px solid var(--vscode-panel-border,#444);",
      "outline:none; padding:5px 8px;",
      "font-size:11px; font-family:inherit;",
      "border-radius:4px 4px 0 0;",
    ].join(" ");
    popup.appendChild(filterInput);

    // ── Scroll body ──────────────────────────────────────────────────────────
    const listEl = document.createElement("div");
    listEl.style.cssText = "max-height:320px; overflow-y:auto; padding:4px 0;";
    popup.appendChild(listEl);

    _popup = popup;
    document.body.appendChild(popup);

    // ── Row state ────────────────────────────────────────────────────────────
    let visibleRows: HTMLElement[] = [];
    let highlightIdx = -1;

    function _setHighlight(idx: number): void {
      if (highlightIdx >= 0 && highlightIdx < visibleRows.length) {
        visibleRows[highlightIdx]!.style.background = "";
      }
      highlightIdx = idx;
      if (highlightIdx >= 0 && highlightIdx < visibleRows.length) {
        visibleRows[highlightIdx]!.style.background =
          "var(--vscode-list-activeSelectionBackground,rgba(255,255,255,.12))";
      }
    }

    function _makeRow(item: RepoDropdownItem): HTMLElement {
      const row = document.createElement("div");
      row.dataset["root"] = item.root;
      row.title = item.root;
      row.style.cssText = [
        "display:flex; align-items:center;",
        "padding:4px 10px; cursor:pointer; white-space:nowrap; overflow:hidden;",
      ].join(" ");

      // Leading check glyph (fixed width keeps non-checked rows aligned).
      const check = document.createElement("span");
      check.style.cssText = "display:inline-block; width:14px; flex-shrink:0;";
      check.textContent = item.root === _current ? "✓" : "";

      const text = document.createElement("span");
      text.style.cssText = "overflow:hidden; text-overflow:ellipsis;";
      text.textContent = item.name;

      const desc = document.createElement("span");
      desc.style.cssText = [
        "margin-left:8px; opacity:0.55; overflow:hidden; text-overflow:ellipsis;",
        "flex:1; min-width:0;",
      ].join(" ");
      desc.textContent = item.root;

      row.appendChild(check);
      row.appendChild(text);
      row.appendChild(desc);

      row.addEventListener("mouseover", () => {
        const idx = visibleRows.indexOf(row);
        if (idx >= 0) _setHighlight(idx);
      });
      row.addEventListener("mouseout", () => {
        const idx = visibleRows.indexOf(row);
        if (idx >= 0 && highlightIdx === idx) {
          row.style.background = "";
          highlightIdx = -1;
        }
      });
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        _selectValue(item.root);
      });

      return row;
    }

    function _buildList(query: string): void {
      listEl.innerHTML = "";
      visibleRows = [];
      highlightIdx = -1;

      const q = query.toLowerCase();

      let any = false;
      for (const item of _items) {
        if (q && !item.name.toLowerCase().includes(q) && !item.root.toLowerCase().includes(q)) continue;
        const row = _makeRow(item);
        listEl.appendChild(row);
        visibleRows.push(row);
        any = true;
      }

      if (!any) {
        const empty = document.createElement("div");
        empty.style.cssText =
          "padding:6px 10px; opacity:0.5; font-style:italic; user-select:none;";
        empty.textContent = query ? "No repos match" : "No repos discovered";
        listEl.appendChild(empty);
      }
    }

    _buildList("");

    // Clamp popup to viewport (offsetWidth/Height available after append).
    const { offsetWidth: pw, offsetHeight: ph } = popup;
    const { innerWidth: vw, innerHeight: vh } = window;
    popup.style.left = `${Math.max(0, Math.min(rect.left, vw - pw - 4))}px`;
    popup.style.top  = `${Math.max(0, Math.min(rect.bottom + 2, vh - ph - 4))}px`;

    // Auto-focus the filter input.
    filterInput.focus();

    // Re-filter on typing.
    filterInput.addEventListener("input", () => {
      _buildList(filterInput.value);
    });

    // Keyboard navigation (↑/↓/Enter in filter input; Escape via dismiss listener).
    filterInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next =
          highlightIdx < 0 ? 0 : Math.min(highlightIdx + 1, visibleRows.length - 1);
        _setHighlight(next);
        visibleRows[next]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next =
          highlightIdx < 0
            ? visibleRows.length - 1
            : Math.max(highlightIdx - 1, 0);
        _setHighlight(next);
        visibleRows[next]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (highlightIdx >= 0 && highlightIdx < visibleRows.length) {
          const root = visibleRows[highlightIdx]!.dataset["root"];
          if (root) _selectValue(root);
        }
      }
      // Escape is handled by the document-level dismiss listener below.
    });

    // ── Select ───────────────────────────────────────────────────────────────
    function _selectValue(root: string): void {
      if (root === _current) {
        _dismissAndClean();
        return;
      }
      opts.onSelect(root);
      _dismissAndClean();
    }

    // ── Dismiss ──────────────────────────────────────────────────────────────
    function _dismissAndClean(): void {
      _closePopup();
      document.removeEventListener("click",       onDismiss, true);
      document.removeEventListener("contextmenu", onDismiss, true);
      document.removeEventListener("keydown",     onDismiss, true);
      window.removeEventListener  ("scroll",      onDismiss, true);
    }

    const onDismiss = (e: Event): void => {
      if (e instanceof KeyboardEvent) {
        // Keyboard: only dismiss on Escape.
        if (e.key !== "Escape") return;
      } else if (e.target instanceof Node && popup.contains(e.target)) {
        // Mouse/scroll interactions that originate inside the popup itself
        // (row clicks, or scrolling the list) must not dismiss it —
        // window-level capture means a `scroll` fired on the popup's own
        // scrollable list also reaches this listener on its way down from
        // `window`, not just clicks.
        return;
      }
      _dismissAndClean();
    };

    document.addEventListener("click",       onDismiss, true);
    document.addEventListener("contextmenu", onDismiss, true);
    document.addEventListener("keydown",     onDismiss, true);
    window.addEventListener  ("scroll",      onDismiss, true);
  }

  // Toggle on trigger click.
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (_popup) {
      _closePopup();
    } else {
      _openPopup();
    }
  });

  // ── Public API ───────────────────────────────────────────────────────────────
  return {
    el: trigger,

    setItems(items: RepoDropdownItem[]): void {
      _items = items;
      _updateLabel();
    },

    setCurrent(root: string): void {
      _current = root;
      _updateLabel();
    },
  };
}
