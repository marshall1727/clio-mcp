// SPDX-License-Identifier: Apache-2.0
/** Verifies that every locale has the same keys and placeholders as English and that all t("…") keys used in src exist. */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");
const locDir = path.join(ROOT, "src/locales");
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const placeholders = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
let errors = 0;
const en = {};
for (const f of fs.readdirSync(path.join(locDir, "en"))) Object.assign(en, read(path.join(locDir, "en", f)));
for (const loc of fs.readdirSync(locDir).filter((d) => d !== "en")) {
  const cat = {};
  for (const f of fs.readdirSync(path.join(locDir, loc))) Object.assign(cat, read(path.join(locDir, loc, f)));
  for (const k of Object.keys(en)) {
    if (!(k in cat)) { console.error(`[${loc}] missing key ${k}`); errors++; continue; }
    const a = placeholders(en[k]), b = placeholders(cat[k]);
    if ([...a].some((x) => !b.has(x)) || [...b].some((x) => !a.has(x))) { console.error(`[${loc}] placeholder mismatch in ${k}`); errors++; }
  }
  for (const k of Object.keys(cat)) if (!(k in en)) { console.error(`[${loc}] extra key ${k}`); errors++; }
}
const used = new Set();
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".ts")) for (const m of fs.readFileSync(p, "utf8").matchAll(/\bt\("([a-z_]+\.[a-z0-9_]+)"/g)) used.add(m[1]); } };
walk(path.join(ROOT, "src"));
for (const k of used) if (!(k in en)) { console.error(`used but undefined: ${k}`); errors++; }
for (const k of Object.keys(en)) if (!used.has(k)) console.warn(`defined but unused: ${k}`);
console.log(`${Object.keys(en).length} keys, ${used.size} used, ${errors} error(s)`);
process.exit(errors ? 1 : 0);
