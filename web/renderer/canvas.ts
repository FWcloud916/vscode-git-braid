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
 * # Data flow
 *
 *   Host sends binary batch → `webviewBridge.ts` posts ArrayBuffer
 *   → `web/index.ts` receives → calls `renderer.appendRows(buffer)`
 *   → renderer decodes + paints visible slice
 *
 * # Phase 0 status
 *
 * **Stub** — creates the canvas context and sets up resize/scroll observers.
 * `appendRows` is a no-op; actual painting is Phase 0/M2 target.
 *
 * See `docs/specs/layout-spec.md` for the RowLayout / Segment contract that
 * this renderer consumes.
 */

/** Colour palette — index matches `ColorId` from Rust `model.rs`. Exported for use by index.ts. */
export const PALETTE = [
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

export class CanvasRenderer {
  private readonly _ctx: CanvasRenderingContext2D;
  private readonly _resizeObserver: ResizeObserver;
  private _scrollTop = 0;
  private _totalRows = 0;

  constructor(private readonly _canvas: HTMLCanvasElement) {
    const ctx = _canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this._ctx = ctx;

    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(_canvas);

    _canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this._scrollTop = Math.max(0, this._scrollTop + e.deltaY);
      this._paint();
    });
  }

  /**
   * Append a decoded binary batch of rows.
   *
   * TODO(Phase 0/M2): decode the ArrayBuffer using the binary protocol from
   * `crates/core/src/serialize.rs` and store the rows for painting.
   */
  appendRows(_buffer: ArrayBuffer): void {
    // stub
  }

  dispose(): void {
    this._resizeObserver.disconnect();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _onResize(): void {
    const dpr = window.devicePixelRatio ?? 1;
    const rect = this._canvas.getBoundingClientRect();
    this._canvas.width  = rect.width  * dpr;
    this._canvas.height = rect.height * dpr;
    this._ctx.scale(dpr, dpr);
    this._paint();
  }

  private _paint(): void {
    const { width, height } = this._canvas.getBoundingClientRect();
    this._ctx.clearRect(0, 0, width, height);

    if (this._totalRows === 0) {
      // Placeholder until rows are loaded.
      this._ctx.fillStyle = "rgba(128,128,128,0.4)";
      this._ctx.font = "13px monospace";
      this._ctx.textAlign = "center";
      this._ctx.fillText("Git Braid — awaiting commit data", width / 2, height / 2);
    }

    // TODO(Phase 0/M2): virtualised row painting loop.
    // Compute visibleStart / visibleEnd from this._scrollTop and ROW_HEIGHT,
    // then iterate and draw nodes + segments only for that slice.
  }
}
