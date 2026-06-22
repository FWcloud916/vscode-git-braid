#!/usr/bin/env node
/**
 * esbuild build script for Git Braid.
 *
 * Two output bundles:
 *  1. dist/extension.js  — Extension host (Node.js, platform=node)
 *     `vscode` is marked external because it's provided by VS Code at runtime.
 *  2. dist/webview.js    — Webview UI (Browser, platform=browser)
 *     Has no access to Node APIs; communicates with the host via postMessage.
 *
 * Usage:
 *   node esbuild.mjs             # production build
 *   node esbuild.mjs --watch     # rebuild on changes (dev)
 */

import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");
const isProd  = !isWatch;

/** @type {import("esbuild").BuildOptions} */
const sharedOpts = {
  bundle: true,
  sourcemap: true,
  minify: isProd,
  logLevel: "info",
};

/** Extension host bundle — runs in VS Code's Node.js process */
const extensionBundle = {
  ...sharedOpts,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  // `vscode` is injected by the extension host; never bundle it.
  // `@git-braid/native` is a platform-native `.node` addon; require'd at runtime.
  external: ["vscode", "@git-braid/native"],
};

/** Webview bundle — runs in VS Code's sandboxed browser context */
const webviewBundle = {
  ...sharedOpts,
  entryPoints: ["web/index.ts"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
  globalName: "GitBraidWebview",
};

if (isWatch) {
  const [extCtx, webCtx] = await Promise.all([
    esbuild.context(extensionBundle),
    esbuild.context(webviewBundle),
  ]);
  await Promise.all([extCtx.watch(), webCtx.watch()]);
  console.log("Watching for changes…");
} else {
  await Promise.all([
    esbuild.build(extensionBundle),
    esbuild.build(webviewBundle),
  ]);
}
