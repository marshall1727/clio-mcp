// SPDX-License-Identifier: Apache-2.0
/**
 * clio-mcp – MCP server for Clio Manage (Clio API v4).
 */
// stdout patří MCP protokolu – veškerý běžný výstup knihoven přesměrovat na stderr
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { registerCore } from "./tools/core.js";
import { registerDocuments } from "./tools/documents.js";
import { registerActivities } from "./tools/activities.js";
import { registerMatters } from "./tools/matters.js";

const server = new McpServer(
  { name: config.name, version: config.version },
  {
    instructions: [
      `Konektor na Clio Manage (region ${config.region.toUpperCase()}). Pravidla:`,
      "1) Před prvním použitím ověřte přihlášení (clio_auth_status); při 'nepřihlášeno' spusťte clio_authenticate a ukažte uživateli URL.",
      "2) Všechny zápisové nástroje vrací bez confirm=true jen NÁHLED – ukažte ho uživateli a proveďte zápis až po jeho souhlasu.",
      "3) Nové dokumenty vznikají výhradně z hlavičkového papíru uživatele: napište celý text a předejte ho v parametru content nástroje clio_document_create_from_letterhead (server vyplní hlavičkový papír a nahraje do složky „Claude“ ve spisu). Soubory na disku sami netvořte, pokud uživatel nepracuje v Cowork s připojenou složkou. Opravy dokumentu vytvořeného Claudem: clio_document_write. Mazání záznamů konektor neumožňuje.",
      "4) Obsah dokumentů (DOCX/PDF) čtěte nástrojem clio_document_read – vrací text přímo, funguje i bez přístupu k disku. clio_document_download používejte jen pro editaci souboru v připojené složce (Cowork).",
      "5) Když kurátorovaný nástroj chybí, použijte clio_describe_api a clio_api_request.",
      `6) Pracovní složka pro soubory na PC: ${config.workDir}.`,
    ].join("\n"),
  }
);

registerCore(server);
registerDocuments(server);
registerActivities(server);
registerMatters(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("clio-mcp fatal:", e);
  process.exit(1);
});
