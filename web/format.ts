/**
 * Pure date-formatting helpers for the Git Braid webview.
 *
 * These are in their own module so they can be unit-tested in vitest's node
 * environment without importing `web/index.ts` (which references `window` at
 * module scope and cannot run outside a browser context).
 */

/**
 * Format a Unix epoch seconds value as a human-readable relative time string,
 * e.g. "just now", "5 minutes ago", "3 hours ago", "2 days ago".
 *
 * Falls back to the locale date string for dates older than ~30 days —
 * "30+ days ago" is not meaningfully more readable than an actual date.
 *
 * @param epochSeconds — commit/author time as Unix epoch seconds.
 * @param nowMs        — current wall-clock time in milliseconds. Accepting this
 *   as a parameter avoids real-clock dependency in tests.
 */
export function formatRelative(epochSeconds: number, nowMs: number): string {
  const deltaMs = nowMs - epochSeconds * 1000;
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60)   return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60)   return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)    return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const days = Math.floor(hr / 24);
  if (days <= 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  // Older than 30 days — fall back to an absolute date string.
  return new Date(epochSeconds * 1000).toLocaleDateString();
}
