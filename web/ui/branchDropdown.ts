/**
 * Searchable branch dropdown for the graph toolbar.
 *
 * Replaces the native `<select>` branch switcher with a wider, custom popup
 * that includes a live filter input and a scrollable, checkmarked branch list.
 *
 * # CSP note
 *
 * All styles are inline (`element.style` assignments), which is permitted by
 * the webview's `style-src 'unsafe-inline'` CSP directive. Glyphs are Unicode
 * characters (▾ ✓ ★) — no external images or SVG assets. Consistent with
 * `web/ui/contextMenu.ts`.
 */

/** A single item in the dropdown's branch list. */
export interface BranchDropdownItem {
  name: string;
  kind: number;
  isCurrent: boolean;
}

/** Handle returned by {@link createBranchDropdown}. */
export interface BranchDropdown {
  /** The trigger button element — append this to the toolbar. */
  el: HTMLElement;
  /** Replace the branch list. Called when the host pushes `config.branches`. */
  setItems(items: BranchDropdownItem[]): void;
  /** Update the label shown on the trigger button without opening the popup. */
  setSelected(value: string | null): void;
}

// At most one popup is open at a time (across all dropdown instances).
let _popup: HTMLElement | null = null;

function _closePopup(): void {
  if (_popup) {
    _popup.remove();
    _popup = null;
  }
}

/**
 * Create a searchable branch dropdown.
 *
 * @param opts.initial  Initially selected branch name, or `null` for "Show All".
 * @param opts.onSelect Called when the user picks an item. `null` means "Show All".
 */
export function createBranchDropdown(opts: {
  initial: string | null;
  onSelect: (value: string | null) => void;
}): BranchDropdown {
  let _items: BranchDropdownItem[] = [];
  let _selected: string | null = opts.initial;

  // ── Trigger button ───────────────────────────────────────────────────────────
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.style.cssText = [
    "display:inline-flex; align-items:center; justify-content:space-between;",
    "min-width:180px; max-width:280px;",
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
    if (_selected === null) {
      triggerLabel.textContent = "Show All";
    } else {
      const item = _items.find((b) => b.name === _selected);
      triggerLabel.textContent = (item?.isCurrent ? "★ " : "") + _selected;
    }
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
      `min-width:${Math.max(220, rect.width)}px; max-width:360px;`,
    ].join(" ");

    // Initial position — clamped after appending (once layout runs).
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 2}px`;

    // ── Filter input ─────────────────────────────────────────────────────────
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.placeholder = "Filter Branches…";
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

    function _makeRow(value: string, label: string, isSelected: boolean): HTMLElement {
      const row = document.createElement("div");
      row.dataset["value"] = value;
      row.style.cssText = [
        "display:flex; align-items:center;",
        "padding:4px 10px; cursor:pointer; white-space:nowrap; overflow:hidden;",
      ].join(" ");

      // Leading check glyph (fixed width keeps non-checked rows aligned).
      const check = document.createElement("span");
      check.style.cssText =
        "display:inline-block; width:14px; flex-shrink:0;";
      check.textContent = isSelected ? "✓" : "";

      const text = document.createElement("span");
      text.style.cssText = "overflow:hidden; text-overflow:ellipsis;";
      text.textContent = label;

      row.appendChild(check);
      row.appendChild(text);

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
        _selectValue(value === "" ? null : value);
      });

      return row;
    }

    function _buildList(query: string): void {
      listEl.innerHTML = "";
      visibleRows = [];
      highlightIdx = -1;

      const q = query.toLowerCase();

      // "Show All" — always visible.
      const showAllRow = _makeRow("", "Show All", _selected === null);
      listEl.appendChild(showAllRow);
      visibleRows.push(showAllRow);

      let anyBranch = false;
      for (const item of _items) {
        if (q && !item.name.toLowerCase().includes(q)) continue;
        const label = (item.isCurrent ? "★ " : "") + item.name;
        const row = _makeRow(item.name, label, _selected === item.name);
        listEl.appendChild(row);
        visibleRows.push(row);
        anyBranch = true;
      }

      if (!anyBranch && q) {
        const empty = document.createElement("div");
        empty.style.cssText =
          "padding:6px 10px; opacity:0.5; font-style:italic; user-select:none;";
        empty.textContent = "No branches match";
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
          const v = visibleRows[highlightIdx]!.dataset["value"] ?? "";
          _selectValue(v === "" ? null : v);
        }
      }
      // Escape is handled by the document-level dismiss listener below.
    });

    // ── Select ───────────────────────────────────────────────────────────────
    function _selectValue(value: string | null): void {
      _selected = value;
      _updateLabel();
      opts.onSelect(value);
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
      // Keyboard: only dismiss on Escape.
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      // Mouse: don't dismiss for clicks inside the popup (let row handlers fire).
      if (e instanceof MouseEvent && popup.contains(e.target as Node)) return;
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

    setItems(items: BranchDropdownItem[]): void {
      _items = items;
      _updateLabel();
    },

    setSelected(value: string | null): void {
      _selected = value;
      _updateLabel();
    },
  };
}
