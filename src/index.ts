#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { IgwApiClient } from "./services/api.js";
import { PanelClient } from "./services/panel.js";
import { IgwAuthConfig } from "./types.js";
import { DEFAULT_IGW_BASE_URL, DEFAULT_PANEL_BASE_URL } from "./constants.js";
import { registerErrorTools } from "./tools/errors.js";
import { registerErrorActionTools } from "./tools/error-actions.js";
import { registerReportTools } from "./tools/reports.js";
import { registerLookupTools } from "./tools/lookups.js";
import { registerProductTools } from "./tools/products.js";

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const config: IgwAuthConfig = {
  baseUrl: process.env.IGW_BASE_URL || DEFAULT_IGW_BASE_URL,
  username: getRequiredEnv("IGW_USERNAME"),
  password: getRequiredEnv("IGW_PASSWORD"),
  webApiKey: getRequiredEnv("IGW_WEB_API_KEY"),
};

const api = new IgwApiClient(config);

const server = new McpServer({
  name: "igw-error-management",
  version: "1.0.0",
});

registerErrorTools(server, api);
registerErrorActionTools(server, api);
registerReportTools(server, api);
registerLookupTools(server, api);

// Product catalog via GatewayProUI admin panel — optional, needs panel credentials
const panelUsername = process.env.IGW_PANEL_USERNAME;
const panelPassword = process.env.IGW_PANEL_PASSWORD;
if (panelUsername && panelPassword) {
  const panel = new PanelClient({
    baseUrl: process.env.IGW_PANEL_BASE_URL || DEFAULT_PANEL_BASE_URL,
    username: panelUsername,
    password: panelPassword,
  });
  registerProductTools(server, panel);
} else {
  console.error(
    "IGW_PANEL_USERNAME / IGW_PANEL_PASSWORD not set — igw_products_list tool disabled"
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
