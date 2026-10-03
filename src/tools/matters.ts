/** Matters, contacts, tasks, calendar, notes, communications, users, custom fields. */
import { z } from "zod";
import { apiRequest, apiList, apiListAll } from "../client.js";
import { loadTokens } from "../store.js";
import { t } from "../i18n.js";
import { text, json, wrap, preview, confirmSchema, compact, dateSchema, type Registrar } from "./common.js";

const MATTER_FIELDS =
  "id,display_number,number,description,status,billing_method,billable,open_date,close_date,pending_date,location,client_reference,last_activity_date,created_at,updated_at,client{id,name,type},responsible_attorney{id,name},originating_attorney{id,name},practice_area{id,name},matter_stage{id,name},folder{id}";
const MATTER_DETAIL = MATTER_FIELDS + ",custom_field_values{id,field_name,field_type,value},account_balances{id,balance,type},statute_of_limitations{id,name,due_at},relationships{id,description,contact},maildrop_address";
const CONTACT_FIELDS =
  "id,name,type,first_name,last_name,title,is_client,primary_email_address,primary_phone_number,created_at,updated_at,company{id,name},primary_address{street,city,postal_code,country}";
const CONTACT_DETAIL = CONTACT_FIELDS + ",date_of_birth,email_addresses{id,address,name,default_email},phone_numbers{id,number,name,default_number},addresses{id,street,city,province,postal_code,country,name},custom_field_values{id,field_name,field_type,value},sales_tax_number,ledes_client_id";
const TASK_FIELDS = "id,name,description,status,priority,due_at,completed_at,created_at,updated_at,matter{id,display_number},assignee{id,name,type},assigner{id,name},task_type{id,name}";
const CAL_FIELDS = "id,summary,description,location,start_at,end_at,all_day,created_at,updated_at,matter{id,display_number},calendar_owner{id,name},attendees{id,name,type},calendar_entry_event_type{id,name}";
const NOTE_FIELDS = "id,type,subject,detail,date,created_at,updated_at,matter{id,display_number},contact{id,name},author{id,name}";
const COMM_FIELDS = "id,type,subject,body,date,received_at,created_at,matter{id,display_number},user{id,name},senders{id,name,type},receivers{id,name,type}";

export const registerMatters: Registrar = (server) => {
  // ---------- Matters ----------
  server.registerTool(
    "clio_matter_search",
    {
      title: "Search matters",
      description: "Searches matters by text (number, description), client, status (open/pending/closed), responsible attorney or practice area. Returns basic details including the matter id needed by the other tools.",
      inputSchema: {
        query: z.string().optional().describe("Text in display_number, number or description"),
        client_id: z.number().int().optional(),
        status: z.enum(["open", "pending", "closed"]).optional().describe("Several values may be comma-separated, e.g. 'open,pending'"),
        responsible_attorney_id: z.number().int().optional(),
        practice_area_id: z.number().int().optional(),
        updated_since: z.string().optional().describe("ISO date/time"),
        order: z.enum(["display_number(asc)", "display_number(desc)", "open_date(desc)", "updated_at(desc)", "client.name(asc)", "id(asc)"]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 25"),
        page_token: z.string().optional(),
      },
    },
    wrap("clio_matter_search", async (a: Record<string, unknown> & { limit?: number; page_token?: string; order?: string }) => {
      const r = await apiList("/matters", { ...(compact({ ...a, limit: undefined, page_token: undefined, order: undefined }) as Record<string, string | number | boolean>), fields: MATTER_FIELDS, limit: a.limit ?? 25, order: a.order ?? "updated_at(desc)" }, { page_token: a.page_token });
      return json({ records: r.records, has_more: r.has_more, next_page_token: r.next_page_token, matters: r.data });
    })
  );

  server.registerTool(
    "clio_matter_get",
    {
      title: "Matter detail",
      description: "Returns matter detail including client, custom fields, account balances, statute of limitations, relationships and related contacts. Optionally also a summary of unbilled time.",
      inputSchema: { matter_id: z.number().int(), include_related_contacts: z.boolean().optional(), include_unbilled: z.boolean().optional() },
    },
    wrap("clio_matter_get", async ({ matter_id, include_related_contacts, include_unbilled }: { matter_id: number; include_related_contacts?: boolean; include_unbilled?: boolean }) => {
      const m = await apiRequest<{ data: unknown }>("GET", `/matters/${matter_id}`, { query: { fields: MATTER_DETAIL } });
      const out: Record<string, unknown> = { matter: m.data.data };
      if (include_related_contacts) {
        const rc = await apiList(`/matters/${matter_id}/related_contacts`, { fields: "id,contact_id,name,type,is_matter_client,primary_email_address,primary_phone_number,relationship", limit: 100 });
        out.related_contacts = rc.data;
      }
      if (include_unbilled) {
        const bm = await apiList(`/billable_matters`, { matter_id, fields: "id,unbilled_hours,unbilled_amount,amount_in_trust,currency_code", limit: 1 });
        out.unbilled = bm.data[0] ?? null;
      }
      return json(out);
    })
  );

  server.registerTool(
    "clio_matter_create",
    {
      title: "Create matter",
      description: "Creates a new matter: client (client_id), description, status, billing method, responsible attorney (defaults to the signed-in user), practice area, custom fields. Write operation – requires confirm=true.",
      inputSchema: {
        client_id: z.number().int(),
        description: z.string(),
        status: z.enum(["open", "pending", "closed"]).optional(),
        billing_method: z.enum(["hourly", "flat", "contingency"]).optional(),
        billable: z.boolean().optional(),
        responsible_attorney_id: z.number().int().optional(),
        originating_attorney_id: z.number().int().optional(),
        practice_area_id: z.number().int().optional(),
        open_date: dateSchema.optional(),
        client_reference: z.string().optional(),
        location: z.string().optional(),
        custom_field_values: z.array(z.object({ custom_field_id: z.number().int(), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_matter_create", async (a: { client_id: number; description: string; status?: string; billing_method?: string; billable?: boolean; responsible_attorney_id?: number; originating_attorney_id?: number; practice_area_id?: number; open_date?: string; client_reference?: string; location?: string; custom_field_values?: { custom_field_id: number; value: unknown }[]; confirm?: boolean }) => {
      const me = loadTokens()?.user?.id;
      const body = compact({
        client: { id: a.client_id },
        description: a.description,
        status: a.status ?? "open",
        billable: a.billable ?? true,
        responsible_attorney: a.responsible_attorney_id ?? me ? { id: a.responsible_attorney_id ?? me } : undefined,
        originating_attorney: a.originating_attorney_id ? { id: a.originating_attorney_id } : undefined,
        practice_area: a.practice_area_id ? { id: a.practice_area_id } : undefined,
        open_date: a.open_date,
        client_reference: a.client_reference,
        location: a.location,
        custom_field_values: a.custom_field_values?.map((c) => ({ custom_field: { id: c.custom_field_id }, value: c.value })),
      });
      if (a.billing_method) (body as Record<string, unknown>).billing_method = a.billing_method;
      if (!a.confirm) return preview(t("matters.preview_new_matter"), body);
      const r = await apiRequest<{ data: unknown }>("POST", "/matters", { query: { fields: MATTER_FIELDS }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_matter_update",
    {
      title: "Update matter",
      description: "Updates a matter: description, status (open/pending/closed), responsible attorney, practice area, custom fields, close date etc. Write operation – requires confirm=true.",
      inputSchema: {
        matter_id: z.number().int(),
        description: z.string().optional(),
        status: z.enum(["open", "pending", "closed"]).optional(),
        close_date: dateSchema.optional(),
        responsible_attorney_id: z.number().int().optional(),
        practice_area_id: z.number().int().optional(),
        client_reference: z.string().optional(),
        location: z.string().optional(),
        billable: z.boolean().optional(),
        custom_field_values: z.array(z.object({ id: z.number().int().optional().describe("id of the existing value (to change it)"), custom_field_id: z.number().int(), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_matter_update", async (a: { matter_id: number; description?: string; status?: string; close_date?: string; responsible_attorney_id?: number; practice_area_id?: number; client_reference?: string; location?: string; billable?: boolean; custom_field_values?: { id?: number; custom_field_id: number; value: unknown }[]; confirm?: boolean }) => {
      const body = compact({
        description: a.description,
        status: a.status,
        close_date: a.close_date,
        responsible_attorney: a.responsible_attorney_id ? { id: a.responsible_attorney_id } : undefined,
        practice_area: a.practice_area_id ? { id: a.practice_area_id } : undefined,
        client_reference: a.client_reference,
        location: a.location,
        billable: a.billable,
        custom_field_values: a.custom_field_values?.map((c) => compact({ id: c.id, custom_field: { id: c.custom_field_id }, value: c.value })),
      });
      if (!Object.keys(body).length) return text(t("matters.no_changes"));
      if (!a.confirm) {
        const cur = await apiRequest<{ data: unknown }>("GET", `/matters/${a.matter_id}`, { query: { fields: MATTER_FIELDS } });
        return preview(t("matters.preview_update_matter", { id: a.matter_id }), { current: cur.data.data, changes: body });
      }
      const r = await apiRequest<{ data: unknown }>("PATCH", `/matters/${a.matter_id}`, { query: { fields: MATTER_DETAIL }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_practice_areas_list",
    { title: "Practice areas and matter stages", description: "Lists practice areas and matter stages (for creating/updating matters).", inputSchema: {} },
    wrap("clio_practice_areas_list", async () => {
      const pa = await apiListAll("/practice_areas", { fields: "id,name,code,category" }, 500);
      const ms = await apiListAll("/matter_stages", { fields: "id,name,practice_area_id,order" }, 500);
      return json({ practice_areas: pa.data, matter_stages: ms.data });
    })
  );

  server.registerTool(
    "clio_custom_fields_list",
    {
      title: "Custom field definitions",
      description: "Lists custom fields for matters or contacts (id, name, type, picklist options) – required to fill in custom_field_values.",
      inputSchema: { parent_type: z.enum(["Matter", "Contact"]).optional() },
    },
    wrap("clio_custom_fields_list", async ({ parent_type }: { parent_type?: string }) => {
      const r = await apiListAll("/custom_fields", { ...compact({ parent_type }), fields: "id,name,parent_type,field_type,displayed,required,deleted,picklist_options{id,option}" }, 500);
      return json({ custom_fields: r.data });
    })
  );

  // ---------- Contacts ----------
  server.registerTool(
    "clio_contact_search",
    {
      title: "Search contacts",
      description: "Searches people and companies by name, e-mail or phone (query); optionally only clients or only type Person/Company.",
      inputSchema: {
        query: z.string().optional(),
        type: z.enum(["Person", "Company"]).optional(),
        client_only: z.boolean().optional(),
        ids: z.array(z.number().int()).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 25"),
        page_token: z.string().optional(),
      },
    },
    wrap("clio_contact_search", async ({ query, type, client_only, ids, limit, page_token }: { query?: string; type?: string; client_only?: boolean; ids?: number[]; limit?: number; page_token?: string }) => {
      const q: Record<string, string | number | boolean | undefined> = compact({ query, type, client_only });
      if (ids?.length) q["ids[]"] = ids.join(",");
      const r = await apiList("/contacts", { ...q, fields: CONTACT_FIELDS, limit: limit ?? 25, order: "name(asc)" }, { page_token });
      return json({ records: r.records, has_more: r.has_more, next_page_token: r.next_page_token, contacts: r.data });
    })
  );

  server.registerTool(
    "clio_contact_get",
    {
      title: "Contact detail",
      description: "Returns contact detail including all e-mail addresses, phone numbers, addresses and custom fields; optionally also the list of the contact's matters.",
      inputSchema: { contact_id: z.number().int(), include_matters: z.boolean().optional() },
    },
    wrap("clio_contact_get", async ({ contact_id, include_matters }: { contact_id: number; include_matters?: boolean }) => {
      const c = await apiRequest<{ data: unknown }>("GET", `/contacts/${contact_id}`, { query: { fields: CONTACT_DETAIL } });
      const out: Record<string, unknown> = { contact: c.data.data };
      if (include_matters) {
        const m = await apiList("/matters", { client_id: contact_id, fields: "id,display_number,description,status,open_date", limit: 100, order: "open_date(desc)" });
        out.matters = m.data;
      }
      return json(out);
    })
  );

  const addressSchema = z.object({ name: z.enum(["Work", "Home", "Billing", "Other"]).optional(), street: z.string().optional(), city: z.string().optional(), province: z.string().optional(), postal_code: z.string().optional(), country: z.string().optional() });

  server.registerTool(
    "clio_contact_create",
    {
      title: "Create contact",
      description: "Creates a person (first_name + last_name) or a company (name) with e-mail addresses, phone numbers, address, tax/VAT number (sales_tax_number) and a link to a company. Write operation – requires confirm=true.",
      inputSchema: {
        type: z.enum(["Person", "Company"]),
        name: z.string().optional().describe("Company name (Company)"),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        prefix: z.string().optional().describe("Title before the name (e.g. Dr., Mr.)"),
        title: z.string().optional().describe("Job title / position"),
        email: z.string().optional(),
        phone: z.string().optional(),
        address: addressSchema.optional(),
        company_id: z.number().int().optional(),
        date_of_birth: dateSchema.optional(),
        sales_tax_number: z.string().optional().describe("VAT / tax identification number"),
        custom_field_values: z.array(z.object({ custom_field_id: z.number().int(), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_contact_create", async (a: { type: "Person" | "Company"; name?: string; first_name?: string; last_name?: string; prefix?: string; title?: string; email?: string; phone?: string; address?: Record<string, string | undefined>; company_id?: number; date_of_birth?: string; sales_tax_number?: string; custom_field_values?: { custom_field_id: number; value: unknown }[]; confirm?: boolean }) => {
      if (a.type === "Company" && !a.name) return text(t("matters.company_requires_name"));
      if (a.type === "Person" && !(a.first_name && a.last_name)) return text(t("matters.person_requires_names"));
      const body = compact({
        type: a.type,
        name: a.type === "Company" ? a.name : undefined,
        first_name: a.first_name,
        last_name: a.last_name,
        prefix: a.prefix,
        title: a.title,
        email_addresses: a.email ? [{ name: "Work", address: a.email, default_email: true }] : undefined,
        phone_numbers: a.phone ? [{ name: "Work", number: a.phone, default_number: true }] : undefined,
        addresses: a.address ? [compact({ name: "Work", ...a.address })] : undefined,
        company: a.company_id ? { id: a.company_id } : undefined,
        date_of_birth: a.date_of_birth,
        sales_tax_number: a.sales_tax_number,
        custom_field_values: a.custom_field_values?.map((c) => ({ custom_field: { id: c.custom_field_id }, value: c.value })),
      });
      if (a.type === "Person") (body as Record<string, unknown>).name = `${a.first_name} ${a.last_name}`;
      if (!a.confirm) return preview(t("matters.preview_new_contact"), body);
      const r = await apiRequest<{ data: unknown }>("POST", "/contacts", { query: { fields: CONTACT_DETAIL }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_contact_update",
    {
      title: "Update contact",
      description: "Updates a contact's basic details; adds an e-mail address/phone number/address (existing ones are kept). Write operation – requires confirm=true.",
      inputSchema: {
        contact_id: z.number().int(),
        name: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        prefix: z.string().optional(),
        title: z.string().optional(),
        add_email: z.string().optional(),
        add_phone: z.string().optional(),
        add_address: addressSchema.optional(),
        company_id: z.number().int().optional(),
        sales_tax_number: z.string().optional(),
        custom_field_values: z.array(z.object({ id: z.number().int().optional(), custom_field_id: z.number().int(), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_contact_update", async (a: { contact_id: number; name?: string; first_name?: string; last_name?: string; prefix?: string; title?: string; add_email?: string; add_phone?: string; add_address?: Record<string, string | undefined>; company_id?: number; sales_tax_number?: string; custom_field_values?: { id?: number; custom_field_id: number; value: unknown }[]; confirm?: boolean }) => {
      const body = compact({
        name: a.name,
        first_name: a.first_name,
        last_name: a.last_name,
        prefix: a.prefix,
        title: a.title,
        email_addresses: a.add_email ? [{ name: "Work", address: a.add_email }] : undefined,
        phone_numbers: a.add_phone ? [{ name: "Work", number: a.add_phone }] : undefined,
        addresses: a.add_address ? [compact({ name: "Work", ...a.add_address })] : undefined,
        company: a.company_id ? { id: a.company_id } : undefined,
        sales_tax_number: a.sales_tax_number,
        custom_field_values: a.custom_field_values?.map((c) => compact({ id: c.id, custom_field: { id: c.custom_field_id }, value: c.value })),
      });
      if (!Object.keys(body).length) return text(t("matters.no_changes"));
      if (!a.confirm) {
        const cur = await apiRequest<{ data: unknown }>("GET", `/contacts/${a.contact_id}`, { query: { fields: CONTACT_FIELDS } });
        return preview(t("matters.preview_update_contact", { id: a.contact_id }), { current: cur.data.data, changes: body });
      }
      const r = await apiRequest<{ data: unknown }>("PATCH", `/contacts/${a.contact_id}`, { query: { fields: CONTACT_DETAIL }, body });
      return json(r.data.data);
    })
  );

  // ---------- Tasks ----------
  server.registerTool(
    "clio_task_list",
    {
      title: "Tasks",
      description: "Lists tasks by matter, assignee, status, due date (from–to) or text. Default: the signed-in user's incomplete tasks sorted by due date.",
      inputSchema: {
        matter_id: z.number().int().optional(),
        assignee_id: z.number().int().optional().describe("User ID; defaults to the signed-in user unless matter_id is given"),
        all_assignees: z.boolean().optional().describe("true = tasks of all users"),
        status: z.enum(["pending", "in_progress", "in_review", "complete", "draft"]).optional(),
        complete: z.boolean().optional().describe("false = only incomplete (default), true = only completed"),
        due_at_from: dateSchema.optional(),
        due_at_to: dateSchema.optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        page_token: z.string().optional(),
      },
    },
    wrap("clio_task_list", async (a: { matter_id?: number; assignee_id?: number; all_assignees?: boolean; status?: string; complete?: boolean; due_at_from?: string; due_at_to?: string; query?: string; limit?: number; page_token?: string }) => {
      const me = loadTokens()?.user?.id;
      const assignee = a.all_assignees ? undefined : a.assignee_id ?? (a.matter_id ? undefined : me);
      const q = compact({ matter_id: a.matter_id, assignee_id: assignee, assignee_type: assignee ? "User" : undefined, status: a.status, complete: a.complete ?? (a.status ? undefined : false), due_at_from: a.due_at_from, due_at_to: a.due_at_to, query: a.query });
      const r = await apiList("/tasks", { ...q, fields: TASK_FIELDS, limit: a.limit ?? 50, order: "due_at(asc)" }, { page_token: a.page_token });
      return json({ records: r.records, has_more: r.has_more, next_page_token: r.next_page_token, tasks: r.data });
    })
  );

  server.registerTool(
    "clio_task_create",
    {
      title: "Create task",
      description: "Creates a task for a matter (or a general one) with a due date, priority and assignee (defaults to the signed-in user). Write operation – requires confirm=true.",
      inputSchema: {
        name: z.string(),
        description: z.string().optional(),
        matter_id: z.number().int().optional(),
        due_at: z.string().optional().describe("YYYY-MM-DD or ISO date/time"),
        priority: z.enum(["High", "Normal", "Low"]).optional(),
        assignee_id: z.number().int().optional(),
        task_type_id: z.number().int().optional(),
        statute_of_limitations: z.boolean().optional().describe("true = mark as a statute of limitations deadline"),
        notify_assignee: z.boolean().optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_task_create", async (a: { name: string; description?: string; matter_id?: number; due_at?: string; priority?: string; assignee_id?: number; task_type_id?: number; statute_of_limitations?: boolean; notify_assignee?: boolean; confirm?: boolean }) => {
      const me = loadTokens()?.user?.id;
      const assignee = a.assignee_id ?? me;
      const body = compact({
        name: a.name,
        description: a.description ?? a.name,
        matter: a.matter_id ? { id: a.matter_id } : undefined,
        due_at: a.due_at && a.due_at.length === 10 ? `${a.due_at}T17:00:00` : a.due_at,
        priority: a.priority ?? "Normal",
        assignee: assignee ? { id: assignee, type: "User" } : undefined,
        task_type: a.task_type_id ? { id: a.task_type_id } : undefined,
        statute_of_limitations: a.statute_of_limitations,
        notify_assignee: a.notify_assignee,
        status: "pending",
      });
      if (!a.confirm) return preview(t("matters.preview_new_task"), body);
      const r = await apiRequest<{ data: unknown }>("POST", "/tasks", { query: { fields: TASK_FIELDS }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_task_update",
    {
      title: "Update / complete task",
      description: "Updates a task (name, description, due date, priority, assignee) or changes its status – status=complete marks the task as done. Write operation – requires confirm=true.",
      inputSchema: {
        task_id: z.number().int(),
        name: z.string().optional(),
        description: z.string().optional(),
        due_at: z.string().optional(),
        priority: z.enum(["High", "Normal", "Low"]).optional(),
        status: z.enum(["pending", "in_progress", "in_review", "complete", "draft"]).optional(),
        assignee_id: z.number().int().optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_task_update", async (a: { task_id: number; name?: string; description?: string; due_at?: string; priority?: string; status?: string; assignee_id?: number; confirm?: boolean }) => {
      const body = compact({ name: a.name, description: a.description, due_at: a.due_at && a.due_at.length === 10 ? `${a.due_at}T17:00:00` : a.due_at, priority: a.priority, status: a.status, assignee: a.assignee_id ? { id: a.assignee_id, type: "User" } : undefined });
      if (!Object.keys(body).length) return text(t("matters.no_changes"));
      if (!a.confirm) return preview(t("matters.preview_update_task", { id: a.task_id }), body);
      const r = await apiRequest<{ data: unknown }>("PATCH", `/tasks/${a.task_id}`, { query: { fields: TASK_FIELDS }, body });
      return json(r.data.data);
    })
  );

  // ---------- Calendar ----------
  server.registerTool(
    "clio_calendar_entries_list",
    {
      title: "Calendar",
      description: "Lists calendar entries in a period (from–to), optionally only for a matter or from a specific calendar. Default: the signed-in user's calendars.",
      inputSchema: {
        from: z.string().describe("From, YYYY-MM-DD or ISO"),
        to: z.string().describe("To, YYYY-MM-DD or ISO"),
        matter_id: z.number().int().optional(),
        calendar_id: z.number().int().optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        page_token: z.string().optional(),
      },
    },
    wrap("clio_calendar_entries_list", async (a: { from: string; to: string; matter_id?: number; calendar_id?: number; query?: string; limit?: number; page_token?: string }) => {
      const from = a.from.length === 10 ? `${a.from}T00:00:00` : a.from;
      const to = a.to.length === 10 ? `${a.to}T23:59:59` : a.to;
      const r = await apiList("/calendar_entries", { ...compact({ matter_id: a.matter_id, calendar_id: a.calendar_id, query: a.query }), from, to, expanded: true, fields: CAL_FIELDS, limit: a.limit ?? 100 }, { page_token: a.page_token });
      return json({ has_more: r.has_more, next_page_token: r.next_page_token, entries: r.data });
    })
  );

  server.registerTool(
    "clio_calendars_list",
    { title: "List calendars", description: "Lists the calendars available to the signed-in user (ids for creating calendar entries) and the calendar entry event types.", inputSchema: {} },
    wrap("clio_calendars_list", async () => {
      const cal = await apiListAll("/calendars", { fields: "id,name,type,color,permission,visible,source" }, 200);
      const types = await apiListAll("/calendar_entry_event_types", { fields: "id,name,color" }, 200);
      return json({ default_calendar_id: (await apiRequest<{ data: { default_calendar_id?: number } }>("GET", "/users/who_am_i", { query: { fields: "default_calendar_id" } })).data.data.default_calendar_id, calendars: cal.data, event_types: types.data });
    })
  );

  server.registerTool(
    "clio_calendar_entry_create",
    {
      title: "Create calendar entry",
      description: "Creates a calendar entry (hearing, deadline, meeting) in the user's calendar (defaults to the default calendar), optionally linked to a matter, with attendees and an event type. Write operation – requires confirm=true.",
      inputSchema: {
        summary: z.string().describe("Title of the calendar entry"),
        start_at: z.string().describe("ISO date/time, or YYYY-MM-DD for an all-day entry"),
        end_at: z.string().optional().describe("ISO date/time; optional for all-day entries"),
        all_day: z.boolean().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        matter_id: z.number().int().optional(),
        calendar_id: z.number().int().optional().describe("Defaults to the user's default calendar"),
        event_type_id: z.number().int().optional(),
        attendee_calendar_ids: z.array(z.number().int()).optional().describe("Calendar IDs of other users (see clio_calendars_list)"),
        attendee_contact_ids: z.array(z.number().int()).optional(),
        send_email_notification: z.boolean().optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_calendar_entry_create", async (a: { summary: string; start_at: string; end_at?: string; all_day?: boolean; description?: string; location?: string; matter_id?: number; calendar_id?: number; event_type_id?: number; attendee_calendar_ids?: number[]; attendee_contact_ids?: number[]; send_email_notification?: boolean; confirm?: boolean }) => {
      const allDay = a.all_day ?? a.start_at.length === 10;
      const calId = a.calendar_id ?? (await apiRequest<{ data: { default_calendar_id?: number } }>("GET", "/users/who_am_i", { query: { fields: "default_calendar_id" } })).data.data.default_calendar_id;
      if (!calId) return text(t("matters.calendar_not_determined"));
      const start = allDay && a.start_at.length === 10 ? `${a.start_at}T00:00:00` : a.start_at;
      const end = a.end_at ?? (allDay ? `${a.start_at.slice(0, 10)}T23:59:59` : new Date(new Date(a.start_at).getTime() + 3600e3).toISOString());
      const attendees = [...(a.attendee_calendar_ids ?? []).map((id) => ({ id, type: "Calendar" })), ...(a.attendee_contact_ids ?? []).map((id) => ({ id, type: "Contact" }))];
      const body = compact({
        summary: a.summary,
        start_at: start,
        end_at: end,
        all_day: allDay,
        description: a.description,
        location: a.location,
        matter: a.matter_id ? { id: a.matter_id } : undefined,
        calendar_owner: { id: calId },
        calendar_entry_event_type: a.event_type_id ? { id: a.event_type_id } : undefined,
        attendees: attendees.length ? attendees : undefined,
        send_email_notification: a.send_email_notification,
      });
      if (!a.confirm) return preview(t("matters.preview_new_calendar_entry"), body);
      const r = await apiRequest<{ data: unknown }>("POST", "/calendar_entries", { query: { fields: CAL_FIELDS }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_calendar_entry_update",
    {
      title: "Update calendar entry",
      description: "Updates the title, time, location, description or matter of a calendar entry. Write operation – requires confirm=true.",
      inputSchema: { entry_id: z.number().int(), summary: z.string().optional(), start_at: z.string().optional(), end_at: z.string().optional(), all_day: z.boolean().optional(), description: z.string().optional(), location: z.string().optional(), matter_id: z.number().int().optional(), confirm: confirmSchema },
    },
    wrap("clio_calendar_entry_update", async ({ entry_id, matter_id, confirm, ...rest }: { entry_id: number; matter_id?: number; confirm?: boolean } & Record<string, unknown>) => {
      const body = compact({ ...rest, matter: matter_id ? { id: matter_id } : undefined });
      if (!Object.keys(body).length) return text(t("matters.no_changes"));
      if (!confirm) return preview(t("matters.preview_update_calendar_entry", { id: entry_id }), body);
      const r = await apiRequest<{ data: unknown }>("PATCH", `/calendar_entries/${entry_id}`, { query: { fields: CAL_FIELDS }, body });
      return json(r.data.data);
    })
  );

  // ---------- Notes and communications ----------
  server.registerTool(
    "clio_notes_list",
    {
      title: "Matter / contact notes",
      description: "Lists the notes of a matter or a contact, newest first.",
      inputSchema: { matter_id: z.number().int().optional(), contact_id: z.number().int().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), page_token: z.string().optional() },
    },
    wrap("clio_notes_list", async ({ matter_id, contact_id, query, limit, page_token }: { matter_id?: number; contact_id?: number; query?: string; limit?: number; page_token?: string }) => {
      if (!matter_id && !contact_id) return text(t("matters.matter_or_contact_required"));
      const r = await apiList("/notes", { ...compact({ matter_id, contact_id, query, type: matter_id ? "Matter" : "Contact" }), fields: NOTE_FIELDS, limit: limit ?? 50, order: "date(desc)" }, { page_token });
      return json({ has_more: r.has_more, next_page_token: r.next_page_token, notes: r.data });
    })
  );

  server.registerTool(
    "clio_note_create",
    {
      title: "Add note",
      description: "Adds a note to a matter or a contact (subject + text). Write operation – requires confirm=true.",
      inputSchema: { matter_id: z.number().int().optional(), contact_id: z.number().int().optional(), subject: z.string(), detail: z.string(), date: dateSchema.optional(), confirm: confirmSchema },
    },
    wrap("clio_note_create", async ({ matter_id, contact_id, subject, detail, date, confirm }: { matter_id?: number; contact_id?: number; subject: string; detail: string; date?: string; confirm?: boolean }) => {
      if (!matter_id && !contact_id) return text(t("matters.matter_or_contact_required"));
      const body = compact({ type: matter_id ? "Matter" : "Contact", matter: matter_id ? { id: matter_id } : undefined, contact: contact_id ? { id: contact_id } : undefined, subject, detail, date: date ?? new Date().toISOString().slice(0, 10) });
      if (!confirm) return preview(t("matters.preview_new_note"), body);
      const r = await apiRequest<{ data: unknown }>("POST", "/notes", { query: { fields: NOTE_FIELDS }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_communications_list",
    {
      title: "Communications (e-mails, calls)",
      description: "Lists logged communications (EmailCommunication, PhoneCommunication) of a matter or a contact, newest first; optionally filtered by text or period.",
      inputSchema: { matter_id: z.number().int().optional(), contact_id: z.number().int().optional(), query: z.string().optional(), received_since: z.string().optional(), type: z.enum(["EmailCommunication", "PhoneCommunication"]).optional(), limit: z.number().int().min(1).max(200).optional(), page_token: z.string().optional() },
    },
    wrap("clio_communications_list", async (a: { matter_id?: number; contact_id?: number; query?: string; received_since?: string; type?: string; limit?: number; page_token?: string }) => {
      if (!a.matter_id && !a.contact_id && !a.query) return text(t("matters.matter_contact_or_query_required"));
      const r = await apiList("/communications", { ...compact({ ...a, limit: undefined, page_token: undefined }), fields: COMM_FIELDS, limit: a.limit ?? 50, order: "date(desc)" }, { page_token: a.page_token });
      return json({ has_more: r.has_more, next_page_token: r.next_page_token, communications: r.data });
    })
  );

  server.registerTool(
    "clio_communication_log",
    {
      title: "Log communication",
      description: "Logs a record of a phone call or an e-mail to a matter (subject, body, date, sender/receiver = user or contact). Write operation – requires confirm=true.",
      inputSchema: {
        matter_id: z.number().int(),
        type: z.enum(["PhoneCommunication", "EmailCommunication"]),
        subject: z.string(),
        body: z.string(),
        received_at: z.string().optional().describe("ISO date/time; defaults to now"),
        contact_id: z.number().int().optional().describe("The other party of the communication (contact)"),
        direction: z.enum(["outgoing", "incoming"]).optional().describe("outgoing = the user sends to the contact (default)"),
        confirm: confirmSchema,
      },
    },
    wrap("clio_communication_log", async (a: { matter_id: number; type: string; subject: string; body: string; received_at?: string; contact_id?: number; direction?: string; confirm?: boolean }) => {
      const me = loadTokens()?.user?.id;
      const user = me ? [{ id: me, type: "User" }] : [];
      const contact = a.contact_id ? [{ id: a.contact_id, type: "Contact" }] : [];
      const outgoing = (a.direction ?? "outgoing") === "outgoing";
      const body = compact({ type: a.type, subject: a.subject, body: a.body, received_at: a.received_at ?? new Date().toISOString(), matter: { id: a.matter_id }, senders: outgoing ? user : contact, receivers: outgoing ? contact : user });
      if (!a.confirm) return preview(t("matters.preview_communication_log"), body);
      const r = await apiRequest<{ data: unknown }>("POST", "/communications", { query: { fields: COMM_FIELDS }, body });
      return json(r.data.data);
    })
  );

  // ---------- Users ----------
  server.registerTool(
    "clio_users_list",
    { title: "Firm users", description: "Lists Clio users (id, name, e-mail, roles, rate) – for assigning tasks and matters and for recording time on behalf of another user.", inputSchema: { enabled_only: z.boolean().optional() } },
    wrap("clio_users_list", async ({ enabled_only }: { enabled_only?: boolean }) => {
      const r = await apiListAll("/users", { ...compact({ enabled: enabled_only ? true : undefined }), fields: "id,name,email,enabled,subscription_type,roles,rate,default_calendar_id" }, 200);
      return json({ users: r.data });
    })
  );

  server.registerTool(
    "clio_text_snippets_list",
    { title: "Text snippets", description: "Lists your firm's text snippets (shortcuts) from Clio – reusable phrases for documents and notes.", inputSchema: { query: z.string().optional() } },
    wrap("clio_text_snippets_list", async ({ query }: { query?: string }) => {
      const r = await apiListAll("/settings/text_snippets", { ...compact({ query }), fields: "id,phrase,snippet,created_at" }, 500);
      return json({ snippets: r.data });
    })
  );
};
