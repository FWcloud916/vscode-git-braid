/**
 * @git-braid/native — native napi-rs addon loader.
 *
 * This file is overwritten by `napi build` / `napi build --platform`.
 * It exists as a stub so the workspace package resolves before the
 * native addon is built.
 *
 * To build the real addon:
 *   pnpm run build:napi:debug   # debug, current platform
 *   pnpm run build:napi         # release, current platform
 */

/* eslint-disable */
const { existsSync } = require("fs");
const { join } = require("path");

const candidates = [
  join(__dirname, "git-braid-native.darwin-arm64.node"),
  join(__dirname, "git-braid-native.darwin-x64.node"),
  join(__dirname, "git-braid-native.linux-x64-gnu.node"),
  join(__dirname, "git-braid-native.win32-x64-msvc.node"),
];

let nativeAddon;
for (const p of candidates) {
  if (existsSync(p)) {
    nativeAddon = require(p);
    break;
  }
}

if (!nativeAddon) {
  // Provide graceful error so VS Code shows a clear message instead of crashing.
  const notBuilt = () => {
    throw new Error(
      "@git-braid/native: native addon not found. " +
        "Run `pnpm run build:napi:debug` to build it.",
    );
  };
  nativeAddon = { getGraphBatch: notBuilt, getCommitDetail: notBuilt };
}

module.exports = nativeAddon;
