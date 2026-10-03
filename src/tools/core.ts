/** Jádro: přihlášení, identita, diagnostika, obecné volání API a popis API. */
import { z } from "zod";
import { config } from "../config.js";
import { loadTokens, storeBackend } from "../store.js";
import { startAuthentication, getPendingAuth, logout } from "../oauth.js";
import { apiRequest, rememberUser, rateLimitSnapshot } from "../client.js";
import { catalog, searchOps, matchOp, describeOp, validateRequest, schemaFields } from "../catalog.js";
import { text, json, wrap, type Registrar } from "./common.js";

export const registerCore: Registrar = (server) => {
  server.registerTool(
    "clio_authenticate",
    {
      title: "Přihlásit do Clio",
      description:
        "Spustí přihlášení do Clio Manage (OAuth 2.0) a IHNED vrátí přihlašovací URL. Pokusí se otevřít prohlížeč; pokud se neotevře, ukažte uživateli URL, aby ji otevřel ručně. " +
        "Uživatel se v prohlížeči přihlásí do Clio a potvrdí přístup; tokeny se pak na pozadí uloží šifrovaně na tomto PC. Výsledek ověřte nástrojem clio_auth_status (nebo clio_who_am_i). " +
        "Použijte při prvním spuštění nebo když jiný nástroj hlásí, že nejste přihlášeni.",
      inputSchema: { force: z.boolean().optional().describe("true = zrušit běžící pokus a začít znovu") },
    },
    wrap("clio_authenticate", async ({ force }: { force?: boolean }) => {
      const r = await startAuthentication(Boolean(force));
      return text(
        [
          r.reused ? "Přihlášení už běží – použijte stejnou URL." : "Přihlášení do Clio zahájeno.",
          r.browserOpened ? "Prohlížeč by se měl otevřít se stránkou Clio EU." : "Prohlížeč se nepodařilo otevřít automaticky.",
          `Pokud se stránka neobjevila, otevřete ručně: ${r.url}`,
          `Po potvrzení přístupu v prohlížeči (callback na portu ${r.port}) zavolejte clio_auth_status pro ověření. Platnost odkazu: 10 minut.`,
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "clio_auth_status",
    {
      title: "Stav přihlášení do Clio",
      description: "Zjistí, zda je na tomto PC uložený platný token Clio, komu patří a kdy expiruje; hlásí i stav probíhajícího přihlášení.",
      inputSchema: { verify: z.boolean().optional().describe("true = ověřit token voláním /users/who_am_i") },
    },
    wrap("clio_auth_status", async ({ verify }: { verify?: boolean }) => {
      const p = getPendingAuth();
      const t = loadTokens();
      if (!t) {
        if (p?.status === "pending" || p?.status === "exchanging") {
          return text(`Přihlášení běží (stav: ${p.status}, zahájeno ${new Date(p.startedAt).toISOString()}). Dokončete potvrzení v prohlížeči; URL: ${p.url}`);
        }
        if (p?.status === "error" || p?.status === "expired") {
          return text(`Poslední pokus o přihlášení skončil: ${p.status} – ${p.error ?? ""}. Spusťte clio_authenticate znovu.`);
        }
        return text(`Nepřihlášeno. Region ${config.region.toUpperCase()}, API ${config.apiBase}. Spusťte clio_authenticate.`);
      }
      const info: Record<string, unknown> = {
        last_auth_flow: p ? { status: p.status, error: p.error } : null,
        region: config.region,
        api_base: config.apiBase,
        user: t.user ?? null,
        access_token_expires_at: new Date(t.expires_at).toISOString(),
        obtained_at: new Date(t.obtained_at).toISOString(),
        has_refresh_token: Boolean(t.refresh_token),
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
      title: "Odhlásit z Clio",
      description: "Smaže uložené tokeny na tomto PC. S revoke=true navíc požádá Clio o zneplatnění access tokenu.",
      inputSchema: { revoke: z.boolean().optional().describe("true = zneplatnit token i na straně Clio (výchozí false)") },
    },
    wrap("clio_logout", async ({ revoke }: { revoke?: boolean }) => {
      const r = await logout(Boolean(revoke));
      return text(`Tokeny odstraněny z tohoto PC.${revoke ? (r.revoked ? " Token zneplatněn i v Clio." : " Zneplatnění v Clio se nezdařilo (token už mohl být neplatný).") : ""}`);
    })
  );

  server.registerTool(
    "clio_who_am_i",
    {
      title: "Kdo jsem v Clio",
      description: "Vrátí přihlášeného uživatele Clio (id, jméno, e-mail, role) a aktuální stav rate limitu. Slouží k ověření spojení a zjištění vlastního user id.",
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
      title: "Popis Clio API (OpenAPI katalog)",
      description:
        "Vyhledá endpointy Clio API v4 podle klíčových slov (např. 'matters', 'time entry', 'bills line items', 'document templates') nebo popíše konkrétní endpoint (method + path). " +
        "Vrací parametry, pole těla požadavku a pole odpovědi použitelná v parametru fields. Použijte před clio_api_request, když kurátorovaný nástroj chybí.",
      inputSchema: {
        query: z.string().optional().describe("Klíčová slova pro vyhledání endpointů"),
        method: z.string().optional().describe("Metoda konkrétního endpointu (GET/POST/PATCH)"),
        path: z.string().optional().describe("Cesta konkrétního endpointu, např. /matters/{id} nebo /matters/123"),
        schema: z.string().optional().describe("Název schématu pro výpis polí, např. Matter, Activity, Bill"),
        limit: z.number().int().min(1).max(60).optional().describe("Max. počet výsledků vyhledávání (výchozí 20)"),
      },
    },
    wrap("clio_describe_api", async ({ query, method, path, schema, limit }: { query?: string; method?: string; path?: string; schema?: string; limit?: number }) => {
      if (schema) {
        const f = schemaFields(schema);
        if (!f) return text(`Schéma '${schema}' není v katalogu. Dostupná např.: ${Object.keys(catalog.schemas).slice(0, 40).join(", ")} …`);
        return text(`${schema}:\n` + f.map((x) => `- ${x.name} (${x.type})${x.desc ? `: ${x.desc}` : ""}`).join("\n"));
      }
      if (path) {
        const m = matchOp(method ?? "GET", path);
        if (!m) {
          const alt = catalog.ops.filter((o) => o.path === path || o.path.startsWith(path));
          return text(alt.length ? "Endpoint s touto metodou nenalezen. Dostupné:\n" + alt.map((o) => describeOp(o, { fields: false })).join("\n") : `Endpoint ${path} nenalezen. Zkuste query.`);
        }
        return text(describeOp(m.op) + `\n\nKatalog vygenerován ${catalog.generated_at} z ${catalog.source}.`);
      }
      const ops = searchOps(query ?? "", limit ?? 20);
      if (!ops.length) return text("Nic nenalezeno. Zkuste jiná klíčová slova (anglicky, např. 'activities', 'bills', 'documents').");
      const tagDesc = ops[0].tag && catalog.tags[ops[0].tag] ? `\n\n${ops[0].tag}: ${catalog.tags[ops[0].tag]}` : "";
      return text(ops.map((o) => `${o.method} ${o.path}  [${o.id}] – ${o.summary ?? ""}`).join("\n") + tagDesc + "\n\nPro detail zavolejte znovu s method + path.");
    })
  );

  server.registerTool(
    "clio_api_request",
    {
      title: "Obecné volání Clio API v4",
      description:
        "Provede GET, POST nebo PATCH na libovolný endpoint Clio API v4 (cesta relativní k /api/v4, např. '/matters' nebo '/matters/123'; nebo celá URL z meta.paging.next). DELETE není povoleno. " +
        "Požadavek se validuje proti OpenAPI katalogu (neexistující cesta = chyba; neznámé parametry = varování). Pro GET předejte query.fields (bez něj API vrací jen id a etag). " +
        "Tělo POST/PATCH se automaticky obalí do {\"data\": ...}. Zápis vyžaduje confirm=true – bez něj nástroj vrátí jen náhled požadavku.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PATCH"]).describe("HTTP metoda"),
        path: z.string().describe("Cesta relativní k /api/v4 nebo úplná URL"),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query parametry, např. {fields: 'id,display_number', limit: 50, order: 'id(asc)'}"),
        body: z.record(z.unknown()).optional().describe("Tělo požadavku pro POST/PATCH (obsah 'data')"),
        confirm: z.boolean().optional().describe("Pro POST/PATCH musí být true, jinak se požadavek neodešle"),
        skip_validation: z.boolean().optional().describe("true = neblokovat požadavek kvůli chybám validace (např. nový endpoint mimo katalog)"),
      },
    },
    wrap(
      "clio_api_request",
      async ({ method, path, query, body, confirm, skip_validation }: { method: "GET" | "POST" | "PATCH"; path: string; query?: Record<string, string | number | boolean>; body?: Record<string, unknown>; confirm?: boolean; skip_validation?: boolean }) => {
        const v = validateRequest(method, path, query, body);
        if (v.errors.length && !skip_validation) {
          return text(`Požadavek neodeslán – validace proti OpenAPI:\n- ${v.errors.join("\n- ")}${v.warnings.length ? `\nVarování:\n- ${v.warnings.join("\n- ")}` : ""}\n(Pro odeslání i přes chyby použijte skip_validation=true.)`);
        }
        if (method !== "GET" && !confirm) {
          return text(
            `NÁHLED (neodesláno). Pro provedení zopakujte s confirm=true.\n${method} ${config.apiBase}${path}\nquery: ${JSON.stringify(query ?? {})}\nbody: ${JSON.stringify({ data: body ?? {} }, null, 2)}${v.warnings.length ? `\nVarování:\n- ${v.warnings.join("\n- ")}` : ""}`
          );
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
      title: "Diagnostika konektoru",
      description: "Vrátí konfiguraci serveru (bez tajemství): region, URL, porty, cesty k souborům, pracovní složku pro dokumenty, verzi Node a způsob uložení tokenů.",
      inputSchema: {},
    },
    wrap("clio_diagnostics", async () =>
      json({
        version: config.version,
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
