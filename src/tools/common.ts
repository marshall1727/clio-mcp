import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import crypto from "node:crypto";
import { loadTokens } from "../store.js";
import { ClioApiError } from "../client.js";
import { audit } from "../audit.js";
import { config } from "../config.js";
import { t } from "../i18n.js";

export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: ContentBlock[]; isError?: boolean; _preview?: boolean };
/** Value of the `confirm` argument: absent/false = preview, a token string from the preview = confirmed write. */
export type Confirm = boolean | string | undefined;

export const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
export const json = (o: unknown): ToolResult => text(JSON.stringify(o, null, 2));
export const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

/** Preview of a write without executing it – a uniform format for all write tools. */
export function preview(what: string, payload: unknown, extra?: string): ToolResult {
  const r = text(`${t(config.confirmMode === "ask" ? "common.preview_header" : "common.preview_header_auto")}\n${what}\n${JSON.stringify(payload, null, 2)}${extra ? `\n${extra}` : ""}`);
  r._preview = true;
  return r;
}

export const confirmSchema = z
  .union([z.boolean(), z.string()])
  .optional()
  .describe(
    config.confirmMode === "ask"
      ? "Leave out on the first call: the tool returns a PREVIEW with a confirmation token. Show the preview to the user, wait for their explicit approval, then repeat the call with identical arguments and confirm set to that token. confirm=true is not accepted."
      : "confirm=true performs the write. Use it directly when the user's request contains everything needed; call without confirm (preview) only when you want to check the data first or something is unclear."
  );

// ---- preview → confirm handshake -------------------------------------------------------------
// A write is accepted only with the token the preview of the *same* arguments produced, so the
// model has to see the preview first (and the user has a chance to approve it).
const CONFIRM_SECRET = crypto.randomBytes(32);
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => k !== "confirm" && (v as any)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
export function confirmToken(tool: string, args: unknown): string {
  return crypto.createHmac("sha256", CONFIRM_SECRET).update(`${tool}\n${canonical(args)}`).digest("base64url").slice(0, 12);
}
function checkConfirm(tool: string, args: unknown): string | undefined {
  const c = (args as any)?.confirm;
  if (c === undefined || c === false || c === null || c === "") return undefined;
  if (c === true) return config.confirmMode === "ask" ? t("common.confirm_true_rejected") : undefined;
  if (typeof c === "string" && c === confirmToken(tool, args)) return undefined;
  return t("common.confirm_token_invalid");
}

/** Wrapper: audit + uniform error handling. */
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
      const refused = checkConfirm(tool, args);
      if (refused) {
        audit({ tool, args, ok: false, user_id, error: "confirm refused", duration_ms: Date.now() - started });
        return { content: [{ type: "text", text: refused }], isError: true };
      }
      const r = await fn(args);
      if (r._preview) {
        const token = confirmToken(tool, args);
        r.content.push({ type: "text", text: t(config.confirmMode === "ask" ? "common.preview_token_line" : "common.preview_auto_hint", { token }) });
      }
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

/** Removes undefined/null/empty values (for request bodies). */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out as Partial<T>;
}

/** Converts hours (decimal) to seconds for Activity.quantity. */
export function hoursToSeconds(h: number): number {
  return Math.round(h * 3600);
}

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date in YYYY-MM-DD format");
