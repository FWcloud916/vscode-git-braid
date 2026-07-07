/**
 * Git write operations — Phase 2.
 *
 * All write operations shell out to the `git` CLI via `child_process.spawn`.
 *
 * # Rationale (plan §3.2 — read/write split)
 *
 * Write operations (checkout, merge, rebase, cherry-pick, …) are
 * correctness-critical and involve many edge cases: hooks, submodules, partial
 * staging, config interaction. Delegating to the official `git` binary is
 * safer than reimplementing these in a library.
 *
 * The Rust core handles the **read path only** (log walk + layout) where
 * performance matters. This module handles the **write path**, where
 * correctness and user-friendly error messages matter more than speed.
 *
 * # Status
 *
 * Phase 2 in progress. Implemented operations are in the "Implemented write
 * operations" section; remaining stubs still throw `NotImplemented`.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class NotImplementedError extends Error {
  constructor(operation: string) {
    super(`${operation} is not yet implemented (Phase 2)`);
    this.name = "NotImplementedError";
  }
}

/** Run a raw `git` command in the given working directory. */
export async function runGit(
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", [...args], { cwd });
}

// ── Error classification ────────────────────────────────────────────────────

/**
 * Returns `true` when git's stderr/stdout contains conflict markers.
 *
 * A conflict is an **expected, non-fatal** outcome for `merge`, `cherry-pick`,
 * and `rebase` — it should be surfaced as a warning modal, not a red error
 * toast. Separating classification from UI keeps this testable without VS Code.
 */
export function isConflictError(output: string): boolean {
  return /CONFLICT|conflict|fix conflicts|needs merge/i.test(output);
}

// ── Implemented write operations ────────────────────────────────────────────

export async function checkout(ref: string, cwd: string): Promise<void> {
  await runGit(["checkout", ref], cwd);
}

/**
 * Check out a remote-tracking branch (e.g. "origin/feature") by creating a
 * local branch that tracks it, then switching to that local branch.
 *
 * Uses explicit `--track <remoteRef>` (rather than `git checkout <name>`
 * DWIM) so multi-remote repos with a same-named branch on two remotes are
 * unambiguous. If a local branch of the derived name already exists, falls
 * back to switching to it (matches git's own DWIM behaviour).
 */
export async function checkoutRemote(remoteRef: string, cwd: string): Promise<void> {
  const slash = remoteRef.indexOf("/");
  const local = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
  try {
    await runGit(["checkout", "-b", local, "--track", remoteRef], cwd);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/already exists/i.test(text)) {
      await runGit(["checkout", local], cwd);
      return;
    }
    throw err;
  }
}

// ── Phase 2 stubs ──────────────────────────────────────────────────────────

export async function createBranch(name: string, from: string, cwd: string): Promise<void> {
  // Create only — no auto-checkout. Keeps the working tree undisturbed.
  await runGit(["branch", name, from], cwd);
}

/**
 * Delete a local branch.
 *
 * `force: false` (default) uses `-d` (safe: refuses unmerged branches).
 * `force: true` uses `-D` (force-delete regardless of merge status).
 * The caller is responsible for confirming force-delete with the user.
 */
export async function deleteBranch(name: string, cwd: string, force = false): Promise<void> {
  await runGit(["branch", force ? "-D" : "-d", name], cwd);
}

export async function merge(ref: string, cwd: string): Promise<void> {
  await runGit(["merge", ref], cwd);
}

export async function rebase(onto: string, cwd: string): Promise<void> {
  await runGit(["rebase", onto], cwd);
}

export async function cherryPick(oid: string, cwd: string): Promise<void> {
  await runGit(["cherry-pick", oid], cwd);
}

export async function revert(oid: string, cwd: string): Promise<void> {
  // --no-edit: commit the revert immediately without opening the editor.
  await runGit(["revert", "--no-edit", oid], cwd);
}

export async function createTag(name: string, oid: string, cwd: string): Promise<void> {
  // Lightweight tag (no annotation). Use `git tag -a` for annotated — Phase 3+.
  await runGit(["tag", name, oid], cwd);
}

export async function deleteTag(name: string, cwd: string): Promise<void> {
  await runGit(["tag", "-d", name], cwd);
}

// ── Reset operations ────────────────────────────────────────────────────────

export async function resetSoft(oid: string, cwd: string): Promise<void> {
  await runGit(["reset", "--soft", oid], cwd);
}

export async function resetMixed(oid: string, cwd: string): Promise<void> {
  await runGit(["reset", "--mixed", oid], cwd);
}

export async function resetHard(oid: string, cwd: string): Promise<void> {
  await runGit(["reset", "--hard", oid], cwd);
}

// ── Remote operations ───────────────────────────────────────────────────────

/**
 * Fetch from all remotes, pruning stale remote-tracking branches.
 *
 * Follows the write-path convention: shells out to the `git` CLI so that
 * credential helpers, SSH agents, and git config (core.sshCommand, etc.) are
 * all honoured without reimplementing them.
 */
export async function fetch(cwd: string): Promise<void> {
  await runGit(["fetch", "--all", "--prune"], cwd);
}

// ── Stash operations ────────────────────────────────────────────────────────

export async function stashApply(stashRef: string, cwd: string): Promise<void> {
  await runGit(["stash", "apply", stashRef], cwd);
}

export async function stashPop(stashRef: string, cwd: string): Promise<void> {
  await runGit(["stash", "pop", stashRef], cwd);
}

export async function stashDrop(stashRef: string, cwd: string): Promise<void> {
  await runGit(["stash", "drop", stashRef], cwd);
}
