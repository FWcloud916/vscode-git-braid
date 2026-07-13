/**
 * Tests for `collectRepoRoots` — the bounded-depth nested-repo scan.
 *
 * Uses a stubbed in-memory directory tree (no real filesystem, no
 * `discoverRepo` native call) so these run without a compiled `.node`
 * addon or a VS Code host — mirrors the injectable-deps pattern documented
 * in `repoScan.ts`.
 */

import { describe, it, expect } from "vitest";
import { collectRepoRoots, type RepoScanDeps } from "./repoScan";

/**
 * Build stub deps from a plain tree description.
 *
 * `tree` maps a directory path to its children (non-repo dirs) or to `null`
 * (a repo root — scanning stops there). Directories not present in `tree`
 * have no children (leaf, non-repo).
 */
function stubDeps(tree: Record<string, string[] | null>): RepoScanDeps {
  return {
    isRepoRoot: (dir) => (tree[dir] === null ? dir : null),
    childDirs: (dir) => tree[dir] ?? [],
  };
}

describe("collectRepoRoots", () => {
  it("finds a repo at the root itself (depth 0)", () => {
    const deps = stubDeps({ "/repo": null });
    expect(collectRepoRoots(["/repo"], 2, deps)).toEqual(["/repo"]);
  });

  it("finds sibling repos one level down (depth 1)", () => {
    const deps = stubDeps({
      "/projects": ["/projects/a", "/projects/b"],
      "/projects/a": null,
      "/projects/b": null,
    });
    expect(collectRepoRoots(["/projects"], 2, deps)).toEqual([
      "/projects/a",
      "/projects/b",
    ]);
  });

  it("finds repos two levels down but not three (respects maxDepth)", () => {
    const deps = stubDeps({
      "/projects": ["/projects/group"],
      "/projects/group": ["/projects/group/repo", "/projects/group/deep"],
      "/projects/group/repo": null,
      "/projects/group/deep": ["/projects/group/deep/hidden"],
      "/projects/group/deep/hidden": null,
    });
    // maxDepth = 2: /projects (0) -> group (1) -> repo (2) found;
    // deep (2) is not itself a repo and depth 2 >= maxDepth so its child
    // "hidden" (would be depth 3) is never reached.
    expect(collectRepoRoots(["/projects"], 2, deps)).toEqual([
      "/projects/group/repo",
    ]);
  });

  it("finds the depth-3 repo when maxDepth allows it", () => {
    const deps = stubDeps({
      "/projects": ["/projects/group"],
      "/projects/group": ["/projects/group/deep"],
      "/projects/group/deep": ["/projects/group/deep/hidden"],
      "/projects/group/deep/hidden": null,
    });
    expect(collectRepoRoots(["/projects"], 3, deps)).toEqual([
      "/projects/group/deep/hidden",
    ]);
  });

  it("stops descending once a directory is identified as a repo", () => {
    let calledOnRepoChild = false;
    const deps: RepoScanDeps = {
      isRepoRoot: (dir) => (dir === "/projects/repo" ? dir : null),
      childDirs: (dir) => {
        if (dir === "/projects/repo") {
          calledOnRepoChild = true;
          return ["/projects/repo/src"]; // should never be reached
        }
        if (dir === "/projects") return ["/projects/repo"];
        return [];
      },
    };
    collectRepoRoots(["/projects"], 4, deps);
    expect(calledOnRepoChild).toBe(false);
  });

  it("dedups repos reached via multiple roots", () => {
    const deps = stubDeps({ "/repo": null });
    // Same repo passed twice as a root (e.g. two workspace folders resolving
    // to the same place).
    expect(collectRepoRoots(["/repo", "/repo"], 2, deps)).toEqual(["/repo"]);
  });

  it("returns an empty array when nothing is found", () => {
    const deps = stubDeps({ "/empty": ["/empty/a"], "/empty/a": [] });
    expect(collectRepoRoots(["/empty"], 2, deps)).toEqual([]);
  });

  it("depth 0 only checks the root, never its children", () => {
    let childDirsCalled = false;
    const deps: RepoScanDeps = {
      isRepoRoot: () => null,
      childDirs: () => {
        childDirsCalled = true;
        return [];
      },
    };
    collectRepoRoots(["/solo"], 0, deps);
    expect(childDirsCalled).toBe(false);
  });
});
