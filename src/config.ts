// SPDX-License-Identifier: Apache-2.0
import os from "node:os";
import path from "node:path";

export type Region = "us" | "eu" | "ca" | "au";

const HOSTS: Record<Region, string> = {
  us: "https://app.clio.com",
  eu: "https://eu.app.clio.com",
  ca: "https://ca.app.clio.com",
  au: "https://au.app.clio.com",
};

export const REGIONS = Object.keys(HOSTS) as Region[];

/** Reads an environment variable; unreplaced manifest placeholders ("${...}") count as unset. */
function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  if (!v || v.trim() === "" || v.includes("${")) return fallback;
  return v.trim();
}

function absDir(name: string, fallback: string): string {
  const v = env(name, fallback)!;
  return path.isAbsolute(v) ? v : fallback;
}

/** Parses "key=value;key2=value2" into a map (keys lower-cased). */
function parseMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || !raw.includes("=")) return out;
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim().toLowerCase();
    const v = pair.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(";").map((s) => s.trim()).filter(Boolean);
}

export const config = (() => {
  const regionRaw = (env("CLIO_REGION") ?? "").toLowerCase();
  const regionValid = (REGIONS as string[]).includes(regionRaw);
  // An invalid/missing region falls back to "us" for URL construction only; assertClientConfig() reports it.
  const region = (regionValid ? regionRaw : "us") as Region;
  const host = HOSTS[region];

  const defaultDataDir = path.join(os.homedir(), ".clio-mcp");
  const dataDir = absDir("CLIO_DATA_DIR", defaultDataDir);
  // Working folder for downloaded/edited documents (connect it in Cowork so Claude can open the files)
  const workDir = absDir("CLIO_WORK_DIR", path.join(os.homedir(), "Documents", "Clio MCP"));

  // Letterhead selection: per-user map "email=template name or prefix;..." and a firm-wide default template
  const letterheads = parseMap(env("CLIO_LETTERHEADS"));
  const defaultTemplate = env("CLIO_DEFAULT_TEMPLATE");
  const internalTemplate = env("CLIO_INTERNAL_TEMPLATE");
  // Folder in the matter (in Clio) that receives every document created by Claude
  const claudeFolderName = env("CLIO_CLAUDE_FOLDER", "Claude")!;

  // DOCX filling: hanging indent for numbered paragraphs (cm) and bold labels followed by a tab ("Evidence:" etc.)
  const indentCm = parseFloat(env("CLIO_DOCX_INDENT_CM", "1.4")!);
  const docxIndentTwips = Math.round((Number.isFinite(indentCm) && indentCm > 0 ? indentCm : 1.4) * 567);
  const docxLabels = parseList(env("CLIO_DOCX_LABELS"));

  const ports = (env("CLIO_REDIRECT_PORTS", "53682,53683,53684")!)
    .split(",")
    .map((p) => parseInt(p.trim(), 10))
    .filter((p) => Number.isFinite(p) && p > 0);

  return {
    region,
    regionConfigured: regionValid,
    regionRaw,
    host,
    apiBase: `${host}/api/v4`,
    authorizeUrl: `${host}/oauth/authorize`,
    tokenUrl: `${host}/oauth/token`,
    deauthorizeUrl: `${host}/oauth/deauthorize`,
    developerPortal: region === "us" ? "https://developers.clio.com" : `https://${region}.developers.clio.com`,
    clientId: env("CLIO_CLIENT_ID"),
    clientSecret: env("CLIO_CLIENT_SECRET"),
    apiVersion: env("CLIO_API_VERSION"), // optional X-API-VERSION header (4.X.Y)
    dataDir,
    tokenFile: path.join(dataDir, `tokens-${region}.bin`),
    auditFile: path.join(dataDir, "audit.jsonl"),
    redirectPorts: ports,
    workDir,
    letterheads,
    defaultTemplate,
    internalTemplate,
    claudeFolderName,
    docxIndentTwips,
    docxLabels,
    name: "clio-mcp",
    version: "1.0.0-beta.1",
  };
})();

/** Throws a readable error when the connector is not configured (region, client id/secret). */
export function assertClientConfig(): { clientId: string; clientSecret: string } {
  const problems: string[] = [];
  if (!config.regionConfigured) {
    problems.push(
      config.regionRaw
        ? `CLIO_REGION "${config.regionRaw}" is not valid (use one of: ${REGIONS.join(", ")}).`
        : `CLIO_REGION is not set (use one of: ${REGIONS.join(", ")}) – it must match the region of your Clio account.`
    );
  }
  if (!config.clientId || !config.clientSecret) {
    problems.push(
      "CLIO_CLIENT_ID and/or CLIO_CLIENT_SECRET are missing. Create a Developer Application in your Clio developer portal " +
        `(${config.developerPortal}) and enter its App Key and App Secret in the extension settings (Claude Desktop → Settings → Extensions → Clio Manage).`
    );
  }
  if (problems.length) throw new Error(problems.join(" "));
  return { clientId: config.clientId!, clientSecret: config.clientSecret! };
}
