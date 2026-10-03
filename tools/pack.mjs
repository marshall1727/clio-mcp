// SPDX-License-Identifier: Apache-2.0
/**
 * Builds the server and packs the Desktop Extension (.mcpb) for Windows x64:
 *   type-check (tsc) → bundle (esbuild) → dist/index.js → pkg/server/index.js
 *   @napi-rs/canvas (+ win32-x64 binary) → pkg/node_modules (native PDF/image rendering)
 *   mcpb pack pkg → release/clio-mcp-<version>.mcpb
 *
 * Everything is spawned through the current Node binary (no shell), so it works even where
 * cmd.exe / PowerShell script execution is restricted.
 * CLIO_PACK_ALLOW_MISSING_NATIVE=1 skips the native module (CI / non-Windows smoke builds only).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");
const node = (script, ...args) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\nFailed: node ${path.relative(ROOT, script)} ${args.join(" ")} (exit ${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
};

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "pkg/manifest.json"), "utf8"));
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (manifest.version !== pkgJson.version) throw new Error(`Version mismatch: manifest ${manifest.version} vs package.json ${pkgJson.version}`);

console.log("1/4 type-check");
node(path.join(ROOT, "node_modules/typescript/bin/tsc"), "--noEmit");
console.log("2/4 bundle");
node(path.join(ROOT, "build.mjs"));

console.log("3/4 assemble pkg/");
fs.mkdirSync(path.join(ROOT, "pkg/server"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "dist/index.js"), path.join(ROOT, "pkg/server/index.js"));
const nativeDir = path.join(ROOT, "pkg/node_modules/@napi-rs");
fs.rmSync(path.join(ROOT, "pkg/node_modules"), { recursive: true, force: true });
fs.mkdirSync(nativeDir, { recursive: true });
for (const name of ["canvas", "canvas-win32-x64-msvc"]) {
  const from = path.join(ROOT, "node_modules/@napi-rs", name);
  if (!fs.existsSync(from)) {
    if (process.env.CLIO_PACK_ALLOW_MISSING_NATIVE) {
      console.warn(`   skipping ${name} (CLIO_PACK_ALLOW_MISSING_NATIVE set) – scanned PDFs/images will not render in this build`);
      continue;
    }
    throw new Error(`Missing ${from}. Run "npm install" on Windows x64, or "npm install @napi-rs/canvas-win32-x64-msvc" explicitly.`);
  }
  fs.cpSync(from, path.join(nativeDir, name), { recursive: true });
}

console.log("4/4 mcpb pack");
fs.mkdirSync(path.join(ROOT, "release"), { recursive: true });
const out = path.join(ROOT, "release", `clio-mcp-${manifest.version}.mcpb`);
node(path.join(ROOT, "node_modules/@anthropic-ai/mcpb/dist/cli/cli.js"), "pack", path.join(ROOT, "pkg"), out);
console.log(`\nPacked ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
