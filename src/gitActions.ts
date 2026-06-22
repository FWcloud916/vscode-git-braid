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
 * **Stub** — Phase 2 implementation target.
 * Every exported function currently throws `NotImplemented`.
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

// ── Phase 2 stubs ──────────────────────────────────────────────────────────

export async function checkout(_ref: string, _cwd: string): Promise<void> {
  throw new NotImplementedError("checkout");
}

export async function createBranch(_name: string, _from: string, _cwd: string): Promise<void> {
  throw new NotImplementedError("createBranch");
}

export async function deleteBranch(_name: string, _cwd: string): Promise<void> {
  throw new NotImplementedError("deleteBranch");
}

export async function merge(_ref: string, _cwd: string): Promise<void> {
  throw new NotImplementedError("merge");
}

export async function rebase(_onto: string, _cwd: string): Promise<void> {
  throw new NotImplementedError("rebase");
}

export async function cherryPick(_oid: string, _cwd: string): Promise<void> {
  throw new NotImplementedError("cherryPick");
}

export async function revert(_oid: string, _cwd: string): Promise<void> {
  throw new NotImplementedError("revert");
}

export async function createTag(_name: string, _oid: string, _cwd: string): Promise<void> {
  throw new NotImplementedError("createTag");
}

export async function deleteTag(_name: string, _cwd: string): Promise<void> {
  throw new NotImplementedError("deleteTag");
}

export async function stashPop(_cwd: string): Promise<void> {
  throw new NotImplementedError("stashPop");
}
