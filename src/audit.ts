import fs from "node:fs";
import { config } from "./config.js";

const SECRET_KEYS = /secret|token|password|authorization/i;

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(val);
    }
    return out;
  }
  if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + `…(${v.length})`;
  return v;
}

export function audit(entry: {
  tool: string;
  args?: unknown;
  ok: boolean;
  status?: number;
  method?: string;
  path?: string;
  user_id?: number;
  error?: string;
  duration_ms?: number;
}): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry, args: redact(entry.args) });
    fs.appendFileSync(config.auditFile, line + "\n", { mode: 0o600 });
  } catch {
    /* audit nesmí shodit nástroj */
  }
}
