import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadTokens } from "../store.js";
import { ClioApiError } from "../client.js";
import { audit } from "../audit.js";

export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: ContentBlock[]; isError?: boolean };

export const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
export const json = (o: unknown): ToolResult => text(JSON.stringify(o, null, 2));
export const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

/** Náhled zápisu bez provedení – jednotný formát pro všechny zápisové nástroje. */
export function preview(what: string, payload: unknown, extra?: string): ToolResult {
  return text(
    `NÁHLED – nic nebylo odesláno. Pro provedení zopakujte volání s confirm=true.\n${what}\n${JSON.stringify(payload, null, 2)}${extra ? `\n${extra}` : ""}`
  );
}

export const confirmSchema = z.boolean().optional().describe("Zápis se provede jen s confirm=true; bez něj nástroj vrátí náhled.");

/** Obal: audit + jednotné chyby. */
export function wrap<A>(tool: string, fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    const started = Date.now();
    const user_id = (() => {
      try {
        return loadTokens()?.user?.id;
      } catch {
        return undefined;
      }
    })();
    try {
      const r = await fn(args);
      audit({ tool, args, ok: !r.isError, user_id, duration_ms: Date.now() - started });
      return r;
    } catch (e) {
      audit({
        tool,
        args,
        ok: false,
        user_id,
        status: e instanceof ClioApiError ? e.status : undefined,
        error: e instanceof Error ? e.message : String(e),
        duration_ms: Date.now() - started,
      });
      return fail(e);
    }
  };
}

export type Registrar = (server: McpServer) => void;

/** Odstraní undefined hodnoty (pro těla požadavků). */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out as Partial<T>;
}

/** Převod hodin (desetinné) na sekundy pro Activity.quantity. */
export function hoursToSeconds(h: number): number {
  return Math.round(h * 3600);
}

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum ve formátu YYYY-MM-DD");
