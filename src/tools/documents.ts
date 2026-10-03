/** Dokumenty: hledání, stažení do pracovní složky, nová verze, nový dokument z hlavičkového papíru, složky, komentáře. */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { apiRequest, apiList, apiListAll, ClioApiError } from "../client.js";
import { loadTokens } from "../store.js";
import { text, json, wrap, preview, confirmSchema, compact, type Registrar } from "./common.js";
import { extractText, renderPdfPages, normalizeImage, IMAGE_EXT } from "../extract.js";
import { fillDocxTemplate } from "../docx.js";

const DOC_FIELDS = "id,name,filename,size,content_type,created_at,updated_at,locked,type,parent{id,type,name},matter{id,display_number},document_category{id,name},latest_document_version{id,version_number,size,fully_uploaded,created_at}";
const TEMPLATE_FIELDS = "id,filename,size,content_type,created_at,updated_at,document_category{id,name}";

const MIME: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".rtf": "application/rtf",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".eml": "message/rfc822",
  ".msg": "application/vnd.ms-outlook",
  ".zip": "application/zip",
};
const mimeOf = (file: string) => MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";

function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, 150) || "dokument";
}

function ensureWorkDir(sub?: string): string {
  const dir = sub ? path.join(config.workDir, safeName(sub)) : config.workDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stáhne soubor z URL bez Authorization (S3 podepsaná URL) do cílové cesty. */
async function downloadTo(url: string, target: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Stažení selhalo: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  return buf.length;
}

/** Získá download URL dokumentu (API vrací 303 Location). */
async function documentDownloadUrl(documentId: number, versionId?: number): Promise<string> {
  const r = await apiRequest<{ location: string | null }>("GET", `/documents/${documentId}/download`, {
    raw: true,
    query: versionId ? { document_version_id: versionId } : undefined,
  });
  if (r.status === 303 || r.status === 302) {
    if (!r.data.location) throw new Error("Clio nevrátilo download URL.");
    return r.data.location;
  }
  if (r.status === 401) throw new ClioApiError(401, undefined, "401 Unauthorized při stahování – token neplatí.");
  throw new Error(`Neočekávaná odpověď při stahování: ${r.status}`);
}

interface UploadInit {
  id: number;
  latest_document_version: { uuid: string; put_url: string; put_headers: { name: string; value: string }[] };
}

/** Kompletní upload flow: POST /documents → PUT S3 → PATCH fully_uploaded. */
async function uploadFile(localPath: string | Buffer, parent: { id: number; type: "Matter" | "Folder" | "Document" }, name?: string, categoryId?: number) {
  let data: Buffer;
  if (Buffer.isBuffer(localPath)) {
    data = localPath;
    if (!name) throw new Error("Pro upload z paměti je nutný název souboru.");
  } else {
    if (!fs.existsSync(localPath)) throw new Error(`Soubor neexistuje: ${localPath}`);
    data = fs.readFileSync(localPath);
  }
  const fileName = name ?? path.basename(localPath as string);
  const contentType = mimeOf(fileName);
  const init = await apiRequest<{ data: UploadInit }>("POST", "/documents", {
    query: { fields: "id,latest_document_version{uuid,put_url,put_headers}" },
    body: compact({ name: fileName, parent, content_type: contentType, document_category: categoryId ? { id: categoryId } : undefined }),
  });
  const v = init.data.data.latest_document_version;
  const headers: Record<string, string> = {};
  for (const h of v.put_headers ?? []) headers[h.name] = h.value;
  if (!headers["Content-Type"]) headers["Content-Type"] = contentType;
  const put = await fetch(v.put_url, { method: "PUT", headers, body: new Uint8Array(data) });
  if (!put.ok) throw new Error(`Upload na úložiště selhal: ${put.status} ${(await put.text()).slice(0, 200)}`);
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const done = await apiRequest<{ data: unknown }>("PATCH", `/documents/${init.data.data.id}`, {
        query: { fields: DOC_FIELDS },
        body: { uuid: v.uuid, fully_uploaded: true },
      });
      return { document: done.data.data, bytes: data.length, content_type: contentType };
    } catch (e) {
      last = e;
      if (e instanceof ClioApiError && e.type === "UploadTimeoutError") {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw e;
    }
  }
  throw last instanceof Error ? last : new Error("Potvrzení uploadu selhalo.");
}

/** Najde (nebo založí) složku "Claude" v kořeni dokumentů spisu – sem se ukládají všechny dokumenty vytvořené Claudem.
 *  Pozn.: parametr `query` endpointu /folders název nenajde spolehlivě → procházíme všechny podsložky kořene a porovnáváme název. */
const claudeFolderCache = new Map<number, number>();
export async function ensureClaudeFolder(matterId: number): Promise<{ id: number; created: boolean; matter_display_number?: string }> {
  const m = await apiRequest<{ data: { id: number; display_number?: string; folder?: { id: number } } }>("GET", `/matters/${matterId}`, { query: { fields: "id,display_number,folder{id}" } });
  const rootId = m.data.data.folder?.id;
  if (!rootId) throw new Error(`Spis ${matterId} nemá kořenovou složku dokumentů.`);
  const wanted = config.claudeFolderName.trim().toLowerCase();
  const findExisting = async () => {
    const all = await apiListAll<{ id: number; name: string }>("/folders", { parent_id: rootId, scope: "children", fields: "id,name", limit: 200 }, 2000);
    const hits = all.data.filter((f) => (f.name ?? "").trim().toLowerCase() === wanted).sort((a, b) => a.id - b.id);
    return hits[0];
  };
  const cached = claudeFolderCache.get(matterId);
  if (cached) {
    const stillThere = (await findExisting())?.id === cached;
    if (stillThere) return { id: cached, created: false, matter_display_number: m.data.data.display_number };
    claudeFolderCache.delete(matterId);
  }
  const hit = await findExisting();
  if (hit) {
    claudeFolderCache.set(matterId, hit.id);
    return { id: hit.id, created: false, matter_display_number: m.data.data.display_number };
  }
  const created = await apiRequest<{ data: { id: number } }>("POST", "/folders", { query: { fields: "id,name" }, body: { name: config.claudeFolderName, parent: { id: rootId, type: "Folder" } } });
  claudeFolderCache.set(matterId, created.data.data.id);
  return { id: created.data.data.id, created: true, matter_display_number: m.data.data.display_number };
}

interface Template {
  id: number;
  filename: string;
  size?: number;
  content_type?: string;
}

async function listTemplates(): Promise<Template[]> {
  const r = await apiList<Template>("/document_templates", { fields: TEMPLATE_FIELDS, limit: 200, order: "id(asc)" });
  return r.data;
}

const listTemplatesStr = (all: Template[]) => all.map((x) => `${x.id} ${x.filename}`).join("; ");

/** Matches a template by exact id/filename or by filename prefix (case-insensitive); newest by name wins. */
function matchTemplate(all: Template[], nameOrPrefix: string): Template | undefined {
  const q = nameOrPrefix.trim().toLowerCase();
  if (!q) return undefined;
  if (/^\d+$/.test(q)) return all.find((x) => x.id === Number(q));
  const exact = all.find((x) => x.filename.toLowerCase() === q);
  if (exact) return exact;
  return all.filter((x) => x.filename.toLowerCase().startsWith(q)).sort((a, b) => b.filename.localeCompare(a.filename))[0];
}

/**
 * Picks the letterhead/template to fill. Order:
 *  1. explicit template (id or name/prefix passed to the tool),
 *  2. kind=internal → CLIO_INTERNAL_TEMPLATE,
 *  3. per-user map CLIO_LETTERHEADS (e-mail of the signed-in user → template name/prefix),
 *  4. CLIO_DEFAULT_TEMPLATE,
 *  5. the only template in Clio, if there is exactly one.
 * Otherwise the caller gets the list of templates and must pass one explicitly.
 */
async function pickLetterhead(kind: "user" | "internal", explicit?: number | string): Promise<{ template: Template; reason: string; all: Template[] }> {
  const all = await listTemplates();
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== "") {
    const t = matchTemplate(all, String(explicit));
    if (!t) throw new Error(`Template "${explicit}" not found. Available templates: ${listTemplatesStr(all)}`);
    return { template: t, reason: "explicitly requested", all };
  }
  if (kind === "internal") {
    if (!config.internalTemplate) throw new Error(`No internal template configured (CLIO_INTERNAL_TEMPLATE). Pass template_id/template explicitly. Available: ${listTemplatesStr(all)}`);
    const t = matchTemplate(all, config.internalTemplate);
    if (!t) throw new Error(`Internal template "${config.internalTemplate}" not found. Available: ${listTemplatesStr(all)}`);
    return { template: t, reason: `internal document → ${config.internalTemplate}`, all };
  }
  const email = loadTokens()?.user?.email?.toLowerCase();
  const mapped = email ? config.letterheads[email] : undefined;
  if (mapped) {
    const t = matchTemplate(all, mapped);
    if (!t) throw new Error(`Letterhead "${mapped}" configured for ${email} was not found in Clio. Available: ${listTemplatesStr(all)}`);
    return { template: t, reason: `user ${email} → ${mapped} (newest by name)`, all };
  }
  if (config.defaultTemplate) {
    const t = matchTemplate(all, config.defaultTemplate);
    if (!t) throw new Error(`Default template "${config.defaultTemplate}" not found in Clio. Available: ${listTemplatesStr(all)}`);
    return { template: t, reason: `default template → ${config.defaultTemplate}`, all };
  }
  if (all.length === 1) return { template: all[0], reason: "the only template in Clio", all };
  throw new Error(
    `No letterhead configured for ${email ?? "(unknown user)"}. Pass template_id or template (name/prefix), or configure CLIO_LETTERHEADS / CLIO_DEFAULT_TEMPLATE in the extension settings. Available templates: ${listTemplatesStr(all)}`
  );
}

export const registerDocuments: Registrar = (server) => {
  server.registerTool(
    "clio_document_search",
    {
      title: "Hledat dokumenty",
      description:
        "Vyhledá dokumenty v Clio podle spisu (matter_id), složky (parent_id), kontaktu, názvu (query) nebo kategorie. Vrací metadata včetně id, názvu, velikosti, verze a umístění. " +
        "Stránkuje přes page_token. Pro obsah složky použijte parent_id + scope=children.",
      inputSchema: {
        matter_id: z.number().int().optional().describe("ID spisu"),
        parent_id: z.number().int().optional().describe("ID složky (nebo dokumentu)"),
        contact_id: z.number().int().optional().describe("ID kontaktu"),
        query: z.string().optional().describe("Hledaný text v názvu dokumentu"),
        document_category_id: z.number().int().optional(),
        scope: z.enum(["children", "descendants"]).optional().describe("children = jen přímý obsah složky, descendants = včetně podsložek"),
        order: z.enum(["id(asc)", "id(desc)", "name(asc)", "name(desc)", "updated_at(asc)", "updated_at(desc)"]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Výchozí 50"),
        page_token: z.string().optional(),
      },
    },
    wrap("clio_document_search", async (a: { matter_id?: number; parent_id?: number; contact_id?: number; query?: string; document_category_id?: number; scope?: string; order?: string; limit?: number; page_token?: string }) => {
      if (!a.matter_id && !a.parent_id && !a.contact_id && !a.query) return text("Zadejte alespoň matter_id, parent_id, contact_id nebo query.");
      const r = await apiList("/documents", { ...compact({ ...a, page_token: undefined }), fields: DOC_FIELDS, limit: a.limit ?? 50, order: a.order ?? "updated_at(desc)" }, { page_token: a.page_token });
      return json({ records: r.records, has_more: r.has_more, next_page_token: r.next_page_token, documents: r.data });
    })
  );

  server.registerTool(
    "clio_document_get",
    {
      title: "Detail dokumentu",
      description: "Vrátí metadata dokumentu a historii verzí (id verze, číslo, velikost, autor, datum). Download URL nevrací – použijte clio_document_download.",
      inputSchema: { document_id: z.number().int() },
    },
    wrap("clio_document_get", async ({ document_id }: { document_id: number }) => {
      const d = await apiRequest<{ data: unknown }>("GET", `/documents/${document_id}`, { query: { fields: DOC_FIELDS + ",creator{id,name},external_properties{name,value}" } });
      const v = await apiList(`/documents/${document_id}/versions`, { fields: "id,version_number,size,content_type,filename,fully_uploaded,created_at,creator{id,name}", limit: 50 });
      return json({ document: d.data.data, versions: v.data });
    })
  );

  server.registerTool(
    "clio_document_read",
    {
      title: "Přečíst obsah dokumentu (text / sken)",
      description:
        "Vrátí obsah dokumentu z Clio přímo v odpovědi – bez nutnosti přístupu k disku. DOCX/PDF s textovou vrstvou/TXT/EML/HTML → text (stránkování offset/max_chars). " +
        "Skenované PDF bez textové vrstvy a obrázky (JPG/PNG) → vrátí stránky jako obrázky, které Claude přečte (vizuální OCR); stránky vybírejte page_from/page_to (max 4 na volání). " +
        "mode: auto (výchozí), text (jen textová vrstva), images (vždy obrázky stránek – např. pro razítka, podpisy, tabulky). Lze zadat document_id nebo file_path.",
      inputSchema: {
        document_id: z.number().int().optional(),
        document_version_id: z.number().int().optional(),
        file_path: z.string().optional().describe("Alternativa k document_id – absolutní cesta k lokálnímu souboru"),
        mode: z.enum(["auto", "text", "images"]).optional(),
        max_chars: z.number().int().min(500).max(200000).optional().describe("Max. znaků textu v odpovědi (výchozí 40000)"),
        offset: z.number().int().min(0).optional().describe("Od kterého znaku textu pokračovat"),
        page_from: z.number().int().min(1).optional().describe("Pro obrázky stránek: první strana (výchozí 1)"),
        page_to: z.number().int().min(1).optional().describe("Pro obrázky stránek: poslední strana (max. 4 strany na volání)"),
      },
    },
    wrap(
      "clio_document_read",
      async ({ document_id, document_version_id, file_path, mode, max_chars, offset, page_from, page_to }: { document_id?: number; document_version_id?: number; file_path?: string; mode?: "auto" | "text" | "images"; max_chars?: number; offset?: number; page_from?: number; page_to?: number }) => {
        let buf: Buffer;
        let name: string;
        let meta: Record<string, unknown> = {};
        if (file_path) {
          if (!fs.existsSync(file_path)) return text(`Soubor neexistuje: ${file_path}`);
          buf = fs.readFileSync(file_path);
          name = path.basename(file_path);
          meta = { file_path };
        } else if (document_id) {
          const m = await apiRequest<{ data: { name: string; filename?: string; size?: number; matter?: { display_number?: string }; latest_document_version?: { version_number?: number } } }>("GET", `/documents/${document_id}`, {
            query: { fields: "id,name,filename,size,matter{id,display_number},latest_document_version{id,version_number}" },
          });
          const d = m.data.data;
          name = d.filename || d.name;
          if (!path.extname(name) && d.name && path.extname(d.name)) name += path.extname(d.name);
          meta = { document_id, name: d.name, matter: d.matter?.display_number, version: d.latest_document_version?.version_number, size: d.size };
          const url = await documentDownloadUrl(document_id, document_version_id);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Stažení selhalo: ${res.status}`);
          buf = Buffer.from(await res.arrayBuffer());
        } else {
          return text("Zadejte document_id nebo file_path.");
        }
        const ext = path.extname(name).toLowerCase();
        const want = mode ?? "auto";
        const from = page_from ?? 1;
        const to = Math.min(page_to ?? from + 3, from + 3);

        // obrázek → rovnou jako obrázek
        if (IMAGE_EXT.has(ext)) {
          const img = await normalizeImage(buf, name);
          return {
            content: [
              { type: "text", text: JSON.stringify({ ...meta, kind: "image", width: img.width, height: img.height, note: "Obrázek – přečtěte text z obrázku." }, null, 2) },
              { type: "image", data: img.data.toString("base64"), mimeType: img.mimeType },
            ],
          };
        }

        const asImages = async (numPagesHint?: number, note?: string) => {
          if (ext !== ".pdf") return text(`Formát ${ext} nelze převést na obrázky stránek.`);
          const pages = Array.from({ length: to - from + 1 }, (_, i) => from + i);
          const r = await renderPdfPages(buf, pages);
          const blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
            {
              type: "text",
              text: JSON.stringify({ ...meta, kind: "pdf-images", pages_total: r.numPages, pages_returned: r.images.map((i) => i.page), has_more_pages: to < r.numPages, next_page_from: to < r.numPages ? to + 1 : undefined, note: note ?? "Stránky jako obrázky – přečtěte text z obrázků; další strany přes page_from/page_to." }, null, 2),
            },
          ];
          for (const img of r.images) blocks.push({ type: "text", text: `--- strana ${img.page}/${r.numPages} ---` }, { type: "image", data: img.data.toString("base64"), mimeType: img.mimeType });
          void numPagesHint;
          return { content: blocks };
        };

        if (want === "images") return asImages();

        const ex = await extractText(buf, name);
        const scanned = ex.kind === "pdf" && ex.note?.includes("textovou vrstvu");
        if (want === "auto" && scanned) return asImages(ex.pages, "PDF nemá textovou vrstvu (sken) – stránky vráceny jako obrázky, přečtěte text z nich.");
        if (ex.kind === "unsupported") return json({ ...meta, kind: ex.kind, note: ex.note });
        const start = offset ?? 0;
        const limit = max_chars ?? 40000;
        const slice = ex.text.slice(start, start + limit);
        return json({
          ...meta,
          kind: ex.kind,
          pages: ex.pages,
          note: ex.note,
          total_chars: ex.text.length,
          offset: start,
          returned_chars: slice.length,
          has_more: start + slice.length < ex.text.length,
          next_offset: start + slice.length < ex.text.length ? start + slice.length : undefined,
          hint: ex.kind === "pdf" ? "Pokud text vypadá neúplně (razítka, ručně psané části, tabulky), zavolejte znovu s mode='images'." : undefined,
          text: slice,
        });
      }
    )
  );

  server.registerTool(
    "clio_document_download",
    {
      title: "Stáhnout dokument do pracovní složky",
      description:
        `Stáhne dokument (nebo konkrétní verzi) z Clio do pracovní složky na PC (výchozí ${config.workDir}, podsložka podle spisu) a vrátí cestu k souboru. ` +
        "Slouží k otevření a editaci dokumentu Claudem; upravený soubor pak nahrajte jako novou verzi nástrojem clio_document_upload_version.",
      inputSchema: {
        document_id: z.number().int(),
        document_version_id: z.number().int().optional().describe("Konkrétní verze; výchozí nejnovější"),
        target_dir: z.string().optional().describe("Vlastní cílová složka (absolutní cesta); výchozí pracovní složka/spis"),
      },
    },
    wrap("clio_document_download", async ({ document_id, document_version_id, target_dir }: { document_id: number; document_version_id?: number; target_dir?: string }) => {
      const meta = await apiRequest<{ data: { name: string; filename?: string; matter?: { display_number?: string }; latest_document_version?: { version_number?: number } } }>("GET", `/documents/${document_id}`, {
        query: { fields: "id,name,filename,matter{id,display_number},latest_document_version{id,version_number}" },
      });
      const doc = meta.data.data;
      const url = await documentDownloadUrl(document_id, document_version_id);
      const dir = target_dir && path.isAbsolute(target_dir) ? (fs.mkdirSync(target_dir, { recursive: true }), target_dir) : ensureWorkDir(doc.matter?.display_number ?? `dokument-${document_id}`);
      let fileName = safeName(doc.filename || doc.name);
      if (!path.extname(fileName) && doc.name && path.extname(doc.name)) fileName += path.extname(doc.name);
      const target = path.join(dir, fileName);
      const bytes = await downloadTo(url, target);
      return json({ path: target, bytes, document_id, name: doc.name, version: doc.latest_document_version?.version_number, matter: doc.matter?.display_number, hint: "Po úpravě nahrajte zpět: clio_document_upload_version {document_id, file_path}" });
    })
  );

  server.registerTool(
    "clio_document_upload_version",
    {
      title: "Nahrát novou verzi dokumentu",
      description: "Nahraje lokální soubor jako novou verzi existujícího dokumentu v Clio (původní verze zůstávají v historii). Zápis – vyžaduje confirm=true.",
      inputSchema: {
        document_id: z.number().int(),
        file_path: z.string().describe("Absolutní cesta k souboru na PC"),
        name: z.string().optional().describe("Název souboru v Clio; výchozí název lokálního souboru"),
        confirm: confirmSchema,
      },
    },
    wrap("clio_document_upload_version", async ({ document_id, file_path, name, confirm }: { document_id: number; file_path: string; name?: string; confirm?: boolean }) => {
      if (!fs.existsSync(file_path)) return text(`Soubor neexistuje: ${file_path}`);
      const size = fs.statSync(file_path).size;
      if (!confirm) return preview(`Nová verze dokumentu ${document_id}`, { file_path, size, name: name ?? path.basename(file_path) });
      const r = await uploadFile(file_path, { id: document_id, type: "Document" }, name);
      return json({ ok: true, ...r });
    })
  );

  server.registerTool(
    "clio_document_upload",
    {
      title: "Nahrát nový dokument (existující soubor)",
      description:
        `Nahraje lokální soubor jako nový dokument do spisu. Bez folder_id se dokument uloží do složky „${config.claudeFolderName}“ v kořeni dokumentů spisu (založí se, pokud neexistuje) – sem patří všechny dokumenty vytvořené Claudem. ` +
        "Pro nové písemnosti kanceláře nejdřív použijte clio_document_create_from_letterhead (hlavičkový papír), pak tento nástroj. Zápis – vyžaduje confirm=true.",
      inputSchema: {
        file_path: z.string().describe("Absolutní cesta k souboru"),
        matter_id: z.number().int().describe("ID spisu"),
        folder_id: z.number().int().optional().describe(`Konkrétní složka; výchozí složka „${config.claudeFolderName}“ ve spisu`),
        name: z.string().optional(),
        document_category_id: z.number().int().optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_document_upload", async ({ file_path, matter_id, folder_id, name, document_category_id, confirm }: { file_path: string; matter_id: number; folder_id?: number; name?: string; document_category_id?: number; confirm?: boolean }) => {
      if (!fs.existsSync(file_path)) return text(`Soubor neexistuje: ${file_path}`);
      if (!confirm) return preview("Nový dokument", { file_path, size: fs.statSync(file_path).size, matter_id, folder: folder_id ?? `složka „${config.claudeFolderName}“ ve spisu (založí se, pokud chybí)`, name: name ?? path.basename(file_path), document_category_id });
      const target = folder_id ? { id: folder_id, created: false } : await ensureClaudeFolder(matter_id);
      const r = await uploadFile(file_path, { id: target.id, type: "Folder" }, name, document_category_id);
      return json({ ok: true, folder_id: target.id, folder_created: target.created, ...r });
    })
  );

  server.registerTool(
    "clio_letterheads_list",
    {
      title: "Hlavičkové papíry a šablony",
      description: "Vypíše šablony dokumentů (Document Templates) v Clio včetně hlavičkových papírů a ukáže, která šablona se použije pro přihlášeného uživatele a pro interní dokumenty.",
      inputSchema: {},
    },
    wrap("clio_letterheads_list", async () => {
      const all = await listTemplates();
      const email = loadTokens()?.user?.email?.toLowerCase();
      let forUser: string | undefined;
      let forInternal: string | undefined;
      try {
        forUser = (await pickLetterhead("user")).template.filename;
      } catch (e) {
        forUser = `nenalezeno: ${(e as Error).message.split(".")[0]}`;
      }
      try {
        forInternal = (await pickLetterhead("internal")).template.filename;
      } catch {
        forInternal = "nenalezeno";
      }
      return json({ user: email, letterhead_for_user: forUser, template_for_internal: forInternal, mapping: config.letterheads, default_template: config.defaultTemplate, templates: all });
    })
  );

  server.registerTool(
    "clio_document_create_from_letterhead",
    {
      title: "Nový dokument z hlavičkového papíru",
      description:
        "Založí nový dokument ve spisu z hlavičkového papíru / šablony (Document Template v Clio): výběr podle template_id nebo template, jinak podle konfigurace (mapa uživatel → šablona, výchozí šablona, kind=internal → interní šablona). " +
        "DOPORUČENÝ POSTUP (funguje všude, i bez přístupu k disku): předejte hotový text v parametru content – server ho vloží do hlavičkového papíru (docx) a nahraje do složky „Claude“ ve spisu (confirm=true). " +
        "Formát content: prázdný řádek = prázdný odstavec; '# ' / '## ' / '### ' = Nadpis 2/3/4 šablony; **tučně**; '[ 1. ] text' = číslovaný odstavec (značka na okraji, text s předsazením); 'Popisek:: text' = tučný popisek + tabulátor; '- ' odrážka; '\\t' tabulátor; '---pagebreak---' konec stránky; ':::center text' na střed, ':::right text' vpravo. Dodržujte zvyklosti uživatele pro strukturu dokumentu (adresát, značky, datum, nadpis, přílohy), pokud je uvede. " +
        "Alternativy: bez content a mode='download' jen stáhne šablonu k ruční editaci (Cowork s připojenou složkou); mode='automation' nechá Clio vygenerovat dokument přes Document Automation. Bez hlavičkového papíru jen s without_letterhead=true.",
      inputSchema: {
        matter_id: z.number().int().describe("ID spisu, do kterého dokument patří"),
        filename: z.string().describe("Název nového dokumentu včetně přípony, např. 'Vyjádření žalovaného.docx'"),
        kind: z.enum(["user", "internal"]).optional().describe("user = hlavičkový papír přihlášeného uživatele (výchozí), internal = interní šablona"),
        template_id: z.number().int().optional().describe("Explicitní id šablony (přebije automatický výběr)"),
        template: z.string().optional().describe("Název nebo prefix názvu šablony (přebije automatický výběr); alternativa k template_id"),
        mode: z.enum(["download", "automation"]).optional().describe("download (výchozí) = stáhnout šablonu k editaci; automation = vygenerovat v Clio přes Document Automation"),
        formats: z.array(z.enum(["original", "pdf"])).optional().describe("Jen pro automation: original = formát šablony (docx), pdf; výchozí ['original']"),
        without_letterhead: z.boolean().optional().describe("true = nepoužít šablonu (pouze vrátí pokyn k nahrání prostého souboru)"),
        target_dir: z.string().optional().describe("Vlastní cílová složka na PC (absolutní cesta), např. složka připojená v Cowork; výchozí pracovní složka/spis"),
        content: z.string().optional().describe("Hotový text dokumentu (markdown-lite, viz popis). Je-li zadán, server vyplní hlavičkový papír a nahraje dokument do Clio."),
        keep_local_copy: z.boolean().optional().describe("true = uložit vyplněný soubor i do pracovní složky (výchozí true)"),
        confirm: confirmSchema,
      },
    },
    wrap(
      "clio_document_create_from_letterhead",
      async ({ matter_id, filename, kind, template_id, template, mode, formats, without_letterhead, target_dir, content, keep_local_copy, confirm }: { matter_id: number; filename: string; kind?: "user" | "internal"; template_id?: number; template?: string; mode?: "download" | "automation"; formats?: ("original" | "pdf")[]; without_letterhead?: boolean; target_dir?: string; content?: string; keep_local_copy?: boolean; confirm?: boolean }) => {
        const matter = await apiRequest<{ data: { id: number; display_number: string; description?: string; client?: { name?: string } } }>("GET", `/matters/${matter_id}`, {
          query: { fields: "id,display_number,description,client{id,name}" },
        });
        const m = matter.data.data;
        const resolveDir = () => {
          if (target_dir && path.isAbsolute(target_dir)) {
            fs.mkdirSync(target_dir, { recursive: true });
            return target_dir;
          }
          return ensureWorkDir(m.display_number);
        };
        if (without_letterhead) {
          const dir = resolveDir();
          return json({ note: "Bez hlavičkového papíru. Vytvořte soubor a nahrajte ho nástrojem clio_document_upload.", target_path: path.join(dir, safeName(filename)), matter: m });
        }
        const pick = await pickLetterhead(kind ?? "user", template_id ?? template);
        if (content !== undefined) {
          // server-side vyplnění hlavičkového papíru a upload do složky „Claude“
          const finalName = safeName(filename.toLowerCase().endsWith(".docx") ? filename : filename + ".docx");
          if (!confirm) {
            return preview(`Nový dokument z hlavičkového papíru → spis ${m.display_number}, složka „${config.claudeFolderName}“`, { filename: finalName, template: pick.template.filename, reason: pick.reason, content_preview: content.slice(0, 1500) + (content.length > 1500 ? "…" : ""), content_chars: content.length });
          }
          const r = await apiRequest<{ location: string | null }>("GET", `/document_templates/${pick.template.id}/download`, { raw: true });
          if (!r.data.location) throw new Error(`Šablonu nelze stáhnout (status ${r.status}).`);
          const tres = await fetch(r.data.location);
          if (!tres.ok) throw new Error(`Stažení šablony selhalo: ${tres.status}`);
          const filled = fillDocxTemplate(Buffer.from(await tres.arrayBuffer()), content);
          let localPath: string | undefined;
          if (keep_local_copy !== false) {
            try {
              const dir = resolveDir();
              localPath = path.join(dir, finalName);
              fs.writeFileSync(localPath, filled);
            } catch {
              localPath = undefined;
            }
          }
          const folder = await ensureClaudeFolder(matter_id);
          const up = await uploadFile(filled, { id: folder.id, type: "Folder" }, finalName);
          return json({ ok: true, template: { id: pick.template.id, filename: pick.template.filename, reason: pick.reason }, folder_id: folder.id, folder_created: folder.created, local_copy: localPath, ...up, next_step: "Dokument je v Clio; případné úpravy: clio_document_write (nová verze z textu) nebo stáhnout a upravit v Cowork." });
        }
        if ((mode ?? "download") === "download") {
          const dir = resolveDir();
          const target = path.join(dir, safeName(filename.endsWith(path.extname(pick.template.filename)) ? filename : filename + path.extname(pick.template.filename)));
          const r = await apiRequest<{ location: string | null }>("GET", `/document_templates/${pick.template.id}/download`, { raw: true });
          if (!r.data.location) throw new Error(`Šablonu nelze stáhnout (status ${r.status}).`);
          const bytes = await downloadTo(r.data.location, target);
          return json({
            path: target,
            bytes,
            template: { id: pick.template.id, filename: pick.template.filename, reason: pick.reason },
            matter: m,
            next_step: `Doplňte obsah do souboru a nahrajte: clio_document_upload {file_path: "${target}", matter_id: ${matter_id}, confirm: true} – uloží se do složky „${config.claudeFolderName}“ ve spisu.`,
          });
        }
        const body = { document_template: { id: pick.template.id }, matter: { id: matter_id }, filename: safeName(filename), formats: formats ?? ["original"] };
        if (!confirm) return preview("Document Automation – vygenerovat dokument ve spisu", { ...body, template_filename: pick.template.filename, reason: pick.reason, matter: m.display_number });
        const created = await apiRequest<{ data: { id: number; state?: string } }>("POST", "/document_automations", { query: { fields: "id,state,filename,export_formats,documents{id,name}" }, body });
        let auto = created.data.data as { id: number; state?: string; documents?: { id: number; name: string }[] };
        for (let i = 0; i < 10 && (!auto.documents || !auto.documents.length); i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const s = await apiRequest<{ data: typeof auto }>("GET", `/document_automations/${auto.id}`, { query: { fields: "id,state,filename,export_formats,documents{id,name}" } });
          auto = s.data.data;
        }
        // vygenerované dokumenty přesunout do složky „Claude“
        let moved: number[] = [];
        if (auto.documents?.length) {
          const folder = await ensureClaudeFolder(matter_id);
          for (const d of auto.documents) {
            try {
              await apiRequest("PATCH", `/documents/${d.id}`, { query: { fields: "id" }, body: { parent: { id: folder.id, type: "Folder" } } });
              moved.push(d.id);
            } catch {
              /* ponecháme v kořeni */
            }
          }
        }
        return json({ automation: auto, moved_to_claude_folder: moved, next_step: auto.documents?.length ? `Stáhněte k editaci: clio_document_download {document_id: ${auto.documents[0].id}}` : "Generování ještě běží; zkontrolujte clio_api_request GET /document_automations/" + auto.id });
      }
    )
  );

  server.registerTool(
    "clio_document_write",
    {
      title: "Přepsat dokument textem (nová verze)",
      description:
        "Vytvoří novou verzi existujícího DOCX dokumentu v Clio z předaného textu (stejný markdown-lite formát jako u clio_document_create_from_letterhead). " +
        "Tělo dokumentu se NAHRADÍ novým textem; hlavička, zápatí a styly zůstávají (šablona = daný dokument, nebo base='letterhead' = aktuální hlavičkový papír uživatele). " +
        "Vhodné pro opravy dokumentů vytvořených Claudem; u cizích dokumentů se složitým formátováním raději stáhnout a upravit v Cowork. Zápis – confirm=true.",
      inputSchema: {
        document_id: z.number().int(),
        content: z.string().describe("Nový úplný text dokumentu (markdown-lite)"),
        base: z.enum(["document", "letterhead"]).optional().describe("document (výchozí) = hlavička/zápatí z aktuální verze dokumentu; letterhead = z hlavičkového papíru uživatele"),
        confirm: confirmSchema,
      },
    },
    wrap("clio_document_write", async ({ document_id, content, base, confirm }: { document_id: number; content: string; base?: "document" | "letterhead"; confirm?: boolean }) => {
      const meta = await apiRequest<{ data: { name: string; filename?: string; matter?: { id: number; display_number?: string } } }>("GET", `/documents/${document_id}`, { query: { fields: "id,name,filename,matter{id,display_number}" } });
      const d = meta.data.data;
      const name = d.filename || d.name;
      if (!name.toLowerCase().endsWith(".docx")) return text(`Dokument ${name} není DOCX – nová verze z textu není možná.`);
      if (!confirm) return preview(`Nová verze dokumentu ${document_id} (${name}) z textu`, { base: base ?? "document", content_preview: content.slice(0, 1500), content_chars: content.length });
      let templateBuf: Buffer;
      if ((base ?? "document") === "document") {
        const url = await documentDownloadUrl(document_id);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Stažení dokumentu selhalo: ${res.status}`);
        templateBuf = Buffer.from(await res.arrayBuffer());
      } else {
        const pick = await pickLetterhead("user");
        const r = await apiRequest<{ location: string | null }>("GET", `/document_templates/${pick.template.id}/download`, { raw: true });
        if (!r.data.location) throw new Error("Šablonu nelze stáhnout.");
        const res = await fetch(r.data.location);
        templateBuf = Buffer.from(await res.arrayBuffer());
      }
      // u existujícího dokumentu smazat celé tělo (všechny odstavce před sectPr), ne jen prázdné
      const filled = fillDocxTemplate(templateBuf, content, { clearTemplateBody: true, clearAllBody: (base ?? "document") === "document" });
      const up = await uploadFile(filled, { id: document_id, type: "Document" }, name);
      return json({ ok: true, matter: d.matter?.display_number, ...up });
    })
  );

  server.registerTool(
    "clio_folder_list",
    {
      title: "Složky spisu",
      description: "Vypíše složky (a volitelně dokumenty) ve spisu nebo pod zadanou složkou – pro zjištění, kam dokument uložit.",
      inputSchema: {
        matter_id: z.number().int().optional(),
        parent_id: z.number().int().optional().describe("ID nadřazené složky"),
        include_documents: z.boolean().optional().describe("true = vrátit i dokumenty (endpoint /folders/list)"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    wrap("clio_folder_list", async ({ matter_id, parent_id, include_documents, limit }: { matter_id?: number; parent_id?: number; include_documents?: boolean; limit?: number }) => {
      if (!matter_id && !parent_id) return text("Zadejte matter_id nebo parent_id.");
      let root = parent_id;
      if (!root) {
        const m = await apiRequest<{ data: { folder?: { id: number } } }>("GET", `/matters/${matter_id}`, { query: { fields: "id,folder{id}" } });
        root = m.data.data.folder?.id;
        if (!root) return text(`Spis ${matter_id} nemá kořenovou složku dokumentů.`);
      }
      const fields = "id,name,type,created_at,updated_at,parent{id,name}";
      if (include_documents) {
        const r = await apiList("/folders/list", { parent_id: root, fields: fields + ",latest_document_version{version_number,size}", limit: limit ?? 100 });
        return json({ root_folder_id: root, items: r.data, has_more: r.has_more, next_page_token: r.next_page_token });
      }
      const r = await apiList("/folders", { parent_id: root, scope: "children", fields, limit: limit ?? 100, order: "id(asc)" });
      return json({ root_folder_id: root, folders: r.data, has_more: r.has_more });
    })
  );

  server.registerTool(
    "clio_folder_create",
    {
      title: "Vytvořit složku",
      description: "Vytvoří složku ve spisu (parent = Matter) nebo v jiné složce (parent = Folder). Zápis – vyžaduje confirm=true.",
      inputSchema: {
        name: z.string(),
        matter_id: z.number().int().optional(),
        parent_folder_id: z.number().int().optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_folder_create", async ({ name, matter_id, parent_folder_id, confirm }: { name: string; matter_id?: number; parent_folder_id?: number; confirm?: boolean }) => {
      if (!matter_id && !parent_folder_id) return text("Zadejte matter_id nebo parent_folder_id.");
      const body = { name, parent: parent_folder_id ? { id: parent_folder_id, type: "Folder" } : { id: matter_id!, type: "Matter" } };
      if (!confirm) return preview("Nová složka", body);
      const r = await apiRequest<{ data: unknown }>("POST", "/folders", { query: { fields: "id,name,parent{id,type},matter{id,display_number}" }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_document_comment_add",
    {
      title: "Komentář k dokumentu",
      description: "Přidá komentář k aktuální verzi dokumentu (viditelný v Clio u dokumentu). Zápis – vyžaduje confirm=true.",
      inputSchema: { document_id: z.number().int(), message: z.string(), confirm: confirmSchema },
    },
    wrap("clio_document_comment_add", async ({ document_id, message, confirm }: { document_id: number; message: string; confirm?: boolean }) => {
      const body = { message, item: { id: document_id } };
      if (!confirm) return preview(`Komentář k dokumentu ${document_id}`, body);
      const r = await apiRequest<{ data: unknown }>("POST", "/comments", { query: { fields: "id,message,created_at,creator{id,name}" }, body });
      return json(r.data.data);
    })
  );
};
