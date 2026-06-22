/**
 * Unit tests for `buildMessages` — verifies prompt construction without a
 * live AI model. `generateReleaseNotes` is the thin wrapper that calls the
 * provider, so it is tested via integration; only the pure builder is tested here.
 */

import { describe, it, expect } from "vitest";
import type { RangeCommit } from "@git-braid/native";
import { buildMessages } from "./releaseNotes";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCommit(overrides: Partial<RangeCommit> = {}): RangeCommit {
  return {
    oid: "abc123def456abc123def456abc123def456abc1",
    subject: "feat: add widget",
    authorName: "Alice",
    commitTime: 946684800,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildMessages", () => {
  it("produces a system + user message pair", () => {
    const msgs = buildMessages({
      commits: [makeCommit()],
      fromRef: "v1.0.0",
      toRef: "HEAD",
      includeDiffStat: false,
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
  });

  it("system message includes the range label", () => {
    const msgs = buildMessages({
      commits: [makeCommit()],
      fromRef: "v1.0.0",
      toRef: "v1.1.0",
      includeDiffStat: false,
    });
    expect(msgs[0]!.content).toContain("v1.0.0..v1.1.0");
  });

  it("range label is just toRef when fromRef is null", () => {
    const msgs = buildMessages({
      commits: [makeCommit()],
      fromRef: null,
      toRef: "HEAD",
      includeDiffStat: false,
    });
    expect(msgs[0]!.content).toContain("HEAD");
    expect(msgs[0]!.content).not.toContain("..");
  });

  it("user message lists commit subjects and authors", () => {
    const commits = [
      makeCommit({ subject: "feat: add widget", authorName: "Alice" }),
      makeCommit({ subject: "fix: crash on empty list", authorName: "Bob" }),
    ];
    const msgs = buildMessages({
      commits,
      fromRef: "v1.0.0",
      toRef: "HEAD",
      includeDiffStat: false,
    });
    const user = msgs[1]!.content;
    expect(user).toContain("feat: add widget");
    expect(user).toContain("Alice");
    expect(user).toContain("fix: crash on empty list");
    expect(user).toContain("Bob");
  });

  it("no diffstat suffix when includeDiffStat is false", () => {
    const msgs = buildMessages({
      commits: [makeCommit({ filesChanged: 5, insertions: 20, deletions: 10 })],
      fromRef: "v1.0.0",
      toRef: "HEAD",
      includeDiffStat: false,
    });
    const user = msgs[1]!.content;
    // The [N files, ...] suffix must not appear.
    expect(user).not.toContain("[");
  });

  it("diffstat suffix included when includeDiffStat is true and filesChanged > 0", () => {
    const msgs = buildMessages({
      commits: [makeCommit({ filesChanged: 3, insertions: 15, deletions: 7 })],
      fromRef: "v1.0.0",
      toRef: "HEAD",
      includeDiffStat: true,
    });
    const user = msgs[1]!.content;
    expect(user).toContain("[3 files, +15/-7]");
  });

  it("diffstat suffix uses singular 'file' for 1 file", () => {
    const msgs = buildMessages({
      commits: [makeCommit({ filesChanged: 1, insertions: 4, deletions: 2 })],
      fromRef: "v1.0.0",
      toRef: "HEAD",
      includeDiffStat: true,
    });
    const user = msgs[1]!.content;
    expect(user).toContain("[1 file,");
    expect(user).not.toContain("[1 files,");
  });

  it("no diffstat suffix when filesChanged is 0 even with includeDiffStat true", () => {
    const msgs = buildMessages({
      commits: [makeCommit({ filesChanged: 0, insertions: 0, deletions: 0 })],
      fromRef: "v1.0.0",
      toRef: "HEAD",
      includeDiffStat: true,
    });
    const user = msgs[1]!.content;
    // Zero-change commits (e.g. empty commits) should not get a suffix.
    expect(user).not.toContain("[0 file");
  });

  it("system message mentions Features / Bug Fixes grouping", () => {
    const msgs = buildMessages({
      commits: [makeCommit()],
      fromRef: "v1.0.0",
      toRef: "HEAD",
      includeDiffStat: false,
    });
    expect(msgs[0]!.content).toMatch(/features/i);
    expect(msgs[0]!.content).toMatch(/bug fix/i);
  });

  it("user message includes commit count", () => {
    const commits = [makeCommit(), makeCommit()];
    const msgs = buildMessages({
      commits,
      fromRef: "v1.0.0",
      toRef: "HEAD",
      includeDiffStat: false,
    });
    expect(msgs[1]!.content).toContain("2 commits");
  });

  it("user message uses singular 'commit' for 1 commit", () => {
    const msgs = buildMessages({
      commits: [makeCommit()],
      fromRef: "v1.0.0",
      toRef: "HEAD",
      includeDiffStat: false,
    });
    expect(msgs[1]!.content).toContain("1 commit");
    expect(msgs[1]!.content).not.toContain("1 commits");
  });
});
