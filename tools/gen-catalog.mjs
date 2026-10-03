// SPDX-License-Identifier: Apache-2.0
/**
 * Generates the compact Clio API v4 catalog from the OpenAPI description.
 * Input: spec/openapi.json (npm run fetch-spec)  Output: src/generated/catalog.json (bundled into the server).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "spec/openapi.json"), "utf8"));
const S = spec.components.schemas;

const short = (s, n = 160) => (s ? String(s).replace(/\s+/g, " ").trim().slice(0, n) : undefined);
const refName = (r) => (r ? r.split("/").pop() : undefined);

function resolve(schema) {
  if (!schema) return schema;
  if (schema.$ref) return resolve(S[refName(schema.$ref)]);
  return schema;
}

/** Sloučí allOf a vrátí {properties, required} */
function flatten(schema, depth = 0) {
  const out = { properties: {}, required: [] };
  if (!schema || depth > 6) return out;
  if (schema.$ref) return flatten(S[refName(schema.$ref)], depth + 1);
  if (schema.allOf) for (const part of schema.allOf) {
    const f = flatten(part, depth + 1);
    Object.assign(out.properties, f.properties);
    out.required.push(...f.required);
  }
  if (schema.properties) Object.assign(out.properties, schema.properties);
  if (schema.required) out.required.push(...schema.required);
  return out;
}

function typeOf(p) {
  if (!p) return "any";
  if (p.$ref) return refName(p.$ref);
  if (p.type === "array") return `array<${typeOf(p.items)}>`;
  if (p.type === "object" && p.properties) return "object";
  if (p.enum) return `enum(${p.enum.slice(0, 8).join("|")}${p.enum.length > 8 ? "|…" : ""})`;
  return (p.type || "any") + (p.format ? `:${p.format}` : "");
}

function fieldsOf(schema) {
  const f = flatten(schema);
  const req = new Set(f.required);
  return Object.entries(f.properties).map(([name, p]) => {
    const e = { name, type: typeOf(p) };
    if (req.has(name)) e.required = true;
    const d = short(p.description, 120);
    if (d) e.desc = d;
    if (p.type === "object" && p.properties) e.fields = fieldsOf(p);
    if (p.type === "array" && p.items && p.items.type === "object" && p.items.properties) e.fields = fieldsOf(p.items);
    return e;
  });
}

// --- schémata (jen ta, na která se odkazují odpovědi/těla) ---
const usedSchemas = new Set();
function markSchema(name) {
  if (!name || usedSchemas.has(name) || !S[name]) return;
  usedSchemas.add(name);
  const f = flatten(S[name]);
  for (const p of Object.values(f.properties)) {
    if (p.$ref) markSchema(refName(p.$ref));
    if (p.items?.$ref) markSchema(refName(p.items.$ref));
  }
}

const ops = [];
for (const [rawPath, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!["get", "post", "patch", "put", "delete"].includes(method)) continue;
    const p = rawPath.replace(/\.json$/, "");
    const params = (op.parameters || [])
      .filter((x) => x.in !== "header")
      .map((x) => {
        const e = { name: x.name, in: x.in, type: typeOf(x.schema) };
        if (x.required) e.required = true;
        const d = short(x.description, 140);
        if (d) e.desc = d;
        return e;
      });
    let body;
    const rb = op.requestBody?.content;
    if (rb) {
      const c = rb["application/json"] || Object.values(rb)[0];
      const data = c?.schema?.properties?.data;
      if (data) body = fieldsOf(data);
    }
    let response;
    const ok = op.responses?.["200"] || op.responses?.["201"];
    const rc = ok?.content && Object.values(ok.content)[0];
    if (rc?.schema) {
      const wrapper = resolve(rc.schema);
      const dataProp = wrapper?.properties?.data;
      let itemSchemaName;
      if (dataProp?.$ref) itemSchemaName = refName(dataProp.$ref);
      else if (dataProp?.type === "array" && dataProp.items?.$ref) itemSchemaName = refName(dataProp.items.$ref);
      if (itemSchemaName) {
        markSchema(itemSchemaName);
        response = { schema: itemSchemaName, list: dataProp.type === "array" };
      }
    }
    const e = {
      id: op.operationId,
      method: method.toUpperCase(),
      path: p,
      tag: op.tags?.[0],
      summary: short(op.summary, 120),
    };
    if (params.length) e.params = params;
    if (body) e.body = body;
    if (response) e.response = response;
    ops.push(e);
  }
}

const schemas = {};
for (const name of usedSchemas) schemas[name] = fieldsOf(S[name]);

const tags = {};
for (const t of spec.tags || []) tags[t.name] = short(t.description, 400);

const catalog = {
  generated_at: new Date().toISOString(),
  source: "https://docs.developers.clio.com/openapi.json",
  openapi: spec.openapi,
  ops,
  schemas,
  tags,
};

fs.mkdirSync(path.join(ROOT, "src/generated"), { recursive: true });
const outFile = path.join(ROOT, "src/generated/catalog.json");
fs.writeFileSync(outFile, JSON.stringify(catalog));
console.log(`catalog: ${ops.length} ops, ${Object.keys(schemas).length} schemas, ${(fs.statSync(outFile).size / 1024).toFixed(0)} kB`);
