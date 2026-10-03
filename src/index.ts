// SPDX-License-Identifier: Apache-2.0
/**
 * clio-mcp – MCP server for Clio Manage (Clio API v4).
 */
// stdout belongs to the MCP protocol – redirect all ordinary library output to stderr
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { t } from "./i18n.js";
import { registerCore } from "./tools/core.js";
import { registerDocuments } from "./tools/documents.js";
import { registerActivities } from "./tools/activities.js";
import { registerMatters } from "./tools/matters.js";

const server = new McpServer(
  { name: config.name, version: config.version },
  {
    instructions: [
      t("runtime.instructions_intro", { region: config.region.toUpperCase() }),
      t("runtime.instructions_1"),
      t(config.confirmMode === "ask" ? "runtime.instructions_2" : "runtime.instructions_2_auto"),
      t("runtime.instructions_3", { claudeFolder: config.claudeFolderName }),
      t("runtime.instructions_4"),
      t("runtime.instructions_5"),
      t("runtime.instructions_6", { workDir: config.workDir }),
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
  console.error(t("runtime.fatal"), e);
  process.exit(1);
});
