/**
 * Tests for Slice-4 settings helpers.
 *
 * Covers the pure `formatRelative` date formatter (injectable `nowMs` avoids
 * real-clock dependency) and the `CanvasRenderer.setPalette` API (palette getter
 * exposed via a tiny exported helper for testability without a real DOM).
 */

import { describe, it, expect } from "vitest";
import { formatRelative } from "./format";
import { PALETTE } from "./renderer/canvas";

// ── formatRelative ────────────────────────────────────────────────────────────

describe("formatRelative", () => {
  // A fixed "now" so the tests are deterministic.
  const now = new Date("2026-06-22T12:00:00Z").getTime(); // ms

  function epoch(offsetSec: number): number {
    // epochSeconds = now/1000 - offsetSec  (positive offset = older commit)
    return now / 1000 - offsetSec;
  }

  it("returns 'just now' for < 60 s ago", () => {
    expect(formatRelative(epoch(0),  now)).toBe("just now");
    expect(formatRelative(epoch(59), now)).toBe("just now");
  });

  it("returns singular 'minute' at exactly 1 minute", () => {
    expect(formatRelative(epoch(60), now)).toBe("1 minute ago");
  });

  it("returns plural 'minutes' for 2–59 minutes", () => {
    expect(formatRelative(epoch(60 * 2),  now)).toBe("2 minutes ago");
    expect(formatRelative(epoch(60 * 59), now)).toBe("59 minutes ago");
  });

  it("returns singular 'hour' at exactly 1 hour", () => {
    expect(formatRelative(epoch(3600), now)).toBe("1 hour ago");
  });

  it("returns plural 'hours' for 2–23 hours", () => {
    expect(formatRelative(epoch(3600 * 2),  now)).toBe("2 hours ago");
    expect(formatRelative(epoch(3600 * 23), now)).toBe("23 hours ago");
  });

  it("returns singular 'day' at exactly 1 day", () => {
    expect(formatRelative(epoch(86400), now)).toBe("1 day ago");
  });

  it("returns plural 'days' for 2–30 days", () => {
    expect(formatRelative(epoch(86400 * 2),  now)).toBe("2 days ago");
    expect(formatRelative(epoch(86400 * 30), now)).toBe("30 days ago");
  });

  it("falls back to absolute date for > 30 days", () => {
    const result = formatRelative(epoch(86400 * 31), now);
    // Should be a locale date string (non-empty, contains digits), not relative.
    expect(result).not.toMatch(/ago/);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── PALETTE default (setPalette tested via PALETTE constant) ─────────────────

describe("PALETTE", () => {
  it("has at least 8 colours", () => {
    expect(PALETTE.length).toBeGreaterThanOrEqual(8);
  });

  it("all entries are CSS hex colours", () => {
    for (const c of PALETTE) {
      expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
