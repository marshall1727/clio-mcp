// SPDX-License-Identifier: Apache-2.0
import { build } from "esbuild";
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  external: ["@napi-rs/canvas"],
  outfile: "dist/index.js",
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  sourcemap: false,
  minify: false,
  legalComments: "none",
});
console.log("built dist/index.js");
