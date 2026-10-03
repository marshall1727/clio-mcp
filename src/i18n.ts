// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal message catalog. English is the source language; other locales override keys.
 * Locale comes from CLIO_LOCALE (default "en"); unknown locales fall back to English.
 *
 *   t("documents.download_failed", { status: 404 })  →  "Download failed: 404"
 *
 * Only runtime messages shown to the user/model (previews, errors, notes, server instructions)
 * are localised. Tool names, titles, descriptions and JSON field names stay English, because
 * they are read by the model, which answers in the user's language anyway.
 */
import enCommon from "./locales/en/common.json" with { type: "json" };
import enCore from "./locales/en/core.json" with { type: "json" };
import enDocuments from "./locales/en/documents.json" with { type: "json" };
import enActivities from "./locales/en/activities.json" with { type: "json" };
import enMatters from "./locales/en/matters.json" with { type: "json" };
import enRuntime from "./locales/en/runtime.json" with { type: "json" };
import csCommon from "./locales/cs/common.json" with { type: "json" };
import csCore from "./locales/cs/core.json" with { type: "json" };
import csDocuments from "./locales/cs/documents.json" with { type: "json" };
import csActivities from "./locales/cs/activities.json" with { type: "json" };
import csMatters from "./locales/cs/matters.json" with { type: "json" };
import csRuntime from "./locales/cs/runtime.json" with { type: "json" };

type Catalog = Record<string, string>;

const CATALOGS: Record<string, Catalog> = {
  en: { ...enCommon, ...enCore, ...enDocuments, ...enActivities, ...enMatters, ...enRuntime },
  cs: { ...csCommon, ...csCore, ...csDocuments, ...csActivities, ...csMatters, ...csRuntime },
};

export const SUPPORTED_LOCALES = Object.keys(CATALOGS);

function pickLocale(): string {
  const raw = (process.env.CLIO_LOCALE ?? "").trim().toLowerCase();
  if (!raw || raw.includes("${")) return "en";
  const base = raw.split(/[-_]/)[0];
  return CATALOGS[raw] ? raw : CATALOGS[base] ? base : "en";
}

export const locale = pickLocale();

/** Returns the message for `key` in the active locale, falling back to English, then to the key itself. */
export function t(key: string, vars: Record<string, unknown> = {}): string {
  const msg = CATALOGS[locale]?.[key] ?? CATALOGS.en[key] ?? key;
  return msg.replace(/\{(\w+)\}/g, (_, name: string) => (vars[name] === undefined || vars[name] === null ? "" : String(vars[name])));
}

/** Lists keys present in English but missing in another locale (used by tests/diagnostics). */
export function missingKeys(loc: string): string[] {
  const target = CATALOGS[loc] ?? {};
  return Object.keys(CATALOGS.en).filter((k) => !(k in target));
}
