/** Evidence času a výdajů (Activities) + billing podklady. */
import { z } from "zod";
import { apiRequest, apiList, apiListAll } from "../client.js";
import { loadTokens } from "../store.js";
import { text, json, wrap, preview, confirmSchema, compact, hoursToSeconds, dateSchema, type Registrar } from "./common.js";

const ACT_FIELDS =
  "id,type,date,quantity_in_hours,quantity,price,total,note,billed,on_bill,non_billable,no_charge,flat_rate,created_at,updated_at,matter{id,display_number},user{id,name},activity_description{id,name},expense_category{id,name},bill{id,number,state}";

type Act = { quantity_in_hours?: number; total?: number; non_billable?: boolean; billed?: boolean; user?: { name?: string }; matter?: { display_number?: string }; type?: string };

export const registerActivities: Registrar = (server) => {
  server.registerTool(
    "clio_time_entries_list",
    {
      title: "Výpis času a výdajů",
      description:
        "Vypíše časové záznamy (TimeEntry) a případně výdaje podle spisu, uživatele, období a stavu fakturace (unbilled/billed/non_billable/draft). Vrací i souhrn hodin a částek za výpis. " +
        "Bez matter_id a user_id vrací záznamy celé kanceláře – u velkých období použijte limit a page_token.",
      inputSchema: {
        matter_id: z.number().int().optional(),
        user_id: z.number().int().optional().describe("ID uživatele; 'me' řeší clio_who_am_i"),
        start_date: dateSchema.optional().describe("Od (včetně), YYYY-MM-DD"),
        end_date: dateSchema.optional().describe("Do (včetně), YYYY-MM-DD"),
        type: z.enum(["TimeEntry", "ExpenseEntry", "HardCostEntry", "SoftCostEntry"]).optional().describe("Výchozí TimeEntry; pro vše nezadávejte"),
        status: z.enum(["billed", "draft", "unbilled", "non_billable", "billable", "written_off"]).optional(),
        query: z.string().optional().describe("Text v poznámce"),
        all_types: z.boolean().optional().describe("true = nevynucovat type TimeEntry"),
        limit: z.number().int().min(1).max(200).optional().describe("Výchozí 100"),
        page_token: z.string().optional(),
      },
    },
    wrap("clio_time_entries_list", async (a: { matter_id?: number; user_id?: number; start_date?: string; end_date?: string; type?: string; status?: string; query?: string; all_types?: boolean; limit?: number; page_token?: string }) => {
      const q = compact({ matter_id: a.matter_id, user_id: a.user_id, start_date: a.start_date, end_date: a.end_date, status: a.status, query: a.query, type: a.all_types ? undefined : a.type ?? "TimeEntry" });
      const r = await apiList<Act>("/activities", { ...q, fields: ACT_FIELDS, limit: a.limit ?? 100, order: "date(desc)" }, { page_token: a.page_token });
      const hours = r.data.reduce((s, x) => s + (x.quantity_in_hours ?? 0), 0);
      const total = r.data.reduce((s, x) => s + (x.total ?? 0), 0);
      const billable = r.data.filter((x) => !x.non_billable).reduce((s, x) => s + (x.quantity_in_hours ?? 0), 0);
      return json({ records_total: r.records, returned: r.data.length, has_more: r.has_more, next_page_token: r.next_page_token, summary_of_page: { hours: +hours.toFixed(2), billable_hours: +billable.toFixed(2), total_amount: +total.toFixed(2) }, activities: r.data });
    })
  );

  server.registerTool(
    "clio_time_summary",
    {
      title: "Souhrn času za spis/období",
      description: "Sečte hodiny a částky za všechny časové záznamy podle spisu, uživatele a období (prochází všechny stránky, max. 2000 záznamů). Členění podle uživatele a stavu fakturace.",
      inputSchema: {
        matter_id: z.number().int().optional(),
        user_id: z.number().int().optional(),
        start_date: dateSchema.optional(),
        end_date: dateSchema.optional(),
        status: z.enum(["billed", "draft", "unbilled", "non_billable", "billable", "written_off"]).optional(),
      },
    },
    wrap("clio_time_summary", async (a: { matter_id?: number; user_id?: number; start_date?: string; end_date?: string; status?: string }) => {
      if (!a.matter_id && !a.user_id && !a.start_date) return text("Zadejte alespoň matter_id, user_id nebo start_date.");
      const r = await apiListAll<Act>("/activities", { ...compact(a), type: "TimeEntry", fields: "id,quantity_in_hours,total,non_billable,billed,user{name},matter{display_number}" }, 2000);
      const by = <K extends string>(key: (x: Act) => K) => {
        const m: Record<string, { hours: number; amount: number; count: number }> = {};
        for (const x of r.data) {
          const k = key(x);
          m[k] ??= { hours: 0, amount: 0, count: 0 };
          m[k].hours += x.quantity_in_hours ?? 0;
          m[k].amount += x.total ?? 0;
          m[k].count++;
        }
        for (const v of Object.values(m)) {
          v.hours = +v.hours.toFixed(2);
          v.amount = +v.amount.toFixed(2);
        }
        return m;
      };
      return json({
        records: r.data.length,
        truncated: r.truncated,
        total: { hours: +r.data.reduce((s, x) => s + (x.quantity_in_hours ?? 0), 0).toFixed(2), amount: +r.data.reduce((s, x) => s + (x.total ?? 0), 0).toFixed(2) },
        by_user: by((x) => x.user?.name ?? "?"),
        by_billing_status: by((x) => (x.non_billable ? "non_billable" : x.billed ? "billed" : "unbilled")),
        by_matter: a.matter_id ? undefined : by((x) => x.matter?.display_number ?? "?"),
      });
    })
  );

  server.registerTool(
    "clio_activity_descriptions_list",
    {
      title: "Číselník činností a sazeb",
      description: "Vypíše ActivityDescriptions (typy činností/výdajů s výchozí sazbou) – potřebné pro správné vyplnění activity_description_id při zápisu času.",
      inputSchema: {
        flat_rate: z.boolean().optional().describe("true = jen paušální činnosti"),
        matter_id: z.number().int().optional().describe("Vrátit sazby platné pro daný spis"),
        query: z.string().optional().describe("Filtr podle názvu (na straně konektoru)"),
      },
    },
    wrap("clio_activity_descriptions_list", async ({ flat_rate, matter_id, query }: { flat_rate?: boolean; matter_id?: number; query?: string }) => {
      const q: Record<string, string | number | boolean | undefined> = compact({ flat_rate });
      if (matter_id) q["rate_for[matter_id]"] = matter_id;
      const r = await apiListAll<{ name?: string }>("/activity_descriptions", { ...q, fields: "id,name,type,default,rate{amount,type},category_type,groups{id,name}" }, 500);
      const data = query ? r.data.filter((x) => (x.name ?? "").toLowerCase().includes(query.toLowerCase())) : r.data;
      return json({ records: data.length, activity_descriptions: data });
    })
  );

  server.registerTool(
    "clio_time_entry_create",
    {
      title: "Zapsat čas",
      description:
        "Zapíše časový záznam (TimeEntry) ke spisu: datum, hodiny (desetinně, např. 0.5), poznámka, volitelně činnost (activity_description_id), sazba (price/hod), uživatel (výchozí přihlášený), ne/fakturovatelné. " +
        "Zápis – vyžaduje confirm=true; bez něj vrátí náhled.",
      inputSchema: {
        matter_id: z.number().int(),
        date: dateSchema.describe("Datum úkonu YYYY-MM-DD"),
        hours: z.number().positive().describe("Počet hodin, desetinně (0.25 = 15 min)"),
        note: z.string().describe("Popis úkonu (objeví se na faktuře)"),
        activity_description_id: z.number().int().optional(),
        price: z.number().optional().describe("Hodinová sazba; výchozí podle sazby uživatele/spisu"),
        user_id: z.number().int().optional().describe("Výchozí přihlášený uživatel"),
        non_billable: z.boolean().optional(),
        no_charge: z.boolean().optional(),
        reference: z.string().optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_time_entry_create", async (a: { matter_id: number; date: string; hours: number; note: string; activity_description_id?: number; price?: number; user_id?: number; non_billable?: boolean; no_charge?: boolean; reference?: string; confirm?: boolean }) => {
      const userId = a.user_id ?? loadTokens()?.user?.id;
      const body = compact({
        type: "TimeEntry",
        date: a.date,
        quantity: hoursToSeconds(a.hours),
        note: a.note,
        matter: { id: a.matter_id },
        activity_description: a.activity_description_id ? { id: a.activity_description_id } : undefined,
        price: a.price,
        user: userId ? { id: userId } : undefined,
        non_billable: a.non_billable,
        no_charge: a.no_charge,
        reference: a.reference,
      });
      if (!a.confirm) return preview("Nový časový záznam", { ...body, hours: a.hours });
      const r = await apiRequest<{ data: unknown }>("POST", "/activities", { query: { fields: ACT_FIELDS }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_expense_create",
    {
      title: "Zapsat výdaj",
      description: "Zapíše výdaj (ExpenseEntry) ke spisu: datum, částka (price × quantity), popis, volitelně kategorie výdaje. Zápis – vyžaduje confirm=true.",
      inputSchema: {
        matter_id: z.number().int(),
        date: dateSchema,
        price: z.number().describe("Jednotková cena"),
        quantity: z.number().positive().optional().describe("Množství, výchozí 1"),
        note: z.string(),
        expense_category_id: z.number().int().optional(),
        non_billable: z.boolean().optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_expense_create", async (a: { matter_id: number; date: string; price: number; quantity?: number; note: string; expense_category_id?: number; non_billable?: boolean; confirm?: boolean }) => {
      const body = compact({ type: "ExpenseEntry", date: a.date, price: a.price, quantity: a.quantity ?? 1, note: a.note, matter: { id: a.matter_id }, expense_category: a.expense_category_id ? { id: a.expense_category_id } : undefined, non_billable: a.non_billable });
      if (!a.confirm) return preview("Nový výdaj", body);
      const r = await apiRequest<{ data: unknown }>("POST", "/activities", { query: { fields: ACT_FIELDS }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_activity_update",
    {
      title: "Upravit časový záznam / výdaj",
      description: "Upraví existující záznam (dokud není vyfakturován): datum, hodiny, poznámku, sazbu, činnost, ne/fakturovatelnost. Zápis – vyžaduje confirm=true.",
      inputSchema: {
        activity_id: z.number().int(),
        date: dateSchema.optional(),
        hours: z.number().positive().optional().describe("Nové hodiny (jen TimeEntry)"),
        quantity: z.number().optional().describe("Nové množství (výdaje)"),
        note: z.string().optional(),
        price: z.number().optional(),
        activity_description_id: z.number().int().optional(),
        matter_id: z.number().int().optional().describe("Přesun na jiný spis"),
        non_billable: z.boolean().optional(),
        no_charge: z.boolean().optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_activity_update", async (a: { activity_id: number; date?: string; hours?: number; quantity?: number; note?: string; price?: number; activity_description_id?: number; matter_id?: number; non_billable?: boolean; no_charge?: boolean; confirm?: boolean }) => {
      const body = compact({
        date: a.date,
        quantity: a.hours !== undefined ? hoursToSeconds(a.hours) : a.quantity,
        note: a.note,
        price: a.price,
        activity_description: a.activity_description_id ? { id: a.activity_description_id } : undefined,
        matter: a.matter_id ? { id: a.matter_id } : undefined,
        non_billable: a.non_billable,
        no_charge: a.no_charge,
      });
      if (!Object.keys(body).length) return text("Nebyla zadána žádná změna.");
      if (!a.confirm) {
        const cur = await apiRequest<{ data: unknown }>("GET", `/activities/${a.activity_id}`, { query: { fields: ACT_FIELDS } });
        return preview(`Úprava záznamu ${a.activity_id}`, { current: cur.data.data, changes: body });
      }
      const r = await apiRequest<{ data: unknown }>("PATCH", `/activities/${a.activity_id}`, { query: { fields: ACT_FIELDS }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_timer",
    {
      title: "Časovač",
      description: "Zobrazí běžící časovač přihlášeného uživatele, nebo spustí nový časovač na spisu (action=start; vytvoří rozpracovaný TimeEntry). Zastavení: action=stop. Spuštění/zastavení je zápis – confirm=true.",
      inputSchema: {
        action: z.enum(["status", "start", "stop"]).optional().describe("Výchozí status"),
        matter_id: z.number().int().optional().describe("Pro start"),
        note: z.string().optional().describe("Pro start"),
        activity_description_id: z.number().int().optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_timer", async ({ action, matter_id, note, activity_description_id, confirm }: { action?: string; matter_id?: number; note?: string; activity_description_id?: number; confirm?: boolean }) => {
      const act = action ?? "status";
      if (act === "status") {
        try {
          const r = await apiRequest<{ data: unknown }>("GET", "/timer", { query: { fields: "id,start_time,elapsed_time,activity{id,note,matter{id,display_number}}" } });
          return json(r.data.data);
        } catch (e) {
          if ((e as { status?: number }).status === 404) return text("Žádný časovač neběží.");
          throw e;
        }
      }
      if (act === "start") {
        if (!matter_id) return text("Pro start zadejte matter_id.");
        const activity = compact({ type: "TimeEntry", date: new Date().toISOString().slice(0, 10), matter: { id: matter_id }, note, activity_description: activity_description_id ? { id: activity_description_id } : undefined, quantity: 0 });
        if (!confirm) return preview("Spustit časovač", { activity });
        const created = await apiRequest<{ data: { id: number } }>("POST", "/activities", { query: { fields: "id" }, body: { ...activity, start_timer: true } });
        return json({ started: true, activity_id: created.data.data.id });
      }
      if (!confirm) return preview("Zastavit časovač", {});
      return text("Zastavení časovače vyžaduje DELETE /timer, který je v tomto konektoru blokován. Zastavte časovač v Clio (tlačítko Stop); zapsaný čas pak upravte nástrojem clio_activity_update.");
    })
  );

  // ---------------- Billing (podklady pro fakturaci) ----------------

  server.registerTool(
    "clio_billable_matters_list",
    {
      title: "Spisy s nevyfakturovaným časem",
      description: "Vypíše spisy s nevyfakturovanými hodinami/částkami (podklad pro přípravu faktur), volitelně za období a klienta. Slouží pro měsíční fakturaci.",
      inputSchema: {
        client_id: z.number().int().optional(),
        matter_id: z.number().int().optional(),
        responsible_attorney_id: z.number().int().optional(),
        start_date: dateSchema.optional(),
        end_date: dateSchema.optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        page_token: z.string().optional(),
      },
    },
    wrap("clio_billable_matters_list", async (a: { client_id?: number; matter_id?: number; responsible_attorney_id?: number; start_date?: string; end_date?: string; query?: string; limit?: number; page_token?: string }) => {
      const r = await apiList<{ unbilled_hours?: number; unbilled_amount?: number }>("/billable_matters", { ...compact({ ...a, page_token: undefined }), fields: "id,display_number,unbilled_hours,unbilled_amount,amount_in_trust,currency_code,client{id,name}", limit: a.limit ?? 100 }, { page_token: a.page_token });
      return json({ records: r.records, has_more: r.has_more, next_page_token: r.next_page_token, total_unbilled_hours: +r.data.reduce((s, x) => s + (x.unbilled_hours ?? 0), 0).toFixed(2), total_unbilled_amount: +r.data.reduce((s, x) => s + (x.unbilled_amount ?? 0), 0).toFixed(2), billable_matters: r.data });
    })
  );

  const BILL_FIELDS = "id,number,subject,state,kind,type,issued_at,due_at,start_at,end_at,total,paid,due,balance,sub_total,tax_sum,total_tax,memo,created_at,updated_at,client{id,name},matters{id,display_number},user{id,name},available_state_transitions,can_update";

  server.registerTool(
    "clio_bills_list",
    {
      title: "Výpis faktur (bills)",
      description: "Vypíše bills (v Clio jen podklad pro skutečnou fakturu) podle stavu (draft, awaiting_approval, awaiting_payment, paid, void), klienta, spisu, období vystavení nebo po splatnosti.",
      inputSchema: {
        state: z.enum(["draft", "awaiting_approval", "awaiting_payment", "paid", "void", "deleted"]).optional(),
        overdue_only: z.boolean().optional(),
        client_id: z.number().int().optional(),
        matter_id: z.number().int().optional(),
        issued_after: dateSchema.optional(),
        issued_before: dateSchema.optional(),
        query: z.string().optional().describe("Číslo/předmět"),
        type: z.enum(["revenue", "trust"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        page_token: z.string().optional(),
      },
    },
    wrap("clio_bills_list", async (a: Record<string, unknown> & { limit?: number; page_token?: string }) => {
      const r = await apiList<{ total?: number; due?: number }>("/bills", { ...(compact({ ...a, page_token: undefined, limit: undefined }) as Record<string, string | number | boolean>), fields: BILL_FIELDS, limit: a.limit ?? 50, order: "issued_at(desc)" }, { page_token: a.page_token });
      return json({ records: r.records, has_more: r.has_more, next_page_token: r.next_page_token, sum_total: +r.data.reduce((s, x) => s + (x.total ?? 0), 0).toFixed(2), sum_due: +r.data.reduce((s, x) => s + (x.due ?? 0), 0).toFixed(2), bills: r.data });
    })
  );

  server.registerTool(
    "clio_bill_get",
    {
      title: "Detail bill včetně položek",
      description: "Vrátí detail bill a jeho položky (line items: datum, popis, množství, cena, celkem, vazba na časový záznam). Volitelně i předrenderované HTML podkladu.",
      inputSchema: { bill_id: z.number().int(), include_html: z.boolean().optional() },
    },
    wrap("clio_bill_get", async ({ bill_id, include_html }: { bill_id: number; include_html?: boolean }) => {
      const b = await apiRequest<{ data: unknown }>("GET", `/bills/${bill_id}`, { query: { fields: BILL_FIELDS + ",balances{id,amount,due,interest_amount},matter_totals{id,amount},discount{rate,type,note}" } });
      const items = await apiListAll("/line_items", { bill_id, fields: "id,type,kind,date,description,quantity,price,total,sub_total,tax,taxable,note,matter{id,display_number},activity{id,type,quantity_in_hours},user{id,name}" }, 1000);
      let html: string | undefined;
      if (include_html) {
        const h = await apiRequest<{ data?: unknown; raw?: string }>("GET", `/bills/${bill_id}/preview`);
        html = typeof h.data === "object" && h.data && "raw" in h.data ? String((h.data as { raw: string }).raw) : JSON.stringify(h.data).slice(0, 20000);
      }
      return json({ bill: b.data.data, line_items: items.data, line_items_truncated: items.truncated, html });
    })
  );

  server.registerTool(
    "clio_bill_update",
    {
      title: "Upravit bill",
      description: "Upraví hlavičku bill (předmět, poznámka/memo, datum vystavení, splatnost, stav – např. draft → awaiting_approval, void). Zápis – vyžaduje confirm=true. Odesílání klientovi konektor neprovádí.",
      inputSchema: {
        bill_id: z.number().int(),
        subject: z.string().optional(),
        memo: z.string().optional(),
        issued_at: dateSchema.optional(),
        due_at: dateSchema.optional(),
        number: z.string().optional(),
        state: z.enum(["draft", "awaiting_approval", "awaiting_payment", "paid", "void"]).optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_bill_update", async ({ bill_id, confirm, ...changes }: { bill_id: number; confirm?: boolean } & Record<string, unknown>) => {
      const body = compact(changes);
      if (!Object.keys(body).length) return text("Nebyla zadána žádná změna.");
      if (!confirm) {
        const cur = await apiRequest<{ data: unknown }>("GET", `/bills/${bill_id}`, { query: { fields: BILL_FIELDS } });
        return preview(`Úprava bill ${bill_id}`, { current: cur.data.data, changes: body });
      }
      const r = await apiRequest<{ data: unknown }>("PATCH", `/bills/${bill_id}`, { query: { fields: BILL_FIELDS }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_line_item_update",
    {
      title: "Upravit položku bill",
      description: "Upraví položku bill (popis, množství, cena, datum, poznámka); s update_original_record=true se změna propíše i do původního časového záznamu. Zápis – vyžaduje confirm=true.",
      inputSchema: {
        line_item_id: z.number().int(),
        description: z.string().optional(),
        quantity: z.number().optional().describe("U služeb v hodinách"),
        price: z.number().optional(),
        date: dateSchema.optional(),
        note: z.string().optional(),
        update_original_record: z.boolean().optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_line_item_update", async ({ line_item_id, confirm, ...changes }: { line_item_id: number; confirm?: boolean } & Record<string, unknown>) => {
      const body = compact(changes);
      if (!Object.keys(body).length) return text("Nebyla zadána žádná změna.");
      if (!confirm) return preview(`Úprava položky ${line_item_id}`, body);
      const r = await apiRequest<{ data: unknown }>("PATCH", `/line_items/${line_item_id}`, { query: { fields: "id,description,quantity,price,total,date,note" }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_outstanding_balances",
    {
      title: "Neuhrazené zůstatky klientů",
      description: "Vypíše klienty s neuhrazenými bills: celkový dluh, poslední platba, nejnovější splatnost, seznam neuhrazených bills.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional(), page_token: z.string().optional() },
    },
    wrap("clio_outstanding_balances", async ({ limit, page_token }: { limit?: number; page_token?: string }) => {
      const r = await apiList<{ total_outstanding_balance?: number }>("/outstanding_client_balances", { fields: "id,total_outstanding_balance,last_payment_date,newest_issued_bill_due_date,pending_payments_total,contact{id,name},outstanding_bills{id,number,due,due_at,state}", limit: limit ?? 100 }, { page_token });
      return json({ has_more: r.has_more, next_page_token: r.next_page_token, sum_outstanding: +r.data.reduce((s, x) => s + (x.total_outstanding_balance ?? 0), 0).toFixed(2), balances: r.data });
    })
  );
};
