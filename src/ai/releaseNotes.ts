/**
 * Release-notes generation — prompt builder + provider call.
 *
 * This module is intentionally free of VS Code API calls so that
 * `buildMessages` is unit-testable without a running extension host.
 *
 * Data-flow:
 *   walkRange (Rust/gitoxide) → RangeCommit[] → buildMessages → AIProvider.complete → Markdown string
 *
 * Privacy levels (plan §7.3):
 *   - Metadata-only (default): commit subject + author.
 *   - +Diff stat: also include files changed and +/- line counts (approximate).
 *
 * The caller (`releaseNotesCommand.ts`) is responsible for obtaining explicit
 * consent before calling `generateReleaseNotes`.
 */

import type { RangeCommit } from "@git-braid/native";
import type { AIMessage, AIProvider } from "./provider";

// ── Input type ────────────────────────────────────────────────────────────────

export interface ReleaseNotesInput {
  /** Commits in the range, newest-first (from `walkRange`). */
  commits: RangeCommit[];
  /** The `from` ref label (e.g. `"v1.0.0"`), or `null` for full history. */
  fromRef: string | null;
  /** The `to` ref label (e.g. `"HEAD"` or `"v1.1.0"`). */
  toRef: string;
  /** Whether diffstat fields (`filesChanged`, `insertions`, `deletions`) are populated. */
  includeDiffStat: boolean;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Build the AI messages for release-notes generation.
 *
 * Exported separately so it can be unit-tested without a live AI provider.
 */
export function buildMessages(input: ReleaseNotesInput): AIMessage[] {
  const { commits, fromRef, toRef, includeDiffStat } = input;

  const rangeLabel = fromRef ? `${fromRef}..${toRef}` : toRef;

  const systemPrompt = `\
You are a technical writer generating concise, user-friendly release notes.

Given a list of git commits, produce a Markdown document with:
1. A level-2 heading: \`## Release notes — ${rangeLabel}\`
2. Three sections (omit any section with no relevant commits):
   - **Features** — commits whose subject starts with \`feat:\` or \`feat(\`
   - **Bug Fixes** — commits whose subject starts with \`fix:\` or \`fix(\`
   - **Other Changes** — all remaining commits
3. Each commit as a bullet: \`- <subject> (<author>)\`${
    includeDiffStat
      ? "\n4. After each bullet, if the commit has a non-zero filesChanged, add a parenthetical: `[N files, +I/-D lines]`"
      : ""
  }

Rules:
- Strip the conventional-commit prefix (e.g. "feat: " → just the description).
- Keep sentences short and factual.
- Do not invent information not present in the commit list.
- Output only the Markdown document; no preamble or explanation.`;

  const commitLines = commits.map((c) => {
    let line = `- ${c.subject} (${c.authorName})`;
    if (includeDiffStat && c.filesChanged > 0) {
      line += ` [${c.filesChanged} file${c.filesChanged === 1 ? "" : "s"}, +${c.insertions}/-${c.deletions}]`;
    }
    return line;
  });

  const userPrompt = `\
Generate release notes for the following ${commits.length} commit${commits.length === 1 ? "" : "s"} in the range \`${rangeLabel}\`:

${commitLines.join("\n")}`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

// ── Generator ─────────────────────────────────────────────────────────────────

/**
 * Generate release notes using the provided AI provider.
 *
 * Returns the raw Markdown string from the model. The caller is responsible
 * for displaying it to the user.
 *
 * @throws If the provider call fails.
 */
export async function generateReleaseNotes(
  provider: AIProvider,
  input: ReleaseNotesInput,
): Promise<string> {
  const messages = buildMessages(input);
  const completion = await provider.complete(messages);
  return completion.text;
}
