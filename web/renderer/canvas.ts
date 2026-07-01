/**
 * Canvas-based virtualised commit graph renderer.
 *
 * # Architecture
 *
 * The renderer maintains a **virtual list** of commit rows. Only the visible
 * window (plus a small overscan buffer) is painted to the canvas; rows outside
 * the viewport are not touched. This is the mechanism that lets Git Braid stay
 * fast on 10k–100k commit repos (plan §6.1 targets: first paint < 500ms,
 * scroll at 60fps).
 *
 * # DOM structure (built by constructor, inside the caller-supplied container)
 *
 *   container  (overflow:auto — drives the native scrollbar)
 *   └── inner  (height = totalRows * ROW_HEIGHT — creates the scroll range)
 *       └── canvas  (position:sticky; top:0 — stays in viewport while scrolling)
 *
 * # Data flow
 *
 *   Host sends binary batch → `webviewBridge.ts` posts ArrayBuffer
 *   → `web/index.ts` receives → `decodeBatch()` → `renderer.appendRows(rows)`
 *   → renderer stores rows + updates spacer height + repaints visible slice
 *
 * # Scroll / paging
 *
 * The container's native scroll position drives both rendering (which rows to
 * paint) and incremental loading. When the visible window comes within 50 rows
 * of the end of loaded data, `onNeedMore` fires with the current loaded count
 * so the caller can request the next page via `requestBatch`.
 *
 * See `docs/specs/layout-spec.md` for the RowLayout / Segment contract that
 * this renderer consumes, and `web/renderer/decode.ts` for the BRAI v2 decoder.
 */

import {
  type DecodedRow,
  type DecodedRef,
  type DecodedSegment,
  shortOid,
  SEG_KIND_STRAIGHT,
  FLAG_IS_MERGE,
  REF_KIND_HEAD,
  REF_KIND_LOCAL_BRANCH,
  REF_KIND_REMOTE_BRANCH,
  REF_KIND_TAG,
  REF_KIND_STASH,
} from "./decode";

// Polyfill roundRect for environments that don't have it (e.g. older jsdom in
// tests). Modern browsers / VS Code's Electron implement it natively.
if (
  typeof CanvasRenderingContext2D !== "undefined" &&
  !CanvasRenderingContext2D.prototype.roundRect
) {
  CanvasRenderingContext2D.prototype.roundRect = function (
    this: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number | DOMPointInit | (number | DOMPointInit)[],
  ): void {
    const radius = typeof r === "number" ? r : Array.isArray(r) ? (r[0] as number) ?? 0 : 0;
    this.moveTo(x + radius, y);
    this.lineTo(x + w - radius, y);
    this.quadraticCurveTo(x + w, y, x + w, y + radius);
    this.lineTo(x + w, y + h - radius);
    this.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    this.lineTo(x + radius, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - radius);
    this.lineTo(x, y + radius);
    this.quadraticCurveTo(x, y, x + radius, y);
    this.closePath();
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Colour palette — index matches `ColorId` from Rust `model.rs`. */
export const PALETTE: readonly string[] = [
  "#6A9FE6", // 0  — blue
  "#E6886A", // 1  — orange
  "#6AE699", // 2  — green
  "#E66A9F", // 3  — pink
  "#9F6AE6", // 4  — purple
  "#E6D46A", // 5  — yellow
  "#6AE6E6", // 6  — cyan
  "#E66A6A", // 7  — red
  "#E5AE6C", // 8  — amber
  "#A8E56C", // 9  — lime
  "#6CE5BE", // 10 — teal
  "#6CC3E5", // 11 — sky
  "#6C6CE5", // 12 — indigo
  "#CD6CE5", // 13 — violet
  "#E56CC7", // 14 — magenta
  "#E56C86", // 15 — rose
] as const;

/**
 * Fixed colour for tag chips. Deliberately kept outside `PALETTE` so a tag
 * is never mistaken for a lane colour — branch/HEAD/stash chips take their
 * colour from the commit's lane instead (see `refChipColor`).
 */
const TAG_COLOR = "#C9A227"; // dark gold — distinct from all 16 palette entries

/** Pixels per commit row (height of one row in the virtual list). */
export const ROW_HEIGHT = 24;

/** Horizontal lane width in pixels. */
export const LANE_WIDTH = 14;

/** Left padding before lane 0, in CSS pixels. Also used by the header bar. */
export const PAD_X = 12;

/** Commit node circle radius, in CSS pixels. */
const NODE_RADIUS = 4;

// ── Right-anchored column widths (CSS pixels) ─────────────────────────────────
// These are exported so the DOM header bar (web/index.ts) can mirror the layout.

/** Width of the Date column, measured from the right anchor. */
export const COL_DATE_WIDTH = 150;
/** Width of the Author column. */
export const COL_AUTHOR_WIDTH = 120;
/** Width of the Commit (short hash) column. */
export const COL_COMMIT_WIDTH = 80;

/** Rows outside the viewport that are still painted (on each side). */
const OVERSCAN = 8;

/** How many unloaded rows from the bottom trigger `onNeedMore`. */
const PREFETCH_THRESHOLD = 50;

/**
 * Return the chip colour for a ref of the given kind, given the colour of
 * the lane its commit sits on. Tags always use the fixed `TAG_COLOR`; every
 * other kind (branch, HEAD, stash) inherits the lane colour so the chip
 * matches the graph line it's attached to.
 */
function refChipColor(kind: number, laneColor: string): string {
  return kind === REF_KIND_TAG ? TAG_COLOR : laneColor;
}

// ── DisplayRef — merged chips for the canvas ──────────────────────────────────

/**
 * A display-level chip that may represent one or several raw `DecodedRef`s.
 *
 * A local branch `X` (kind=0) and its remote counterparts `<remote>/X`
 * (kind=1) at the same commit are merged into a single chip with `remotes`
 * populated.  HEAD (kind=3) is merged into the local branch chip when both
 * point at the same commit.  Tags (kind=2) and stash (kind=4) are never merged.
 */
interface DisplayRef {
  /** Label shown in the chip (local branch name, remote-only name, tag, etc.). */
  label: string;
  /** RefKind of this chip (0=LocalBranch, 1=RemoteBranch, 2=Tag, 3=HEAD, 4=Stash). */
  kind: number;
  /**
   * Non-empty when a local branch chip has been merged with one or more
   * remote-tracking branches.  Each entry is the remote name prefix
   * (e.g. `"origin"`).
   */
  remotes: string[];
}

/**
 * Collapse `DecodedRef[]` for one commit into display chips.
 *
 * Rules:
 * - Local branch `X` and remote `<remote>/X` → single chip `X` (coloured by
 *   the commit's lane) with a remote mark listing each remote that tracks it.
 * - Remote-only branch (no matching local) → its own lane-coloured chip.
 * - HEAD merges into the local branch chip (or stays alone if detached).
 * - Tags and stash are never merged.
 * - Sort order in the output: LocalBranch, Tag, RemoteBranch, Stash.
 *   (HEAD is embedded in the branch chip, not a separate chip.)
 *
 * This function is pure and deterministic — same input always gives same output.
 */
export function buildDisplayRefs(refs: DecodedRef[]): DisplayRef[] {
  // Collect local branch names and remote branches.
  const localBranchNames = new Set<string>(
    refs.filter(r => r.kind === REF_KIND_LOCAL_BRANCH).map(r => r.name),
  );

  const result: DisplayRef[] = [];
  // Track which remote refs have been absorbed into a local chip.
  const absorbedRemotes = new Set<string>();

  // ── Local branches (kind=0) ── merge HEAD and remote counterparts in.
  for (const ref of refs) {
    if (ref.kind !== REF_KIND_LOCAL_BRANCH) continue;

    const remotes: string[] = [];
    for (const r of refs) {
      if (r.kind !== REF_KIND_REMOTE_BRANCH) continue;
      // Does this remote branch track the local branch?
      // e.g. "origin/main" tracks local "main" when name ends with "/main".
      const slash = r.name.indexOf("/");
      const remoteBranch = slash >= 0 ? r.name.slice(slash + 1) : r.name;
      if (remoteBranch === ref.name) {
        const remoteName = slash >= 0 ? r.name.slice(0, slash) : r.name;
        remotes.push(remoteName);
        absorbedRemotes.add(r.name);
      }
    }

    result.push({ label: ref.name, kind: REF_KIND_LOCAL_BRANCH, remotes });
  }

  // ── Tags (kind=2) — never merged.
  for (const ref of refs) {
    if (ref.kind === REF_KIND_TAG) {
      result.push({ label: ref.name, kind: REF_KIND_TAG, remotes: [] });
    }
  }

  // ── Unabsorbed remote branches (kind=1).
  for (const ref of refs) {
    if (ref.kind === REF_KIND_REMOTE_BRANCH && !absorbedRemotes.has(ref.name)) {
      result.push({ label: ref.name, kind: REF_KIND_REMOTE_BRANCH, remotes: [] });
    }
  }

  // ── Stash (kind=4).
  for (const ref of refs) {
    if (ref.kind === REF_KIND_STASH) {
      result.push({ label: ref.name, kind: REF_KIND_STASH, remotes: [] });
    }
  }

  // Detached HEAD (kind=3 with no matching local branch) — add a HEAD chip.
  const hasHead = refs.some(r => r.kind === REF_KIND_HEAD);
  if (hasHead && localBranchNames.size === 0) {
    result.unshift({ label: "HEAD", kind: REF_KIND_HEAD, remotes: [] });
  }

  return result;
}

/** Width of the small kind-icon drawn at the left of each chip, in pixels. */
const CHIP_ICON_W = 10;

/**
 * Draw a small vector icon inside a ref chip at position `(x, y)`.
 * The icon is centred vertically around `y` and left-aligned at `x`.
 * CSP forbids external SVG or image assets — we draw canvas paths only.
 */
function drawRefIcon(
  ctx: CanvasRenderingContext2D,
  kind: number,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = 1;

  if (kind === REF_KIND_TAG) {
    // Tag icon: a small rectangle with a rounded right side (label shape).
    const w = 7, h = 6;
    const tx = x, ty = y - h / 2;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx + w - 2, ty);
    ctx.quadraticCurveTo(tx + w, ty, tx + w, ty + h / 2);
    ctx.quadraticCurveTo(tx + w, ty + h, tx + w - 2, ty + h);
    ctx.lineTo(tx, ty + h);
    ctx.closePath();
    ctx.stroke();
    // Small punch-hole dot.
    ctx.beginPath();
    ctx.arc(tx + 1.5, ty + h / 2, 0.8, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === REF_KIND_REMOTE_BRANCH) {
    // Remote branch icon: a downward arrow into a tray (fetch/download glyph),
    // distinct from the local-branch fork so remotes read at a glance even
    // though the chip colour now comes from the lane, not the ref kind.
    const bx = x + 1, by = y;
    ctx.beginPath();
    ctx.moveTo(bx + 2, by - 3);
    ctx.lineTo(bx + 2, by + 1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx, by - 1);
    ctx.lineTo(bx + 2, by + 1);
    ctx.lineTo(bx + 4, by - 1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx - 1, by + 3);
    ctx.lineTo(bx + 5, by + 3);
    ctx.stroke();
  } else if (kind === REF_KIND_STASH) {
    // Stash icon: stacked horizontal bars (a small "layers" glyph).
    const bx = x, by = y;
    ctx.beginPath();
    ctx.moveTo(bx, by - 3);
    ctx.lineTo(bx + 6, by - 3);
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + 6, by);
    ctx.moveTo(bx, by + 3);
    ctx.lineTo(bx + 6, by + 3);
    ctx.stroke();
  } else {
    // Local branch/HEAD icon: a simple fork glyph (two-segment branch).
    //   ── stem up (vertical from mid)
    //   └── branch off to the right at top
    const bx = x + 1, by = y;
    // Vertical stem.
    ctx.beginPath();
    ctx.moveTo(bx + 1, by + 3);
    ctx.lineTo(bx + 1, by - 2);
    ctx.stroke();
    // Branch arm.
    ctx.beginPath();
    ctx.moveTo(bx + 1, by - 1);
    ctx.lineTo(bx + 5, by - 3);
    ctx.stroke();
    // Node dots.
    ctx.beginPath();
    ctx.arc(bx + 1, by + 3, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx + 5, by - 3, 1, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/** Width of the small cloud icon marking a remote-tracked branch, in pixels. */
const REMOTE_ICON_W = 8;

/**
 * Draw a small cloud icon marking a remote-tracked branch, left-aligned at
 * `x` and vertically centred on `y`. Built from three overlapping filled
 * circles plus a base rectangle (no stroke — a filled blob reads fine at
 * this size and avoids seams between the arcs).
 */
function drawRemoteMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  const cx = x + REMOTE_ICON_W / 2;
  ctx.beginPath();
  ctx.arc(cx - 2.5, y + 0.5, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, y - 0.8, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 2.5, y + 0.5, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.rect(cx - 3.5, y + 0.3, 7, 1.8);
  ctx.fill();
  ctx.restore();
}

/**
 * Format an epoch-seconds timestamp as a compact date string for the list column.
 * Produces "DD Mon YYYY HH:MM" in local time, e.g. "15 Jun 2026 16:44".
 */
function formatListDate(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"] as const;
  const dd   = String(d.getDate()).padStart(2, "0");
  const mon  = months[d.getMonth()];
  const yyyy = d.getFullYear();
  const hh   = String(d.getHours()).padStart(2, "0");
  const mm   = String(d.getMinutes()).padStart(2, "0");
  return `${dd} ${mon} ${yyyy} ${hh}:${mm}`;
}

/**
 * Truncate `text` with an ellipsis so it fits within `maxWidth` CSS pixels using
 * the canvas context's current font. Returns the original string if it already fits.
 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = "…";
  const ellipsisW = ctx.measureText(ellipsis).width;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid)).width + ellipsisW <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo === 0 ? ellipsis : text.slice(0, lo) + ellipsis;
}

/** Return the full 40-char hex of a 20-byte OID. */
function fullOid(oid: Uint8Array): string {
  return Array.from(oid)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── CanvasRenderer ────────────────────────────────────────────────────────────

export class CanvasRenderer {
  // DOM elements
  private readonly _inner: HTMLDivElement;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _ctx: CanvasRenderingContext2D;
  private readonly _resizeObserver: ResizeObserver;

  // Virtual list state
  private _rows: DecodedRow[] = [];
  private _totalRows = 0;
  private _maxLane = 0;

  // Scroll state
  private _scrollTop = 0;

  // Paging state
  private _atEnd = false;
  private _pendingMore = false;

  // Selection state (-1 = nothing selected).
  private _selectedRow = -1;

  // Find state.
  private _matchRows = new Set<number>();
  private _currentMatch = -1;

  // Per-instance palette (defaults to the module-level PALETTE; overridable via
  // setPalette so the host can push a user-configured colour cycle).
  private _palette: readonly string[] = PALETTE;

  /**
   * Called when more rows are needed (visible window nearing the loaded tail).
   * Receives the current loaded row count as the `offset` for the next batch.
   * Set before the first `appendRows` call so the initial paint can fire it.
   */
  onNeedMore?: ((loadedCount: number) => void) | undefined;

  /**
   * Called when the user clicks a commit row. Receives the full 40-char hex OID.
   */
  onSelect?: ((oidHex: string) => void) | undefined;

  /**
   * Called when the user right-clicks a commit row.
   * Receives the full 40-char OID, the decoded refs on the row, and the
   * pointer position (client coordinates) for positioning the context menu.
   */
  onContextMenu?: ((info: {
    oidHex: string;
    refs: DecodedRef[];
    clientX: number;
    clientY: number;
  }) => void) | undefined;

  /**
   * @param _container  The element that acts as the scroll viewport. It must
   *   have a defined height (e.g. `height:100%` filling the webview body).
   *   The constructor sets `overflow:auto` on it and builds the DOM tree inside.
   */
  constructor(private readonly _container: HTMLElement) {
    // Container becomes the scroll viewport.
    _container.style.overflow = "auto";
    _container.style.position = "relative";

    // Inner div: its height creates the scroll range.
    this._inner = document.createElement("div");
    this._inner.style.cssText = "position:relative; width:100%; height:0;";
    _container.appendChild(this._inner);

    // Canvas: sticky at top — stays visible while inner scrolls past.
    this._canvas = document.createElement("canvas");
    this._canvas.style.cssText =
      "position:sticky; top:0; display:block; width:100%;";
    this._inner.appendChild(this._canvas);

    const ctx = this._canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this._ctx = ctx;

    // Native scroll drives painting + paging.
    _container.addEventListener("scroll", () => {
      this._scrollTop = _container.scrollTop;
      this._paint();
    });

    // Click selects a row and notifies the host.
    _container.addEventListener("click", (e: MouseEvent) => {
      const rect = this._canvas.getBoundingClientRect();
      const y = e.clientY - rect.top + this._scrollTop;
      const row = Math.floor(y / ROW_HEIGHT);
      if (row >= 0 && row < this._totalRows) {
        this._selectedRow = row;
        this._paint();
        const r = this._rows[row];
        if (r) {
          this.onSelect?.(fullOid(r.oid));
        }
      }
    });

    // Right-click selects the row and fires the context-menu callback.
    // The callback (set in web/index.ts) builds and shows the DOM popup.
    _container.addEventListener("contextmenu", (e: MouseEvent) => {
      const rect = this._canvas.getBoundingClientRect();
      const y = e.clientY - rect.top + this._scrollTop;
      const row = Math.floor(y / ROW_HEIGHT);
      if (row >= 0 && row < this._totalRows) {
        e.preventDefault();
        this._selectedRow = row;
        this._paint();
        const r = this._rows[row];
        if (r) {
          this.onContextMenu?.({
            oidHex: fullOid(r.oid),
            refs: r.refs,
            clientX: e.clientX,
            clientY: e.clientY,
          });
        }
      }
    });

    // Resize keeps the canvas sized to the viewport.
    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(_container);
  }

  /**
   * Append a decoded batch of rows.
   *
   * Rows must be appended in order (newest first) matching the wire protocol.
   * Append-only stability (layout-spec invariant 5) guarantees that rows[0..N]
   * are identical across calls, so concatenation is safe.
   */
  appendRows(rows: DecodedRow[]): void {
    for (const row of rows) {
      this._rows.push(row);
      if (row.lane > this._maxLane) {
        this._maxLane = row.lane;
      }
    }
    this._totalRows = this._rows.length;
    this._inner.style.height = `${this._totalRows * ROW_HEIGHT}px`;
    this._pendingMore = false; // clear in-flight guard; a new page has arrived
    this._paint();
  }

  /**
   * Signal that the repository has no more commits to load.
   * After this call `onNeedMore` will never fire again.
   */
  markEnd(): void {
    this._atEnd = true;
  }

  // ── Find highlight API ───────────────────────────────────────────────────

  /**
   * Highlight all matching row indices (amber tint). Replaces any prior set.
   * Triggers a repaint.
   */
  setMatches(indices: number[]): void {
    this._matchRows = new Set(indices);
    this._paint();
  }

  /**
   * Emphasise one match as the "current" match (stronger amber tint).
   * Must be a value already in `setMatches`. Triggers a repaint.
   */
  setCurrentMatch(index: number): void {
    this._currentMatch = index;
    this._paint();
  }

  /** Clear all find highlights and repaint. */
  clearFind(): void {
    this._matchRows.clear();
    this._currentMatch = -1;
    this._paint();
  }

  /**
   * Clear the current selection highlight (e.g. when the detail panel closes).
   * Triggers a repaint.
   */
  clearSelection(): void {
    this._selectedRow = -1;
    this._paint();
  }

  /**
   * Override the lane colour cycle.
   *
   * `colors` is an ordered array of CSS colour strings. Empty array resets to
   * the built-in module-level `PALETTE`. Triggers a repaint.
   */
  setPalette(colors: string[]): void {
    this._palette = colors.length > 0 ? colors : PALETTE;
    this._paint();
  }

  /**
   * Scroll the row at `index` to the vertical centre of the viewport.
   * The existing `scroll` listener repaints automatically.
   */
  scrollToRow(index: number): void {
    this._container.scrollTop = Math.max(
      0,
      index * ROW_HEIGHT - this._container.clientHeight / 2 + ROW_HEIGHT / 2,
    );
  }

  /**
   * Reset all renderer state.
   *
   * Called when the graph must be reloaded from scratch after a write
   * operation. Clears the row list, paging state, selection, and find
   * highlights, then repaints the empty canvas.
   *
   * After calling `reset()` the caller must send a fresh `requestBatch`
   * to repopulate the renderer. The append-only stability invariant
   * (layout-spec §5 invariant 5) is restored by this reset.
   */
  reset(): void {
    this._rows = [];
    this._totalRows = 0;
    this._maxLane = 0;
    this._selectedRow = -1;
    this._atEnd = false;
    this._pendingMore = false;
    this._matchRows.clear();
    this._currentMatch = -1;
    this._inner.style.height = "0";
    this._paint();
  }

  dispose(): void {
    this._resizeObserver.disconnect();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Return the colour string for a lane/segment colour id from the instance palette. */
  private _paletteColor(id: number): string {
    return this._palette[id % this._palette.length] ?? "#6A9FE6";
  }

  private _onResize(): void {
    const dpr = window.devicePixelRatio ?? 1;
    const cw = this._container.clientWidth;
    const ch = this._container.clientHeight;

    // Safety clamp: Chromium refuses canvas contexts beyond ~16k px per side.
    // In normal operation ch is the viewport height (~800px), so this is inert.
    // If a layout bug balloons clientHeight this prevents canvas context loss.
    const MAX_CANVAS_PX = 8192;

    // Physical backing-store dimensions.
    this._canvas.width  = Math.min(Math.round(cw * dpr), MAX_CANVAS_PX);
    this._canvas.height = Math.min(Math.round(ch * dpr), MAX_CANVAS_PX);

    // CSS dimensions match container viewport.
    this._canvas.style.width  = `${cw}px`;
    this._canvas.style.height = `${ch}px`;

    // Resetting .width clears all canvas state — re-apply DPR scale.
    this._ctx.scale(dpr, dpr);

    this._paint();
  }

  private _paint(): void {
    const cw = this._container.clientWidth;
    const ch = this._container.clientHeight;

    this._ctx.clearRect(0, 0, cw, ch);

    if (this._totalRows === 0) {
      // Placeholder until the first batch arrives.
      this._ctx.fillStyle = "rgba(128,128,128,0.4)";
      this._ctx.font = "13px monospace";
      this._ctx.textAlign = "center";
      this._ctx.fillText("Git Braid — awaiting commit data", cw / 2, ch / 2);
      return;
    }

    const scrollTop = this._scrollTop;

    // Visible row range + overscan, clamped to loaded data.
    const visibleStart = Math.max(
      0,
      Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN,
    );
    const visibleEnd = Math.min(
      this._totalRows,
      Math.ceil((scrollTop + ch) / ROW_HEIGHT) + OVERSCAN,
    );

    // X-coordinate of the OID text column (to the right of all lanes).
    const textX = PAD_X + (this._maxLane + 2) * LANE_WIDTH;

    // ── 0a. Find match highlights (amber tint, behind everything) ────────
    if (this._matchRows.size > 0) {
      for (let i = visibleStart; i < visibleEnd; i++) {
        if (this._matchRows.has(i)) {
          const y = i * ROW_HEIGHT - scrollTop;
          // Current match: stronger emphasis; other matches: softer tint.
          this._ctx.fillStyle =
            i === this._currentMatch
              ? "rgba(229, 192, 123, 0.40)" // current match — stronger amber
              : "rgba(229, 192, 123, 0.18)"; // other matches — soft amber
          this._ctx.fillRect(0, y, cw, ROW_HEIGHT);
        }
      }
    }

    // ── 0b. Selection highlight (full-width band, on top of match tints) ─
    if (this._selectedRow >= visibleStart && this._selectedRow < visibleEnd) {
      const y = this._selectedRow * ROW_HEIGHT - scrollTop;
      this._ctx.fillStyle = "rgba(100, 159, 230, 0.15)"; // soft blue
      this._ctx.fillRect(0, y, cw, ROW_HEIGHT);
    }

    // ── 1. Draw segments first (nodes are painted on top) ────────────────
    for (let i = visibleStart; i < visibleEnd; i++) {
      const row = this._rows[i];
      if (row === undefined) continue;

      // Gap spans from the vertical midpoint of row i to the midpoint of row i+1.
      const yTop    = i       * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2;
      const yBottom = (i + 1) * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2;

      for (const seg of row.segments) {
        this._drawSegment(seg, yTop, yBottom);
      }
    }

    // ── 2. Draw nodes (on top of segments) ───────────────────────────────
    this._ctx.font      = "11px monospace";
    this._ctx.textAlign = "left";

    for (let i = visibleStart; i < visibleEnd; i++) {
      const row = this._rows[i];
      if (row === undefined) continue;

      const y = i * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2;
      const x = PAD_X + row.lane * LANE_WIDTH;
      const color = this._paletteColor(row.color);

      // Filled circle.
      this._ctx.beginPath();
      this._ctx.arc(x, y, NODE_RADIUS, 0, Math.PI * 2);
      this._ctx.fillStyle = color;
      this._ctx.fill();

      // Merge indicator: an extra ring around the node.
      if (row.flags & FLAG_IS_MERGE) {
        this._ctx.beginPath();
        this._ctx.arc(x, y, NODE_RADIUS + 2, 0, Math.PI * 2);
        this._ctx.strokeStyle = color;
        this._ctx.lineWidth = 1;
        this._ctx.stroke();
      }

      // HEAD indicator: outer yellow ring (outermost — sits just beyond the merge ring).
      if ((row.refs ?? []).some(r => r.kind === REF_KIND_HEAD)) {
        this._ctx.beginPath();
        this._ctx.arc(x, y, NODE_RADIUS + 3, 0, Math.PI * 2);
        this._ctx.strokeStyle = "#E6D46A"; // HEAD yellow — fixed indicator colour, independent of lane/chip colour
        this._ctx.lineWidth = 1.5;
        this._ctx.stroke();
      }

      // ── Right-anchored column x-positions (recomputed per row using cw).
      // cw is captured at the top of _paint() and is stable across the loop.
      const colCommitX = cw - PAD_X - COL_COMMIT_WIDTH;
      const colAuthorX = colCommitX - COL_AUTHOR_WIDTH;
      const colDateX   = colAuthorX - COL_DATE_WIDTH;
      const descRight  = colDateX - 8; // Description clips before the Date column.

      // ── Description column: ref chips, then subject (clipped to descRight).
      let tx = textX;

      // Build display-level chips: merge local+remote branch pairs, add icons.
      const displayRefs = buildDisplayRefs(row.refs ?? []);
      for (const dref of displayRefs) {
        const chipColor = refChipColor(dref.kind, color);
        this._ctx.font = "10px monospace";
        const tw = this._ctx.measureText(dref.label).width;
        // Width = icon box + gap + separator + gap + label + right padding
        // + (gap + separator + gap + remote cloud icon + padding, if tracked).
        const remotePad = dref.remotes.length > 0 ? 15 : 0;
        const chipW = CHIP_ICON_W + tw + 13 + remotePad;
        const chipH = 14;
        const chipY = y - chipH / 2;

        // Stop drawing chips if they would overflow into the Date column.
        if (tx + chipW > descRight) break;

        // Background fill and border.
        this._ctx.beginPath();
        this._ctx.roundRect(tx, chipY, chipW, chipH, 3);
        this._ctx.fillStyle = chipColor + "33"; // ~20% opacity fill
        this._ctx.fill();
        this._ctx.strokeStyle = chipColor;
        this._ctx.lineWidth = 0.8;
        this._ctx.stroke();

        // Kind icon.
        drawRefIcon(this._ctx, dref.kind, tx + 4, y, chipColor);

        // Separator between icon and label — solid line, with a gap on
        // each side so it doesn't touch the icon or the text.
        const sepX = tx + CHIP_ICON_W + 4;
        this._ctx.beginPath();
        this._ctx.moveTo(sepX, chipY + 3);
        this._ctx.lineTo(sepX, chipY + chipH - 2);
        this._ctx.strokeStyle = chipColor;
        this._ctx.lineWidth = 0.8;
        this._ctx.stroke();

        // Label text.
        this._ctx.fillStyle = chipColor;
        this._ctx.fillText(dref.label, sepX + 4, y + 4);

        // Remote tracking mark: a separator (same style as the icon/label one)
        // followed by a small cloud icon, both with a gap so nothing touches.
        if (dref.remotes.length > 0) {
          const remoteSepX = sepX + 4 + tw + 3;
          this._ctx.beginPath();
          this._ctx.moveTo(remoteSepX, chipY + 2);
          this._ctx.lineTo(remoteSepX, chipY + chipH - 2);
          this._ctx.strokeStyle = chipColor;
          this._ctx.lineWidth = 0.8;
          this._ctx.stroke();

          drawRemoteMark(this._ctx, remoteSepX + 5, y, chipColor);
        }

        tx += chipW + 5;
      }

      // Subject text (after chips, clipped to descRight).
      if (row.subject && tx < descRight) {
        this._ctx.font = "11px monospace";
        this._ctx.fillStyle = "rgba(200,200,200,0.9)";
        const subject = fitText(this._ctx, row.subject, descRight - tx);
        this._ctx.fillText(subject, tx, y + 4);
      }

      // ── Date column (right-anchored).
      this._ctx.font = "11px monospace";
      this._ctx.fillStyle = "rgba(130,130,130,0.75)";
      this._ctx.fillText(formatListDate(row.commitTime), colDateX, y + 4);

      // ── Author column (right-anchored, clipped to column width).
      this._ctx.font = "11px monospace";
      this._ctx.fillStyle = "rgba(180,180,180,0.8)";
      const authorText = fitText(this._ctx, row.author ?? "", COL_AUTHOR_WIDTH - 8);
      this._ctx.fillText(authorText, colAuthorX, y + 4);

      // ── Commit (short hash) column (right-anchored, dimmed).
      this._ctx.font = "11px monospace";
      this._ctx.fillStyle = "rgba(130,130,130,0.6)";
      this._ctx.fillText(shortOid(row.oid), colCommitX, y + 4);
    }

    // ── 3. Prefetch trigger ───────────────────────────────────────────────
    if (
      !this._atEnd &&
      !this._pendingMore &&
      visibleEnd >= this._totalRows - PREFETCH_THRESHOLD
    ) {
      this._pendingMore = true; // cleared when next appendRows arrives
      this.onNeedMore?.(this._totalRows);
    }
  }

  /**
   * Draw one segment in the gap between two row midpoints.
   *
   * `Straight` (kind=0): vertical line (from_lane === to_lane guaranteed by
   *   the layout invariant, but we use from_lane for the x-coord to be safe).
   * `MergeOut` (kind=1) / `ConvergeIn` (kind=2): cubic bezier for a smooth
   *   S-curve — control points are placed at the midpoint y, pinned to each
   *   lane's x, giving a natural branch/merge shape.
   */
  private _drawSegment(
    seg: DecodedSegment,
    yTop: number,
    yBottom: number,
  ): void {
    const x1 = PAD_X + seg.fromLane * LANE_WIDTH;
    const x2 = PAD_X + seg.toLane   * LANE_WIDTH;

    this._ctx.beginPath();
    this._ctx.strokeStyle = this._paletteColor(seg.color);
    this._ctx.lineWidth   = 1.5;

    if (seg.kind === SEG_KIND_STRAIGHT) {
      // Vertical straight line.
      this._ctx.moveTo(x1, yTop);
      this._ctx.lineTo(x2, yBottom);
    } else {
      // Diagonal (MergeOut or ConvergeIn): cubic bezier.
      // Both control points sit at mid-gap y, held at their respective lane x.
      // This produces a gentle horizontal-to-vertical S-curve.
      const midY = (yTop + yBottom) / 2;
      this._ctx.moveTo(x1, yTop);
      this._ctx.bezierCurveTo(x1, midY, x2, midY, x2, yBottom);
    }

    this._ctx.stroke();
  }
}
