/** Documents: search, download to the work folder, new version, new document from letterhead, folders, comments. */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { apiRequest, apiList, apiListAll, ClioApiError } from "../client.js";
import { loadTokens } from "../store.js";
import { text, json, wrap, preview, confirmSchema, compact, type Registrar, type Confirm } from "./common.js";
import { extractText, renderPdfPages, normalizeImage, IMAGE_EXT } from "../extract.js";
import { fillDocxTemplate } from "../docx.js";
import { t } from "../i18n.js";

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
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, 150) || "document";
}

function ensureWorkDir(sub?: string): string {
  const dir = sub ? path.join(config.workDir, safeName(sub)) : config.workDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Downloads a file from a URL without Authorization (signed S3 URL) to the target path. */
async function downloadTo(url: string, target: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(t("documents.download_failed", { status: res.status }));
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  return buf.length;
}

/** Obtains the download URL of a document (the API returns 303 Location). */
async function documentDownloadUrl(documentId: number, versionId?: number): Promise<string> {
  const r = await apiRequest<{ location: string | null }>("GET", `/documents/${documentId}/download`, {
    raw: true,
    query: versionId ? { document_version_id: versionId } : undefined,
  });
  if (r.status === 303 || r.status === 302) {
    if (!r.data.location) throw new Error(t("documents.no_download_url"));
    return r.data.location;
  }
  if (r.status === 401) throw new ClioApiError(401, undefined, t("documents.download_unauthorized"));
  throw new Error(t("documents.download_unexpected_status", { status: r.status }));
}

interface UploadInit {
  id: number;
  latest_document_version: { uuid: string; put_url: string; put_headers: { name: string; value: string }[] };
}

/** Complete upload flow: POST /documents → PUT S3 → PATCH fully_uploaded. */
async function uploadFile(localPath: string | Buffer, parent: { id: number; type: "Matter" | "Folder" | "Document" }, name?: string, categoryId?: number) {
  let data: Buffer;
  if (Buffer.isBuffer(localPath)) {
    data = localPath;
    if (!name) throw new Error(t("documents.upload_name_required"));
  } else {
    if (!fs.existsSync(localPath)) throw new Error(t("documents.file_not_found", { path: localPath }));
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
  if (!put.ok) throw new Error(t("documents.upload_storage_failed", { status: put.status, detail: (await put.text()).slice(0, 200) }));
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
  throw last instanceof Error ? last : new Error(t("documents.upload_confirm_failed"));
}

/** Finds (or creates) the "Claude" folder in the root of the matter's documents – every document created by Claude is stored there.
 *  Note: the `query` parameter of the /folders endpoint does not find the name reliably → we list all subfolders of the root and compare names. */
const claudeFolderCache = new Map<number, number>();
export async function ensureClaudeFolder(matterId: number): Promise<{ id: number; created: boolean; matter_display_number?: string }> {
  const m = await apiRequest<{ data: { id: number; display_number?: string; folder?: { id: number } } }>("GET", `/matters/${matterId}`, { query: { fields: "id,display_number,folder{id}" } });
  const rootId = m.data.data.folder?.id;
  if (!rootId) throw new Error(t("documents.matter_no_root_folder", { matter_id: matterId }));
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
    const tpl = matchTemplate(all, String(explicit));
    if (!tpl) throw new Error(t("documents.template_not_found", { template: explicit, list: listTemplatesStr(all) }));
    return { template: tpl, reason: t("documents.reason_explicit"), all };
  }
  if (kind === "internal") {
    if (!config.internalTemplate) throw new Error(t("documents.internal_template_not_configured", { list: listTemplatesStr(all) }));
    const tpl = matchTemplate(all, config.internalTemplate);
    if (!tpl) throw new Error(t("documents.internal_template_not_found", { template: config.internalTemplate, list: listTemplatesStr(all) }));
    return { template: tpl, reason: t("documents.reason_internal", { template: config.internalTemplate }), all };
  }
  const email = loadTokens()?.user?.email?.toLowerCase();
  const mapped = email ? config.letterheads[email] : undefined;
  if (mapped) {
    const tpl = matchTemplate(all, mapped);
    if (!tpl) throw new Error(t("documents.user_letterhead_not_found", { template: mapped, email, list: listTemplatesStr(all) }));
    return { template: tpl, reason: t("documents.reason_user_mapping", { email, template: mapped }), all };
  }
  if (config.defaultTemplate) {
    const tpl = matchTemplate(all, config.defaultTemplate);
    if (!tpl) throw new Error(t("documents.default_template_not_found", { template: config.defaultTemplate, list: listTemplatesStr(all) }));
    return { template: tpl, reason: t("documents.reason_default", { template: config.defaultTemplate }), all };
  }
  if (all.length === 1) return { template: all[0], reason: t("documents.reason_only_template"), all };
  throw new Error(t("documents.no_letterhead_configured", { email: email ?? t("documents.unknown_user"), list: listTemplatesStr(all) }));
}

export const registerDocuments: Registrar = (server) => {
  server.registerTool(
    "clio_document_search",
    {
      title: "Search documents",
      description:
        "Searches documents in Clio by matter (matter_id), folder (parent_id), contact, name (query) or category. Returns metadata including id, name, size, version and location. " +
        "Paginates via page_token. For the contents of a folder use parent_id + scope=children.",
      inputSchema: {
        matter_id: z.number().int().optional().describe("Matter ID"),
        parent_id: z.number().int().optional().describe("Folder (or document) ID"),
        contact_id: z.number().int().optional().describe("Contact ID"),
        query: z.string().optional().describe("Text to search for in the document name"),
        document_category_id: z.number().int().optional(),
        scope: z.enum(["children", "descendants"]).optional().describe("children = direct contents of the folder only, descendants = including subfolders"),
        order: z.enum(["id(asc)", "id(desc)", "name(asc)", "name(desc)", "updated_at(asc)", "updated_at(desc)"]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
        page_token: z.string().optional(),
      },
    },
    wrap("clio_document_search", async (a: { matter_id?: number; parent_id?: number; contact_id?: number; query?: string; document_category_id?: number; scope?: string; order?: string; limit?: number; page_token?: string }) => {
      if (!a.matter_id && !a.parent_id && !a.contact_id && !a.query) return text(t("documents.search_need_filter"));
      const r = await apiList("/documents", { ...compact({ ...a, page_token: undefined }), fields: DOC_FIELDS, limit: a.limit ?? 50, order: a.order ?? "updated_at(desc)" }, { page_token: a.page_token });
      return json({ records: r.records, has_more: r.has_more, next_page_token: r.next_page_token, documents: r.data });
    })
  );

  server.registerTool(
    "clio_document_get",
    {
      title: "Document details",
      description: "Returns document metadata and the version history (version id, number, size, author, date). Does not return a download URL – use clio_document_download.",
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
      title: "Read document content (text / scan)",
      description:
        "Returns the content of a Clio document directly in the response – no disk access needed. DOCX/PDF with a text layer/TXT/EML/HTML → text (paginate with offset/max_chars). " +
        "Scanned PDFs without a text layer and images (JPG/PNG) → returns the pages as images that Claude reads (visual OCR); select pages with page_from/page_to (max 4 per call). " +
        "mode: auto (default), text (text layer only), images (always page images – e.g. for stamps, signatures, tables). Accepts document_id or file_path.",
      inputSchema: {
        document_id: z.number().int().optional(),
        document_version_id: z.number().int().optional(),
        file_path: z.string().optional().describe("Alternative to document_id – absolute path to a local file"),
        mode: z.enum(["auto", "text", "images"]).optional(),
        max_chars: z.number().int().min(500).max(200000).optional().describe("Max. characters of text in the response (default 40000)"),
        offset: z.number().int().min(0).optional().describe("Character offset to continue from"),
        page_from: z.number().int().min(1).optional().describe("For page images: first page (default 1)"),
        page_to: z.number().int().min(1).optional().describe("For page images: last page (max. 4 pages per call)"),
      },
    },
    wrap(
      "clio_document_read",
      async ({ document_id, document_version_id, file_path, mode, max_chars, offset, page_from, page_to }: { document_id?: number; document_version_id?: number; file_path?: string; mode?: "auto" | "text" | "images"; max_chars?: number; offset?: number; page_from?: number; page_to?: number }) => {
        let buf: Buffer;
        let name: string;
        let meta: Record<string, unknown> = {};
        if (file_path) {
          if (!fs.existsSync(file_path)) return text(t("documents.file_not_found", { path: file_path }));
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
          if (!res.ok) throw new Error(t("documents.download_failed", { status: res.status }));
          buf = Buffer.from(await res.arrayBuffer());
        } else {
          return text(t("documents.read_need_source"));
        }
        const ext = path.extname(name).toLowerCase();
        const want = mode ?? "auto";
        const from = page_from ?? 1;
        const to = Math.min(page_to ?? from + 3, from + 3);

        // image → return it directly as an image
        if (IMAGE_EXT.has(ext)) {
          const img = await normalizeImage(buf, name);
          return {
            content: [
              { type: "text", text: JSON.stringify({ ...meta, kind: "image", width: img.width, height: img.height, note: t("documents.read_image_note") }, null, 2) },
              { type: "image", data: img.data.toString("base64"), mimeType: img.mimeType },
            ],
          };
        }

        const asImages = async (numPagesHint?: number, note?: string) => {
          if (ext !== ".pdf") return text(t("documents.read_cannot_render_images", { ext }));
          const pages = Array.from({ length: to - from + 1 }, (_, i) => from + i);
          const r = await renderPdfPages(buf, pages);
          const blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
            {
              type: "text",
              text: JSON.stringify({ ...meta, kind: "pdf-images", pages_total: r.numPages, pages_returned: r.images.map((i) => i.page), has_more_pages: to < r.numPages, next_page_from: to < r.numPages ? to + 1 : undefined, note: note ?? t("documents.read_pages_as_images_note") }, null, 2),
            },
          ];
          for (const img of r.images) blocks.push({ type: "text", text: t("documents.read_page_separator", { page: img.page, total: r.numPages }) }, { type: "image", data: img.data.toString("base64"), mimeType: img.mimeType });
          void numPagesHint;
          return { content: blocks };
        };

        if (want === "images") return asImages();

        const ex = await extractText(buf, name);
        // "scanned" = extractText reported a PDF without a usable text layer
        const scanned = ex.kind === "pdf" && ex.scanned === true;
        if (want === "auto" && scanned) return asImages(ex.pages, t("documents.read_scanned_pdf_note"));
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
          hint: ex.kind === "pdf" ? t("documents.read_pdf_images_hint") : undefined,
          text: slice,
        });
      }
    )
  );

  server.registerTool(
    "clio_document_download",
    {
      title: "Download document to the work folder",
      description:
        `Downloads a document (or a specific version) from Clio to the work folder on the PC (default ${config.workDir}, subfolder per matter) and returns the file path. ` +
        "Intended for opening and editing the document with Claude; upload the edited file back as a new version with clio_document_upload_version.",
      inputSchema: {
        document_id: z.number().int(),
        document_version_id: z.number().int().optional().describe("Specific version; default latest"),
        target_dir: z.string().optional().describe("Custom target folder (absolute path); default work folder/matter"),
      },
    },
    wrap("clio_document_download", async ({ document_id, document_version_id, target_dir }: { document_id: number; document_version_id?: number; target_dir?: string }) => {
      const meta = await apiRequest<{ data: { name: string; filename?: string; matter?: { display_number?: string }; latest_document_version?: { version_number?: number } } }>("GET", `/documents/${document_id}`, {
        query: { fields: "id,name,filename,matter{id,display_number},latest_document_version{id,version_number}" },
      });
      const doc = meta.data.data;
      const url = await documentDownloadUrl(document_id, document_version_id);
      const dir = target_dir && path.isAbsolute(target_dir) ? (fs.mkdirSync(target_dir, { recursive: true }), target_dir) : ensureWorkDir(doc.matter?.display_number ?? `document-${document_id}`);
      let fileName = safeName(doc.filename || doc.name);
      if (!path.extname(fileName) && doc.name && path.extname(doc.name)) fileName += path.extname(doc.name);
      const target = path.join(dir, fileName);
      const bytes = await downloadTo(url, target);
      return json({ path: target, bytes, document_id, name: doc.name, version: doc.latest_document_version?.version_number, matter: doc.matter?.display_number, hint: t("documents.download_hint") });
    })
  );

  server.registerTool(
    "clio_document_upload_version",
    {
      title: "Upload new document version",
      description: "Uploads a local file as a new version of an existing document in Clio (previous versions stay in the history). Write operation – preview first, then confirm with the token from the preview.",
      inputSchema: {
        document_id: z.number().int(),
        file_path: z.string().describe("Absolute path to the file on the PC"),
        name: z.string().optional().describe("File name in Clio; default the local file name"),
        confirm: confirmSchema,
      },
    },
    wrap("clio_document_upload_version", async ({ document_id, file_path, name, confirm }: { document_id: number; file_path: string; name?: string; confirm?: Confirm }) => {
      if (!fs.existsSync(file_path)) return text(t("documents.file_not_found", { path: file_path }));
      const size = fs.statSync(file_path).size;
      if (!confirm) return preview(t("documents.preview_new_version", { document_id }), { file_path, size, name: name ?? path.basename(file_path) });
      const r = await uploadFile(file_path, { id: document_id, type: "Document" }, name);
      return json({ ok: true, ...r });
    })
  );

  server.registerTool(
    "clio_document_upload",
    {
      title: "Upload new document (existing file)",
      description:
        `Uploads a local file as a new document into a matter. Without folder_id the document is stored in the "${config.claudeFolderName}" folder in the root of the matter's documents (created if it does not exist) – every document created by Claude belongs there. ` +
        "For new letters/filings first use clio_document_create_from_letterhead (letterhead), then this tool. Write operation – preview first, then confirm with the token from the preview.",
      inputSchema: {
        file_path: z.string().describe("Absolute path to the file"),
        matter_id: z.number().int().describe("Matter ID"),
        folder_id: z.number().int().optional().describe(`Specific folder; default the "${config.claudeFolderName}" folder in the matter`),
        name: z.string().optional(),
        document_category_id: z.number().int().optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_document_upload", async ({ file_path, matter_id, folder_id, name, document_category_id, confirm }: { file_path: string; matter_id: number; folder_id?: number; name?: string; document_category_id?: number; confirm?: Confirm }) => {
      if (!fs.existsSync(file_path)) return text(t("documents.file_not_found", { path: file_path }));
      if (!confirm) return preview(t("documents.preview_new_document"), { file_path, size: fs.statSync(file_path).size, matter_id, folder: folder_id ?? t("documents.claude_folder_default", { folder: config.claudeFolderName }), name: name ?? path.basename(file_path), document_category_id });
      const target = folder_id ? { id: folder_id, created: false } : await ensureClaudeFolder(matter_id);
      const r = await uploadFile(file_path, { id: target.id, type: "Folder" }, name, document_category_id);
      return json({ ok: true, folder_id: target.id, folder_created: target.created, ...r });
    })
  );

  server.registerTool(
    "clio_letterheads_list",
    {
      title: "Letterheads and templates",
      description: "Lists the document templates (Document Templates) in Clio including letterheads and shows which template will be used for the signed-in user and for internal documents.",
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
        forUser = t("documents.letterhead_not_found_prefix", { detail: (e as Error).message.split(".")[0] });
      }
      try {
        forInternal = (await pickLetterhead("internal")).template.filename;
      } catch {
        forInternal = t("documents.not_found");
      }
      return json({ user: email, letterhead_for_user: forUser, template_for_internal: forInternal, mapping: config.letterheads, default_template: config.defaultTemplate, templates: all });
    })
  );

  server.registerTool(
    "clio_document_create_from_letterhead",
    {
      title: "New document from letterhead",
      description:
        "Creates a new document in a matter from a letterhead / template (Document Template in Clio): selected by template_id or template, otherwise by configuration (user → template map, default template, kind=internal → internal template). " +
        `RECOMMENDED APPROACH (works everywhere, even without disk access): pass the finished text in the content parameter – the server inserts it into the letterhead (docx) and uploads it to the "${config.claudeFolderName}" folder in the matter (preview, then confirm with the token). ` +
        "content format: empty line = empty paragraph; '# ' / '## ' / '### ' = Heading 2/3/4 of the template; **bold**; '[ 1. ] text' = numbered paragraph (number in the margin, text with a hanging indent); 'Label:: text' = bold label + tab; '- ' bullet; '\\t' tab; '---pagebreak---' page break; ':::center text' centred, ':::right text' right-aligned. Follow the user's conventions for the document structure (addressee, reference numbers, date, heading, enclosures) if they state them. " +
        "Alternatives: without content, mode='download' only downloads the template for manual editing (Cowork with a connected folder); mode='automation' lets Clio generate the document via Document Automation. Without a letterhead only with without_letterhead=true. " +
        "Do not create empty documents: if the user has not provided the text (and the document type, addressee, matter), ask before calling this tool. Choose filename from the document type and addressee (e.g. 'Letter_to_opposing_counsel_2026-10-03.docx') unless the user names it.",
      inputSchema: {
        matter_id: z.number().int().describe("ID of the matter the document belongs to"),
        filename: z.string().describe("Name of the new document including the extension, e.g. 'Statement of defence.docx'"),
        kind: z.enum(["user", "internal"]).optional().describe("user = letterhead of the signed-in user (default), internal = internal template"),
        template_id: z.number().int().optional().describe("Explicit template id (overrides automatic selection)"),
        template: z.string().optional().describe("Template name or name prefix (overrides automatic selection); alternative to template_id"),
        mode: z.enum(["download", "automation"]).optional().describe("download (default) = download the template for editing; automation = generate in Clio via Document Automation"),
        formats: z.array(z.enum(["original", "pdf"])).optional().describe("Automation only: original = template format (docx), pdf; default ['original']"),
        without_letterhead: z.boolean().optional().describe("true = do not use a template (only returns instructions for uploading a plain file)"),
        target_dir: z.string().optional().describe("Custom target folder on the PC (absolute path), e.g. a folder connected in Cowork; default work folder/matter"),
        content: z.string().optional().describe("Finished document text (markdown-lite, see description). If provided, the server fills the letterhead and uploads the document to Clio. Never pass empty or placeholder text – if the user has not said what the document should contain, ask first."),
        keep_local_copy: z.boolean().optional().describe("true = also save the filled file to the work folder (default true)"),
        confirm: confirmSchema,
      },
    },
    wrap(
      "clio_document_create_from_letterhead",
      async ({ matter_id, filename, kind, template_id, template, mode, formats, without_letterhead, target_dir, content, keep_local_copy, confirm }: { matter_id: number; filename: string; kind?: "user" | "internal"; template_id?: number; template?: string; mode?: "download" | "automation"; formats?: ("original" | "pdf")[]; without_letterhead?: boolean; target_dir?: string; content?: string; keep_local_copy?: boolean; confirm?: Confirm }) => {
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
          return json({ note: t("documents.without_letterhead_note"), target_path: path.join(dir, safeName(filename)), matter: m });
        }
        const pick = await pickLetterhead(kind ?? "user", template_id ?? template);
        if (content !== undefined) {
          // server-side filling of the letterhead and upload to the "Claude" folder
          if (content.trim().length < 20) return text(t("documents.content_empty"));
          const finalName = safeName(filename.toLowerCase().endsWith(".docx") ? filename : filename + ".docx");
          if (!confirm) {
            return preview(t("documents.preview_letterhead_document", { matter: m.display_number, folder: config.claudeFolderName }), { filename: finalName, template: pick.template.filename, reason: pick.reason, content_preview: content.slice(0, 1500) + (content.length > 1500 ? "…" : ""), content_chars: content.length });
          }
          const r = await apiRequest<{ location: string | null }>("GET", `/document_templates/${pick.template.id}/download`, { raw: true });
          if (!r.data.location) throw new Error(t("documents.template_download_no_url", { status: r.status }));
          const tres = await fetch(r.data.location);
          if (!tres.ok) throw new Error(t("documents.template_download_failed", { status: tres.status }));
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
          return json({ ok: true, template: { id: pick.template.id, filename: pick.template.filename, reason: pick.reason }, folder_id: folder.id, folder_created: folder.created, local_copy: localPath, ...up, next_step: t("documents.created_next_step") });
        }
        if ((mode ?? "download") === "download") {
          const dir = resolveDir();
          const target = path.join(dir, safeName(filename.endsWith(path.extname(pick.template.filename)) ? filename : filename + path.extname(pick.template.filename)));
          const r = await apiRequest<{ location: string | null }>("GET", `/document_templates/${pick.template.id}/download`, { raw: true });
          if (!r.data.location) throw new Error(t("documents.template_download_no_url", { status: r.status }));
          const bytes = await downloadTo(r.data.location, target);
          return json({
            path: target,
            bytes,
            template: { id: pick.template.id, filename: pick.template.filename, reason: pick.reason },
            matter: m,
            next_step: t("documents.download_template_next_step", { path: target, matter_id, folder: config.claudeFolderName }),
          });
        }
        const body = { document_template: { id: pick.template.id }, matter: { id: matter_id }, filename: safeName(filename), formats: formats ?? ["original"] };
        if (!confirm) return preview(t("documents.preview_automation"), { ...body, template_filename: pick.template.filename, reason: pick.reason, matter: m.display_number });
        const created = await apiRequest<{ data: { id: number; state?: string } }>("POST", "/document_automations", { query: { fields: "id,state,filename,export_formats,documents{id,name}" }, body });
        let auto = created.data.data as { id: number; state?: string; documents?: { id: number; name: string }[] };
        for (let i = 0; i < 10 && (!auto.documents || !auto.documents.length); i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const s = await apiRequest<{ data: typeof auto }>("GET", `/document_automations/${auto.id}`, { query: { fields: "id,state,filename,export_formats,documents{id,name}" } });
          auto = s.data.data;
        }
        // move the generated documents into the "Claude" folder
        let moved: number[] = [];
        if (auto.documents?.length) {
          const folder = await ensureClaudeFolder(matter_id);
          for (const d of auto.documents) {
            try {
              await apiRequest("PATCH", `/documents/${d.id}`, { query: { fields: "id" }, body: { parent: { id: folder.id, type: "Folder" } } });
              moved.push(d.id);
            } catch {
              /* leave it in the root */
            }
          }
        }
        return json({ automation: auto, moved_to_claude_folder: moved, next_step: auto.documents?.length ? t("documents.automation_done_next_step", { document_id: auto.documents[0].id }) : t("documents.automation_pending_next_step", { automation_id: auto.id }) });
      }
    )
  );

  server.registerTool(
    "clio_document_write",
    {
      title: "Rewrite document from text (new version)",
      description:
        "Creates a new version of an existing DOCX document in Clio from the given text (same markdown-lite format as clio_document_create_from_letterhead). " +
        "The document body is REPLACED by the new text; header, footer and styles are kept (template = the document itself, or base='letterhead' = the current letterhead of the user). " +
        "Suitable for fixing documents created by Claude; for third-party documents with complex formatting prefer downloading and editing in Cowork. Write operation – preview first, then confirm with the token from the preview.",
      inputSchema: {
        document_id: z.number().int(),
        content: z.string().describe("New complete text of the document (markdown-lite)"),
        base: z.enum(["document", "letterhead"]).optional().describe("document (default) = header/footer from the current version of the document; letterhead = from the user's letterhead"),
        confirm: confirmSchema,
      },
    },
    wrap("clio_document_write", async ({ document_id, content, base, confirm }: { document_id: number; content: string; base?: "document" | "letterhead"; confirm?: Confirm }) => {
      const meta = await apiRequest<{ data: { name: string; filename?: string; matter?: { id: number; display_number?: string } } }>("GET", `/documents/${document_id}`, { query: { fields: "id,name,filename,matter{id,display_number}" } });
      const d = meta.data.data;
      const name = d.filename || d.name;
      if (!name.toLowerCase().endsWith(".docx")) return text(t("documents.write_not_docx", { name }));
      if (!confirm) return preview(t("documents.preview_write_version", { document_id, name }), { base: base ?? "document", content_preview: content.slice(0, 1500), content_chars: content.length });
      let templateBuf: Buffer;
      if ((base ?? "document") === "document") {
        const url = await documentDownloadUrl(document_id);
        const res = await fetch(url);
        if (!res.ok) throw new Error(t("documents.document_download_failed", { status: res.status }));
        templateBuf = Buffer.from(await res.arrayBuffer());
      } else {
        const pick = await pickLetterhead("user");
        const r = await apiRequest<{ location: string | null }>("GET", `/document_templates/${pick.template.id}/download`, { raw: true });
        if (!r.data.location) throw new Error(t("documents.template_download_unavailable"));
        const res = await fetch(r.data.location);
        templateBuf = Buffer.from(await res.arrayBuffer());
      }
      // for an existing document clear the whole body (all paragraphs before sectPr), not just the empty ones
      const filled = fillDocxTemplate(templateBuf, content, { clearTemplateBody: true, clearAllBody: (base ?? "document") === "document" });
      const up = await uploadFile(filled, { id: document_id, type: "Document" }, name);
      return json({ ok: true, matter: d.matter?.display_number, ...up });
    })
  );

  server.registerTool(
    "clio_folder_list",
    {
      title: "Matter folders",
      description: "Lists the folders (and optionally documents) in a matter or under a given folder – to find out where to store a document.",
      inputSchema: {
        matter_id: z.number().int().optional(),
        parent_id: z.number().int().optional().describe("Parent folder ID"),
        include_documents: z.boolean().optional().describe("true = also return documents (endpoint /folders/list)"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    wrap("clio_folder_list", async ({ matter_id, parent_id, include_documents, limit }: { matter_id?: number; parent_id?: number; include_documents?: boolean; limit?: number }) => {
      if (!matter_id && !parent_id) return text(t("documents.folder_list_need_parent"));
      let root = parent_id;
      if (!root) {
        const m = await apiRequest<{ data: { folder?: { id: number } } }>("GET", `/matters/${matter_id}`, { query: { fields: "id,folder{id}" } });
        root = m.data.data.folder?.id;
        if (!root) return text(t("documents.matter_no_root_folder", { matter_id }));
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
      title: "Create folder",
      description: "Creates a folder in a matter (parent = Matter) or inside another folder (parent = Folder). Write operation – preview first, then confirm with the token from the preview.",
      inputSchema: {
        name: z.string(),
        matter_id: z.number().int().optional(),
        parent_folder_id: z.number().int().optional(),
        confirm: confirmSchema,
      },
    },
    wrap("clio_folder_create", async ({ name, matter_id, parent_folder_id, confirm }: { name: string; matter_id?: number; parent_folder_id?: number; confirm?: Confirm }) => {
      if (!matter_id && !parent_folder_id) return text(t("documents.folder_create_need_parent"));
      const body = { name, parent: parent_folder_id ? { id: parent_folder_id, type: "Folder" } : { id: matter_id!, type: "Matter" } };
      if (!confirm) return preview(t("documents.preview_new_folder"), body);
      const r = await apiRequest<{ data: unknown }>("POST", "/folders", { query: { fields: "id,name,parent{id,type},matter{id,display_number}" }, body });
      return json(r.data.data);
    })
  );

  server.registerTool(
    "clio_document_comment_add",
    {
      title: "Comment on document",
      description: "Adds a comment to the current version of a document (visible in Clio next to the document). Write operation – preview first, then confirm with the token from the preview.",
      inputSchema: { document_id: z.number().int(), message: z.string(), confirm: confirmSchema },
    },
    wrap("clio_document_comment_add", async ({ document_id, message, confirm }: { document_id: number; message: string; confirm?: Confirm }) => {
      const body = { message, item: { id: document_id } };
      if (!confirm) return preview(t("documents.preview_comment", { document_id }), body);
      const r = await apiRequest<{ data: unknown }>("POST", "/comments", { query: { fields: "id,message,created_at,creator{id,name}" }, body });
      return json(r.data.data);
    })
  );
};
