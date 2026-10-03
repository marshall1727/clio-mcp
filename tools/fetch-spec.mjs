// SPDX-License-Identifier: Apache-2.0
/**
 * Downloads the OpenAPI description of the Clio Manage API v4 into spec/openapi.json.
 * The file is not committed (see .gitignore); run `npm run catalog` afterwards to regenerate
 * src/generated/catalog.json, which is what the server bundles.
 *
 *   node tools/fetch-spec.mjs [url-or-local-path]
 *
 * Default source: https://docs.developers.clio.com/openapi.json ("Download OpenAPI specification"
 * on https://docs.developers.clio.com/clio-manage/api-reference/). Override with CLIO_OPENAPI_URL.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const src = process.argv[2] || process.env.CLIO_OPENAPI_URL || "https://docs.developers.clio.com/openapi.json";
const out = path.join(ROOT, "spec", "openapi.json");

let text;
if (/^https?:\/\//.test(src)) {
  const res = await fetch(src, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  text = await res.text();
} else {
  text = fs.readFileSync(src, "utf8");
}
const spec = JSON.parse(text);
if (!spec.openapi || !spec.paths) throw new Error("The file is not an OpenAPI document.");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text);
console.log(`Saved ${out} (${(text.length / 1024 / 1024).toFixed(1)} MB, OpenAPI ${spec.openapi}, ${Object.keys(spec.paths).length} paths). Now run: npm run catalog`);
