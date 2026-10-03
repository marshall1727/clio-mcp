/** Server-side text extraction from documents (DOCX, PDF, TXT/EML/CSV) – so that Claude can read matter contents even without disk access. */
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { t } from "./i18n.js";

export interface Extracted {
  text: string;
  kind: "docx" | "pdf" | "text" | "unsupported";
  pages?: number;
  note?: string;
  /** true when a PDF has no usable text layer (probably a scan) */
  scanned?: boolean;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** DOCX: word/document.xml → paragraphs; tables as tab-separated rows; header/footer separately. */
function docxText(buf: Buffer): Extracted {
  const files = unzipSync(new Uint8Array(buf));
  const part = (name: string) => (files[name] ? strFromU8(files[name]) : undefined);
  const body = part("word/document.xml");
  if (!body) return { text: "", kind: "unsupported", note: t("runtime.docx_missing_document_xml") };
  const xmlToText = (xml: string) =>
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, "")
      .replace(/<[^>]+>/g, "")
      .split("\n")
      .map((l) => decodeXml(l).replace(/[ \t]+$/g, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const main = xmlToText(body);
  const headers = Object.keys(files)
    .filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))
    .map((n) => xmlToText(part(n)!))
    .filter(Boolean);
  const text = headers.length ? `${main}\n\n${t("runtime.docx_header_footer_marker")}\n${headers.join("\n")}` : main;
  return { text, kind: "docx" };
}

async function pdfText(buf: Buffer): Promise<Extracted> {
  // the pdfjs legacy build works in Node without a worker
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // the worker is shipped next to the bundle (pkg/server/pdf.worker.mjs)
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.mjs", import.meta.url).href;
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const parts: string[] = [];
  const bodies: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    let lastY: number | undefined;
    const lines: string[] = [];
    for (const item of content.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
      if (item.str === undefined) continue;
      const y = item.transform?.[5];
      if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 2) {
        lines.push(line);
        line = "";
      }
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
      lastY = y;
    }
    if (line) lines.push(line);
    const pageBody = lines.join("\n").trim();
    bodies.push(pageBody);
    parts.push(`${t("runtime.pdf_page_marker", { page: i })}\n${pageBody}`);
  }
  const text = parts.join("\n\n").trim();
  // text without the page markers – used to detect a missing text layer (scanned PDF)
  const bare = bodies.join("\n\n").trim();
  const scanned = bare.length < 20;
  return { text, kind: "pdf", pages: doc.numPages, scanned, note: scanned ? t("runtime.pdf_no_text_layer") : undefined };
}

export async function extractText(buf: Buffer, fileName: string): Promise<Extracted> {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".docx" || ext === ".dotx") return docxText(buf);
  if (ext === ".pdf") return pdfText(buf);
  if ([".txt", ".md", ".csv", ".eml", ".json", ".xml", ".html", ".htm", ".rtf"].includes(ext)) {
    let txt = buf.toString("utf8");
    if (ext === ".html" || ext === ".htm") txt = decodeXml(txt.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, "").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/g, "\n").replace(/<[^>]+>/g, ""));
    return { text: txt, kind: "text" };
  }
  return {
    text: "",
    kind: "unsupported",
    note: t("runtime.unsupported_format", { ext: ext || t("runtime.no_extension") }),
  };
}

// ---------------- Raster: PDF pages and images for Claude to read (visual "OCR") ----------------

export interface PageImage {
  page: number;
  mimeType: "image/jpeg" | "image/png";
  data: Buffer;
  width: number;
  height: number;
}

async function loadCanvas() {
  // the native module (@napi-rs/canvas) is outside the bundle – it lives in the package's node_modules
  try {
    return await import("@napi-rs/canvas");
  } catch (e) {
    throw new Error(t("runtime.canvas_unavailable", { detail: (e as Error).message }));
  }
}

/** Renders the selected PDF pages to JPEG (default ~110 DPI, max. width 1400 px). */
export async function renderPdfPages(buf: Buffer, pages: number[], opts: { scale?: number; quality?: number } = {}): Promise<{ images: PageImage[]; numPages: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.mjs", import.meta.url).href;
  const { createCanvas } = await loadCanvas();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const images: PageImage[] = [];
  const scale = opts.scale ?? 1.5; // 72 dpi × 1.5 ≈ 108 dpi
  for (const n of pages) {
    if (n < 1 || n > doc.numPages) continue;
    const page = await doc.getPage(n);
    let viewport = page.getViewport({ scale });
    if (viewport.width > 1400) viewport = page.getViewport({ scale: (scale * 1400) / viewport.width });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // pdfjs expects a CanvasRenderingContext2D – @napi-rs/canvas is API-compatible
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
    const data = canvas.toBuffer("image/jpeg", opts.quality ?? 80);
    images.push({ page: n, mimeType: "image/jpeg", data, width: canvas.width, height: canvas.height });
  }
  return { images, numPages: doc.numPages };
}

/** Image (JPG/PNG/WebP/GIF/BMP): downscales to max. 1600 px and returns JPEG; other formats are returned unchanged. */
export async function normalizeImage(buf: Buffer, fileName: string): Promise<PageImage> {
  const ext = path.extname(fileName).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  try {
    const { loadImage, createCanvas } = await loadCanvas();
    const img = await loadImage(buf);
    const max = 1600;
    const ratio = Math.min(1, max / Math.max(img.width, img.height));
    if (ratio === 1 && buf.length < 900_000) return { page: 1, mimeType: mime, data: buf, width: img.width, height: img.height };
    const canvas = createCanvas(Math.round(img.width * ratio), Math.round(img.height * ratio));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { page: 1, mimeType: "image/jpeg", data: canvas.toBuffer("image/jpeg", 82), width: canvas.width, height: canvas.height };
  } catch {
    return { page: 1, mimeType: mime, data: buf, width: 0, height: 0 };
  }
}

export const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
