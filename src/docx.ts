// SPDX-License-Identifier: Apache-2.0
/**
 * Server-side filling of a DOCX template (letterhead) with text – no Word, no disk access needed by the model.
 * Input is a small "markdown-lite" dialect:
 *   empty line               → empty paragraph
 *   # / ## / ###             → Heading 2 / 3 / 4 of the template (styles "heading 2–4"; bold paragraph when missing)
 *   **bold**                 → bold run
 *   [ 1. ] text              → numbered paragraph: marker at 0 cm, text at the configured indent (hanging), tab
 *   Label:: text             → "Label:" in bold + tab + text, hanging indent (any label)
 *   <Label>: text            → same, for labels listed in CLIO_DOCX_LABELS (e.g. "Evidence")
 *   - item                   → "-" bullet with indent
 *   \t                       → tab
 *   ---pagebreak---          → page break
 *   :::center text           → centered paragraph;  :::right text → right-aligned
 */
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { config } from "./config.js";

const INDENT_TWIPS = config.docxIndentTwips; // default 1.4 cm

const esc1 = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LABEL_RE = config.docxLabels.length ? new RegExp(`^(${config.docxLabels.map(esc1).join("|")}):\\s*(.*)$`) : undefined;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inline text with **bold** and \t → sequence of <w:r>. */
function runs(text: string, opts: { bold?: boolean } = {}): string {
  const out: string[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== "");
  for (const p of parts) {
    const bold = opts.bold || (p.startsWith("**") && p.endsWith("**"));
    const raw = p.startsWith("**") && p.endsWith("**") ? p.slice(2, -2) : p;
    const segs = raw.split("\t");
    segs.forEach((seg, i) => {
      if (i > 0) out.push(`<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:tab/></w:r>`);
      if (seg) out.push(`<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(seg)}</w:t></w:r>`);
    });
  }
  return out.join("");
}

function para(inner: string, pPr = ""): string {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;
}

/** Finds a paragraph style by its built-in name (e.g. "heading 2"), falling back to common style ids. */
function findStyleId(stylesXml: string | undefined, name: string, ...fallbackIds: string[]): string | undefined {
  if (!stylesXml) return undefined;
  const re = new RegExp(`<w:style\\b[^>]*w:styleId="([^"]+)"[^>]*>(?:(?!</w:style>)[\\s\\S])*?<w:name w:val="${name}"`, "i");
  const m = re.exec(stylesXml);
  if (m?.[1]) return m[1];
  for (const id of fallbackIds) if (stylesXml.includes(`w:styleId="${id}"`)) return id;
  return undefined;
}

export interface FillOptions {
  /** true = remove the empty paragraphs the template carries in its body (default true) */
  clearTemplateBody?: boolean;
  /** true = remove the whole body (all paragraphs and tables before sectPr) – when rewriting an existing document */
  clearAllBody?: boolean;
}

/** Inserts the content into the template body (before <w:sectPr>) and returns the new DOCX. */
export function fillDocxTemplate(template: Buffer, content: string, opts: FillOptions = {}): Buffer {
  const files = unzipSync(new Uint8Array(template));
  const docName = "word/document.xml";
  if (!files[docName]) throw new Error("The template does not contain word/document.xml.");
  let doc = strFromU8(files[docName]);
  const styles = files["word/styles.xml"] ? strFromU8(files["word/styles.xml"]) : undefined;
  const h2 = findStyleId(styles, "heading 2", "Heading2", "Nadpis2");
  const h3 = findStyleId(styles, "heading 3", "Heading3", "Nadpis3");
  const h4 = findStyleId(styles, "heading 4", "Heading4", "Nadpis4");

  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const body: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");
    if (line === "") {
      body.push(para(""));
      continue;
    }
    if (/^---\s*pagebreak\s*---$/i.test(line.trim())) {
      body.push(para(`<w:r><w:br w:type="page"/></w:r>`));
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      const level = m[1].length;
      const styleId = level === 1 ? h2 : level === 2 ? h3 : h4;
      body.push(styleId ? para(runs(m[2]), `<w:pStyle w:val="${styleId}"/>`) : para(runs(m[2], { bold: true })));
      continue;
    }
    if ((m = line.match(/^(\[\s*\d+\.\s*\])\s*(.*)$/))) {
      body.push(para(runs(m[1]) + `<w:r><w:tab/></w:r>` + runs(m[2]), `<w:ind w:left="${INDENT_TWIPS}" w:hanging="${INDENT_TWIPS}"/><w:jc w:val="both"/>`));
      continue;
    }
    if ((m = line.match(/^([^:\t]{1,40})::\s*(.*)$/)) || (LABEL_RE && (m = line.match(LABEL_RE)))) {
      body.push(para(runs(`${m[1]}:`, { bold: true }) + `<w:r><w:tab/></w:r>` + runs(m[2]), `<w:ind w:left="${INDENT_TWIPS}" w:hanging="${INDENT_TWIPS}"/>`));
      continue;
    }
    if ((m = line.match(/^[-•]\s+(.*)$/))) {
      body.push(para(runs("-") + `<w:r><w:tab/></w:r>` + runs(m[1]), `<w:ind w:left="${INDENT_TWIPS * 2}" w:hanging="${INDENT_TWIPS / 2}"/>`));
      continue;
    }
    if ((m = line.match(/^:::(center|right)\s+(.*)$/))) {
      body.push(para(runs(m[2]), `<w:jc w:val="${m[1]}"/>`));
      continue;
    }
    body.push(para(runs(line), `<w:jc w:val="both"/>`));
  }

  const sectIdx = doc.lastIndexOf("<w:sectPr");
  if (sectIdx < 0) throw new Error("The template has no <w:sectPr> – unexpected document structure.");
  let head = doc.slice(0, sectIdx);
  if (opts.clearAllBody) {
    const bodyIdx = head.indexOf("<w:body>");
    if (bodyIdx >= 0) head = head.slice(0, bodyIdx + "<w:body>".length);
  } else if (opts.clearTemplateBody !== false) {
    // drop empty paragraphs at the end of the template body (typically the single empty paragraph of a letterhead)
    head = head.replace(/(?:<w:p\b[^>]*\/>|<w:p\b[^>]*>(?:<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*<\/w:pPr>)?<\/w:p>)+$/g, "");
  }
  doc = head + body.join("") + doc.slice(sectIdx);
  files[docName] = strToU8(doc);
  return Buffer.from(zipSync(files, { level: 6 }));
}
