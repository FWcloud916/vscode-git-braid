#!/usr/bin/env node
/**
 * scripts/vendor-native.mjs — Copy the napi loader + local *.node files into
 * <root>/native/ so require("../native") resolves in both the F5 Extension
 * Host and the packaged .vsix.
 *
 * Run automatically as part of `pnpm run build`.
 * In CI packaging: override the source dir if needed (env NAPI_SRC).
 */

import { readdirSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const src = process.env.NAPI_SRC ?? join(root, "bindings/napi");
const dst = join(root, "native");

mkdirSync(dst, { recursive: true });

// Loader (index.js: runtime binary picker — unchanged from bindings/napi/index.js)
copyFileSync(join(src, "index.js"), join(dst, "index.js"));

// Platform binary/binaries present in src/
let count = 0;
for (const file of readdirSync(src)) {
  if (file.endsWith(".node")) {
    copyFileSync(join(src, file), join(dst, file));
    count++;
  }
}

console.log(`vendor-native: loader + ${count} .node file(s) → native/`);
