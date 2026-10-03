/**
 * Clio API v4 catalog generated from OpenAPI (tools/gen-catalog.mjs) – endpoint lookup and request validation.
 */
import catalogJson from "./generated/catalog.json" with { type: "json" };
import { t } from "./i18n.js";

export interface Field {
  name: string;
  type: string;
  required?: boolean;
  desc?: string;
  fields?: Field[];
}
export interface Param {
  name: string;
  in: "query" | "path";
  type: string;
  required?: boolean;
  desc?: string;
}
export interface Op {
  id: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string; // e.g. /matters/{id}
  tag?: string;
  summary?: string;
  params?: Param[];
  body?: Field[];
  response?: { schema: string; list: boolean };
}
interface Catalog {
  generated_at: string;
  source: string;
  ops: Op[];
  schemas: Record<string, Field[]>;
  tags: Record<string, string>;
}

export const catalog = catalogJson as unknown as Catalog;

/** Normalizes a path: strips the base URL, query string, .json suffix and trailing slash. */
export function normalizePath(input: string): string {
  let p = input.trim();
  try {
    if (/^https?:\/\//i.test(p)) {
      const u = new URL(p);
      p = u.pathname;
    }
  } catch {
    /* keep as is */
  }
  p = p.split("?")[0];
  p = p.replace(/^\/api\/v4/, "");
  p = p.replace(/\.json$/, "");
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

function templateToRegex(tpl: string): RegExp {
  const re = tpl.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === "{" || m === "}" ? m : "\\" + m)).replace(/\{[^}]+\}/g, "([^/]+)");
  return new RegExp("^" + re + "$");
}

const compiled = catalog.ops.map((op) => ({ op, re: templateToRegex(op.path) }));

/** Finds the operation for a method and a concrete path (e.g. GET /matters/123). */
export function matchOp(method: string, path: string): { op: Op; pathParams: string[] } | undefined {
  const p = normalizePath(path);
  const m = method.toUpperCase();
  // paths without parameters (exact match) take precedence
  const exact = compiled.find((c) => c.op.method === m && c.op.path === p);
  if (exact) return { op: exact.op, pathParams: [] };
  for (const c of compiled) {
    if (c.op.method !== m) continue;
    const mm = c.re.exec(p);
    if (mm) return { op: c.op, pathParams: mm.slice(1) };
  }
  return undefined;
}

/** Returns all methods available for the given path. */
export function methodsForPath(path: string): string[] {
  const p = normalizePath(path);
  const out = new Set<string>();
  for (const c of compiled) if (c.op.path === p || c.re.test(p)) out.add(c.op.method);
  return [...out];
}

/** Full-text search over id, path, tag and summary; returns results sorted by score. */
export function searchOps(query: string, limit = 25): Op[] {
  const terms = query
    .toLowerCase()
    .split(/[\s,;/]+/)
    .filter(Boolean);
  if (!terms.length) return catalog.ops.slice(0, limit);
  const scored = catalog.ops
    .map((op) => {
      const hay = `${op.id} ${op.path} ${op.tag ?? ""} ${op.summary ?? ""}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (op.path.toLowerCase().includes(term)) score += 3;
        if ((op.tag ?? "").toLowerCase().includes(term)) score += 2;
        if (hay.includes(term)) score += 1;
      }
      return { op, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.op.path.localeCompare(b.op.path) || a.op.method.localeCompare(b.op.method));
  return scored.slice(0, limit).map((x) => x.op);
}

export function schemaFields(name: string): Field[] | undefined {
  return catalog.schemas[name];
}

/** Checks the `fields` parameter against the response schema (1 level of nesting). */
export function validateFieldsParam(op: Op, fields: string): string[] {
  const warnings: string[] = [];
  if (!op.response) return warnings;
  const top = schemaFields(op.response.schema);
  if (!top) return warnings;
  // parses "a,b{c,d},e"
  const items: { name: string; nested?: string[] }[] = [];
  let i = 0;
  while (i < fields.length) {
    let j = i;
    while (j < fields.length && fields[j] !== "," && fields[j] !== "{") j++;
    const name = fields.slice(i, j).trim();
    let nested: string[] | undefined;
    if (fields[j] === "{") {
      const k = fields.indexOf("}", j);
      nested = fields
        .slice(j + 1, k < 0 ? fields.length : k)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      j = k < 0 ? fields.length : k + 1;
    }
    if (name) items.push({ name, nested });
    i = j + 1;
  }
  for (const it of items) {
    const f = top.find((x) => x.name === it.name);
    if (!f) {
      warnings.push(t("runtime.field_not_in_schema", { field: it.name, schema: op.response.schema }));
      continue;
    }
    if (it.nested) {
      const nestedSchema = schemaFields(f.type.replace(/^array<(.+)>$/, "$1")) ?? f.fields;
      if (nestedSchema) {
        for (const n of it.nested) {
          if (!nestedSchema.find((x) => x.name === n)) warnings.push(t("runtime.nested_field_not_in_schema", { field: `${it.name}{${n}}` }));
        }
      }
    }
  }
  return warnings;
}

export interface Validation {
  op?: Op;
  errors: string[];
  warnings: string[];
}

export function validateRequest(method: string, path: string, query?: Record<string, unknown>, body?: Record<string, unknown>): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const m = matchOp(method, path);
  if (!m) {
    const others = methodsForPath(path);
    if (others.length) errors.push(t("runtime.endpoint_method_unsupported", { path: normalizePath(path), method: method.toUpperCase(), methods: others.join(", ") }));
    else errors.push(t("runtime.endpoint_not_found", { path: normalizePath(path) }));
    return { errors, warnings };
  }
  const op = m.op;
  const known = new Set((op.params ?? []).map((p) => p.name));
  for (const k of Object.keys(query ?? {})) {
    if (!known.has(k) && !known.has(k + "[]")) warnings.push(t("runtime.query_param_undocumented", { param: k, op: op.id }));
  }
  for (const p of op.params ?? []) {
    if (p.required && p.in === "query" && !(query && p.name in query)) errors.push(t("runtime.query_param_required", { param: p.name }));
  }
  if (typeof query?.fields === "string") warnings.push(...validateFieldsParam(op, query.fields));
  if (body && op.body) {
    const knownBody = new Set(op.body.map((f) => f.name));
    for (const k of Object.keys(body)) if (!knownBody.has(k)) warnings.push(t("runtime.body_field_undocumented", { field: k, op: op.id }));
    for (const f of op.body) if (f.required && !(f.name in body)) errors.push(t("runtime.body_field_required", { field: f.name }));
  }
  if ((op.method === "POST" || op.method === "PATCH") && op.body && !body) warnings.push(t("runtime.body_missing"));
  return { op, errors, warnings };
}

/** Textual description of an operation for Claude. */
export function describeOp(op: Op, opts: { fields?: boolean } = { fields: true }): string {
  const lines: string[] = [];
  lines.push(`${op.method} /api/v4${op.path}  [${op.id}]${op.tag ? `  (${op.tag})` : ""}`);
  if (op.summary) lines.push(`  ${op.summary}`);
  const q = (op.params ?? []).filter((p) => p.in === "query");
  if (q.length) {
    lines.push(`  ${t("runtime.describe_query_params")}`);
    for (const p of q) lines.push(`    - ${p.name}${p.required ? "*" : ""} (${p.type})${p.desc ? `: ${p.desc}` : ""}`);
  }
  if (op.body?.length) {
    lines.push(`  ${t("runtime.describe_body")}`);
    for (const f of op.body) {
      lines.push(`    - ${f.name}${f.required ? "*" : ""} (${f.type})${f.desc ? `: ${f.desc}` : ""}`);
      if (f.fields) for (const sub of f.fields.slice(0, 12)) lines.push(`        · ${sub.name}${sub.required ? "*" : ""} (${sub.type})${sub.desc ? `: ${sub.desc.slice(0, 80)}` : ""}`);
    }
  }
  if (op.response && opts.fields) {
    const fs = schemaFields(op.response.schema) ?? [];
    lines.push(`  ${t("runtime.describe_response", { list: op.response.list ? t("runtime.describe_response_list") : "", schema: op.response.schema })}`);
    lines.push("    " + fs.map((f) => (f.type.match(/^[A-Z]/) || f.type.startsWith("array<") ? `${f.name}{…}` : f.name)).join(", "));
  }
  return lines.join("\n");
}
