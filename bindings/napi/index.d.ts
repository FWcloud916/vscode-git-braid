/**
 * Type declarations for the @git-braid/native napi-rs addon.
 *
 * This file is **hand-written** to bootstrap TypeScript compilation before
 * `napi build` is run. `napi build` will overwrite it with auto-generated
 * declarations derived from the Rust `#[napi]` attributes.
 *
 * If you add or rename an `#[napi]` export in `bindings/napi/src/lib.rs`,
 * update this file manually until you have run `napi build` at least once.
 */

/**
 * Request a batch of commit graph rows from the Rust core.
 *
 * @param repoPath - Absolute path to the git worktree or `.git` directory.
 * @param offset   - Number of commits already loaded (incremental paging).
 * @param limit    - Maximum number of commits to return.
 * @returns A Node.js `Buffer` containing the binary-encoded RowLayout batch
 *          (BRAI v1 wire format, see `crates/core/src/serialize.rs`).
 */
export declare function getGraphBatch(repoPath: string, offset: number, limit: number): Buffer;
