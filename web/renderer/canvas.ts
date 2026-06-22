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
 * this renderer consumes, and `web/renderer/decode.ts` for the BRAI v1 decoder.
 */

import {
  type DecodedRow,
  type DecodedSegment,
  shortOid,
  SEG_KIND_STRAIGHT,
  FLAG_IS_MERGE,
} from "./decode";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Colour palette — index matches `ColorId` from Rust `model.rs`. */
export const PALETTE: readonly string[] = [
  "#6A9FE6", // 0 — blue
  "#E6886A", // 1 — orange
  "#6AE699", // 2 — green
  "#E66A9F", // 3 — pink
  "#9F6AE6", // 4 — purple
  "#E6D46A", // 5 — yellow
  "#6AE6E6", // 6 — cyan
  "#E66A6A", // 7 — red
] as const;

/** Pixels per commit row (height of one row in the virtual list). */
export const ROW_HEIGHT = 24;

/** Horizontal lane width in pixels. */
export const LANE_WIDTH = 14;

/** Left padding before lane 0, in CSS pixels. */
const PAD_X = 12;

/** Commit node circle radius, in CSS pixels. */
const NODE_RADIUS = 4;

/** Rows outside the viewport that are still painted (on each side). */
const OVERSCAN = 8;

/** How many unloaded rows from the bottom trigger `onNeedMore`. */
const PREFETCH_THRESHOLD = 50;

/** Return the palette hex string for a given colour id (wraps around palette). */
function paletteColor(id: number): string {
  return PALETTE[id % PALETTE.length] ?? "#6A9FE6";
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

  /**
   * Called when more rows are needed (visible window nearing the loaded tail).
   * Receives the current loaded row count as the `offset` for the next batch.
   * Set before the first `appendRows` call so the initial paint can fire it.
   */
  onNeedMore?: ((loadedCount: number) => void) | undefined;

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

  dispose(): void {
    this._resizeObserver.disconnect();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _onResize(): void {
    const dpr = window.devicePixelRatio ?? 1;
    const cw = this._container.clientWidth;
    const ch = this._container.clientHeight;

    // Physical backing-store dimensions.
    this._canvas.width  = Math.round(cw * dpr);
    this._canvas.height = Math.round(ch * dpr);

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
      const color = paletteColor(row.color);

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

      // Short OID (7 hex chars) to the right of the lane graph.
      this._ctx.fillStyle = "rgba(160,160,160,0.85)";
      this._ctx.fillText(shortOid(row.oid), textX, y + 4);
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
    this._ctx.strokeStyle = paletteColor(seg.color);
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
