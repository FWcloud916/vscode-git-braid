/**
 * Bounded-depth filesystem scan for nested/sibling git repositories.
 *
 * `resolveRepos()` in `extension.ts` only discovers a repo when a workspace
 * folder *is* one (or a subdirectory of one) — a folder that merely
 * *contains* several sibling repos (e.g. a `projects/` folder holding many
 * unrelated checkouts) yields nothing (see `docs/adr/0006` §"Known
 * limitation" and `docs/adr/0007`). `collectRepoRoots` fills that gap with a
 * bounded-depth downward scan.
 *
 * This module is intentionally free of VS Code API calls (mirrors the
 * convention in `src/ai/releaseNotes.ts`) so `collectRepoRoots` is
 * unit-testable without a running extension host — see `repoScan.test.ts`.
 * `extension.ts` wires it up with the real `fs`/`discoverRepo`
 * implementations exported below.
 */

import * as fs from "fs";
import * as path from "path";
import { discoverRepo } from "@git-braid/native";

/** Dependencies injected into {@link collectRepoRoots} for testability. */
export interface RepoScanDeps {
  /**
   * Return the canonical repo root if `dir` is (or resolves to) a git
   * repository, else `null`.
   */
  isRepoRoot(dir: string): string | null;
  /** Return the child directory paths to descend into (already filtered). */
  childDirs(dir: string): string[];
}

/**
 * Scan `roots` and their descendants, up to `maxDepth` levels deep, for git
 * repositories.
 *
 * - Stops descending as soon as a directory is identified as a repo — it
 *   does not recurse into a repo's internals or submodules.
 * - `maxDepth` counts levels below each entry in `roots` (the roots
 *   themselves are depth 0), so `maxDepth = 2` finds repos one level down
 *   (immediate children of a root) and two levels down (their children).
 * - Deduplicates by canonical root; caller order is preserved for first
 *   occurrences.
 */
export function collectRepoRoots(
  roots: string[],
  maxDepth: number,
  deps: RepoScanDeps,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  function add(root: string | null): void {
    if (root && !seen.has(root)) {
      seen.add(root);
      result.push(root);
    }
  }

  function scan(dir: string, depth: number): void {
    const root = deps.isRepoRoot(dir);
    if (root) {
      add(root);
      return;
    }
    if (depth >= maxDepth) return;
    for (const child of deps.childDirs(dir)) {
      scan(child, depth + 1);
    }
  }

  for (const r of roots) scan(r, 0);
  return result;
}

/** Directory names never descended into during a nested-repo scan. */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

/**
 * Real filesystem `childDirs` implementation: lists subdirectories, skipping
 * `node_modules`, `.git`, and dot-prefixed directories (e.g. `.vscode`,
 * `.cache`). Symlinked directories are skipped too — a `Dirent`'s type
 * reflects the link entry itself (not its target), so `isDirectory()` is
 * `false` for a symlink even when it points at a directory. This sidesteps
 * symlink cycles without extra bookkeeping.
 */
export function listChildDirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const children: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
    children.push(path.join(dir, entry.name));
  }
  return children;
}

/**
 * Real `isRepoRoot` implementation: a directory counts as a repo if it
 * directly contains a `.git` entry (a directory for a normal checkout, or a
 * file for a worktree checkout). The canonical root is then resolved via
 * `discoverRepo` (gitoxide, no subprocess) so worktree/bare edge cases match
 * the upward-discovery path used elsewhere in `extension.ts`.
 */
export function isRepoRoot(dir: string): string | null {
  try {
    if (!fs.existsSync(path.join(dir, ".git"))) return null;
  } catch {
    return null;
  }
  return discoverRepo(dir) ?? null;
}
