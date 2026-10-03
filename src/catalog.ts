/**
 * Katalog Clio API v4 vygenerovaný z OpenAPI (tools/gen-catalog.mjs) – vyhledávání endpointů a validace požadavků.
 */
import catalogJson from "./generated/catalog.json" with { type: "json" };

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
  path: string; // např. /matters/{id}
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

/** Normalizuje cestu: odstraní base URL, query, příponu .json, koncové lomítko. */
export function normalizePath(input: string): string {
  let p = input.trim();
  try {
    if (/^https?:\/\//i.test(p)) {
      const u = new URL(p);
      p = u.pathname;
    }
  } catch {
    /* ponecháme */
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

/** Najde operaci podle metody a konkrétní cesty (např. GET /matters/123). */
export function matchOp(method: string, path: string): { op: Op; pathParams: string[] } | undefined {
  const p = normalizePath(path);
  const m = method.toUpperCase();
  // přednost mají cesty bez parametrů (přesná shoda)
  const exact = compiled.find((c) => c.op.method === m && c.op.path === p);
  if (exact) return { op: exact.op, pathParams: [] };
  for (const c of compiled) {
    if (c.op.method !== m) continue;
    const mm = c.re.exec(p);
    if (mm) return { op: c.op, pathParams: mm.slice(1) };
  }
  return undefined;
}

/** Vrátí všechny metody dostupné pro danou cestu. */
export function methodsForPath(path: string): string[] {
  const p = normalizePath(path);
  const out = new Set<string>();
  for (const c of compiled) if (c.op.path === p || c.re.test(p)) out.add(c.op.method);
  return [...out];
}

/** Fulltext nad id, cestou, tagem a summary; vrací seřazené podle skóre. */
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
      for (const t of terms) {
        if (op.path.toLowerCase().includes(t)) score += 3;
        if ((op.tag ?? "").toLowerCase().includes(t)) score += 2;
        if (hay.includes(t)) score += 1;
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

/** Zkontroluje zápis parametru `fields` proti schématu odpovědi (1 úroveň vnoření). */
export function validateFieldsParam(op: Op, fields: string): string[] {
  const warnings: string[] = [];
  if (!op.response) return warnings;
  const top = schemaFields(op.response.schema);
  if (!top) return warnings;
  // rozparsuje "a,b{c,d},e"
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
      warnings.push(`Pole '${it.name}' není ve schématu ${op.response.schema} (API vrátí 400).`);
      continue;
    }
    if (it.nested) {
      const nestedSchema = schemaFields(f.type.replace(/^array<(.+)>$/, "$1")) ?? f.fields;
      if (nestedSchema) {
        for (const n of it.nested) {
          if (!nestedSchema.find((x) => x.name === n)) warnings.push(`Vnořené pole '${it.name}{${n}}' není ve schématu.`);
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
    if (others.length) errors.push(`Endpoint ${normalizePath(path)} nepodporuje metodu ${method.toUpperCase()}; dostupné: ${others.join(", ")}.`);
    else errors.push(`Endpoint ${normalizePath(path)} v Clio API v4 neexistuje. Použijte clio_describe_api pro vyhledání správné cesty.`);
    return { errors, warnings };
  }
  const op = m.op;
  const known = new Set((op.params ?? []).map((p) => p.name));
  for (const k of Object.keys(query ?? {})) {
    if (!known.has(k) && !known.has(k + "[]")) warnings.push(`Query parametr '${k}' není v dokumentaci endpointu ${op.id}.`);
  }
  for (const p of op.params ?? []) {
    if (p.required && p.in === "query" && !(query && p.name in query)) errors.push(`Chybí povinný query parametr '${p.name}'.`);
  }
  if (typeof query?.fields === "string") warnings.push(...validateFieldsParam(op, query.fields));
  if (body && op.body) {
    const knownBody = new Set(op.body.map((f) => f.name));
    for (const k of Object.keys(body)) if (!knownBody.has(k)) warnings.push(`Pole těla '${k}' není v dokumentaci ${op.id}.`);
    for (const f of op.body) if (f.required && !(f.name in body)) errors.push(`Chybí povinné pole těla '${f.name}'.`);
  }
  if ((op.method === "POST" || op.method === "PATCH") && op.body && !body) warnings.push("Požadavek nemá tělo; endpoint tělo očekává.");
  return { op, errors, warnings };
}

/** Textový popis operace pro Claude. */
export function describeOp(op: Op, opts: { fields?: boolean } = { fields: true }): string {
  const lines: string[] = [];
  lines.push(`${op.method} /api/v4${op.path}  [${op.id}]${op.tag ? `  (${op.tag})` : ""}`);
  if (op.summary) lines.push(`  ${op.summary}`);
  const q = (op.params ?? []).filter((p) => p.in === "query");
  if (q.length) {
    lines.push("  Query parametry:");
    for (const p of q) lines.push(`    - ${p.name}${p.required ? "*" : ""} (${p.type})${p.desc ? `: ${p.desc}` : ""}`);
  }
  if (op.body?.length) {
    lines.push("  Tělo (data):");
    for (const f of op.body) {
      lines.push(`    - ${f.name}${f.required ? "*" : ""} (${f.type})${f.desc ? `: ${f.desc}` : ""}`);
      if (f.fields) for (const sub of f.fields.slice(0, 12)) lines.push(`        · ${sub.name}${sub.required ? "*" : ""} (${sub.type})${sub.desc ? `: ${sub.desc.slice(0, 80)}` : ""}`);
    }
  }
  if (op.response && opts.fields) {
    const fs = schemaFields(op.response.schema) ?? [];
    lines.push(`  Odpověď: ${op.response.list ? "seznam " : ""}${op.response.schema}; pole pro parametr fields:`);
    lines.push("    " + fs.map((f) => (f.type.match(/^[A-Z]/) || f.type.startsWith("array<") ? `${f.name}{…}` : f.name)).join(", "));
  }
  return lines.join("\n");
}
