// SPDX-License-Identifier: Apache-2.0
/**
 * Builds the server and packs the Desktop Extension (.mcpb) for Windows x64:
 *   dist/index.js → pkg/server/index.js
 *   @napi-rs/canvas (+ win32-x64 binary) → pkg/node_modules (native PDF/image rendering)
 *   npx @anthropic-ai/mcpb pack pkg release/clio-mcp-<version>.mcpb
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: "inherit" });

run("npm run build");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "pkg/manifest.json"), "utf8"));
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (manifest.version !== pkgJson.version) throw new Error(`Version mismatch: manifest ${manifest.version} vs package.json ${pkgJson.version}`);

fs.mkdirSync(path.join(ROOT, "pkg/server"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "dist/index.js"), path.join(ROOT, "pkg/server/index.js"));

const nativeDir = path.join(ROOT, "pkg/node_modules/@napi-rs");
fs.rmSync(nativeDir, { recursive: true, force: true });
fs.mkdirSync(nativeDir, { recursive: true });
for (const name of ["canvas", "canvas-win32-x64-msvc"]) {
  const from = path.join(ROOT, "node_modules/@napi-rs", name);
  if (!fs.existsSync(from)) throw new Error(`Missing ${from} – run npm install on Windows x64 (or install @napi-rs/canvas-win32-x64-msvc explicitly).`);
  fs.cpSync(from, path.join(nativeDir, name), { recursive: true });
}

fs.mkdirSync(path.join(ROOT, "release"), { recursive: true });
const out = path.join(ROOT, "release", `clio-mcp-${manifest.version}.mcpb`);
run(`npx --yes @anthropic-ai/mcpb pack pkg "${out}"`);
console.log(`Packed ${out}`);
