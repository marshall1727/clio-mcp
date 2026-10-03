/** Core: sign-in, identity, diagnostics, generic API calls and API description. */
import { z } from "zod";
import { config } from "../config.js";
import { loadTokens, storeBackend } from "../store.js";
import { startAuthentication, getPendingAuth, logout } from "../oauth.js";
import { apiRequest, rememberUser, rateLimitSnapshot } from "../client.js";
import { catalog, searchOps, matchOp, describeOp, validateRequest, schemaFields } from "../catalog.js";
import { text, json, wrap, confirmSchema, type Confirm, type Registrar } from "./common.js";
import { t, locale } from "../i18n.js";

export const registerCore: Registrar = (server) => {
  server.registerTool(
    "clio_authenticate",
    {
      title: "Sign in to Clio",
      description:
        "Starts the Clio Manage sign-in (OAuth 2.0) and IMMEDIATELY returns the sign-in URL. It tries to open the browser; if it does not open, show the URL to the user so they can open it manually. " +
        "The user signs in to Clio in the browser and approves access; the tokens are then stored encrypted on this computer in the background. Verify the result with clio_auth_status (or clio_who_am_i). " +
        "Use on first run or whenever another tool reports that you are not signed in.",
      inputSchema: { force: z.boolean().optional().describe("true = cancel the running attempt and start over") },
    },
    wrap("clio_authenticate", async ({ force }: { force?: boolean }) => {
      const r = await startAuthentication(Boolean(force));
      return text(
        [
          r.reused ? t("core.auth_already_running") : t("core.auth_started"),
          r.browserOpened ? t("core.auth_browser_opened") : t("core.auth_browser_not_opened"),
          t("core.auth_open_manually", { url: r.url }),
          t("core.auth_next_step", { port: r.port }),
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "clio_auth_status",
    {
      title: "Clio sign-in status",
      description: "Checks whether a valid Clio token is stored on this computer, who it belongs to and when it expires; also reports the state of a sign-in in progress.",
      inputSchema: { verify: z.boolean().optional().describe("true = verify the token by calling /users/who_am_i") },
    },
    wrap("clio_auth_status", async ({ verify }: { verify?: boolean }) => {
      const p = getPendingAuth();
      const tok = loadTokens();
      if (!tok) {
        if (p?.status === "pending" || p?.status === "exchanging") {
          return text(t("core.auth_in_progress", { status: p.status, started_at: new Date(p.startedAt).toISOString(), url: p.url }));
        }
        if (p?.status === "error" || p?.status === "expired") {
          return text(t("core.auth_last_attempt_failed", { status: p.status, error: p.error ?? "" }));
        }
        return text(t("core.not_signed_in", { region: config.region.toUpperCase(), api_base: config.apiBase }));
      }
      const info: Record<string, unknown> = {
        last_auth_flow: p ? { status: p.status, error: p.error } : null,
        region: config.region,
        api_base: config.apiBase,
        user: tok.user ?? null,
        access_token_expires_at: new Date(tok.expires_at).toISOString(),
        obtained_at: new Date(tok.obtained_at).toISOString(),
        has_refresh_token: Boolean(tok.refresh_token),
        token_store: storeBackend,
        token_file: config.tokenFile,
        audit_file: config.auditFile,
        work_dir: config.workDir,
        rate_limit: rateLimitSnapshot(),
      };
      if (verify) {
        const me = await apiRequest<{ data: { id: number; name?: string; email?: string } }>("GET", "/users/who_am_i", { query: { fields: "id,name,email" } });
        rememberUser(me.data.data);
        info.verified_user = me.data.data;
      }
      return json(info);
    })
  );

  server.registerTool(
    "clio_logout",
    {
      title: "Sign out of Clio",
      description: "Deletes the tokens stored on this computer. With revoke=true it also asks Clio to invalidate the access token.",
      inputSchema: { revoke: z.boolean().optional().describe("true = also invalidate the token on the Clio side (default false)") },
    },
    wrap("clio_logout", async ({ revoke }: { revoke?: boolean }) => {
      const r = await logout(Boolean(revoke));
      return text(`${t("core.tokens_removed")}${revoke ? (r.revoked ? ` ${t("core.token_revoked")}` : ` ${t("core.token_revoke_failed")}`) : ""}`);
    })
  );

  server.registerTool(
    "clio_who_am_i",
    {
      title: "Who am I in Clio",
      description: "Returns the signed-in Clio user (id, name, e-mail, roles) and the current rate-limit state. Use it to verify the connection and to find your own user id.",
      inputSchema: {},
    },
    wrap("clio_who_am_i", async () => {
      const me = await apiRequest<{ data: Record<string, unknown> }>("GET", "/users/who_am_i", {
        query: { fields: "id,name,first_name,last_name,email,enabled,subscription_type,roles,account_owner,time_zone,default_calendar_id,rate" },
      });
      const u = me.data.data as { id: number; name?: string; email?: string };
      rememberUser({ id: u.id, name: u.name, email: u.email });
      return json({ user: me.data.data, rate_limit: me.rateLimit, region: config.region });
    })
  );

  server.registerTool(
    "clio_describe_api",
    {
      title: "Describe the Clio API (OpenAPI catalog)",
      description:
        "Searches Clio API v4 endpoints by keywords (e.g. 'matters', 'time entry', 'bills line items', 'document templates') or describes a specific endpoint (method + path). " +
        "Returns parameters, request-body fields and response fields usable in the fields parameter. Use it before clio_api_request when no curated tool exists.",
      inputSchema: {
        query: z.string().optional().describe("Keywords for searching endpoints"),
        method: z.string().optional().describe("Method of a specific endpoint (GET/POST/PATCH)"),
        path: z.string().optional().describe("Path of a specific endpoint, e.g. /matters/{id} or /matters/123"),
        schema: z.string().optional().describe("Schema name to list its fields, e.g. Matter, Activity, Bill"),
        limit: z.number().int().min(1).max(60).optional().describe("Max. number of search results (default 20)"),
      },
    },
    wrap("clio_describe_api", async ({ query, method, path, schema, limit }: { query?: string; method?: string; path?: string; schema?: string; limit?: number }) => {
      if (schema) {
        const f = schemaFields(schema);
        if (!f) return text(t("core.schema_not_found", { schema, list: Object.keys(catalog.schemas).slice(0, 40).join(", ") }));
        return text(`${schema}:\n` + f.map((x) => `- ${x.name} (${x.type})${x.desc ? `: ${x.desc}` : ""}`).join("\n"));
      }
      if (path) {
        const m = matchOp(method ?? "GET", path);
        if (!m) {
          const alt = catalog.ops.filter((o) => o.path === path || o.path.startsWith(path));
          return text(alt.length ? t("core.endpoint_method_not_found", { list: alt.map((o) => describeOp(o, { fields: false })).join("\n") }) : t("core.endpoint_not_found", { path }));
        }
        return text(describeOp(m.op) + `\n\n${t("core.catalog_generated", { generated_at: catalog.generated_at, source: catalog.source })}`);
      }
      const ops = searchOps(query ?? "", limit ?? 20);
      if (!ops.length) return text(t("core.search_nothing_found"));
      const tagDesc = ops[0].tag && catalog.tags[ops[0].tag] ? `\n\n${ops[0].tag}: ${catalog.tags[ops[0].tag]}` : "";
      return text(ops.map((o) => `${o.method} ${o.path}  [${o.id}] – ${o.summary ?? ""}`).join("\n") + tagDesc + `\n\n${t("core.search_detail_hint")}`);
    })
  );

  server.registerTool(
    "clio_api_request",
    {
      title: "Generic Clio API v4 call",
      description:
        "Performs a GET, POST or PATCH on any Clio API v4 endpoint (path relative to /api/v4, e.g. '/matters' or '/matters/123'; or a full URL from meta.paging.next). DELETE is not allowed. " +
        "The request is validated against the OpenAPI catalog (unknown path = error; unknown parameters = warning). For GET pass query.fields (without it the API returns only id and etag). " +
        "The POST/PATCH body is automatically wrapped in {\"data\": ...}. Writes follow the preview → confirm handshake: the first call returns a preview with a confirmation token; repeat with confirm set to that token after the user approves.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PATCH"]).describe("HTTP method"),
        path: z.string().describe("Path relative to /api/v4 or a full URL"),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query parameters, e.g. {fields: 'id,display_number', limit: 50, order: 'id(asc)'}"),
        body: z.record(z.unknown()).optional().describe("Request body for POST/PATCH (the content of 'data')"),
        confirm: confirmSchema,
        skip_validation: z.boolean().optional().describe("true = do not block the request because of validation errors (e.g. a new endpoint not in the catalog)"),
      },
    },
    wrap(
      "clio_api_request",
      async ({ method, path, query, body, confirm, skip_validation }: { method: "GET" | "POST" | "PATCH"; path: string; query?: Record<string, string | number | boolean>; body?: Record<string, unknown>; confirm?: Confirm; skip_validation?: boolean }) => {
        const v = validateRequest(method, path, query, body);
        const warnings = v.warnings.length ? t("core.validation_warnings", { warnings: v.warnings.join("\n- ") }) : "";
        if (v.errors.length && !skip_validation) {
          return text(t("core.validation_failed", { errors: v.errors.join("\n- "), warnings }));
        }
        if (method !== "GET" && !confirm) {
          const r = text(
            t(config.confirmMode === "ask" ? "core.api_request_preview" : "core.api_request_preview_auto", {
              method,
              url: `${config.apiBase}${path}`,
              query: JSON.stringify(query ?? {}),
              body: JSON.stringify({ data: body ?? {} }, null, 2),
              warnings,
            })
          );
          r._preview = true;
          return r;
        }
        const r = await apiRequest(method, path, { query, body });
        const out: Record<string, unknown> = { status: r.status, rate_limit: r.rateLimit };
        if (v.warnings.length) out.validation_warnings = v.warnings;
        Object.assign(out, typeof r.data === "object" && r.data ? (r.data as object) : { data: r.data });
        return json(out);
      }
    )
  );

  server.registerTool(
    "clio_diagnostics",
    {
      title: "Connector diagnostics",
      description: "Returns the server configuration (without secrets): region, URLs, ports, file paths, the work folder for documents, Node version and the token storage method.",
      inputSchema: {},
    },
    wrap("clio_diagnostics", async () =>
      json({
        version: config.version,
        locale,
        region: config.region,
        region_configured: config.regionConfigured,
        api_base: config.apiBase,
        authorize_url: config.authorizeUrl,
        redirect_ports: config.redirectPorts,
        data_dir: config.dataDir,
        work_dir: config.workDir,
        claude_folder: config.claudeFolderName,
        letterheads: config.letterheads,
        default_template: config.defaultTemplate ?? null,
        internal_template: config.internalTemplate ?? null,
        docx: { indent_twips: config.docxIndentTwips, labels: config.docxLabels },
        token_store: storeBackend,
        client_id_configured: Boolean(config.clientId),
        client_secret_configured: Boolean(config.clientSecret),
        catalog: { generated_at: catalog.generated_at, operations: catalog.ops.length, schemas: Object.keys(catalog.schemas).length },
        node: process.version,
        platform: process.platform,
      })
    )
  );
};
